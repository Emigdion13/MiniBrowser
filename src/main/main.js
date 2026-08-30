'use strict';

const path = require('path');
const { app, BrowserWindow, WebContentsView, session, ipcMain, screen, shell, nativeTheme } = require('electron');

const {
  applyCommandLineHardening,
  hardenBrowsingSession,
  hardenWebContents,
  normalizeInput,
  grantPermission,
  revokeAllPermissions,
  originOf
} = require('./security');

const trackerBlocker = require('./tracker-blocker');

// ---------------------------------------------------------------------------
// Single instance + pre-ready hardening
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

applyCommandLineHardening();

const IS_MAC = process.platform === 'darwin';
const CONTENT_PARTITION = 'persist:minibrowser-content';
const HOME_URL = 'about:blank';

/** @type {BrowserWindow|null} */ let contentWindow = null;
/** @type {BrowserWindow|null} */ let toolbarWindow = null;
/** @type {WebContentsView|null} */ let pageView = null;

let toolbarPinned = true;
let lastBlocked = null;

// ---------------------------------------------------------------------------
// Content window: nothing but the website. No chrome, no buttons.
// ---------------------------------------------------------------------------

function createContentWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1280, Math.round(workAreaSize.width * 0.86));
  const height = Math.min(860, Math.round(workAreaSize.height * 0.86));

  contentWindow = new BrowserWindow({
    width,
    height,
    minWidth: 380,
    minHeight: 320,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#ffffff',
    title: 'MiniBrowser',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 14 } : undefined,
    icon: appIcon(),
    webPreferences: {
      // The shell window itself renders nothing; all safety flags on anyway.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false
    }
  });

  const contentSession = session.fromPartition(CONTENT_PARTITION);
  hardenBrowsingSession(contentSession, { onBlocked: reportBlocked });
  trackerBlocker.attach(contentSession, { onBlocked: reportBlocked });

  pageView = new WebContentsView({
    webPreferences: {
      session: contentSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      disableBlinkFeatures: 'AutomationControlled',
      safeDialogs: true,
      safeDialogsMessage: 'MiniBrowser blocked repeated dialogs from this page.',
      spellcheck: false,
      devTools: false,
      backgroundThrottling: true
    }
  });

  hardenWebContents(pageView.webContents, { onBlocked: reportBlocked });

  contentWindow.contentView.addChildView(pageView);
  layoutPageView();

  contentWindow.on('resize', layoutPageView);
  contentWindow.on('enter-full-screen', layoutPageView);
  contentWindow.on('leave-full-screen', layoutPageView);

  // Keep the floating bar glued to the content window.
  contentWindow.on('move', repositionToolbar);
  contentWindow.on('resize', repositionToolbar);
  contentWindow.on('focus', () => raiseToolbar());
  contentWindow.on('show', () => toolbarWindow?.showInactive());
  contentWindow.on('hide', () => toolbarWindow?.hide());
  contentWindow.on('minimize', () => toolbarWindow?.hide());
  contentWindow.on('restore', () => toolbarWindow?.showInactive());
  contentWindow.on('closed', () => {
    contentWindow = null;
    pageView = null;
    if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.close();
  });

  wireContentEvents();

  contentWindow.once('ready-to-show', () => contentWindow.show());
  contentWindow.show();

  pageView.webContents.loadURL(HOME_URL);
}

function layoutPageView() {
  if (!contentWindow || !pageView) return;
  const { width, height } = contentWindow.getContentBounds();
  // macOS keeps a native title bar strip for the traffic lights.
  const inset = IS_MAC && !contentWindow.isFullScreen() ? 0 : 0;
  pageView.setBounds({ x: 0, y: inset, width, height: height - inset });
}

function wireContentEvents() {
  const wc = pageView.webContents;
  const push = () => sendState();

  wc.on('did-start-loading', () => sendToToolbar('nav:loading', true));
  wc.on('did-stop-loading', () => {
    sendToToolbar('nav:loading', false);
    push();
  });
  wc.on('did-navigate', push);
  wc.on('did-navigate-in-page', push);
  wc.on('page-title-updated', (_e, title) => {
    if (contentWindow) contentWindow.setTitle(title ? `${title} — MiniBrowser` : 'MiniBrowser');
    push();
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    reportBlocked({ reason: 'load-failed', url, detail: `${desc} (${code})` });
    push();
  });
  wc.on('certificate-error', () => push());
}

// ---------------------------------------------------------------------------
// Toolbar window: a separate, frameless, always-on-top PiP-style window.
// ---------------------------------------------------------------------------

function createToolbarWindow() {
  toolbarWindow = new BrowserWindow({
    width: 720,
    height: 132,
    minWidth: 320,
    minHeight: 92,
    maxHeight: 420,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    roundedCorners: true,
    title: 'MiniBrowser Controls',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'toolbar-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false
    }
  });

  // Float above normal windows, including full-screen apps on macOS.
  toolbarWindow.setAlwaysOnTop(true, 'floating', 1);
  if (IS_MAC) {
    toolbarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenUI: true });
  }

  hardenWebContents(toolbarWindow.webContents, { isPrivileged: true });

  toolbarWindow.loadFile(path.join(__dirname, '..', 'renderer', 'toolbar', 'toolbar.html'));
  toolbarWindow.once('ready-to-show', () => {
    repositionToolbar();
    toolbarWindow.showInactive();
    sendState();
  });
  toolbarWindow.on('closed', () => {
    toolbarWindow = null;
  });
}

function repositionToolbar() {
  if (!toolbarWindow || toolbarWindow.isDestroyed() || !contentWindow || !toolbarPinned) return;
  const parent = contentWindow.getBounds();
  const bar = toolbarWindow.getBounds();
  const display = screen.getDisplayMatching(parent).workArea;

  const width = Math.min(Math.max(360, parent.width - 80), 900);
  const x = Math.round(parent.x + (parent.width - width) / 2);
  let y = parent.y + parent.height - bar.height - 28;

  // If the bar would fall off the screen, dock it just under the top edge.
  if (y + bar.height > display.y + display.height) {
    y = display.y + display.height - bar.height - 12;
  }

  toolbarWindow.setBounds({ x, y, width, height: bar.height });
}

function raiseToolbar() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  toolbarWindow.setAlwaysOnTop(true, 'floating', 1);
  toolbarWindow.showInactive();
}

// ---------------------------------------------------------------------------
// State plumbing
// ---------------------------------------------------------------------------

function currentState() {
  const wc = pageView?.webContents;
  const url = wc ? wc.getURL() : '';
  const nav = wc?.navigationHistory;
  return {
    url: url === 'about:blank' ? '' : url,
    title: wc?.getTitle() || '',
    canGoBack: nav ? nav.canGoBack() : false,
    canGoForward: nav ? nav.canGoForward() : false,
    loading: wc ? wc.isLoading() : false,
    secure: url.startsWith('https://'),
    origin: originOf(url),
    pinned: toolbarPinned,
    blockedCount: trackerBlocker.countFor(originOf(url)),
    lastBlocked
  };
}

function sendState() {
  sendToToolbar('nav:state', currentState());
}

function sendToToolbar(channel, payload) {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.webContents.send(channel, payload);
  }
}

function reportBlocked(info) {
  lastBlocked = { ...info, at: Date.now() };
  sendToToolbar('nav:blocked', lastBlocked);
}

// ---------------------------------------------------------------------------
// IPC — the only bridge between the privileged toolbar and the browser core.
// Every handler validates its input and ignores calls from any other window.
// ---------------------------------------------------------------------------

function fromToolbar(event) {
  return toolbarWindow && !toolbarWindow.isDestroyed() && event.sender === toolbarWindow.webContents;
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromToolbar(event)) return null;
    return fn(...args);
  });
}

handle('nav:go', (input) => {
  const url = normalizeInput(String(input || '').slice(0, 4096));
  if (!url) {
    reportBlocked({ reason: 'blocked-url', url: String(input || '').slice(0, 200) });
    return currentState();
  }
  pageView?.webContents.loadURL(url).catch(() => {});
  return currentState();
});

handle('nav:back', () => {
  const nav = pageView?.webContents.navigationHistory;
  if (nav?.canGoBack()) nav.goBack();
  return currentState();
});

handle('nav:forward', () => {
  const nav = pageView?.webContents.navigationHistory;
  if (nav?.canGoForward()) nav.goForward();
  return currentState();
});

handle('nav:reload', (hard) => {
  if (hard) pageView?.webContents.reloadIgnoringCache();
  else pageView?.webContents.reload();
  return currentState();
});

handle('nav:stop', () => {
  pageView?.webContents.stop();
  return currentState();
});

handle('nav:home', () => {
  pageView?.webContents.loadURL(HOME_URL).catch(() => {});
  return currentState();
});

handle('nav:state', () => currentState());

handle('view:zoom', (direction) => {
  const wc = pageView?.webContents;
  if (!wc) return 1;
  const current = wc.getZoomLevel();
  const next = direction === 'reset' ? 0 : Math.max(-5, Math.min(5, current + (direction === 'in' ? 0.5 : -0.5)));
  wc.setZoomLevel(next);
  return next;
});

handle('privacy:clear', async () => {
  const ses = session.fromPartition(CONTENT_PARTITION);
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'shadercache']
  });
  await ses.clearCache();
  await ses.clearAuthCache();
  await ses.clearHostResolverCache();
  revokeAllPermissions();
  trackerBlocker.reset();
  pageView?.webContents.loadURL(HOME_URL).catch(() => {});
  return currentState();
});

handle('privacy:grant', (permission) => {
  const url = pageView?.webContents.getURL() || '';
  grantPermission(originOf(url), String(permission));
  return currentState();
});

handle('privacy:report', () => trackerBlocker.report());

handle('bar:pin', (value) => {
  toolbarPinned = Boolean(value);
  if (toolbarPinned) repositionToolbar();
  return toolbarPinned;
});

handle('bar:resize', (height) => {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return null;
  const h = Math.max(92, Math.min(420, Math.round(Number(height) || 132)));
  const b = toolbarWindow.getBounds();
  toolbarWindow.setBounds({ ...b, height: h });
  if (toolbarPinned) repositionToolbar();
  return h;
});

handle('win:minimize', () => contentWindow?.minimize());
handle('win:close', () => contentWindow?.close());
handle('win:focus', () => contentWindow?.focus());
handle('win:toggle-maximize', () => {
  if (!contentWindow) return false;
  if (contentWindow.isMaximized()) contentWindow.unmaximize();
  else contentWindow.maximize();
  return contentWindow.isMaximized();
});

handle('shell:external', (url) => {
  const target = normalizeInput(String(url || ''));
  if (target && /^https?:/i.test(target)) shell.openExternal(target).catch(() => {});
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('web-contents-created', (_event, contents) => {
  // Belt and braces: anything we did not explicitly create still gets locked down.
  hardenWebContents(contents, { onBlocked: reportBlocked });
});

app.on('second-instance', () => {
  if (contentWindow) {
    if (contentWindow.isMinimized()) contentWindow.restore();
    contentWindow.focus();
    raiseToolbar();
  }
});

app.whenReady().then(async () => {
  await trackerBlocker.load();
  createContentWindow();
  createToolbarWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createContentWindow();
      createToolbarWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

// Never trust a bad certificate, on any platform.
app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
  event.preventDefault();
  reportBlocked({ reason: 'certificate', url, detail: error });
  callback(false);
});

function appIcon() {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(__dirname, '..', '..', 'assets', file);
}
