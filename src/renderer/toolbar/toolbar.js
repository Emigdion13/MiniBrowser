'use strict';

/* Toolbar renderer. Runs sandboxed with context isolation; the only capability
   it has is the frozen `window.mini` bridge created by the preload script. */

const $ = (id) => document.getElementById(id);

const bar = $('bar');
const urlInput = $('url');
const backBtn = $('back');
const forwardBtn = $('forward');
const reloadBtn = $('reload');
const menuBtn = $('menu');
const panel = $('panel');
const shield = $('shield');
const shieldCount = $('shieldCount');
const toast = $('toast');
const zoomReset = $('zoomReset');
const pinBtn = $('pin');

const COLLAPSED_H = 132;
const EXPANDED_H = 360;

let urlDirty = false;
let toastTimer = null;
let panelOpen = false;

// --- helpers ---------------------------------------------------------------

function prettyUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname + u.search + u.hash;
    return u.host + path;
  } catch {
    return url;
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

// --- state rendering -------------------------------------------------------

function render(state) {
  if (!state) return;

  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;

  bar.classList.toggle('loading', Boolean(state.loading));
  bar.classList.toggle('secure', Boolean(state.secure));
  bar.classList.toggle('insecure', Boolean(state.url) && !state.secure);

  if (!urlDirty && document.activeElement !== urlInput) {
    urlInput.value = prettyUrl(state.url);
    urlInput.title = state.url || '';
  }

  const blocked = state.blockedCount || 0;
  shieldCount.textContent = String(blocked);
  shield.classList.toggle('active', blocked > 0);
  shield.title = blocked
    ? `${blocked} tracker${blocked === 1 ? '' : 's'} blocked on this page`
    : 'Tracker blocking is on';

  pinBtn.classList.toggle('on', Boolean(state.pinned));
  pinBtn.setAttribute('aria-pressed', String(Boolean(state.pinned)));
}

async function refresh() {
  render(await window.mini.state());
}

window.mini.onState(render);
window.mini.onLoading((loading) => bar.classList.toggle('loading', Boolean(loading)));
window.mini.onBlocked((info) => {
  if (!info) return;
  const messages = {
    popup: 'Popup blocked',
    scheme: 'Blocked an unsafe link',
    'blocked-url': 'That address is not allowed',
    download: `Download blocked: ${info.filename || ''}`,
    certificate: 'Blocked: invalid certificate',
    'load-failed': `Could not load page — ${info.detail || ''}`,
    crash: 'The page crashed and was stopped',
    webview: 'Blocked an embedded frame',
    'file-access': 'Blocked local file access'
  };
  // Tracker blocks are frequent; only update the counter for those.
  if (info.reason === 'tracker') {
    refresh();
    return;
  }
  showToast(messages[info.reason] || 'Blocked');
  refresh();
});

// --- navigation ------------------------------------------------------------

$('omniform').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = urlInput.value.trim();
  if (!value) return;
  urlDirty = false;
  urlInput.blur();
  render(await window.mini.go(value));
  window.mini.focusContent();
});

urlInput.addEventListener('input', () => {
  urlDirty = true;
});
urlInput.addEventListener('focus', () => urlInput.select());
urlInput.addEventListener('blur', () => {
  urlDirty = false;
  refresh();
});
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    urlDirty = false;
    urlInput.blur();
  }
});

backBtn.addEventListener('click', async () => render(await window.mini.back()));
forwardBtn.addEventListener('click', async () => render(await window.mini.forward()));
$('home').addEventListener('click', async () => render(await window.mini.home()));
reloadBtn.addEventListener('click', async () => {
  if (bar.classList.contains('loading')) render(await window.mini.stop());
  else render(await window.mini.reload(false));
});

$('close').addEventListener('click', () => window.mini.close());

// --- panel -----------------------------------------------------------------

async function setPanel(open) {
  panelOpen = open;
  panel.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  await window.mini.resizeBar(open ? EXPANDED_H : COLLAPSED_H);
  if (open) loadReport();
}

menuBtn.addEventListener('click', () => setPanel(!panelOpen));
shield.addEventListener('click', () => setPanel(!panelOpen));

async function loadReport() {
  const data = await window.mini.privacyReport();
  const list = $('reportList');
  list.textContent = '';
  if (!data || !data.total) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing blocked yet.';
    list.appendChild(li);
    return;
  }
  const head = document.createElement('li');
  const headName = document.createElement('span');
  headName.textContent = `${data.total} requests blocked · ${data.listSize} rules`;
  head.appendChild(headName);
  list.appendChild(head);

  for (const [host, count] of data.top) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = host;
    const num = document.createElement('b');
    num.textContent = String(count);
    li.append(name, num);
    list.appendChild(li);
  }
}

// --- zoom / window / privacy ----------------------------------------------

async function applyZoom(direction) {
  const level = await window.mini.zoom(direction);
  zoomReset.textContent = `${Math.round(Math.pow(1.2, level) * 100)}%`;
}

$('zoomIn').addEventListener('click', () => applyZoom('in'));
$('zoomOut').addEventListener('click', () => applyZoom('out'));
zoomReset.addEventListener('click', () => applyZoom('reset'));

$('minimize').addEventListener('click', () => window.mini.minimize());
$('maximize').addEventListener('click', () => window.mini.toggleMaximize());

pinBtn.addEventListener('click', async () => {
  const pinned = await window.mini.pin(!pinBtn.classList.contains('on'));
  pinBtn.classList.toggle('on', pinned);
  pinBtn.setAttribute('aria-pressed', String(pinned));
  showToast(pinned ? 'Bar follows the window' : 'Bar moves freely');
});

const grants = [
  ['grantCam', 'media', 'Camera allowed for this site'],
  ['grantMic', 'media', 'Microphone allowed for this site'],
  ['grantLoc', 'geolocation', 'Location allowed for this site']
];
for (const [id, permission, message] of grants) {
  $(id).addEventListener('click', async () => {
    await window.mini.grant(permission);
    showToast(message);
  });
}

$('clear').addEventListener('click', async () => {
  render(await window.mini.clearData());
  showToast('Cookies, cache and site data cleared');
  loadReport();
});

// --- keyboard shortcuts ----------------------------------------------------

document.addEventListener('keydown', (event) => {
  const mod = window.mini.platform === 'darwin' ? event.metaKey : event.ctrlKey;

  if (mod && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    urlInput.focus();
  } else if (mod && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    window.mini.reload(event.shiftKey);
  } else if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    window.mini.back();
  } else if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    window.mini.forward();
  } else if (mod && (event.key === '=' || event.key === '+')) {
    event.preventDefault();
    applyZoom('in');
  } else if (mod && event.key === '-') {
    event.preventDefault();
    applyZoom('out');
  } else if (mod && event.key === '0') {
    event.preventDefault();
    applyZoom('reset');
  } else if (event.key === 'Escape' && panelOpen) {
    setPanel(false);
  }
});

// --- boot ------------------------------------------------------------------

refresh();
setInterval(refresh, 1500);
urlInput.focus();
