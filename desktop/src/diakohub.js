'use strict';
// Integração com o DiakoHub (plataforma da igreja): lê a escala do louvor e o repertório para
// montar a fila. Só o PC fala com o DiakoHub; celulares e navegadores recebem os dados prontos.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const REFRESH_MS = 5 * 60 * 1000;
const MAX_CULTOS = 12;

/** Mesmo critério do DiakoHub (repertorio.dart › idVideoYoutube): só links HTTPS do YouTube. */
function videoIdDe(referencia) {
  let u;
  try {
    u = new URL(String(referencia || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const partes = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (u.hostname === 'youtu.be' && partes.length === 1) id = partes[0];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(u.hostname)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    if (partes.length === 2 && ['shorts', 'live', 'embed'].includes(partes[0])) id = partes[1];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** O primeiro tom anotado (ex.: "Em (Intro: C...)" → "Em"), como RepertorioMusica.tomPadrao. */
function tomPadrao(r) {
  if (!r) return '';
  if (typeof r.tomSelecionado === 'string') return r.tomSelecionado;
  const linha = String(r.tomDiakonia || '').split(/\r?\n/)[0];
  const m = linha.match(/(?:^|[^A-Za-z])([A-G](?:#|b)?m?)(?=$|[^A-Za-z#])/i);
  return m ? m[1] : '';
}

function normalizarUrl(url) {
  let s = String(url || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = (/^(\d+\.){3}\d+(:\d+)?$|^localhost/i.test(s) ? 'http://' : 'https://') + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const cifrar = (s) =>
  safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : '';
const decifrar = (s) => {
  try {
    return s ? safeStorage.decryptString(Buffer.from(s, 'base64')) : '';
  } catch {
    return '';
  }
};

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {(patch: object) => void} deps.setConfig
 */
function createHub({ getConfig, setConfig }) {
  const cacheFile = path.join(app.getPath('userData'), 'diakohub-cache.json');
  let cache = { cultos: [], repertorio: [], updatedAt: null };
  try {
    cache = { ...cache, ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) };
  } catch {}
  let lastError = null;
  let refreshing = null;
  let lastAttempt = 0;

  const cfg = () => getConfig().diakohub || {};
  const configured = () => !!(cfg().url && cfg().token);

  async function http(base, method, rota, { token, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(base + rota, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12000),
      });
    } catch (e) {
      throw Object.assign(new Error(`Não foi possível alcançar o DiakoHub (${e.cause?.code || e.name})`), { offline: true });
    }
    let dados = null;
    try {
      dados = await res.json();
    } catch {}
    if (!res.ok) {
      throw Object.assign(new Error(dados?.erro || dados?.error || `DiakoHub respondeu ${res.status}`), { status: res.status });
    }
    return dados;
  }

  /** Entra no DiakoHub e confere se o usuário pode ler as escalas. */
  async function connect({ url, usuario, senha }) {
    const base = normalizarUrl(url);
    if (!base) throw new Error('Endereço do DiakoHub inválido.');
    if (!usuario || !senha) throw new Error('Informe o usuário e a senha.');
    const { token } = await http(base, 'POST', '/api/login', { body: { usuario: usuario.trim(), senha } });
    const eu = await http(base, 'GET', '/api/eu', { token });
    if (!(eu.permissoes || []).includes('escalasVer')) {
      throw new Error(`O usuário "${usuario}" (perfil ${eu.perfilNome}) não pode ver as escalas. Use um usuário com o perfil DiakoPlayer.`);
    }
    setConfig({
      diakohub: { url: base, usuario: usuario.trim(), token, senha: cifrar(senha), perfil: eu.perfilNome || '' },
    });
    lastError = null;
    await refresh(true);
    return info();
  }

  function disconnect() {
    const c = cfg();
    if (c.url && c.token) http(c.url, 'POST', '/api/logout', { token: c.token }).catch(() => {});
    setConfig({ diakohub: { url: c.url || '', usuario: c.usuario || '' } });
    cache = { cultos: [], repertorio: [], updatedAt: null };
    try {
      fs.unlinkSync(cacheFile);
    } catch {}
    lastError = null;
    return info();
  }

  /** GET autenticado; com a sessão vencida, entra de novo com a senha guardada (cifrada) no PC. */
  async function get(rota) {
    const c = cfg();
    try {
      return await http(c.url, 'GET', rota, { token: c.token });
    } catch (e) {
      const senha = decifrar(c.senha);
      if (e.status !== 401 || !senha) throw e;
      const { token } = await http(c.url, 'POST', '/api/login', { body: { usuario: c.usuario, senha } });
      setConfig({ diakohub: { ...c, token } });
      return http(c.url, 'GET', rota, { token });
    }
  }

  function montar(escala, repertorio) {
    const porId = new Map(repertorio.map((r) => [r.id, r]));
    const cultos = (escala.cultos || []).slice(0, MAX_CULTOS).map((c) => ({
      id: c.id,
      data: c.data,
      hora: c.hora,
      rotulo: c.rotulo || c.data,
      horaTexto: c.horaTexto || c.hora,
      nome: c.nome || 'Culto',
      tema: c.tema || '',
      ceia: !!c.ceia,
      equipe: Object.entries(c.louvor || {})
        .map(([funcao, pessoas]) => ({ funcao, nomes: (pessoas || []).map((p) => p.nome).filter(Boolean) }))
        .filter((f) => f.nomes.length),
      musicas: (c.musicas || []).map((m, i) => {
        const r = porId.get(m.repertorioId);
        return {
          ordem: i + 1,
          titulo: r?.titulo || m.titulo || '(sem título)',
          cantor: r?.cantor || '',
          tom: m.tom || tomPadrao(r),
          bpm: r?.bpm || '',
          videoId: videoIdDe(r?.referencia),
          repertorioId: m.repertorioId || '',
        };
      }),
    }));
    const lista = repertorio
      .filter((r) => r.ativo !== false)
      .map((r) => ({
        id: r.id,
        titulo: r.titulo,
        cantor: r.cantor || '',
        tom: tomPadrao(r),
        bpm: r.bpm || '',
        videoId: videoIdDe(r.referencia),
      }))
      .sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
    return { cultos, repertorio: lista };
  }

  async function refresh(force = false) {
    if (!configured()) return;
    if (refreshing) return refreshing;
    if (!force && Date.now() - lastAttempt < 10000) return;
    lastAttempt = Date.now();
    refreshing = (async () => {
      try {
        const [escala, repertorio] = await Promise.all([get('/api/escalas/hoje?todos=1'), get('/api/repertorio')]);
        cache = { ...montar(escala || {}, Array.isArray(repertorio) ? repertorio : []), updatedAt: new Date().toISOString() };
        lastError = null;
        try {
          fs.writeFileSync(cacheFile, JSON.stringify(cache));
        } catch {}
      } catch (e) {
        lastError = e.message;
        console.error('[DiakoHub]', e.message);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function info() {
    const c = cfg();
    return {
      configured: configured(),
      url: c.url || '',
      usuario: c.usuario || '',
      perfil: c.perfil || '',
      senhaGuardada: !!c.senha,
      updatedAt: cache.updatedAt,
      error: lastError,
      cultos: cache.cultos.length,
      musicas: cache.repertorio.length,
    };
  }

  /** O que o controle recebe: os próximos cultos (já ligados ao repertório) e o estado da integração. */
  function culto() {
    const i = info();
    return {
      configured: i.configured,
      updatedAt: i.updatedAt,
      error: i.error,
      stale: !!i.error && !!i.updatedAt,
      cultos: i.configured ? cache.cultos : [],
    };
  }

  const repertorio = () => (configured() ? cache.repertorio : []);

  const timer = setInterval(() => refresh(), REFRESH_MS);
  timer.unref?.();
  refresh(true);

  return { connect, disconnect, refresh, info, culto, repertorio, stop: () => clearInterval(timer) };
}

module.exports = { createHub, videoIdDe, tomPadrao, normalizarUrl };
