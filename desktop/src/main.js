'use strict';
const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  globalShortcut,
} = require('electron');
const QRCode = require('qrcode');

const config = require('./config');
const { createServer } = require('./server');
const { startDiscovery, lanAddresses } = require('./discovery');

const VERSION = app.getVersion();
const ASSETS = path.join(__dirname, '..', 'assets');
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '..', '..', 'web');
const INJECT_CODE = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// O YouTube Music recusa login em navegadores "embutidos": usamos um user agent de Chrome comum.
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = CHROME_UA;
// Permite tocar sem gesto do usuário (comandos chegam pela rede).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let pairWin = null;
let tray = null;
let server = null;
let stopDiscovery = null;
let quitting = false;
let playerState = null;
let serverError = null;

// ---------------- RPC com o script injetado ----------------
let rpcSeq = 0;
const pending = new Map();

function rpc(method, ...args) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('Player não está aberto'));
    const id = ++rpcSeq;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('O player não respondeu (a página ainda está carregando?)'), { status: 503 }));
    }, method === 'search' || method === 'addToQueue' || method === 'playSong' ? 15000 : 4000);
    pending.set(id, { resolve, reject, timeout });
    win.webContents.send('diako:rpc', { id, method, args });
  });
}

ipcMain.on('diako:rpc-result', (_e, { id, result, error }) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timeout);
  if (error) p.reject(Object.assign(new Error(error), { status: 500 }));
  else p.resolve(result);
});

ipcMain.on('diako:state', (_e, state) => {
  const prev = playerState;
  playerState = state;
  server?.onStateChange(prev, state);
  if (prev?.song?.videoId !== state?.song?.videoId || prev?.isPlaying !== state?.isPlaying) updateTray();
});

// ---------------- janela principal ----------------
function createWindow() {
  const cfg = config.get();
  win = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    minWidth: 400,
    minHeight: 300,
    title: 'DiakoPlayer',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#030303',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(INJECT_CODE).catch((e) => console.error('[inject]', e));
    win.webContents
      .executeJavaScript(`window.__diakoAutoDismiss = ${!!config.get('autoDismissYouThere')};`)
      .catch(() => {});
  });

  // Lembra a última música/página para retomar ao abrir.
  const rememberUrl = (_e, url) => {
    if (url.startsWith('https://music.youtube.com/')) config.set({ lastUrl: url });
  };
  win.webContents.on('did-navigate', rememberUrl);
  win.webContents.on('did-navigate-in-page', rememberUrl);

  // Links externos abrem no navegador padrão; login do Google fica dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(accounts\.google\.com|music\.youtube\.com)/.test(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    const [width, height] = win.getSize();
    config.set({ window: { width, height } });
    if (!quitting && config.get('minimizeToTray')) {
      e.preventDefault();
      win.hide();
    }
  });

  const start = cfg.resumeLastUrl && cfg.lastUrl ? cfg.lastUrl : cfg.startUrl;
  win.loadURL(start);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------- janela de pareamento ----------------
async function pairInfo() {
  const port = config.get('port');
  const addresses = lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${port}/` }));
  const primary = addresses[0]?.url || `http://localhost:${port}/`;
  return {
    version: VERSION,
    port,
    addresses,
    primary,
    qr: await QRCode.toDataURL(primary, { margin: 1, width: 280 }),
    authEnabled: config.get('authEnabled'),
    clients: config.get('authorizedClients'),
    connected: server?.clientCount() || 0,
    serverError,
  };
}

function openPairWindow() {
  if (pairWin && !pairWin.isDestroyed()) return pairWin.focus();
  pairWin = new BrowserWindow({
    width: 460,
    height: 740,
    resizable: false,
    title: 'Conectar celular — DiakoPlayer',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    parent: win?.isVisible() ? win : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'pair-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  pairWin.loadFile(path.join(__dirname, 'pair.html'));
}

ipcMain.handle('pair:info', () => pairInfo());
ipcMain.handle('pair:set-auth', (_e, enabled) => {
  config.set({ authEnabled: !!enabled });
  return pairInfo();
});
ipcMain.handle('pair:revoke', (_e, id) => {
  config.set({ authorizedClients: config.get('authorizedClients').filter((c) => c !== id) });
  return pairInfo();
});
ipcMain.handle('pair:open', (_e, url) => {
  if (/^http:\/\/[\d.]+:\d+\/$|^http:\/\/localhost:\d+\/$/.test(url)) shell.openExternal(url);
});

async function askApproval(id, address) {
  const parent = win && !win.isDestroyed() ? win : undefined;
  if (parent && !parent.isVisible()) parent.show();
  const ip = String(address || '').replace(/^::ffff:/, '');
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'DiakoPlayer — novo aparelho',
    message: 'Um aparelho quer controlar o player',
    detail: `Endereço: ${ip}\nIdentificação: ${id}\n\nPermitir que ele controle a música deste PC?`,
    buttons: ['Permitir', 'Recusar'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

// ---------------- bandeja e menu ----------------
function updateTray() {
  if (!tray) return;
  const s = playerState;
  const song = s?.song;
  tray.setToolTip(song ? `DiakoPlayer — ${song.title} · ${song.artist}` : 'DiakoPlayer');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: song ? `${song.title} — ${song.artist}`.slice(0, 60) : 'Nada tocando', enabled: false },
      { type: 'separator' },
      { label: s?.isPlaying ? 'Pausar' : 'Tocar', click: () => rpc('togglePlay').catch(() => {}) },
      { label: 'Próxima', click: () => rpc('next').catch(() => {}) },
      { label: 'Anterior', click: () => rpc('previous').catch(() => {}) },
      { type: 'separator' },
      { label: 'Mostrar player', click: showWindow },
      { label: 'Conectar celular (QR code)…', click: openPairWindow },
      { type: 'separator' },
      { label: 'Sair', click: () => ((quitting = true), app.quit()) },
    ]),
  );
}

function buildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'DiakoPlayer',
        submenu: [
          { label: 'Conectar celular (QR code)…', accelerator: 'CmdOrCtrl+Shift+C', click: openPairWindow },
          {
            label: 'Abrir controle web neste PC',
            click: () => shell.openExternal(`http://localhost:${config.get('port')}/`),
          },
          { type: 'separator' },
          {
            label: 'Exigir aprovação de novos aparelhos',
            type: 'checkbox',
            checked: config.get('authEnabled'),
            click: (item) => config.set({ authEnabled: item.checked }),
          },
          {
            label: 'Fechar o aviso "Ainda está aí?" automaticamente',
            type: 'checkbox',
            checked: config.get('autoDismissYouThere'),
            click: (item) => {
              config.set({ autoDismissYouThere: item.checked });
              win?.webContents.executeJavaScript(`window.__diakoAutoDismiss = ${item.checked};`).catch(() => {});
            },
          },
          {
            label: 'Minimizar para a bandeja ao fechar',
            type: 'checkbox',
            checked: config.get('minimizeToTray'),
            click: (item) => config.set({ minimizeToTray: item.checked }),
          },
          { type: 'separator' },
          { label: 'Sair', accelerator: 'CmdOrCtrl+Q', click: () => ((quitting = true), app.quit()) },
        ],
      },
      {
        label: 'Navegar',
        submenu: [
          { label: 'Voltar', accelerator: 'Alt+Left', click: () => win?.webContents.navigationHistory.goBack() },
          { label: 'Avançar', accelerator: 'Alt+Right', click: () => win?.webContents.navigationHistory.goForward() },
          { label: 'Início', click: () => win?.loadURL('https://music.youtube.com/') },
          { role: 'reload', label: 'Recarregar' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Tela cheia' },
          { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
        ],
      },
    ]),
  );
}

// ---------------- ciclo de vida ----------------
app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  config.load();
  buildAppMenu();
  createWindow();

  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.on('click', showWindow);
  updateTray();

  server = createServer({
    getConfig: () => config.get(),
    setConfig: (p) => config.set(p),
    rpc,
    getState: () => playerState,
    navigateToSong: (id) => win?.loadURL(`https://music.youtube.com/watch?v=${id}`),
    askApproval,
    webRoot: WEB_ROOT,
    version: VERSION,
  });
  try {
    const port = await server.listen();
    console.log(`[DiakoPlayer] controle em http://localhost:${port}/`);
    lanAddresses().forEach((a) => console.log(`  http://${a.address}:${port}/  (${a.name})`));
  } catch (e) {
    serverError = `Não foi possível abrir a porta ${config.get('port')}: ${e.message}`;
    console.error(serverError);
    dialog.showErrorBox('DiakoPlayer', `${serverError}\n\nFeche outro programa que use essa porta (por ex. o pear-desktop com o API Server ligado).`);
  }
  stopDiscovery = startDiscovery({ getPort: () => config.get('port'), version: VERSION });

  // Teclas de mídia do teclado.
  globalShortcut.register('MediaPlayPause', () => rpc('togglePlay').catch(() => {}));
  globalShortcut.register('MediaNextTrack', () => rpc('next').catch(() => {}));
  globalShortcut.register('MediaPreviousTrack', () => rpc('previous').catch(() => {}));
});

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  server?.close();
  stopDiscovery?.();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
