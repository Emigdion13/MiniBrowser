/* Mock of the preload bridge so the real toolbar UI can be previewed in a
   plain browser. Not shipped with the app. */
(function () {
  const state = {
    url: 'https://en.wikipedia.org/wiki/Web_browser',
    title: 'Web browser - Wikipedia',
    canGoBack: true,
    canGoForward: false,
    loading: false,
    secure: true,
    origin: 'https://en.wikipedia.org',
    pinned: true,
    blockedCount: 7,
    adblockEnabled: true,
    siteAllowlisted: false,
    lastBlocked: null
  };

  const subs = { state: new Set(), loading: new Set(), blocked: new Set(), find: new Set() };
  const emit = (k, v) => subs[k].forEach((f) => f(v));
  const push = () => emit('state', { ...state });

  function fakeLoad(url) {
    state.url = url;
    state.secure = url.startsWith('https://');
    state.loading = true;
    state.canGoBack = true;
    state.blockedCount = Math.floor(Math.random() * 14);
    emit('loading', true);
    push();
    setTimeout(() => {
      state.loading = false;
      emit('loading', false);
      push();
    }, 1100);
  }

  window.mini = {
    go: async (input) => {
      const raw = String(input).trim();
      if (/^(javascript|file|chrome):/i.test(raw)) {
        emit('blocked', { reason: 'blocked-url', url: raw });
        return { ...state };
      }
      const url = /^https?:\/\//i.test(raw)
        ? raw
        : /^[\w-]+(\.[\w-]+)+/.test(raw)
          ? 'https://' + raw
          : 'https://duckduckgo.com/?q=' + encodeURIComponent(raw);
      fakeLoad(url);
      return { ...state };
    },
    back: async () => { state.canGoForward = true; fakeLoad('https://example.com/'); return { ...state }; },
    forward: async () => { fakeLoad('https://en.wikipedia.org/wiki/Web_browser'); return { ...state }; },
    reload: async () => { fakeLoad(state.url); return { ...state }; },
    stop: async () => { state.loading = false; emit('loading', false); push(); return { ...state }; },
    home: async () => { state.url = ''; state.canGoBack = false; state.blockedCount = 0; push(); return { ...state }; },
    state: async () => ({ ...state }),
    zoom: async (d) => {
      window.__z = d === 'reset' ? 0 : Math.max(-5, Math.min(5, (window.__z || 0) + (d === 'in' ? 0.5 : -0.5)));
      return window.__z;
    },
    adblockToggle: async () => { state.adblockEnabled = !state.adblockEnabled; push(); return state.adblockEnabled; },
    adblockCosmetic: async (v) => v,
    adblockToggleSite: async () => {
      state.siteAllowlisted = !state.siteAllowlisted; push();
      return { domain: 'wikipedia.org', blocking: !state.siteAllowlisted };
    },
    adblockSubscribe: async () => ({ ok: true, networkRules: 84213, cosmeticRules: 51204 }),
    adblockUnsubscribe: async () => true,

    clearData: async () => {
      state.blockedCount = 0; state.url = ''; push();
      emit('blocked', { reason: 'cleared' });
      return { ...state };
    },
    grant: async () => ({ ...state }),
    privacyReport: async () => ({
      total: 128,
      enabled: state.adblockEnabled,
      cosmeticEnabled: true,
      networkRules: 214,
      cosmeticRules: 31,
      allowlist: state.siteAllowlisted ? ['wikipedia.org'] : [],
      subscriptions: [
        { key: 'easylist', name: 'EasyList (ads)', active: false },
        { key: 'easyprivacy', name: 'EasyPrivacy (tracking)', active: false },
        { key: 'annoyances', name: 'Cookie notices & annoyances', active: false }
      ],
      top: [
        ['google-analytics.com', 31], ['doubleclick.net', 24], ['googletagmanager.com', 18],
        ['facebook.net', 14], ['criteo.com', 11], ['hotjar.com', 9], ['taboola.com', 7],
        ['adnxs.com', 6], ['clarity.ms', 5], ['outbrain.com', 3]
      ]
    }),
    pin: async (v) => { state.pinned = v; push(); return v; },
    resizeBar: async (h) => h,
    minimize: async () => true,
    fullscreen: async () => true,
    center: async () => true,
    moveBy: async () => true,
    snap: async () => true,
    find: async (q) => {
      const total = q ? Math.max(1, q.length * 2) : 0;
      emit('find', { active: total ? 1 : 0, total });
      return true;
    },
    findStop: async () => { emit('find', { active: 0, total: 0 }); return true; },
    print: async () => true,
    copyUrl: async () => state.url,
    edit: async () => true,
    toggleMaximize: async () => true,
    close: async () => emit('blocked', { reason: 'preview-close' }),
    focusContent: async () => true,
    openExternal: async () => true,
    onState: (f) => (subs.state.add(f), () => subs.state.delete(f)),
    onLoading: (f) => (subs.loading.add(f), () => subs.loading.delete(f)),
    onBlocked: (f) => (subs.blocked.add(f), () => subs.blocked.delete(f)),
    onFindResult: (f) => (subs.find.add(f), () => subs.find.delete(f)),
    platform: 'linux'
  };

  window.addEventListener('message', (e) => {
    if (e.data === 'toggle-panel') document.querySelector('[data-menu="adblock"]')?.click();
  });

  // Demo a blocked popup shortly after load so the toast is visible.
  setTimeout(() => emit('blocked', { reason: 'popup', url: 'https://ads.example/pop' }), 2200);
})();
