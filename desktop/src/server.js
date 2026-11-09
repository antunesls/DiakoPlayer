'use strict';
// Servidor HTTP + WebSocket. As rotas /api/v1/* seguem o plugin "API Server" do pear-desktop,
// então o controle web/APK também funciona com o pear-desktop, e vice-versa.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const API = '/api/v1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {(patch: object) => void} deps.setConfig
 * @param {(method: string, ...args: any[]) => Promise<any>} deps.rpc  chama o script injetado
 * @param {() => object|null} deps.getState  último estado conhecido do player
 * @param {(videoId: string) => void} deps.navigateToSong
 * @param {(id: string, address: string) => Promise<boolean>} deps.askApproval
 * @param {string} deps.webRoot
 * @param {string} deps.version
 * @param {ReturnType<import('./diakohub').createHub>} deps.hub  escala e repertório do DiakoHub
 * @param {(videoIds: string[]) => Promise<object>} deps.loadSetlist  monta a fila sem tocar
 */
function createServer(deps) {
  const { getConfig, setConfig, rpc, getState, navigateToSong, askApproval, webRoot, version, hub, loadSetlist } = deps;

  // ---------- autenticação (token = id.hmac) ----------
  const sign = (id) => {
    const mac = crypto.createHmac('sha256', getConfig().secret).update(id).digest('base64url');
    return `${Buffer.from(id).toString('base64url')}.${mac}`;
  };
  const verify = (token) => {
    if (!token) return false;
    const [idPart, mac] = String(token).split('.');
    if (!idPart || !mac) return false;
    const id = Buffer.from(idPart, 'base64url').toString();
    const expected = sign(id).split('.')[1];
    const ok =
      expected.length === mac.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
    return ok && getConfig().authorizedClients.includes(id);
  };
  const isLoopback = (addr) => /^(::1|127\.|::ffff:127\.)/.test(addr || '');
  const authorized = (req, token) =>
    !getConfig().authEnabled || isLoopback(req.socket.remoteAddress) || verify(token);

  const pendingApprovals = new Map();
  let approvalChain = Promise.resolve();
  function requestApproval(id, address) {
    if (pendingApprovals.has(id)) return pendingApprovals.get(id);
    // Um diálogo por vez no PC.
    const p = (approvalChain = approvalChain.then(() => askApproval(id, address)).catch(() => false));
    pendingApprovals.set(id, p);
    p.finally(() => pendingApprovals.delete(id));
    return p;
  }

  // ---------- utilidades HTTP ----------
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  };
  const send = (res, status, body) => {
    if (body === undefined || body === null) {
      res.writeHead(status, cors);
      return res.end();
    }
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
    res.end(data);
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1e6) {
          reject(new Error('payload grande demais'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('JSON inválido'));
        }
      });
      req.on('error', reject);
    });
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw Object.assign(new Error(`campo "${name}" deve ser número`), { status: 400 });
    return n;
  };

  // ---------- rotas ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/\{(\w+)\}/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    routes.push({ method, re, keys, handler });
  };
  const noContent = (fn) => async (ctx) => {
    await fn(ctx);
    return [204];
  };

  route('GET', `${API}/info`, () => [
    200,
    { app: 'diakoplayer', version, authEnabled: getConfig().authEnabled, features: ['play-song', 'culto', 'load-queue'] },
  ]);

  // ---------- extensões do DiakoPlayer: louvor do DiakoHub ----------
  route('GET', `${API}/culto`, async ({ query }) => {
    if (query.get('refresh') === '1') await hub.refresh();
    return [200, hub.culto()];
  });
  route('GET', `${API}/repertorio`, () => [200, { configured: hub.info().configured, musicas: hub.repertorio() }]);
  // Troca a fila pelas músicas indicadas, na ordem, e deixa a 1ª pronta e PAUSADA (alguém dá o play).
  route('POST', `${API}/queue/load`, async ({ body }) => {
    const ids = Array.isArray(body.videoIds) ? body.videoIds.map(String) : [];
    if (!ids.length || ids.length > 50 || !ids.every((id) => /^[\w-]{11}$/.test(id))) {
      throw Object.assign(new Error('videoIds deve ser uma lista de 1 a 50 IDs do YouTube'), { status: 400 });
    }
    return [200, await loadSetlist(ids)];
  });

  route('POST', `${API}/previous`, noContent(() => rpc('previous')));
  route('POST', `${API}/next`, noContent(() => rpc('next')));
  route('POST', `${API}/play`, noContent(() => rpc('play')));
  route('POST', `${API}/pause`, noContent(() => rpc('pause')));
  route('POST', `${API}/toggle-play`, noContent(() => rpc('togglePlay')));
  route('POST', `${API}/like`, noContent(() => rpc('setLike', 'LIKE')));
  route('POST', `${API}/dislike`, noContent(() => rpc('setLike', 'DISLIKE')));
  route('GET', `${API}/like-state`, async () => [200, { state: (await rpc('getState')).like ?? null }]);
  route('POST', `${API}/seek-to`, noContent(({ body }) => rpc('seekTo', num(body.seconds, 'seconds'))));
  route('POST', `${API}/go-back`, noContent(({ body }) => rpc('seekBy', -num(body.seconds, 'seconds'))));
  route('POST', `${API}/go-forward`, noContent(({ body }) => rpc('seekBy', num(body.seconds, 'seconds'))));
  route('GET', `${API}/shuffle`, async () => [200, { state: (await rpc('getState')).shuffle }]);
  route('POST', `${API}/shuffle`, noContent(() => rpc('shuffle')));
  route('GET', `${API}/repeat-mode`, async () => [200, { mode: (await rpc('getState')).repeat ?? null }]);
  route('POST', `${API}/switch-repeat`, noContent(({ body }) => rpc('switchRepeat', num(body.iteration ?? 1, 'iteration'))));
  route('GET', `${API}/volume`, async () => {
    const s = await rpc('getState');
    return [200, { state: s.volume, isMuted: s.muted }];
  });
  route('POST', `${API}/volume`, noContent(({ body }) => rpc('setVolume', num(body.volume, 'volume'))));
  route('POST', `${API}/toggle-mute`, noContent(() => rpc('toggleMute')));
  route('GET', `${API}/fullscreen`, async () => [200, { state: (await rpc('getState')).fullscreen }]);
  route('POST', `${API}/fullscreen`, noContent(({ body }) => rpc('setFullscreen', !!body.state)));

  const songInfo = async () => {
    const s = await rpc('getState');
    return s.song ? [200, s.song] : [204];
  };
  route('GET', `${API}/song`, songInfo);
  route('GET', `${API}/song-info`, songInfo);

  const queueInfo = async () => {
    const q = await rpc('getQueue');
    return q ? [200, q] : [204];
  };
  route('GET', `${API}/queue`, queueInfo);
  route('GET', `${API}/queue-info`, queueInfo);
  route('GET', `${API}/queue/next`, async () => {
    const q = await rpc('getQueue');
    const items = (q && q.items) || [];
    const renderer = (it) =>
      it.playlistPanelVideoRenderer ||
      (it.playlistPanelVideoWrapperRenderer && it.playlistPanelVideoWrapperRenderer.primaryRenderer.playlistPanelVideoRenderer);
    const cur = items.findIndex((it) => renderer(it)?.selected);
    const next = items[cur + 1] && renderer(items[cur + 1]);
    if (!next) return [204];
    return [
      200,
      {
        title: next.title?.runs?.[0]?.text,
        videoId: next.videoId,
        thumbnails: next.thumbnail?.thumbnails,
        lengthText: next.lengthText?.runs?.[0]?.text,
        shortBylineText: next.shortBylineText?.runs?.[0]?.text,
      },
    ];
  });
  route('POST', `${API}/queue`, noContent(({ body }) => {
    if (!body.videoId) throw Object.assign(new Error('videoId obrigatório'), { status: 400 });
    return rpc('addToQueue', String(body.videoId), body.insertPosition || 'INSERT_AT_END');
  }));
  route('PATCH', `${API}/queue/{index}`, noContent(({ params, body }) =>
    rpc('moveInQueue', num(params.index, 'index'), num(body.toIndex, 'toIndex'))));
  route('DELETE', `${API}/queue/{index}`, noContent(({ params }) => rpc('removeFromQueue', num(params.index, 'index'))));
  route('PATCH', `${API}/queue`, noContent(({ body }) => rpc('setQueueIndex', num(body.index, 'index'))));
  route('DELETE', `${API}/queue`, noContent(() => rpc('clearQueue')));
  route('POST', `${API}/search`, async ({ body }) => {
    if (!body.query && !body.continuation) throw Object.assign(new Error('query obrigatória'), { status: 400 });
    return [200, await rpc('search', String(body.query || ''), body.params, body.continuation)];
  });
  // Extensão do DiakoPlayer: tocar uma faixa agora.
  route('POST', `${API}/play-song`, noContent(async ({ body }) => {
    const id = String(body.videoId || '');
    if (!/^[\w-]{11}$/.test(id)) throw Object.assign(new Error('videoId inválido'), { status: 400 });
    const r = await rpc('playSong', id);
    if (r === 'navigate') navigateToSong(id);
  }));

  // Pareamento: o aparelho pede um token; o PC mostra um diálogo de aprovação.
  route('POST', '/auth/{id}', async ({ params, req }) => {
    const id = decodeURIComponent(params.id).slice(0, 128);
    const cfg = getConfig();
    const already = cfg.authorizedClients.includes(id);
    if (!already && cfg.authEnabled && !isLoopback(req.socket.remoteAddress)) {
      const ok = await requestApproval(id, req.socket.remoteAddress);
      if (!ok) return [403];
    }
    if (!getConfig().authorizedClients.includes(id)) {
      setConfig({ authorizedClients: [...getConfig().authorizedClients, id] });
    }
    return [200, { accessToken: sign(id) }];
  });

  // ---------- arquivos estáticos (controle web) ----------
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(webRoot, rel));
    if (!file.startsWith(path.normalize(webRoot))) return send(res, 403);
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'não encontrado' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204);

    const isApi = url.pathname.startsWith(API) || url.pathname.startsWith('/auth/');
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405);
      return serveStatic(req, res, url.pathname);
    }

    const match = routes
      .map((r) => ({ r, m: r.method === req.method && url.pathname.match(r.re) }))
      .find((x) => x.m);
    if (!match) return send(res, 404, { error: 'rota não encontrada' });

    const open = url.pathname === `${API}/info` || url.pathname.startsWith('/auth/');
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!open && !authorized(req, token)) return send(res, 401, { error: 'não autorizado' });

    try {
      const params = {};
      match.r.keys.forEach((k, i) => (params[k] = match.m[i + 1]));
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const [status, payload] = await match.r.handler({ req, params, body, query: url.searchParams });
      send(res, status, payload);
    } catch (e) {
      send(res, e.status || 500, { error: e.message || String(e) });
    }
  });

  // ---------- WebSocket (mesmo formato de mensagens do pear-desktop) ----------
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== `${API}/ws`) return socket.destroy();
    if (!authorized(req, url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = getState();
      ws.send(JSON.stringify({ type: 'PLAYER_INFO', ...playerInfo(s) }));
    });
  });

  const playerInfo = (s) => ({
    song: s?.song || undefined,
    isPlaying: !!s?.isPlaying,
    muted: !!s?.muted,
    position: Math.floor(s?.position || 0),
    volume: s?.volume ?? 100,
    repeat: s?.repeat || 'NONE',
    shuffle: !!s?.shuffle,
    like: s?.like || 'INDIFFERENT',
  });

  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, ...payload });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };

  /** Recebe o estado anterior e o novo do player e emite os eventos correspondentes. */
  function onStateChange(prev, next) {
    if (!wss.clients.size || !next) return;
    const pid = prev?.song?.videoId, nid = next.song?.videoId;
    if (pid !== nid || (next.song && prev?.song && next.song.title !== prev.song.title)) {
      broadcast('VIDEO_CHANGED', { song: next.song || undefined, position: Math.floor(next.position || 0) });
    }
    if (!!prev?.isPlaying !== !!next.isPlaying) {
      broadcast('PLAYER_STATE_CHANGED', { isPlaying: next.isPlaying, position: Math.floor(next.position || 0) });
    }
    if (Math.floor(prev?.position || 0) !== Math.floor(next.position || 0)) {
      broadcast('POSITION_CHANGED', { position: Math.floor(next.position || 0) });
    }
    if (prev?.volume !== next.volume || !!prev?.muted !== !!next.muted) {
      broadcast('VOLUME_CHANGED', { volume: next.volume, muted: next.muted });
    }
    if (prev?.repeat !== next.repeat) broadcast('REPEAT_CHANGED', { repeat: next.repeat });
    if (!!prev?.shuffle !== !!next.shuffle) broadcast('SHUFFLE_CHANGED', { shuffle: next.shuffle });
    if (prev?.like !== next.like) broadcast('LIKE_CHANGED', { like: next.like });
  }

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        const { port, hostname } = getConfig();
        server.once('error', reject);
        server.listen(port, hostname, () => resolve(port));
      }),
    close: () => {
      for (const c of wss.clients) c.terminate();
      server.close();
    },
    onStateChange,
    clientCount: () => wss.clients.size,
  };
}

module.exports = { createServer };
