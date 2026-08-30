'use strict';

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const { URL } = require('url');

const { FilterEngine, hostOf, baseDomain } = require('./filter-engine');
const DEFAULT_FILTERS = require('./default-filters');

/**
 * The ad blocker: network filtering, cosmetic element hiding, a per-site
 * allowlist, and optional filter-list subscriptions.
 */

// Optional subscriptions. Off until the user turns them on, so a fresh install
// makes zero network requests before the first page loads.
const SUBSCRIPTIONS = {
  easylist: { name: 'EasyList (ads)', url: 'https://easylist.to/easylist/easylist.txt' },
  easyprivacy: { name: 'EasyPrivacy (tracking)', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  annoyances: { name: 'Cookie notices & annoyances', url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt' }
};

let engine = new FilterEngine();
let enabled = true;
let cosmeticEnabled = true;

/** Sites the user chose to stop blocking on. Set<baseDomain> */
const allowlist = new Set();

/** Stats */
let totalBlocked = 0;
const byHost = new Map();      // blocked hostname -> count
const byPage = new Map();      // page origin -> count

let settingsPath = null;
let cachePath = null;
let activeSubscriptions = new Set();

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function paths() {
  if (!settingsPath) {
    const dir = app.getPath('userData');
    settingsPath = path.join(dir, 'adblock-settings.json');
    cachePath = path.join(dir, 'filter-cache');
  }
  return { settingsPath, cachePath };
}

function loadSettings() {
  try {
    const { settingsPath: p } = paths();
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    enabled = data.enabled !== false;
    cosmeticEnabled = data.cosmeticEnabled !== false;
    for (const d of data.allowlist || []) allowlist.add(d);
    for (const s of data.subscriptions || []) activeSubscriptions.add(s);
  } catch {
    /* first run */
  }
}

function saveSettings() {
  try {
    const { settingsPath: p } = paths();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          enabled,
          cosmeticEnabled,
          allowlist: [...allowlist],
          subscriptions: [...activeSubscriptions]
        },
        null,
        2
      )
    );
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Building the engine
// ---------------------------------------------------------------------------

function rebuild() {
  const next = new FilterEngine();
  next.addFilters(DEFAULT_FILTERS);

  const { cachePath: dir } = paths();
  for (const key of activeSubscriptions) {
    try {
      const text = fs.readFileSync(path.join(dir, `${key}.txt`), 'utf8');
      next.addFilters(text);
    } catch {
      /* not downloaded yet */
    }
  }

  engine = next;
  return engine.stats();
}

async function load() {
  loadSettings();
  return rebuild();
}

/** Download a filter list and add it to the engine. */
async function subscribe(key) {
  const sub = SUBSCRIPTIONS[key];
  if (!sub) return { ok: false, error: 'Unknown list' };

  try {
    const text = await fetchText(sub.url);
    if (!text || text.length < 1000) throw new Error('List looked empty');

    const { cachePath: dir } = paths();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.txt`), text);

    activeSubscriptions.add(key);
    saveSettings();
    const stats = rebuild();
    return { ok: true, ...stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function unsubscribe(key) {
  activeSubscriptions.delete(key);
  saveSettings();
  return rebuild();
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    let body = '';
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('Timed out'));
    }, 20000);

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        request.abort();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 12 * 1024 * 1024) {
          clearTimeout(timer);
          request.abort();
          reject(new Error('List too large'));
        }
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve(body);
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

function isAllowlisted(url) {
  const host = hostOf(url);
  if (!host) return false;
  return allowlist.has(baseDomain(host));
}

function toggleSite(url) {
  const host = hostOf(url);
  if (!host) return null;
  const domain = baseDomain(host);
  if (allowlist.has(domain)) allowlist.delete(domain);
  else allowlist.add(domain);
  saveSettings();
  return { domain, blocking: !allowlist.has(domain) };
}

// ---------------------------------------------------------------------------
// Request filtering
// ---------------------------------------------------------------------------

function attach(ses, { onBlocked, getPageUrl } = {}) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!enabled) return callback({ cancel: false });

    // Never filter the top-level document itself.
    if (details.resourceType === 'mainFrame') return callback({ cancel: false });

    const pageUrl = details.initiator || getPageUrl?.() || '';
    if (isAllowlisted(pageUrl)) return callback({ cancel: false });

    const hit = engine.match(details.url, details.resourceType, pageUrl);
    if (!hit) return callback({ cancel: false });

    totalBlocked += 1;
    const host = hostOf(details.url);
    if (host) byHost.set(host, (byHost.get(host) || 0) + 1);
    const origin = safeOrigin(pageUrl);
    if (origin) byPage.set(origin, (byPage.get(origin) || 0) + 1);

    onBlocked?.({ reason: 'ad', url: details.url, host, rule: hit.rule });
    callback({ cancel: true });
  });

  // Strip third-party cookies and referrers (kept from the old blocker).
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (isThirdParty(details.url, details.initiator)) {
      delete headers.Cookie;
      delete headers.cookie;
      delete headers.Referer;
      delete headers.referer;
    }
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!isThirdParty(details.url, details.initiator)) {
      return callback({ responseHeaders: details.responseHeaders });
    }
    const responseHeaders = { ...details.responseHeaders };
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'set-cookie') delete responseHeaders[key];
    }
    callback({ responseHeaders });
  });
}

/**
 * Inject the cosmetic stylesheet for a page. Call on 'dom-ready'.
 */
async function applyCosmetics(webContents) {
  if (!enabled || !cosmeticEnabled) return 0;
  const url = webContents.getURL();
  if (isAllowlisted(url)) return 0;

  const css = engine.cosmeticCSS(hostOf(url));
  if (!css) return 0;

  try {
    await webContents.insertCSS(css, { cssOrigin: 'user' });
    return css.length;
  } catch {
    return 0;
  }
}

function isThirdParty(requestUrl, initiator) {
  if (!initiator) return false;
  const a = hostOf(requestUrl);
  const b = hostOf(initiator);
  if (!a || !b) return false;
  return baseDomain(a) !== baseDomain(b);
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reporting / control
// ---------------------------------------------------------------------------

function countFor(origin) {
  return origin ? byPage.get(origin) || 0 : 0;
}

function report() {
  const top = [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const stats = engine.stats();
  return {
    total: totalBlocked,
    top,
    enabled,
    cosmeticEnabled,
    networkRules: stats.networkRules,
    cosmeticRules: stats.cosmeticRules,
    allowlist: [...allowlist],
    subscriptions: Object.entries(SUBSCRIPTIONS).map(([key, s]) => ({
      key,
      name: s.name,
      active: activeSubscriptions.has(key)
    }))
  };
}

function setEnabled(value) {
  enabled = Boolean(value);
  saveSettings();
  return enabled;
}

function setCosmetic(value) {
  cosmeticEnabled = Boolean(value);
  saveSettings();
  return cosmeticEnabled;
}

function reset() {
  totalBlocked = 0;
  byHost.clear();
  byPage.clear();
}

module.exports = {
  load,
  attach,
  applyCosmetics,
  countFor,
  report,
  reset,
  setEnabled,
  setCosmetic,
  toggleSite,
  isAllowlisted,
  subscribe,
  unsubscribe,
  isEnabled: () => enabled,
  SUBSCRIPTIONS
};
