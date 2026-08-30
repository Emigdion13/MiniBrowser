'use strict';

const { URL } = require('url');

/**
 * A small, dependency-free tracker / ad blocker.
 *
 * It works on hostname suffixes rather than regex URL matching, which keeps it
 * fast (a few Set lookups per request) and impossible to bypass with query
 * string tricks. Third-party cookies are additionally stripped from every
 * cross-site request.
 */

const BLOCKED_HOSTS = [
  // Analytics
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'googletagservices.com',
  'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'heap.io', 'heapanalytics.com',
  'hotjar.com', 'hotjar.io', 'fullstory.com', 'mouseflow.com', 'crazyegg.com', 'quantserve.com',
  'scorecardresearch.com', 'chartbeat.com', 'parsely.com', 'newrelic.com', 'nr-data.net',
  'matomo.cloud', 'statcounter.com', 'clarity.ms',
  // Ads
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'criteo.com',
  'criteo.net', 'taboola.com', 'outbrain.com', 'sharethrough.com', 'smartadserver.com',
  'casalemedia.com', 'indexww.com', 'bidswitch.net', 'yieldmo.com', 'teads.tv', 'moatads.com',
  'adform.net', 'media.net', '2mdn.net', 'serving-sys.com', 'zedo.com', 'revcontent.com',
  // Social / cross-site trackers
  'connect.facebook.net', 'facebook.net', 'pixel.facebook.com', 'ct.pinterest.com',
  'analytics.tiktok.com', 'ads-twitter.com', 'analytics.twitter.com', 'static.ads-twitter.com',
  'bat.bing.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
  // Fingerprinting / session replay
  'fingerprintjs.com', 'fpjs.io', 'logrocket.com', 'lr-ingest.io', 'smartlook.com',
  'inspectlet.com', 'luckyorange.com', 'sessioncam.com'
];

const blockedSuffixes = new Set(BLOCKED_HOSTS);

/** Map<pageOrigin, count> */
const counters = new Map();
/** Map<blockedHost, count> */
const byHost = new Map();
let totalBlocked = 0;

function hostIsBlocked(hostname) {
  const host = hostname.toLowerCase();
  if (blockedSuffixes.has(host)) return true;
  let idx = host.indexOf('.');
  while (idx !== -1) {
    const suffix = host.slice(idx + 1);
    if (blockedSuffixes.has(suffix)) return true;
    idx = host.indexOf('.', idx + 1);
  }
  return false;
}

function baseDomain(hostname) {
  const parts = hostname.toLowerCase().split('.');
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function isThirdParty(requestUrl, initiator) {
  if (!initiator) return false;
  try {
    return baseDomain(new URL(requestUrl).hostname) !== baseDomain(new URL(initiator).hostname);
  } catch {
    return false;
  }
}

async function load() {
  // Placeholder for loading an updated remote list in the future.
  // The built-in list is intentionally offline: no network call at startup
  // means nothing to intercept or poison before the first page loads.
  return blockedSuffixes.size;
}

function attach(ses, { onBlocked } = {}) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let hostname;
    try {
      hostname = new URL(details.url).hostname;
    } catch {
      return callback({ cancel: false });
    }

    if (hostname && hostIsBlocked(hostname)) {
      totalBlocked += 1;
      byHost.set(hostname, (byHost.get(hostname) || 0) + 1);
      const pageOrigin = safeOrigin(details.initiator);
      if (pageOrigin) counters.set(pageOrigin, (counters.get(pageOrigin) || 0) + 1);
      onBlocked?.({ reason: 'tracker', url: details.url, host: hostname });
      return callback({ cancel: true });
    }

    callback({ cancel: false });
  });

  // Strip cookies and referrers from third-party requests.
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

  // Refuse third-party Set-Cookie headers outright.
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

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function countFor(origin) {
  return origin ? counters.get(origin) || 0 : 0;
}

function report() {
  const top = [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { total: totalBlocked, listSize: blockedSuffixes.size, top };
}

function reset() {
  counters.clear();
  byHost.clear();
  totalBlocked = 0;
}

module.exports = { load, attach, countFor, report, reset, hostIsBlocked };
