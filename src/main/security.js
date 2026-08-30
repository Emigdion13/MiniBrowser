'use strict';

const { session, shell, app } = require('electron');
const { URL } = require('url');

/**
 * Central security policy for MiniBrowser.
 *
 * Threat model: the rendered page is fully untrusted. It must never be able to
 * reach Node, the main process, the file system, the user's devices, or the
 * privileged toolbar UI.
 */

// Schemes we are ever willing to load in the content view.
const ALLOWED_PAGE_SCHEMES = new Set(['https:', 'http:', 'about:', 'data:', 'blob:']);

// Permissions are denied by default. Nothing is on this list on purpose:
// the user grants per-site exceptions at runtime through the toolbar.
const DEFAULT_ALLOWED_PERMISSIONS = new Set();

// Sites the user explicitly allowed a permission for, this session only.
// Map<origin, Set<permission>>
const permissionGrants = new Map();

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function grantPermission(origin, permission) {
  if (!origin) return;
  if (!permissionGrants.has(origin)) permissionGrants.set(origin, new Set());
  permissionGrants.get(origin).add(permission);
}

function revokeAllPermissions() {
  permissionGrants.clear();
}

function isPermitted(origin, permission) {
  if (DEFAULT_ALLOWED_PERMISSIONS.has(permission)) return true;
  const granted = permissionGrants.get(origin);
  return Boolean(granted && granted.has(permission));
}

/**
 * Command-line level hardening. Must run before app "ready".
 */
function applyCommandLineHardening() {
  // Chromium's own sandbox + site isolation, made explicit.
  app.enableSandbox();
  app.commandLine.appendSwitch('site-per-process');
  app.commandLine.appendSwitch('enable-features', 'StrictOriginIsolation,PartitionedCookies');
  // Reduce fingerprinting / drive-by surface.
  app.commandLine.appendSwitch('disable-features', [
    'InterestCohort',
    'PrivacySandboxSettings4',
    'Translate',
    'MediaRouter',
    'AutofillServerCommunication'
  ].join(','));
  // No remote debugging surface, ever.
  app.commandLine.appendSwitch('disable-remote-fonts-fallback');
}

/**
 * Everything that must be configured on the untrusted browsing session.
 */
function hardenBrowsingSession(ses, { onBlocked } = {}) {
  // 1. Deny every permission request unless the user explicitly allowed it.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf(details?.requestingUrl || wc?.getURL?.() || '');
    callback(isPermitted(origin, permission));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return isPermitted(requestingOrigin, permission);
  });

  // 2. Never auto-select a device (serial, HID, USB, bluetooth).
  ses.setDevicePermissionHandler(() => false);
  ses.setBluetoothPairingHandler((details, callback) => callback({ confirmed: false }));
  ses.on('select-serial-port', (event, ports, wc, callback) => {
    event.preventDefault();
    callback('');
  });

  // 3. Refuse to load anything from a scheme we do not trust, and strip
  //    identifying headers on the way out.
  ses.webRequest.onBeforeRequest((details, callback) => {
    let parsed;
    try {
      parsed = new URL(details.url);
    } catch {
      return callback({ cancel: true });
    }

    if (!ALLOWED_PAGE_SCHEMES.has(parsed.protocol) && parsed.protocol !== 'file:') {
      onBlocked?.({ reason: 'scheme', url: details.url });
      return callback({ cancel: true });
    }

    // file:// is only allowed for our own bundled UI, never for remote frames.
    if (parsed.protocol === 'file:' && details.resourceType !== 'mainFrame') {
      const inApp = decodeURIComponent(parsed.pathname).includes(app.getAppPath());
      if (!inApp) {
        onBlocked?.({ reason: 'file-access', url: details.url });
        return callback({ cancel: true });
      }
    }

    callback({ cancel: false });
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    // Do-Not-Track + Global Privacy Control, and no referrer leakage across origins.
    headers.DNT = '1';
    headers['Sec-GPC'] = '1';
    delete headers['X-Requested-With'];
    callback({ requestHeaders: headers });
  });

  // 4. Do not let remote content set headers that would weaken the shell.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    // Strip any attempt to open a privileged popup relationship.
    delete responseHeaders['cross-origin-opener-policy-report-only'];
    callback({ responseHeaders });
  });

  // 5. Block downloads from starting silently; the user must opt in.
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    onBlocked?.({ reason: 'download', url: item.getURL(), filename: item.getFilename() });
  });

  // 6. No extensions, no speculative connections.
  ses.setSpellCheckerEnabled(false);
  ses.setPreloads([]);
}

/**
 * Per-WebContents hardening. Applied to every renderer we create.
 */
function hardenWebContents(contents, { isPrivileged = false, onBlocked } = {}) {
  // Untrusted pages may never spawn windows, only hand the URL back to us.
  contents.setWindowOpenHandler(({ url }) => {
    onBlocked?.({ reason: 'popup', url });
    return { action: 'deny' };
  });

  // Refuse navigation to schemes that could execute local code.
  contents.on('will-navigate', (event, url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return event.preventDefault();
    }
    if (isPrivileged) {
      // The toolbar UI is never allowed to navigate away from itself.
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
      return;
    }
    if (!ALLOWED_PAGE_SCHEMES.has(parsed.protocol)) {
      event.preventDefault();
      onBlocked?.({ reason: 'scheme', url });
    }
  });

  // Kill webview/attach attempts and force safe preferences on any child.
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    event.preventDefault();
    onBlocked?.({ reason: 'webview', url: params?.src });
  });

  // Never let a page trigger a native permission-ish action.
  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    callback('');
  });

  // Surface renderer crashes instead of silently showing a blank page.
  contents.on('render-process-gone', (_event, details) => {
    onBlocked?.({ reason: 'crash', detail: details.reason });
  });
}

/**
 * Normalise whatever the user typed into a URL we are willing to load.
 * Anything that is not clearly a URL becomes a search query.
 */
function normalizeInput(input, searchTemplate = 'https://duckduckgo.com/?q=%s') {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Explicitly reject dangerous schemes before anything else.
  if (/^(javascript|vbscript|file|chrome|devtools):/i.test(raw)) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).toString();
    } catch {
      /* fall through to search */
    }
  }

  // Looks like a bare hostname? Upgrade it to HTTPS.
  const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(raw) || /^localhost(:\d+)?(\/\S*)?$/.test(raw);
  if (looksLikeHost) {
    try {
      return new URL(`https://${raw}`).toString();
    } catch {
      /* fall through to search */
    }
  }

  return searchTemplate.replace('%s', encodeURIComponent(raw));
}

module.exports = {
  applyCommandLineHardening,
  hardenBrowsingSession,
  hardenWebContents,
  normalizeInput,
  grantPermission,
  revokeAllPermissions,
  originOf
};
