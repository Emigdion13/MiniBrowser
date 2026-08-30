'use strict';

/* Toolbar renderer. Runs sandboxed with context isolation; the only capability
   it has is the frozen `window.mini` bridge created by the preload script.

   This window owns EVERY menu in the application. The page window has no
   frame, no title bar and no native menu at all. */

const $ = (id) => document.getElementById(id);

const bar = $('bar');
const urlInput = $('url');
const backBtn = $('back');
const forwardBtn = $('forward');
const menubar = $('menubar');
const dropdown = $('dropdown');
const shield = $('shield');
const shieldCount = $('shieldCount');
const toast = $('toast');
const findbar = $('findbar');
const findInput = $('findInput');
const findCount = $('findCount');

const MOD = window.mini.platform === 'darwin' ? '\u2318' : 'Ctrl';
const H_BASE = 118; // menubar + nav row + progress
const H_FIND = 44;

let state = {};
let urlDirty = false;
let toastTimer = null;
let openMenu = null;
let zoomLevel = 0;
let findOpen = false;
let adReport = null;

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
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function zoomPercent() {
  return `${Math.round(Math.pow(1.2, zoomLevel) * 100)}%`;
}

async function fitHeight() {
  let h = H_BASE;
  if (findOpen) h += H_FIND;
  if (openMenu) h = Math.max(h, H_BASE + dropdown.offsetHeight + 12);

  selfResizing += 1;
  try {
    await window.mini.resizeBar(h);
  } finally {
    // Release only after the resize event has had a chance to fire.
    setTimeout(() => { selfResizing = Math.max(0, selfResizing - 1); }, 250);
  }
}

// --- menu definitions ------------------------------------------------------
// Each entry: { label, key, run, enabled, checked, type }

const MENUS = {
  file: () => [
    { label: 'New address\u2026', key: `${MOD} L`, run: () => urlInput.focus() },
    { label: 'Open home page', run: async () => render(await window.mini.home()) },
    { type: 'sep' },
    { label: 'Copy page address', key: `${MOD} \u21E7 C`, run: copyUrl, enabled: Boolean(state.url) },
    { label: 'Open in system browser', run: openExternal, enabled: Boolean(state.url) },
    { type: 'sep' },
    { label: 'Print\u2026', key: `${MOD} P`, run: () => window.mini.print(), enabled: Boolean(state.url) },
    { type: 'sep' },
    { label: 'Quit MiniBrowser', key: `${MOD} Q`, danger: true, run: () => window.mini.close() }
  ],

  edit: () => [
    { label: 'Undo', key: `${MOD} Z`, run: () => window.mini.edit('undo') },
    { label: 'Redo', key: `${MOD} \u21E7 Z`, run: () => window.mini.edit('redo') },
    { type: 'sep' },
    { label: 'Cut', key: `${MOD} X`, run: () => window.mini.edit('cut') },
    { label: 'Copy', key: `${MOD} C`, run: () => window.mini.edit('copy') },
    { label: 'Paste', key: `${MOD} V`, run: () => window.mini.edit('paste') },
    { label: 'Select all', key: `${MOD} A`, run: () => window.mini.edit('selectAll') },
    { type: 'sep' },
    { label: 'Find in page\u2026', key: `${MOD} F`, run: () => toggleFind(true) }
  ],

  view: () => [
    { label: 'Reload', key: `${MOD} R`, run: () => window.mini.reload(false) },
    { label: 'Hard reload (bypass cache)', key: `${MOD} \u21E7 R`, run: () => window.mini.reload(true) },
    { label: 'Stop loading', run: () => window.mini.stop(), enabled: Boolean(state.loading) },
    { type: 'sep' },
    { label: `Zoom in  (${zoomPercent()})`, key: `${MOD} +`, run: () => applyZoom('in') },
    { label: 'Zoom out', key: `${MOD} \u2212`, run: () => applyZoom('out') },
    { label: 'Reset zoom', key: `${MOD} 0`, run: () => applyZoom('reset') },
    { type: 'sep' },
    { label: 'Full screen page', key: 'F11', run: () => window.mini.fullscreen() }
  ],

  history: () => [
    { label: 'Back', key: 'Alt \u2190', run: () => window.mini.back(), enabled: state.canGoBack },
    { label: 'Forward', key: 'Alt \u2192', run: () => window.mini.forward(), enabled: state.canGoForward },
    { type: 'sep' },
    { label: 'Home', run: () => window.mini.home() },
    { type: 'sep' },
    { type: 'head', label: 'Current page' },
    { type: 'stat', label: state.url ? prettyUrl(state.url) : 'Nothing loaded', value: '' },
    { type: 'stat', label: 'Connection', value: state.url ? (state.secure ? 'HTTPS' : 'Not secure') : '\u2014' }
  ],

  adblock: () => {
    const items = [
      {
        label: 'Block ads and trackers',
        type: 'check',
        checked: Boolean(state.adblockEnabled),
        run: async () => {
          const on = await window.mini.adblockToggle();
          showToast(on ? 'Ad blocking on' : 'Ad blocking off \u2014 reloading');
        }
      },
      {
        label: 'Hide leftover ad space',
        type: 'check',
        checked: adReport ? adReport.cosmeticEnabled : true,
        run: async () => {
          const on = await window.mini.adblockCosmetic(!(adReport && adReport.cosmeticEnabled));
          if (adReport) adReport.cosmeticEnabled = on;
          showToast(on ? 'Cosmetic hiding on' : 'Cosmetic hiding off');
        }
      },
      { type: 'sep' },
      { type: 'head', label: 'This page' },
      { type: 'stat', label: 'Blocked here', value: String(state.blockedCount || 0) },
      {
        label: state.siteAllowlisted ? 'Re-enable blocking on this site' : 'Allow ads on this site',
        run: async () => {
          const r = await window.mini.adblockToggleSite();
          if (r) showToast(r.blocking ? `Blocking on for ${r.domain}` : `Ads allowed on ${r.domain}`);
        },
        enabled: Boolean(state.url)
      },
      { type: 'sep' },
      { type: 'head', label: 'Statistics' },
      { type: 'stat', label: 'Blocked this session', value: adReport ? String(adReport.total) : '\u2026' },
      { type: 'stat', label: 'Network rules', value: adReport ? adReport.networkRules.toLocaleString() : '\u2026' },
      { type: 'stat', label: 'Cosmetic rules', value: adReport ? adReport.cosmeticRules.toLocaleString() : '\u2026' },
      { label: 'Top blocked domains\u2026', run: showReport }
    ];

    if (adReport && adReport.subscriptions.length) {
      items.push({ type: 'sep' }, { type: 'head', label: 'Filter list subscriptions' });
      for (const sub of adReport.subscriptions) {
        items.push({
          label: sub.name,
          type: 'check',
          checked: sub.active,
          run: async () => {
            if (sub.active) {
              await window.mini.adblockUnsubscribe(sub.key);
              showToast(`${sub.name} removed`);
            } else {
              showToast(`Downloading ${sub.name}\u2026`);
              const r = await window.mini.adblockSubscribe(sub.key);
              showToast(r.ok ? `${sub.name} added \u2014 ${r.networkRules.toLocaleString()} rules` : `Failed: ${r.error}`);
            }
            loadReport();
          }
        });
      }
    }

    if (adReport && adReport.allowlist.length) {
      items.push({ type: 'sep' }, { type: 'head', label: 'Ads allowed on' });
      for (const d of adReport.allowlist.slice(0, 6)) {
        items.push({ type: 'stat', label: d, value: '' });
      }
    }

    return items;
  },

  privacy: () => [
    { type: 'head', label: 'Grant for this site only' },
    { label: 'Allow camera', run: () => grant('media', 'Camera allowed for this site') },
    { label: 'Allow microphone', run: () => grant('media', 'Microphone allowed for this site') },
    { label: 'Allow location', run: () => grant('geolocation', 'Location allowed for this site') },
    { label: 'Allow notifications', run: () => grant('notifications', 'Notifications allowed for this site') },
    { type: 'sep' },
    { label: 'Clear all browsing data', danger: true, run: clearData }
  ],

  window: () => [
    {
      label: 'Always on top',
      type: 'check',
      checked: Boolean(state.alwaysOnTop),
      keep: true,
      run: async () => {
        const on = await window.mini.alwaysOnTop();
        state.alwaysOnTop = on;
        showToast(on ? 'Page window stays on top' : 'Page window behaves normally');
      }
    },
    {
      label: 'Top drag strip (auto-hides)',
      type: 'check',
      checked: state.dragBar !== false,
      keep: true,
      run: async () => {
        const on = await window.mini.dragBar();
        state.dragBar = on;
        showToast(on ? 'Drag strip on \u2014 move the pointer to the top edge' : 'Drag strip off');
      }
    },
    { type: 'sep' },
    { type: 'head', label: 'Transparency' },
    { type: 'slider' },
    { type: 'sep' },
    { label: 'Minimize page window', run: () => window.mini.minimize() },
    { label: 'Maximize / restore', run: () => window.mini.toggleMaximize() },
    { label: 'Center on screen', run: () => window.mini.center() },
    { type: 'sep' },
    { type: 'head', label: 'Snap page window' },
    { label: 'Left half', run: () => window.mini.snap('left') },
    { label: 'Right half', run: () => window.mini.snap('right') },
    { label: 'Fill screen', run: () => window.mini.snap('full') },
    { type: 'sep' },
    {
      label: 'Bar follows page window',
      type: 'check',
      checked: Boolean(state.pinned),
      run: async () => {
        const pinned = await window.mini.pin(!state.pinned);
        state.pinned = pinned;
        showToast(pinned ? 'Bar follows the page window' : 'Bar moves freely');
      }
    }
  ]
};

// --- menu rendering --------------------------------------------------------

function buildMenu(name) {
  dropdown.textContent = '';
  for (const item of MENUS[name]()) {
    if (item.type === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'mi-sep';
      dropdown.appendChild(sep);
      continue;
    }
    if (item.type === 'head') {
      const head = document.createElement('div');
      head.className = 'mi-head';
      head.textContent = item.label;
      dropdown.appendChild(head);
      continue;
    }
    if (item.type === 'slider') {
      const row = document.createElement('div');
      row.className = 'mi-slider';

      const input = document.createElement('input');
      input.type = 'range';
      input.min = '20';
      input.max = '100';
      input.step = '5';
      input.value = String(Math.round((state.opacity ?? 1) * 100));
      input.setAttribute('aria-label', 'Page window opacity');

      const value = document.createElement('b');
      value.textContent = `${input.value}%`;

      const apply = async () => {
        value.textContent = `${input.value}%`;
        const v = await window.mini.opacity(Number(input.value) / 100);
        state.opacity = v;
      };
      input.addEventListener('input', apply);
      // Keep the menu open while dragging the slider.
      input.addEventListener('pointerdown', (e) => e.stopPropagation());

      row.append(input, value);
      dropdown.appendChild(row);

      const presets = document.createElement('div');
      presets.className = 'mi-presets';
      for (const pct of [100, 90, 75, 50]) {
        const b = document.createElement('button');
        b.className = 'preset';
        b.textContent = pct === 100 ? 'Solid' : `${pct}%`;
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          input.value = String(pct);
          await apply();
        });
        presets.appendChild(b);
      }
      dropdown.appendChild(presets);
      continue;
    }

    if (item.type === 'stat') {
      const row = document.createElement('div');
      row.className = 'mi-stat';
      const l = document.createElement('span');
      l.textContent = item.label;
      const v = document.createElement('b');
      v.textContent = item.value;
      row.append(l, v);
      dropdown.appendChild(row);
      continue;
    }

    const btn = document.createElement('button');
    btn.className = 'mi';
    if (item.danger) btn.classList.add('danger');
    if (item.type === 'check') {
      btn.classList.add('check');
      if (item.checked) btn.classList.add('on');
    }
    if (item.enabled === false) btn.disabled = true;

    const label = document.createElement('span');
    label.textContent = item.label;
    btn.appendChild(label);

    if (item.key) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = item.key;
      btn.appendChild(key);
    }

    btn.addEventListener('click', async () => {
      if (item.keep) {
        await item.run();
        await refresh();
        if (openMenu) buildMenu(openMenu);
        return;
      }
      closeMenu();
      await item.run();
      refresh();
    });
    dropdown.appendChild(btn);
  }
}

async function showMenu(name) {
  const title = menubar.querySelector(`[data-menu="${name}"]`);
  if (!title) return;

  // The Ad Block menu shows live counters; fetch them before laying out.
  if (name === 'adblock' && !adReport) await loadReport();

  openMenu = name;
  buildMenu(name);
  dropdown.hidden = false;

  // Position under its title, clamped inside the bar.
  const left = Math.min(title.offsetLeft, Math.max(8, window.innerWidth - dropdown.offsetWidth - 10));
  dropdown.style.left = `${left}px`;
  dropdown.style.top = `${title.offsetTop + title.offsetHeight + 4}px`;

  for (const el of menubar.querySelectorAll('.menu-title')) {
    el.classList.toggle('open', el.dataset.menu === name);
  }
  await fitHeight();
}

// Resizing the bar to fit a menu fires 'resize' on ourselves. Only treat a
// resize as "user grabbed the window edge" once our own layout has settled.
let selfResizing = 0;
window.addEventListener('resize', () => {
  if (selfResizing > 0) return;
  if (openMenu) closeMenu();
});

function closeMenu() {
  if (!openMenu) return;
  openMenu = null;
  dropdown.hidden = true;
  for (const el of menubar.querySelectorAll('.menu-title')) el.classList.remove('open');
  fitHeight();
}

for (const title of menubar.querySelectorAll('.menu-title')) {
  title.addEventListener('click', (event) => {
    event.stopPropagation();
    if (openMenu === title.dataset.menu) closeMenu();
    else showMenu(title.dataset.menu);
  });
  // Hovering slides between menus once one is open, like a native menubar.
  title.addEventListener('mouseenter', () => {
    if (openMenu && openMenu !== title.dataset.menu) showMenu(title.dataset.menu);
  });
}

// Close on any press outside the dropdown. pointerdown (not click) so a
// press-and-drag, or a press that steals focus, still dismisses the menu.
function outsidePress(event) {
  if (!openMenu) return;
  if (dropdown.contains(event.target)) return;
  if (event.target.closest?.('.menu-title')) return; // the title handler toggles
  closeMenu();
}
document.addEventListener('pointerdown', outsidePress, true);
// Safety net: some environments deliver only mousedown for certain regions.
document.addEventListener('mousedown', outsidePress, true);

// Presses on a -webkit-app-region: drag area are consumed by the OS window
// drag and never reach the document, so hook those elements directly.
for (const region of document.querySelectorAll('.drag-gap, .brand')) {
  region.addEventListener('pointerdown', () => closeMenu());
  region.addEventListener('mousedown', () => closeMenu());
}

// The bar is its own OS window: clicking the page window or another app sends
// us no event at all, so dismiss on focus loss too.
window.addEventListener('blur', () => closeMenu());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) closeMenu();
});
// The main process tells us when the page window takes focus.
window.mini.onContentFocus?.(() => closeMenu());
// Main process tells us to dismiss (page clicked, window moved, etc.).
window.mini.onDismiss?.(() => closeMenu());

// --- actions ---------------------------------------------------------------

async function applyZoom(direction) {
  zoomLevel = await window.mini.zoom(direction);
  showToast(`Zoom ${zoomPercent()}`);
}

async function grant(permission, message) {
  await window.mini.grant(permission);
  showToast(message);
}

async function copyUrl() {
  const url = await window.mini.copyUrl();
  showToast(url ? 'Address copied' : 'Nothing to copy');
}

async function openExternal() {
  if (state.url) {
    await window.mini.openExternal(state.url);
    showToast('Opened in your system browser');
  }
}

async function clearData() {
  render(await window.mini.clearData());
  showToast('Cookies, cache and site data cleared');
}

async function loadReport() {
  adReport = await window.mini.privacyReport();
  return adReport;
}

async function showReport() {
  const data = await loadReport();
  if (!data || !data.total) {
    showToast('Nothing blocked yet');
    return;
  }
  const top = data.top.slice(0, 3).map(([h, c]) => `${h} (${c})`).join(', ');
  showToast(`${data.total} blocked \u00B7 ${top}`);
}

// --- find in page ----------------------------------------------------------

async function toggleFind(open) {
  findOpen = open;
  findbar.hidden = !open;
  await fitHeight();
  if (open) {
    findInput.focus();
    findInput.select();
  } else {
    findInput.value = '';
    findCount.textContent = '0/0';
    window.mini.findStop();
  }
}

findInput.addEventListener('input', () => window.mini.find(findInput.value, true));
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    window.mini.find(findInput.value, !event.shiftKey);
  } else if (event.key === 'Escape') {
    toggleFind(false);
  }
});
$('findNext').addEventListener('click', () => window.mini.find(findInput.value, true));
$('findPrev').addEventListener('click', () => window.mini.find(findInput.value, false));
$('findClose').addEventListener('click', () => toggleFind(false));

window.mini.onFindResult((r) => {
  findCount.textContent = `${r.active || 0}/${r.total || 0}`;
});

// --- dragging the frameless PAGE window ------------------------------------

const moveHandle = $('moveWindow');
if (moveHandle) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  moveHandle.addEventListener('mousedown', (event) => {
    dragging = true;
    lastX = event.screenX;
    lastY = event.screenY;
    moveHandle.classList.add('dragging');
    event.preventDefault();
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const dx = event.screenX - lastX;
    const dy = event.screenY - lastY;
    lastX = event.screenX;
    lastY = event.screenY;
    if (dx || dy) window.mini.moveBy(dx, dy);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    moveHandle.classList.remove('dragging');
  });
}

// --- state rendering -------------------------------------------------------

function render(next) {
  if (!next) return;
  state = next;

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
  const off = state.adblockEnabled === false || state.siteAllowlisted;
  shield.classList.toggle('off', off);
  shield.title = off
    ? (state.siteAllowlisted ? 'Ads allowed on this site' : 'Ad blocking is off')
    : blocked
      ? `${blocked} ad${blocked === 1 ? '' : 's'} and tracker${blocked === 1 ? '' : 's'} blocked here`
      : 'Ad blocking is on';
}

async function refresh() {
  render(await window.mini.state());
}

window.mini.onState(render);
window.mini.onLoading((loading) => bar.classList.toggle('loading', Boolean(loading)));
window.mini.onBlocked((info) => {
  if (!info) return;
  if (info.reason === 'ad' || info.reason === 'tracker') {
    refresh();
    return;
  }
  const messages = {
    popup: 'Popup blocked',
    scheme: 'Blocked an unsafe link',
    'blocked-url': 'That address is not allowed',
    download: `Download blocked: ${info.filename || ''}`,
    certificate: 'Blocked: invalid certificate',
    'load-failed': `Could not load page \u2014 ${info.detail || ''}`,
    crash: 'The page crashed and was stopped',
    webview: 'Blocked an embedded frame',
    'file-access': 'Blocked local file access'
  };
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

urlInput.addEventListener('input', () => { urlDirty = true; });
urlInput.addEventListener('focus', () => urlInput.select());
urlInput.addEventListener('blur', () => { urlDirty = false; refresh(); });
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { urlDirty = false; urlInput.blur(); }
});

backBtn.addEventListener('click', async () => render(await window.mini.back()));
forwardBtn.addEventListener('click', async () => render(await window.mini.forward()));
$('home').addEventListener('click', async () => render(await window.mini.home()));
$('reload').addEventListener('click', async () => {
  if (bar.classList.contains('loading')) render(await window.mini.stop());
  else render(await window.mini.reload(false));
});

$('minimize').addEventListener('click', () => window.mini.minimize());
$('maximize').addEventListener('click', () => window.mini.toggleMaximize());
$('close').addEventListener('click', () => window.mini.close());
shield.addEventListener('click', () => showMenu('adblock'));

// --- keyboard shortcuts ----------------------------------------------------

document.addEventListener('keydown', (event) => {
  const mod = window.mini.platform === 'darwin' ? event.metaKey : event.ctrlKey;
  const k = event.key.toLowerCase();

  if (mod && k === 'l') { event.preventDefault(); urlInput.focus(); }
  else if (mod && k === 'f') { event.preventDefault(); toggleFind(true); }
  else if (mod && k === 'p') { event.preventDefault(); window.mini.print(); }
  else if (mod && event.shiftKey && k === 'c') { event.preventDefault(); copyUrl(); }
  else if (mod && k === 'r') { event.preventDefault(); window.mini.reload(event.shiftKey); }
  else if (event.key === 'F11') { event.preventDefault(); window.mini.fullscreen(); }
  else if (mod && k === 't') {
    event.preventDefault();
    window.mini.alwaysOnTop().then((on) => {
      state.alwaysOnTop = on;
      showToast(on ? 'Page window stays on top' : 'Page window behaves normally');
    });
  }
  else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); window.mini.back(); }
  else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); window.mini.forward(); }
  else if (mod && (event.key === '=' || event.key === '+')) { event.preventDefault(); applyZoom('in'); }
  else if (mod && event.key === '-') { event.preventDefault(); applyZoom('out'); }
  else if (mod && event.key === '0') { event.preventDefault(); applyZoom('reset'); }
  else if (event.key === 'Escape') {
    if (openMenu) closeMenu();
    else if (findOpen) toggleFind(false);
  }
});

// --- boot ------------------------------------------------------------------

refresh();
loadReport();
setInterval(() => { if (!openMenu) { refresh(); loadReport(); } }, 1500);
fitHeight();
urlInput.focus();
