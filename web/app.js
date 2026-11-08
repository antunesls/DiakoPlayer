/* DiakoPlayer — controle remoto (web e APK).
 * Fala com a API /api/v1 do DiakoPlayer desktop (compatível com o plugin API Server do pear-desktop).
 */
'use strict';

const $ = (id) => document.getElementById(id);
const isNative = typeof window.DiakoNative !== 'undefined';
const DEFAULT_PORT = 26538;

// ---------------- armazenamento local ----------------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`diako.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`diako.${key}`, JSON.stringify(value));
    } catch {}
  },
};

function clientId() {
  let id = store.get('clientId', null);
  if (!id) {
    const rand = Math.random().toString(36).slice(2, 8);
    const kind = isNative ? 'android' : /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'celular' : 'navegador';
    id = `diako-${kind}-${rand}`;
    store.set('clientId', id);
  }
  return id;
}

// ---------------- estado ----------------
const S = {
  conn: null, // {id, name, url}
  token: null,
  features: { diako: false, playSong: false },
  song: null,
  isPlaying: false,
  position: 0,
  posAt: performance.now(),
  volume: null,
  muted: false,
  repeat: 'NONE',
  shuffle: false,
  like: 'INDIFFERENT',
  online: false,
  ws: null,
  wsOk: false,
  wsRetry: 0,
  seeking: false,
  volTouchedAt: -1e9,
  queue: [],
  connectSeq: 0,
};

// ---------------- utilidades ----------------
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const bigThumb = (url, size = 544) =>
  url ? url.replace(/=w\d+-h\d+/, `=w${size}-h${size}`).replace(/=s\d+(?=[-&]|$)/, `=s${size}`) : '';
const runsText = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || '';
const lastThumb = (list) => (list && list.length ? list[list.length - 1].url : '');

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 4000 : 2200);
}

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const url = new URL(u);
    if (!url.port && url.protocol === 'http:') url.port = String(DEFAULT_PORT);
    return url.origin;
  } catch {
    return null;
  }
}

// ---------------- conexões salvas ----------------
const conns = () => store.get('conns', []);
const saveConns = (list) => store.set('conns', list);
const tokens = () => store.get('tokens', {});
function setToken(url, token) {
  const t = tokens();
  if (token) t[url] = token;
  else delete t[url];
  store.set('tokens', t);
}
function upsertConn(url, name) {
  const list = conns();
  let c = list.find((x) => x.url === url);
  if (!c) {
    c = { id: Math.random().toString(36).slice(2, 10), url, name: name || new URL(url).hostname };
    list.push(c);
  } else if (name) c.name = name;
  saveConns(list);
  return c;
}

// ---------------- HTTP ----------------
class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

async function api(method, path, body, opt = {}) {
  const conn = S.conn;
  if (!conn) throw new Error('Nenhum player conectado');
  const doFetch = () => {
    const headers = {};
    if (S.token) headers.Authorization = `Bearer ${S.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opt.timeout || 8000);
    return fetch(conn.url + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  };
  let res;
  try {
    res = await doFetch();
  } catch (e) {
    setOnline(false);
    throw new Error(e.name === 'AbortError' ? 'O player demorou a responder' : 'Não foi possível alcançar o PC');
  }
  if ((res.status === 401 || res.status === 403) && !opt.noAuth && conn === S.conn) {
    await authorize();
    res = await doFetch();
  }
  setOnline(true);
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {}
    throw new HttpError(res.status, msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : null;
}

let authPromise = null;
let authAbort = null;
function authorize() {
  if (authPromise) return authPromise;
  const conn = S.conn;
  $('authOverlay').hidden = false;
  authAbort = new AbortController();
  authPromise = fetch(`${conn.url}/auth/${encodeURIComponent(clientId())}`, {
    method: 'POST',
    signal: authAbort.signal,
  })
    .then(async (res) => {
      if (res.status === 403) throw new Error('Acesso recusado no PC');
      if (!res.ok) throw new Error(`Falha na autorização (${res.status})`);
      const { accessToken } = await res.json();
      S.token = accessToken;
      setToken(conn.url, accessToken);
      toast('Aparelho autorizado ✓');
      if (S.conn === conn) openSocket();
    })
    .catch((e) => {
      if (e.name === 'AbortError') throw new Error('Autorização cancelada');
      throw e;
    })
    .finally(() => {
      $('authOverlay').hidden = true;
      authPromise = null;
    });
  return authPromise;
}

// ---------------- conexão ----------------
function setOnline(on) {
  if (S.online === on) return;
  S.online = on;
  renderConn();
}

function renderConn() {
  const dot = $('connDot');
  dot.className = 'dot ' + (!S.conn ? '' : S.online ? (S.wsOk ? 'ok' : 'warn') : 'err');
  $('connName').textContent = S.conn ? S.conn.name : 'Sem conexão';
  $('connBtn').classList.toggle('ok', !!S.conn && S.online);
  $('liveTag').hidden = !(S.conn && S.online && S.isPlaying);
  $('connBtn').title = S.conn ? `${S.conn.url} — ${S.online ? (S.wsOk ? 'tempo real' : 'conectado') : 'sem resposta'}` : '';
}

async function connect(conn) {
  const seq = ++S.connectSeq;
  closeSocket();
  Object.assign(S, { conn, token: tokens()[conn.url] || null, song: null, online: false, queue: [], volume: null });
  store.set('active', conn.id);
  renderConn();
  render();
  // Descobre se é um DiakoPlayer (endpoints extras) ou um pear-desktop.
  try {
    const info = await api('GET', '/api/v1/info', undefined, { noAuth: true, timeout: 4000 });
    S.features = { diako: info?.app === 'diakoplayer', playSong: (info?.features || []).includes('play-song') };
  } catch {
    S.features = { diako: false, playSong: false };
  }
  if (seq !== S.connectSeq) return;
  try {
    await refreshSong();
    await refreshExtras();
    openSocket();
    loadQueue(true);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------- WebSocket ----------------
function closeSocket() {
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
  }
  S.ws = null;
  S.wsOk = false;
}

function openSocket() {
  closeSocket();
  if (!S.conn) return;
  const conn = S.conn;
  const url = `${conn.url.replace(/^http/, 'ws')}/api/v1/ws${S.token ? `?token=${encodeURIComponent(S.token)}` : ''}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }
  S.ws = ws;
  ws.onopen = () => {
    S.wsOk = true;
    S.wsRetry = 0;
    renderConn();
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(m);
  };
  ws.onclose = () => {
    S.wsOk = false;
    renderConn();
    if (S.conn !== conn) return;
    const delay = Math.min(15000, 1000 * 2 ** S.wsRetry++);
    setTimeout(() => {
      if (S.conn === conn && !S.wsOk) openSocket();
    }, delay);
  };
}

function setPosition(p) {
  S.position = Number(p) || 0;
  S.posAt = performance.now();
}

function handleEvent(m) {
  switch (m.type) {
    case 'PLAYER_INFO':
      if (m.song !== undefined) applySong(m.song || null);
      S.isPlaying = !!m.isPlaying;
      setPosition(m.position);
      applyVolume(m.volume, m.muted);
      if (m.repeat) S.repeat = m.repeat;
      S.shuffle = !!m.shuffle;
      if (m.like) S.like = m.like;
      break;
    case 'VIDEO_CHANGED':
      applySong(m.song || null);
      setPosition(m.position || 0);
      if (!S.features.diako) refreshExtras();
      loadQueue(true);
      break;
    case 'PLAYER_STATE_CHANGED':
      S.isPlaying = !!m.isPlaying;
      setPosition(m.position);
      break;
    case 'POSITION_CHANGED':
      if (!S.seeking) setPosition(m.position);
      break;
    case 'VOLUME_CHANGED':
      applyVolume(m.volume, m.muted);
      break;
    case 'REPEAT_CHANGED':
      S.repeat = m.repeat || 'NONE';
      break;
    case 'SHUFFLE_CHANGED':
      S.shuffle = !!m.shuffle;
      break;
    case 'LIKE_CHANGED':
      S.like = m.like || 'INDIFFERENT';
      break;
  }
  render();
}

function applySong(song) {
  const changed = (S.song?.videoId || null) !== (song?.videoId || null);
  // O pear-desktop às vezes omite imageSrc no GET; mantém a capa já conhecida.
  if (song && !song.imageSrc && S.song?.videoId === song.videoId) song.imageSrc = S.song.imageSrc;
  S.song = song;
  if (song) {
    S.isPlaying = !song.isPaused;
    if (!S.seeking && song.elapsedSeconds !== undefined) setPosition(song.elapsedSeconds);
  } else {
    S.isPlaying = false;
  }
  return changed;
}

function applyVolume(volume, muted) {
  if (muted !== undefined) S.muted = !!muted;
  // O slider é "dono" do valor por alguns segundos após o toque (evita pulos).
  if (volume !== undefined && volume !== null && performance.now() - S.volTouchedAt > 3000) S.volume = volume;
}

// ---------------- polling (fallback e complemento do WebSocket) ----------------
async function refreshSong() {
  const song = await api('GET', '/api/v1/song');
  if (applySong(song || null) && !S.features.diako) refreshExtras();
  render();
}

async function refreshExtras() {
  const [like, vol, rep, shuf] = await Promise.allSettled([
    api('GET', '/api/v1/like-state'),
    api('GET', '/api/v1/volume'),
    api('GET', '/api/v1/repeat-mode'),
    api('GET', '/api/v1/shuffle'),
  ]);
  if (like.value) S.like = like.value.state || 'INDIFFERENT';
  if (vol.value) applyVolume(vol.value.state, vol.value.isMuted);
  if (rep.value) S.repeat = rep.value.mode || 'NONE';
  if (shuf.value) S.shuffle = !!shuf.value.state;
  render();
}

let pollTick = 0;
async function pollLoop() {
  pollTick++;
  if (S.conn && !authPromise && document.visibilityState === 'visible') {
    try {
      if (!S.wsOk || pollTick % 5 === 0) await refreshSong();
      if (!S.features.diako && pollTick % 6 === 0) await refreshExtras();
    } catch {}
  }
  setTimeout(pollLoop, 1000);
}

// ---------------- renderização ----------------
let lastArt = null;
function render() {
  const s = S.song;
  document.body.classList.toggle('has-song', !!s);
  $('title').textContent = s ? s.title : S.conn ? 'Nada tocando' : 'Sem conexão';
  $('artist').textContent = s
    ? [s.isAd ? 'Anúncio tocando…' : '', s.artist, s.album].filter(Boolean).join(' • ')
    : S.conn
      ? 'Escolha uma música no PC ou busque aqui'
      : 'Toque em "Sem conexão" para escolher o PC';
  document.title = s ? `${s.isPaused === false || S.isPlaying ? '▶' : '❚❚'} ${s.title} — DiakoPlayer` : 'DiakoPlayer';

  const art = s ? bigThumb(s.imageSrc, 144) : '';
  if (art !== lastArt) {
    lastArt = art;
    $('art').hidden = !art;
    $('artEmpty').hidden = !!art;
    if (art) $('art').src = art;
  }
  $('nowLabel').textContent = !s ? 'PLAYER' : s.isAd ? 'ANÚNCIO' : S.isPlaying ? 'TOCANDO AGORA' : 'PAUSADO';

  $('playIcon').setAttribute('href', S.isPlaying ? '#i-pause' : '#i-play');
  $('playLabel').textContent = S.isPlaying ? 'PAUSAR' : 'TOCAR';
  $('playBtn').setAttribute('aria-label', S.isPlaying ? 'Pausar' : 'Tocar');
  $('likeBtn').classList.toggle('on', S.like === 'LIKE');
  $('dislikeBtn').classList.toggle('on', S.like === 'DISLIKE');
  $('shuffleBtn').classList.toggle('on', S.shuffle);
  $('repeatBtn').classList.toggle('on', S.repeat !== 'NONE');
  $('repeatIcon').setAttribute('href', S.repeat === 'ONE' ? '#i-repeat1' : '#i-repeat');
  $('repeatLabel').textContent = { NONE: 'Repetir', ALL: 'Repetir todas', ONE: 'Repetir uma' }[S.repeat] || 'Repetir';
  $('muteBtn').classList.toggle('on', S.muted);
  $('muteLabel').textContent = S.muted ? 'Som de volta' : 'Silenciar';
  $('fadeBtn').classList.toggle('on', !!fadeJob);
  $('fadeLabel').textContent = fadeJob ? 'Cancelar' : 'Baixar aos poucos';

  const vol = S.volume;
  $('volVal').textContent = vol === null ? '–' : S.muted ? 'MUDO' : `${Math.round(vol)}%`;
  const lit = vol === null ? 0 : Math.round(vol / 10);
  $('volBar').querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i < lit));
  $('volBar').classList.toggle('muted', S.muted);

  const dur = s ? s.songDuration || 0 : 0;
  $('seek').max = Math.max(1, dur);
  tickProgress();
  renderConn();
  markCurrentInQueue();
  renderUpNext();
}

let upNextKey = '';
function renderUpNext() {
  const id = S.song?.videoId;
  let cur = S.queue.findIndex((q) => q.videoId === id);
  if (cur < 0) cur = S.queue.findIndex((q) => q.selected);
  const next = cur >= 0 ? S.queue.slice(cur + 1, cur + 3) : [];
  const key = next.map((q) => q.index + q.videoId).join('|') + (S.conn ? '1' : '0');
  if (key === upNextKey) return;
  upNextKey = key;
  const list = $('upNextList');
  list.textContent = '';
  if (!next.length) {
    list.append(el('li', 'none', S.conn ? 'Nada na fila depois desta.' : 'Conecte-se a um player.'));
    return;
  }
  for (const q of next) {
    const li = el('li');
    li.append(el('span', '', q.title), el('span', '', q.length || ''));
    li.title = 'Tocar esta agora';
    li.addEventListener('click', () => jumpQueue(q.index));
    list.append(li);
  }
}

function currentPosition() {
  const dur = S.song?.songDuration || 0;
  let p = S.position + (S.isPlaying ? (performance.now() - S.posAt) / 1000 : 0);
  if (dur) p = Math.min(p, dur);
  return p;
}

function tickProgress() {
  if (S.seeking) return;
  const p = S.song ? currentPosition() : 0;
  $('seek').value = p;
  $('cur').textContent = fmt(p);
  $('remain').textContent = `−${fmt((S.song?.songDuration || 0) - p)}`;
  paintRange($('seek'));
}

function paintRange(el) {
  const max = Number(el.max) || 100;
  el.style.setProperty('--pct', `${(Number(el.value) / max) * 100}%`);
}

// ---------------- ações ----------------
const post = (path, body) => api('POST', path, body);

async function action(name) {
  if (!S.conn) return openSettings();
  try {
    switch (name) {
      case 'toggle':
        S.isPlaying = !S.isPlaying;
        setPosition(currentPosition());
        render();
        await post('/api/v1/toggle-play');
        break;
      case 'next':
        await post('/api/v1/next');
        break;
      case 'prev':
        await post('/api/v1/previous');
        break;
      case 'back10':
        setPosition(Math.max(0, currentPosition() - 10));
        render();
        await post('/api/v1/go-back', { seconds: 10 });
        break;
      case 'fwd10':
        setPosition(currentPosition() + 10);
        render();
        await post('/api/v1/go-forward', { seconds: 10 });
        break;
      case 'like':
        S.like = S.like === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
        render();
        await post('/api/v1/like');
        break;
      case 'dislike':
        S.like = S.like === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE';
        render();
        await post('/api/v1/dislike');
        break;
      case 'shuffle':
        S.shuffle = !S.shuffle;
        render();
        await post('/api/v1/shuffle');
        setTimeout(() => loadQueue(true), 600);
        break;
      case 'repeat':
        S.repeat = { NONE: 'ALL', ALL: 'ONE', ONE: 'NONE' }[S.repeat] || 'ALL';
        render();
        await post('/api/v1/switch-repeat', { iteration: 1 });
        break;
      case 'mute':
        S.muted = !S.muted;
        render();
        await post('/api/v1/toggle-mute');
        break;
      case 'fade':
        await fadeOut();
        break;
    }
  } catch (e) {
    toast(e.message, true);
  }
}

let volTimer = null;
function setVolume(v, immediate = false) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  S.volume = v;
  S.volTouchedAt = performance.now();
  render();
  clearTimeout(volTimer);
  volTimer = setTimeout(() => post('/api/v1/volume', { volume: v }).catch((e) => toast(e.message, true)), immediate ? 0 : 120);
}

// Chamado pelo app Android ao apertar os botões físicos de volume.
window.diakoVolumeStep = (dir) => {
  if (!S.conn) return;
  setVolume((S.volume ?? 50) + (dir > 0 ? 5 : -5));
  toast(`Volume do PC: ${S.volume}%`);
};

// "Baixar aos poucos": reduz o volume até zero, pausa e devolve o volume original
// (assim a próxima música começa no nível normal). Apertar de novo cancela.
let fadeJob = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fadeOut() {
  if (fadeJob) {
    fadeJob.cancel = true;
    return;
  }
  if (!S.isPlaying) return toast('Nada tocando agora');
  const job = (fadeJob = { cancel: false });
  const start = S.volume ?? 50;
  const secs = Number(store.get('fadeSecs', 5)) || 5;
  const steps = Math.max(8, secs * 5);
  render();
  try {
    for (let i = 1; i <= steps && !job.cancel; i++) {
      await sleep((secs * 1000) / steps);
      if (job.cancel) break;
      S.volume = Math.round(start * (1 - i / steps));
      S.volTouchedAt = performance.now();
      render();
      await post('/api/v1/volume', { volume: S.volume }).catch(() => {});
    }
    if (!job.cancel) {
      await post('/api/v1/pause');
      S.isPlaying = false;
    }
  } finally {
    await post('/api/v1/volume', { volume: start }).catch(() => {});
    S.volume = start;
    S.volTouchedAt = performance.now();
    fadeJob = null;
    render();
    toast(job.cancel ? 'Cancelado: volume de volta' : `Pausado. Volume voltou para ${start}%`);
  }
}

async function playNow(videoId) {
  try {
    if (S.features.playSong) {
      await post('/api/v1/play-song', { videoId });
    } else {
      await post('/api/v1/queue', { videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' });
      await new Promise((r) => setTimeout(r, 700));
      await post('/api/v1/next');
    }
    toast('Tocando agora');
    setTimeout(() => loadQueue(true), 1200);
  } catch (e) {
    toast(e.message, true);
  }
}

async function enqueue(videoId, position) {
  try {
    await post('/api/v1/queue', { videoId, insertPosition: position });
    toast(position === 'INSERT_AFTER_CURRENT_VIDEO' ? 'Vai tocar a seguir' : 'Adicionada ao fim da fila');
    setTimeout(() => loadQueue(true), 800);
  } catch (e) {
    toast(e.message.includes('Fila indisponível') ? 'Comece a tocar algo antes de montar a fila' : e.message, true);
  }
}

// ---------------- fila ----------------
function parseQueueItem(it, index) {
  const r =
    it.playlistPanelVideoRenderer ||
    it.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
  if (!r) return null;
  return {
    index,
    videoId: r.videoId,
    title: runsText(r.title),
    artist: runsText(r.shortBylineText) || runsText(r.longBylineText),
    length: runsText(r.lengthText),
    thumb: bigThumb(lastThumb(r.thumbnail?.thumbnails), 120),
    selected: !!r.selected,
  };
}

let queueLoading = false;
async function loadQueue(quiet = false) {
  if (!S.conn || queueLoading) return;
  queueLoading = true;
  try {
    const q = await api('GET', '/api/v1/queue', undefined, { timeout: 12000 });
    S.queue = ((q && q.items) || []).map(parseQueueItem).filter(Boolean);
    renderQueue();
  } catch (e) {
    if (!quiet) toast(e.message, true);
  } finally {
    queueLoading = false;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function iconBtn(icon, title, onClick) {
  const b = el('button', 'icon-btn');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
function thumbImg(src) {
  const img = el('img', 'thumb');
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  if (src) img.src = src;
  return img;
}

function renderQueue() {
  renderUpNext();
  const list = $('queueList');
  list.textContent = '';
  const cur = S.queue.findIndex((q) => q.selected);
  $('queueInfo').textContent = S.queue.length
    ? `${S.queue.length} NA FILA${cur >= 0 ? ` · ${cur + 1}ª TOCANDO` : ''}`
    : 'FILA';
  if (!S.queue.length) {
    list.append(el('li', 'empty', S.conn ? 'A fila está vazia.' : 'Conecte-se a um player.'));
    return;
  }
  for (const q of S.queue) {
    const li = el('li', 'item' + (q.selected ? ' current' : ''));
    li.dataset.index = q.index;
    li.dataset.videoId = q.videoId;
    const text = el('div', 'item-text');
    text.append(el('div', 'item-title', q.title), el('div', 'item-sub', [q.artist, q.length].filter(Boolean).join(' • ')));
    const actions = el('div', 'item-actions');
    actions.append(
      iconBtn('i-up', 'Subir', () => moveQueue(q.index, q.index - 1)),
      iconBtn('i-down', 'Descer', () => moveQueue(q.index, q.index + 1)),
      iconBtn('i-close', 'Remover', () => removeQueue(q.index)),
    );
    li.append(thumbImg(q.thumb), text, actions);
    li.addEventListener('click', () => jumpQueue(q.index));
    list.append(li);
  }
  const current = list.querySelector('.current');
  if (current && !list.dataset.scrolled) {
    current.scrollIntoView({ block: 'center' });
    list.dataset.scrolled = '1';
  }
}

function markCurrentInQueue() {
  const id = S.song?.videoId;
  const list = $('queueList');
  const items = list.querySelectorAll('.item');
  if (!id || !items.length) return;
  const current = list.querySelector('.current');
  if (current?.dataset.videoId === id) return;
  items.forEach((li) => li.classList.toggle('current', li.dataset.videoId === id));
}

async function jumpQueue(index) {
  try {
    await api('PATCH', '/api/v1/queue', { index });
    setTimeout(() => loadQueue(true), 700);
  } catch (e) {
    toast(e.message, true);
  }
}
async function moveQueue(from, to) {
  if (to < 0 || to >= S.queue.length) return;
  try {
    await api('PATCH', `/api/v1/queue/${from}`, { toIndex: to });
    const [item] = S.queue.splice(from, 1);
    S.queue.splice(to, 0, item);
    S.queue.forEach((q, i) => (q.index = i));
    renderQueue();
  } catch (e) {
    toast(e.message, true);
  }
}
async function removeQueue(index) {
  try {
    await api('DELETE', `/api/v1/queue/${index}`);
    S.queue.splice(index, 1);
    S.queue.forEach((q, i) => (q.index = i));
    renderQueue();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------- busca ----------------
function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  visit(node);
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit, depth + 1));
  else for (const k in node) walk(node[k], visit, depth + 1);
}

function parseSearch(res) {
  const out = [];
  const seen = new Set();
  const add = (r) => {
    if (r.videoId && !seen.has(r.videoId)) {
      seen.add(r.videoId);
      out.push(r);
    }
  };
  walk(res, (n) => {
    const card = n.musicCardShelfRenderer;
    if (card) {
      const vid =
        card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
        card.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
          ?.watchEndpoint?.videoId;
      add({
        videoId: vid,
        title: runsText(card.title),
        sub: runsText(card.subtitle),
        thumb: bigThumb(lastThumb(card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails), 120),
        top: true,
      });
    }
    const r = n.musicResponsiveListItemRenderer;
    if (r) {
      const vid =
        r.playlistItemData?.videoId ||
        r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
          ?.watchEndpoint?.videoId;
      const cols = (r.flexColumns || []).map((c) => runsText(c.musicResponsiveListItemFlexColumnRenderer?.text));
      add({
        videoId: vid,
        title: cols[0] || '',
        sub: cols.slice(1).filter(Boolean).join(' • '),
        thumb: bigThumb(lastThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails), 120),
      });
    }
  });
  return out;
}

function extractVideoId(q) {
  const s = q.trim();
  const m =
    s.match(/[?&]v=([\w-]{11})/) || s.match(/youtu\.be\/([\w-]{11})/) || s.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(s) && /\d|[A-Z].*[a-z]|-|_/.test(s) && !/\s/.test(s) ? s : null;
}

async function search(q) {
  const list = $('searchList');
  if (!S.conn) return openSettings();
  const direct = extractVideoId(q);
  list.textContent = '';
  if (direct) {
    renderResults([{ videoId: direct, title: 'Vídeo do link', sub: direct, thumb: `https://i.ytimg.com/vi/${direct}/mqdefault.jpg` }]);
    return;
  }
  list.append(el('li', 'empty', 'Buscando…'));
  try {
    const res = await api('POST', '/api/v1/search', { query: q }, { timeout: 15000 });
    const items = parseSearch(res);
    renderResults(items);
  } catch (e) {
    list.textContent = '';
    list.append(el('li', 'empty', e.message));
  }
}

function renderResults(items) {
  const list = $('searchList');
  list.textContent = '';
  if (!items.length) {
    list.append(el('li', 'empty', 'Nenhuma música encontrada.'));
    return;
  }
  for (const it of items) {
    const li = el('li', 'item');
    const text = el('div', 'item-text');
    text.append(el('div', 'item-title', it.title), el('div', 'item-sub', it.sub));
    const actions = el('div', 'item-actions');
    actions.append(
      iconBtn('i-playnext', 'Tocar a seguir', () => enqueue(it.videoId, 'INSERT_AFTER_CURRENT_VIDEO')),
      iconBtn('i-add', 'Adicionar ao fim da fila', () => enqueue(it.videoId, 'INSERT_AT_END')),
    );
    li.append(thumbImg(it.thumb), text, actions);
    li.title = 'Tocar agora';
    li.addEventListener('click', () => playNow(it.videoId));
    list.append(li);
  }
}

// ---------------- configurações ----------------
function openSettings() {
  renderConnList();
  $('discoverSec').hidden = !isNative;
  $('clientIdHint').textContent = `ID deste aparelho: ${clientId()}`;
  $('keepAwake').checked = store.get('keepAwake', false);
  if (!$('settings').open) $('settings').showModal();
  if (isNative && !discovered.length) discover();
}

function connRow(c, { active, onClick, onRemove, sub }) {
  const li = el('li', 'conn-item' + (active ? ' active' : ''));
  const text = el('div', 'item-text');
  text.append(el('div', 'item-title', c.name), el('div', 'item-sub', sub || c.url));
  li.append(text);
  if (onRemove) li.append(iconBtn('i-trash', 'Remover', onRemove));
  li.addEventListener('click', onClick);
  return li;
}

function renderConnList() {
  const list = $('connList');
  list.textContent = '';
  const all = conns();
  if (!all.length) list.append(el('li', 'hint', 'Nenhum player salvo ainda.'));
  for (const c of all) {
    list.append(
      connRow(c, {
        active: S.conn?.id === c.id,
        onClick: () => {
          $('settings').close();
          connect(c);
        },
        onRemove: () => {
          saveConns(conns().filter((x) => x.id !== c.id));
          setToken(c.url, null);
          if (S.conn?.id === c.id) {
            closeSocket();
            S.conn = null;
            S.song = null;
            render();
          }
          renderConnList();
        },
      }),
    );
  }
}

// Descoberta (somente no app Android, via UDP nativo).
let discovered = [];
function discover() {
  if (!isNative) return;
  $('discoverList').textContent = '';
  $('discoverList').append(el('li', 'hint', 'Procurando na rede Wi-Fi…'));
  try {
    window.DiakoNative.discover();
  } catch {}
}
window.onDiakoDiscovered = (json) => {
  try {
    discovered = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    discovered = [];
  }
  const list = $('discoverList');
  list.textContent = '';
  if (!discovered.length) {
    list.append(el('li', 'hint', 'Nenhum PC encontrado. Confira se o DiakoPlayer está aberto e no mesmo Wi-Fi.'));
    return;
  }
  for (const d of discovered) {
    const url = `http://${d.host}:${d.port}`;
    list.append(
      connRow(
        { name: d.name, url },
        {
          active: S.conn?.url === url,
          sub: `${url} · v${d.version || '?'}`,
          onClick: () => {
            const c = upsertConn(url, d.name);
            $('settings').close();
            connect(c);
          },
        },
      ),
    );
  }
  // Primeira vez e só um PC: conecta direto.
  if (!S.conn && discovered.length === 1) {
    const d = discovered[0];
    const c = upsertConn(`http://${d.host}:${d.port}`, d.name);
    if ($('settings').open) $('settings').close();
    connect(c);
  }
};

function applyKeepAwake(on) {
  store.set('keepAwake', on);
  if (isNative) {
    try {
      window.DiakoNative.keepScreenOn(on);
    } catch {}
  } else if ('wakeLock' in navigator && on) {
    navigator.wakeLock.request('screen').catch(() => {});
  }
}

// ---------------- abas ----------------
function setTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.tab === tab || (tab === 'player' && b.dataset.tab === 'queue' && b.classList.contains('ptab')));
  });
  if (tab === 'queue') loadQueue(true);
  if (tab === 'search') setTimeout(() => $('searchInput').focus(), 50);
}

// ---------------- eventos ----------------
function bind() {
  document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => action(b.dataset.action)));
  document.querySelectorAll('button[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  const seek = $('seek');
  seek.addEventListener('input', () => {
    S.seeking = true;
    $('cur').textContent = fmt(seek.value);
    paintRange(seek);
  });
  seek.addEventListener('change', async () => {
    const t = Number(seek.value);
    setPosition(t);
    S.seeking = false;
    try {
      await post('/api/v1/seek-to', { seconds: t });
    } catch (e) {
      toast(e.message, true);
    }
  });

  const bar = $('volBar');
  for (let i = 1; i <= 10; i++) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Volume ${i * 10}%`);
    b.addEventListener('click', () => setVolume(i * 10));
    bar.append(b);
  }
  $('volDown').addEventListener('click', () => setVolume((S.volume ?? 50) - 5));
  $('volUp').addEventListener('click', () => setVolume((S.volume ?? 50) + 5));
  document.querySelector('.volume').addEventListener('wheel', (e) => {
    e.preventDefault();
    setVolume((S.volume ?? 50) + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });
  $('fadeSecs').value = String(store.get('fadeSecs', 5));
  $('fadeSecs').addEventListener('change', (e) => store.set('fadeSecs', Number(e.target.value)));

  $('queueRefresh').addEventListener('click', () => loadQueue());
  $('queueClear').addEventListener('click', async () => {
    if (!confirm('Limpar toda a fila do player?')) return;
    try {
      await api('DELETE', '/api/v1/queue');
      S.queue = [];
      renderQueue();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    if (q) search(q);
    $('searchInput').blur();
  });

  $('settingsBtn').addEventListener('click', openSettings);
  $('connBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', () => $('settings').close());
  $('discoverBtn').addEventListener('click', discover);
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = normalizeUrl($('addUrl').value);
    if (!url) return toast('Endereço inválido', true);
    const c = upsertConn(url, $('addName').value.trim() || undefined);
    $('addUrl').value = '';
    $('addName').value = '';
    $('settings').close();
    connect(c);
  });
  $('forgetToken').addEventListener('click', () => {
    if (!S.conn) return;
    setToken(S.conn.url, null);
    S.token = null;
    $('settings').close();
    authorize().then(() => refreshSong()).catch((e) => toast(e.message, true));
  });
  $('keepAwake').addEventListener('change', (e) => applyKeepAwake(e.target.checked));
  $('authCancel').addEventListener('click', () => authAbort?.abort());

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') && e.target.type !== 'range') return;
    if ($('settings').open || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const map = { ' ': 'toggle', k: 'toggle', n: 'next', p: 'prev', l: 'like', d: 'dislike', s: 'shuffle', r: 'repeat', m: 'mute', f: 'fade', arrowleft: 'back10', arrowright: 'fwd10' };
    if (map[k]) {
      e.preventDefault();
      action(map[k]);
    } else if (k === 'arrowup' || k === 'arrowdown') {
      e.preventDefault();
      setVolume((S.volume ?? 50) + (k === 'arrowup' ? 5 : -5));
    } else if (k === '/') {
      e.preventDefault();
      setTab('search');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.conn) {
      if (!S.wsOk) openSocket();
      refreshSong().catch(() => {});
      if (store.get('keepAwake', false)) applyKeepAwake(true);
    }
  });
}

// ---------------- inicialização ----------------
async function boot() {
  bind();
  setTab('player');
  render();
  setInterval(tickProgress, 250);
  pollLoop();
  if (store.get('keepAwake', false)) applyKeepAwake(true);

  // Página servida pelo próprio DiakoPlayer? Conecta nele automaticamente.
  let served = null;
  if (/^https?:$/.test(location.protocol) && location.hostname !== 'app.diakoplayer') {
    try {
      const r = await fetch(`${location.origin}/api/v1/info`, { cache: 'no-store' });
      const info = r.ok ? await r.json() : null;
      if (info?.app === 'diakoplayer') {
        const name = /^(localhost|127\.)/.test(location.hostname) ? 'Este PC' : `PC ${location.hostname}`;
        served = upsertConn(location.origin, conns().find((c) => c.url === location.origin)?.name || name);
      }
    } catch {}
  }

  const active = conns().find((c) => c.id === store.get('active', null));
  const target = served || active;
  if (target) connect(target);
  else openSettings();
}

boot();
