// Executado no "mundo principal" da página do YouTube Music (acesso aos elementos Polymer).
// Lógica de controle portada do pear-desktop (src/renderer.ts e providers/song-info-front.ts).
(() => {
  if (window.__diakoInjected) return;
  window.__diakoInjected = true;

  const bridge = window.diakoBridge;
  if (!bridge) return;

  const $ = (s) => document.querySelector(s);
  const playerBar = () => $('ytmusic-player-bar');
  const api = () => $('#movie_player');
  const video = () => $('video');
  const queueEl = () => $('#queue');
  const appEl = () => $('ytmusic-app');

  const MEDIA_TYPES = {
    MUSIC_VIDEO_TYPE_ATV: 'AUDIO',
    MUSIC_VIDEO_TYPE_OMV: 'ORIGINAL_MUSIC_VIDEO',
    MUSIC_VIDEO_TYPE_UGC: 'USER_GENERATED_CONTENT',
    MUSIC_VIDEO_TYPE_PODCAST_EPISODE: 'PODCAST_EPISODE',
  };

  const safe = (fn, fallback = null) => {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };

  const bigThumb = (url) =>
    url ? url.replace(/=w\d+-h\d+/, '=w544-h544').replace(/=s\d+/, '=s544') : url;

  const isAdShowing = () => {
    const p = api();
    return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  };

  function getSong() {
    const v = video();
    const p = api();
    const vd = safe(() => p.getVideoData(), {}) || {};
    const pr = safe(() => p.getPlayerResponse(), {}) || {};
    const det = pr.videoDetails || {};
    const videoId = vd.video_id || det.videoId;
    if (!videoId) return null;

    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    // A metadata do MediaSession pode estar atrasada logo após a troca de faixa.
    const mdFresh = md && !isAdShowing() && (md.title === det.title || md.title === vd.title);
    const artwork = mdFresh && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : null;
    const thumbs = (det.thumbnail && det.thumbnail.thumbnails) || [];

    const ad = isAdShowing();
    const duration =
      !ad && v && isFinite(v.duration) ? Math.round(v.duration) : Number(det.lengthSeconds) || 0;
    return {
      isAd: ad,
      title: (mdFresh && md.title) || det.title || vd.title || '',
      artist: (mdFresh && md.artist) || det.author || vd.author || '',
      album: (mdFresh && md.album) || null,
      views: Number(det.viewCount) || 0,
      imageSrc: bigThumb(artwork || (thumbs.length ? thumbs[thumbs.length - 1].url : null)),
      isPaused: v ? v.paused : true,
      songDuration: duration,
      elapsedSeconds: v && !ad ? Math.floor(v.currentTime) : 0,
      url: `https://music.youtube.com/watch?v=${videoId}`,
      videoId,
      playlistId: vd.list || '',
      mediaType: MEDIA_TYPES[det.musicVideoType] || 'OTHER_VIDEO',
    };
  }

  function getRepeat() {
    const fromState = (el) => safe(() => el.getState().queue.repeatMode);
    return (
      fromState(playerBar()) ||
      fromState(appEl()) ||
      safe(() => queueEl().queue.store.store.getState().queue.repeatMode) ||
      'NONE'
    );
  }

  function getVolume() {
    const slider = $('#volume-slider');
    const sv = slider && Number(slider.value);
    if (Number.isFinite(sv)) return sv;
    return safe(() => api().getVolume(), 100);
  }

  function getState() {
    const v = video();
    const song = getSong();
    return {
      song,
      isPlaying: song ? !(v ? v.paused : true) : false,
      position: v && !(song && song.isAd) ? v.currentTime : 0,
      volume: getVolume(),
      muted: safe(() => api().isMuted(), v ? v.muted : false),
      repeat: getRepeat(),
      shuffle: !!(playerBar() && playerBar().hasAttribute('shuffle-on')),
      like: safe(() => $('#like-button-renderer').getAttribute('like-status'), null) || 'INDIFFERENT',
      fullscreen: !!(playerBar() && playerBar().hasAttribute('player-fullscreened')),
    };
  }

  const click = (sel) => {
    const el = $(sel);
    if (el) el.click();
    return !!el;
  };

  function selectedIndex(items) {
    return items.findIndex((it) => {
      const r =
        it.playlistPanelVideoRenderer ||
        (it.playlistPanelVideoWrapperRenderer &&
          it.playlistPanelVideoWrapperRenderer.primaryRenderer.playlistPanelVideoRenderer);
      return r && r.selected;
    });
  }

  async function addToQueue(videoId, insertPosition = 'INSERT_AT_END') {
    const queue = queueEl();
    const app = appEl();
    const store = queue && queue.queue && queue.queue.store && queue.queue.store.store;
    if (!app || !store) throw new Error('Fila indisponível (nada tocando ainda)');

    const result = await app.networkManager.fetch('/music/get_queue', {
      queueContextParams: store.getState().queue.queueContextParams,
      queueInsertPosition: insertPosition,
      videoIds: [videoId],
    });
    if (!result || !Array.isArray(result.queueDatas)) throw new Error('Resposta inesperada da fila');

    const items = store.getState().queue.items || [];
    const index =
      insertPosition === 'INSERT_AFTER_CURRENT_VIDEO' ? selectedIndex(items) + 1 || items.length : items.length;
    queue.dispatch({
      type: 'ADD_ITEMS',
      payload: {
        nextQueueItemId: store.getState().queue.nextQueueItemId,
        index,
        items: result.queueDatas.map((it) => (it && it.content) || null).filter(Boolean),
        shuffleEnabled: false,
        shouldAssignIds: true,
      },
    });
    return index;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const handlers = {
    getState,
    previous: () => click('.previous-button.ytmusic-player-bar'),
    next: () => click('.next-button.ytmusic-player-bar'),
    play: () => api() && api().playVideo(),
    pause: () => api() && api().pauseVideo(),
    togglePlay: () => {
      const p = api();
      if (!p) return;
      if (p.getPlayerState() === 1) p.pauseVideo();
      else p.playVideo();
    },
    seekTo: (s) => api() && api().seekTo(Number(s), true),
    seekBy: (s) => api() && api().seekBy(Number(s)),
    shuffle: () => safe(() => playerBar().queue.shuffle()),
    switchRepeat: (n = 1) => {
      for (let i = 0; i < Number(n); i++) safe(() => playerBar().onRepeatButtonClick());
    },
    setVolume: (v) => {
      const vol = Math.max(0, Math.min(100, Math.round(Number(v))));
      const bar = playerBar();
      if (bar && typeof bar.updateVolume === 'function') bar.updateVolume(vol);
      else if (api()) api().setVolume(vol);
    },
    toggleMute: () => safe(() => playerBar().onVolumeClick()),
    setLike: (status) => {
      const el = $('#like-button-renderer');
      if (!el) return;
      const current = el.getAttribute('like-status');
      // Apertar de novo desfaz (como no app oficial).
      el.updateLikeStatus(current === status ? 'INDIFFERENT' : status);
    },
    setFullscreen: (on) => {
      const isFs = !!(playerBar() && playerBar().hasAttribute('player-fullscreened'));
      if (!!on === isFs) return;
      click(isFs ? '.exit-fullscreen-button' : '.fullscreen-button');
    },
    getQueue: () => {
      const q = queueEl();
      if (!q || !q.queue) return null;
      return {
        items: q.queue.getItems(),
        autoPlaying: q.queue.autoPlaying,
        continuation: q.queue.continuation,
      };
    },
    addToQueue,
    moveInQueue: (fromIndex, toIndex) =>
      queueEl() && queueEl().dispatch({ type: 'MOVE_ITEM', payload: { fromIndex, toIndex } }),
    removeFromQueue: (index) => queueEl() && queueEl().dispatch({ type: 'REMOVE_ITEM', payload: index }),
    setQueueIndex: (index) => queueEl() && queueEl().dispatch({ type: 'SET_INDEX', payload: index }),
    clearQueue: () => {
      const q = queueEl();
      if (!q) return;
      safe(() => q.queue.store.store.dispatch({ type: 'SET_PLAYER_PAGE_INFO', payload: { open: false } }));
      q.dispatch({ type: 'CLEAR' });
    },
    search: async (query, params, continuation) => {
      const app = appEl();
      if (!app) throw new Error('YouTube Music ainda não carregou');
      const box = $('ytmusic-search-box');
      return app.networkManager.fetch('/search', {
        query,
        params,
        continuation,
        suggestStats: safe(() => box.getSearchboxStats()),
      });
    },
    // Toca uma faixa imediatamente. Retorna 'navigate' quando não há fila e o main precisa abrir a URL.
    playSong: async (videoId) => {
      const store = safe(() => queueEl().queue.store.store);
      if (!store || !getSong()) return 'navigate';
      try {
        const index = await addToQueue(videoId, 'INSERT_AFTER_CURRENT_VIDEO');
        await sleep(150);
        queueEl().dispatch({ type: 'SET_INDEX', payload: index });
        return 'ok';
      } catch {
        return 'navigate';
      }
    },
  };

  bridge.on('rpc', async ({ id, method, args }) => {
    try {
      const fn = handlers[method];
      if (!fn) throw new Error(`Método desconhecido: ${method}`);
      const result = await fn(...(args || []));
      bridge.send('rpc-result', { id, result: result === undefined ? null : result });
    } catch (e) {
      bridge.send('rpc-result', { id, error: String((e && e.message) || e) });
    }
  });

  // Envia o estado periodicamente; o processo main calcula o que mudou e notifica os clientes.
  const push = () => {
    try {
      bridge.send('state', getState());
    } catch {}
  };
  setInterval(push, 500);
  document.addEventListener(
    'play',
    push,
    true,
  );
  document.addEventListener('pause', push, true);
  document.addEventListener('volumechange', push, true);
  document.addEventListener('seeked', push, true);

  // Clica em "Pular anúncio" assim que o botão aparece.
  setInterval(() => {
    if (!isAdShowing()) return;
    const skip = document.querySelector(
      '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button, button[id^="skip-button"]',
    );
    if (skip && skip.offsetParent !== null) skip.click();
  }, 500);

  // Fecha o aviso "Ainda está aí?" que pausa a música depois de um tempo sem interação.
  setInterval(() => {
    if (!window.__diakoAutoDismiss) return;
    const dlg = $('ytmusic-you-there-renderer');
    if (dlg && dlg.offsetParent !== null) {
      const btn = dlg.querySelector('button, yt-button-renderer, tp-yt-paper-button');
      if (btn) btn.click();
    }
  }, 3000);
})();
