'use strict';

/**
 * Reproduces the "menu will not close" bug against the real toolbar.js,
 * driven through jsdom with a mock bridge.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src/renderer/toolbar/toolbar.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'src/renderer/toolbar/toolbar.js'), 'utf8');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Boot toolbar.js inside a fresh jsdom. */
async function boot() {
  const body = HTML.replace(/<script src="toolbar\.js"><\/script>/, '')
    .replace(/<link[^>]*>/g, '');

  const dom = new JSDOM(body, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const focusHandlers = new Set();
  const dismissHandlers = new Set();
  const resizeCalls = [];
  const state = {
    url: 'https://example.com/', title: 'Example', canGoBack: true, canGoForward: false,
    loading: false, secure: true, origin: 'https://example.com', pinned: true,
    blockedCount: 3, adblockEnabled: true, siteAllowlisted: false,
    alwaysOnTop: false, opacity: 1, dragBar: true
  };
  const noop = async () => state;

  window.mini = {
    go: noop, back: noop, forward: noop, reload: noop, stop: noop, home: noop,
    state: async () => state,
    zoom: async () => 0,
    clearData: noop, grant: noop,
    privacyReport: async () => ({
      total: 5, enabled: true, cosmeticEnabled: true, networkRules: 200,
      cosmeticRules: 30, allowlist: [], subscriptions: [], top: [['ads.com', 5]]
    }),
    adblockToggle: async () => true, adblockCosmetic: async () => true,
    adblockToggleSite: async () => ({ domain: 'example.com', blocking: true }),
    adblockSubscribe: async () => ({ ok: true, networkRules: 1 }),
    adblockUnsubscribe: async () => true,
    pin: async () => true,
    resizeBar: async (h) => {
      // The real main process resizes the window, which fires 'resize' on us.
      // This is exactly what used to slam the menu shut.
      resizeCalls.push(h);
      window.dispatchEvent(new window.Event('resize'));
      return h;
    },
    minimize: noop, toggleMaximize: noop, close: noop, focusContent: noop,
    fullscreen: noop, center: noop, moveBy: noop, snap: noop,
    alwaysOnTop: async () => false, opacity: async (v) => v, dragBar: async () => true,
    find: noop, findStop: noop, print: noop, copyUrl: async () => state.url, edit: noop,
    openExternal: noop,
    onState: () => () => {}, onLoading: () => () => {}, onBlocked: () => () => {},
    onFindResult: () => () => {},
    onContentFocus: (fn) => { focusHandlers.add(fn); return () => focusHandlers.delete(fn); },
    onDismiss: (fn) => { dismissHandlers.add(fn); return () => dismissHandlers.delete(fn); },
    platform: 'linux'
  };

  window.eval(SCRIPT);
  await tick();
  await tick();

  const doc = window.document;
  return {
    window,
    doc,
    dropdown: doc.getElementById('dropdown'),
    isOpen: () => doc.getElementById('dropdown').hidden === false,
    title: (name) => doc.querySelector(`[data-menu="${name}"]`),
    fireContentFocus: () => { for (const fn of focusHandlers) fn(); },
    fireDismiss: () => { for (const fn of dismissHandlers) fn(); },
    fireUserResize: () => window.dispatchEvent(new window.Event('resize')),
    resizeCalls
  };
}

/** Dispatch a full, realistic mouse interaction. */
function press(window, target, type = 'pointerdown') {
  const Ev = window.MouseEvent;
  target.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window }));
}

function fullClick(window, target) {
  press(window, target, 'pointerdown');
  press(window, target, 'mousedown');
  press(window, target, 'mouseup');
  press(window, target, 'click');
}

(async () => {
  console.log('\nmenu open/close');

  await check('clicking a menu title opens it', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    assert.ok(t.isOpen(), 'menu did not open');
  });

  await check('clicking the same title again closes it', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    fullClick(t.window, t.title('file'));
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open');
  });

  await check('pressing the omnibox closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    fullClick(t.window, t.doc.getElementById('url'));
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open after clicking the address bar');
  });

  await check('pressing a nav button closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('view'));
    await tick();
    fullClick(t.window, t.doc.getElementById('back'));
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open after clicking Back');
  });

  await check('pressing the bar background closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('view'));
    await tick();
    fullClick(t.window, t.doc.getElementById('bar'));
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open after clicking the bar');
  });

  await check('choosing a normal menu item closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    const item = t.dropdown.querySelector('.mi:not([disabled])');
    fullClick(t.window, item);
    await tick();
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open after choosing an item');
  });

  await check('page-window focus closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    t.fireContentFocus();
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open when the page took focus');
  });

  await check('Escape closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    t.doc.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open after Escape');
  });

  await check('switching directly to another menu title works', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    fullClick(t.window, t.title('view'));
    await tick();
    assert.ok(t.isOpen(), 'menu closed entirely instead of switching');
    const labels = [...t.dropdown.querySelectorAll('.mi span:first-child')].map((n) => n.textContent);
    assert.ok(labels.some((l) => l.includes('Reload')), `expected the View menu, got: ${labels[0]}`);
  });

  await check('a keep:true item leaves the menu open', async () => {
    const t = await boot();
    fullClick(t.window, t.title('window'));
    await tick();
    const item = [...t.dropdown.querySelectorAll('.mi')]
      .find((n) => n.textContent.includes('Always on top'));
    fullClick(t.window, item);
    await tick();
    await tick();
    assert.ok(t.isOpen(), 'keep:true item closed the menu');
  });

  await check('the transparency slider does not close the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('window'));
    await tick();
    const slider = t.dropdown.querySelector('input[type="range"]');
    assert.ok(slider, 'slider missing');
    press(t.window, slider, 'pointerdown');
    await tick();
    assert.ok(t.isOpen(), 'dragging the slider closed the menu');
  });

  console.log('\nregressions');

  await check('REGRESSION: the bar resizing itself does not close the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick();
    await tick();
    assert.ok(t.resizeCalls.length > 0, 'fitHeight never resized the bar');
    assert.ok(t.isOpen(), 'the self-inflicted resize closed the menu');
  });

  await check('REGRESSION: menu survives several open/close cycles', async () => {
    const t = await boot();
    for (let i = 0; i < 4; i += 1) {
      fullClick(t.window, t.title('file'));
      await tick(); await tick();
      assert.ok(t.isOpen(), `cycle ${i}: did not open`);
      fullClick(t.window, t.title('file'));
      await tick(); await tick();
      assert.ok(!t.isOpen(), `cycle ${i}: did not close`);
    }
  });

  await check('a genuine user resize still closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('file'));
    await tick(); await tick();
    assert.ok(t.isOpen());
    await new Promise((r) => setTimeout(r, 320)); // let selfResizing lapse
    t.fireUserResize();
    await tick();
    assert.ok(!t.isOpen(), 'user resize did not close the menu');
  });

  await check('main-process dismiss closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('view'));
    await tick(); await tick();
    t.fireDismiss();
    await tick();
    assert.ok(!t.isOpen(), 'dismiss signal ignored');
  });

  await check('pressing the drag gap closes the menu', async () => {
    const t = await boot();
    fullClick(t.window, t.title('view'));
    await tick(); await tick();
    press(t.window, t.doc.getElementById('dragGap'), 'mousedown');
    await tick();
    assert.ok(!t.isOpen(), 'menu stayed open after pressing the drag region');
  });

  await check('every menu opens and closes cleanly', async () => {
    for (const name of ['file', 'edit', 'view', 'history', 'adblock', 'privacy', 'window']) {
      const t = await boot();
      fullClick(t.window, t.title(name));
      await tick(); await tick();
      assert.ok(t.isOpen(), `${name}: did not open`);
      fullClick(t.window, t.doc.getElementById('url'));
      await tick();
      assert.ok(!t.isOpen(), `${name}: would not close`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  // toolbar.js installs a setInterval; nothing else keeps us alive.
  process.exit(failed ? 1 : 0);
})();
