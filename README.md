<div align="center">

<img src="assets/icon.png" width="112" alt="MiniBrowser" />

# MiniBrowser

**A security-first minimal web browser with a detached, floating control bar.**

Windows · macOS · Linux

</div>

---

## What makes it different

The page and the browser UI live in **two separate OS windows**.

- **Content window** — *only* the webpage. Frameless: no title bar, no native menu, no buttons, no borders. The page is rendered edge to edge and nothing else exists in that window.
- **Control bar** — its own frameless, transparent, always-on-top window that floats over everything like a picture-in-picture player. It owns **every** menu, button and control in the application. Drag it anywhere, resize it, park it on a second monitor.

Because the bar is a genuinely separate window with its own renderer process, a compromised page has **no DOM access to the address bar at all** — it cannot spoof the URL, fake the lock icon, or phish your input.

## Ad blocker

A real filter engine, written from scratch with no dependencies. It parses **Adblock Plus / uBlock Origin syntax**:

| Syntax | Meaning |
|---|---|
| `\|\|example.com^` | Block a domain and its subdomains |
| `\|http://example.com` | Anchor to the start of the URL |
| `/banner/*.gif\|` | Wildcards and an end anchor |
| `/ads?\d+/` | Regular-expression rules |
| `@@\|\|example.com^` | **Exception** — allow, overrides blocks |
| `$script,image,third-party` | Restrict by resource type and party |
| `$domain=a.com\|~b.com` | Scope to (or exclude) specific sites |
| `example.com##.ad-banner` | **Cosmetic** — hide the element |
| `example.com#@#.ad-banner` | Cosmetic exception |

**Network filtering** cancels the request before a byte is sent. **Cosmetic filtering** injects a user-origin stylesheet on `dom-ready`, so the empty gap where an ad used to be collapses instead of leaving a hole.

### Speed

Every rule is indexed under the longest token in its pattern, so a lookup only tests the handful of rules sharing a token with the URL — not the whole list:

```
20,157 rules → 0.005 ms per lookup
```

That is roughly 190,000 URL checks per second, so the blocker is never the bottleneck.

### Controls

- **Master switch** and a separate **cosmetic hiding** toggle
- **Per-site allowlist** — "Allow ads on this site" when a site breaks; persisted across restarts
- **Live counters** — ads blocked on the page (in the shield chip), session totals, rule counts
- **Top blocked domains** report
- **Optional subscriptions** to EasyList, EasyPrivacy and Fanboy's Annoyances

The built-in list ships **offline** — a fresh install makes no network request before your first page loads, so there is nothing to intercept or poison. Subscriptions are opt-in from the Ad Block menu, cached to disk, and merged with the built-in rules.

## Security model

The rendered page is treated as fully hostile. Every layer below is on by default.

| Layer | Protection |
|---|---|
| **Process** | Chromium sandbox forced on (`app.enableSandbox()`), `site-per-process` site isolation, strict origin isolation |
| **Renderer** | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, DevTools disabled, `AutomationControlled` disabled |
| **IPC** | No generic invoke bridge. Each capability is a hard-coded channel; the main process rejects any message that did not come from the toolbar window |
| **Navigation** | `javascript:`, `file:`, `chrome:`, `devtools:` and every unknown scheme are refused. Bare hostnames are upgraded to HTTPS |
| **Popups** | `setWindowOpenHandler` denies all window creation; `will-attach-webview` is blocked |
| **Permissions** | Camera, mic, location, notifications, USB, HID, serial and Bluetooth are **denied by default**. You grant them per-site, per-session, from the menu |
| **Certificates** | Invalid certificates are never overridable — the load simply fails |
| **Downloads** | Blocked from starting silently; you are notified instead |
| **Ads & tracking** | Full Adblock Plus-syntax filter engine — see below |
| **Cookies** | Third-party `Cookie` and `Referer` headers stripped on the way out; third-party `Set-Cookie` stripped on the way in |
| **Headers** | `DNT: 1` and `Sec-GPC: 1` sent on every request |
| **UI** | Toolbar page ships a strict CSP: `default-src 'none'`, no inline script, no remote origins |

One click on **Clear all browsing data** wipes cookies, localStorage, IndexedDB, service workers, caches, auth cache, DNS cache, and every permission grant.

## The floating bar

```
 ┌──────────────────────────────────────────────────────────┐
 │ 🛡  File  Edit  View  History  Privacy  Window    ─ □ ✕  │  ← menubar
 │  ‹  ›  ⟳  ⌂   🔒 en.wikipedia.org/wiki/…    🛡 7    ✥    │  ← navigation
 │ ────────────────────── progress ──────────────────────── │
 │ 🔍 find in page                        3/12   ˄ ˅  ✕     │  ← find (Ctrl+F)
 └──────────────────────────────────────────────────────────┘
```

**Row 1 — the menubar.** A full application menubar, hover-to-slide between menus just like a native one:

| Menu | Contains |
|---|---|
| **File** | New address, home, copy page address, open in system browser, print, quit |
| **Edit** | Undo/redo, cut/copy/paste, select all, find in page |
| **View** | Reload, hard reload, stop, zoom in/out/reset (live %), full screen |
| **History** | Back, forward, home, plus current page + connection status |
| **Ad Block** | On/off, cosmetic hiding, per-site allowlist, live counters, top blocked domains, filter-list subscriptions |
| **Privacy** | Per-site grants (camera / mic / location / notifications), clear all data |
| **Window** | **Always on top**, **transparency slider**, minimize, maximize, center, snap left/right/fill, "bar follows page window" toggle |

Window buttons (─ □ ✕) on the right control the **page** window and live here too.

**Row 2 — navigation.** Back / forward / reload-stop / home, the omnibox (URL, bare hostname, or a DuckDuckGo search), a lock indicator (green HTTPS, amber otherwise), the tracker shield, and a **✥ move handle** — since the page window is frameless, you drag it from here.

**Row 3 — find in page**, opened with `Ctrl/Cmd+F`, with match counts and next/previous.

The bar grows and shrinks automatically as menus and the find bar open.

### Responsive

The bar reflows as you resize it: menu titles drop out progressively (Edit/Window at 700px, File/History at 560px, View at 420px), the home button and move handle hide at 560px, and on touch screens (`pointer: coarse`) every hit target grows to 42px. Dark and light themes follow the OS, and `prefers-reduced-motion` is respected.

### Shortcuts

| | |
|---|---|
| `Ctrl/Cmd + L` | Focus address bar |
| `Ctrl/Cmd + R` | Reload (`+Shift` bypasses cache) |
| `Alt + ← / →` | Back / forward |
| `Ctrl/Cmd + + / − / 0` | Zoom in / out / reset |
| `Ctrl/Cmd + F` | Find in page |
| `Ctrl/Cmd + P` | Print |
| `Ctrl/Cmd + Shift + C` | Copy page address |
| `F11` | Full screen the page window |
| `Ctrl/Cmd + T` | Toggle always on top |
| `Esc` | Close menu / find bar, or revert the address bar |

## Running it

```bash
npm install
npm start
```

> **Note:** `npm install` downloads the Chromium binary from GitHub releases. If you are behind a restricted network, set a mirror first:
> ```bash
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> npm install
> ```

## Tests

```bash
npm test
```

**38 checks**, no Electron required:

- `logic.test.js` — URL normalisation, including rejection of `javascript:` / `file:` / `chrome:`
- `adblock.test.js` — every filter syntax form, `$type` / `$third-party` / `$domain` options, exception rules, cosmetic matching and inheritance, parser robustness against malformed input, verification that real ad servers are blocked while Wikipedia/GitHub/jsDelivr are not, and a performance assertion on 20k rules

## Building installers

```bash
npm run dist:win     # NSIS installer + portable .exe
npm run dist:mac     # .dmg + .zip (hardened runtime)
npm run dist:linux   # AppImage + .deb
npm run dist:all     # all three
```

Output lands in `release/`. Cross-compiling to macOS requires macOS; Windows and Linux targets can be built from Linux.

## UI preview without Electron

```bash
python3 -m http.server 3000
# open http://localhost:3000/preview/
```

Runs the real toolbar HTML/CSS/JS against a mock bridge so you can see the layout and responsive behaviour in any browser.

## Layout

```
src/
  main/
    main.js             app lifecycle, two windows, IPC handlers
    security.js         hardening policy, permissions, URL normalisation
    adblock/
      index.js          blocker: allowlist, stats, subscriptions, cosmetics
      filter-engine.js  ABP-syntax parser + token-indexed matcher
      default-filters.js  built-in offline filter list
  preload/
    toolbar-preload.js  the entire (tiny) privileged API surface
  renderer/toolbar/     the floating bar UI
preview/                browser-only mock for previewing the UI
test/                   38 pure-logic tests
```

## License

MIT
