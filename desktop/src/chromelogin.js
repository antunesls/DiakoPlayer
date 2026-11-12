'use strict';
// Login do Google via Chrome de verdade (o Google bloqueia login dentro do Electron).
// Abre o Chrome com um perfil próprio + porta de debug, espera o login e copia os cookies para o app.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?service=youtube&continue=' +
  encodeURIComponent('https://music.youtube.com/');

function findBrowser() {
  const env = process.env;
  const candidates = [
    path.join(env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pend = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    const p = pend.get(msg.id);
    if (p) { pend.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      pend.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => { try { ws.close(); } catch {} },
  };
}

function toElectronCookie(c) {
  const hostOnly = !c.domain.startsWith('.');
  const host = c.domain.replace(/^\./, '');
  const out = {
    url: `https://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (!hostOnly) out.domain = c.domain;
  if (c.expires && c.expires > 0) out.expirationDate = c.expires;
  const ss = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[c.sameSite];
  if (ss) out.sameSite = ss;
  return out;
}

/**
 * Etapa 1: Chrome NORMAL (sem flags de debug, senão o Google bloqueia o login). O usuário loga e fecha a janela.
 * Etapa 2: reabre o mesmo perfil (já logado) em modo headless com porta de debug só para ler os cookies.
 * @returns {Promise<number>} quantidade de cookies importados
 */
async function loginWithChrome({ userDataDir, session }) {
  const exe = findBrowser();
  if (!exe) throw new Error('Não encontrei o Google Chrome (nem o Edge) instalado neste PC.');

  const profile = path.join(userDataDir, 'chrome-login');
  fs.mkdirSync(profile, { recursive: true });

  // ---- Etapa 1: login manual ----
  await new Promise((resolve, reject) => {
    const child = spawn(
      exe,
      [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', LOGIN_URL],
      { stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await sleep(1500); // deixa o Chrome soltar o perfil

  // ---- Etapa 2: lê os cookies do perfil ----
  const port = 9222 + Math.floor(Math.random() * 500);
  const child = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let exited = false;
  child.on('exit', () => (exited = true));
  child.on('error', () => (exited = true));

  let client;
  try {
    let version;
    for (let i = 0; i < 40 && !version; i++) {
      if (exited) throw new Error('Não consegui abrir o Chrome para ler a sessão.');
      try { version = await getJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(500); }
    }
    if (!version) throw new Error('Não consegui conectar ao Chrome.');

    client = cdp(version.webSocketDebuggerUrl);
    await client.ready;
    const { cookies } = await client.send('Storage.getCookies');
    if (!cookies.some((c) => c.name === 'SAPISID' && /youtube\.com$/.test(c.domain))) {
      throw new Error('Não encontrei o login do YouTube. Entre na conta, abra o YouTube Music na janela do Chrome e só então feche a janela.');
    }

    const relevant = cookies.filter((c) => /(google|youtube)\.com$/.test(c.domain) && !c.partitionKey);
    let n = 0;
    for (const c of relevant) {
      try { await session.cookies.set(toElectronCookie(c)); n++; } catch { /* ignora cookie inválido */ }
    }
    await session.cookies.flushStore();
    try { await client.send('Browser.close'); } catch {}
    return n;
  } finally {
    client?.close();
    setTimeout(() => { try { child.kill(); } catch {} }, 3000);
  }
}

module.exports = { loginWithChrome };
