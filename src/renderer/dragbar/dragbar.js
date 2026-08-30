'use strict';

/* Auto-hiding drag strip.

   The overlay view this runs in is resized by the main process: 6px tall while
   hidden (so the page receives virtually every pointer event) and full height
   while shown. We ask for those resizes over the bar bridge. */

const HIDE_DELAY = 3000;

const body = document.body;
const strip = document.getElementById('strip');
const hotzone = document.getElementById('hotzone');
const pinBtn = document.getElementById('pin');
const titleEl = document.getElementById('title');

let shown = false;
let pinned = false;
let hideTimer = null;

function show() {
  clearTimeout(hideTimer);
  if (!shown) {
    shown = true;
    body.classList.add('shown');
    window.dragbar.expand(true);
  }
  scheduleHide();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (pinned) return;
  hideTimer = setTimeout(hide, HIDE_DELAY);
}

function hide() {
  clearTimeout(hideTimer);
  if (!shown || pinned) return;
  shown = false;
  body.classList.remove('shown');
  // Wait for the slide-up to finish before shrinking the view, otherwise the
  // animation gets clipped.
  setTimeout(() => {
    if (!shown) window.dragbar.expand(false);
  }, 200);
}

// Pointer entering the top sliver reveals the strip.
hotzone.addEventListener('mouseenter', show);
hotzone.addEventListener('mousemove', show);

// While the strip is open, keep it open as long as the pointer is on it.
strip.addEventListener('mouseenter', show);
strip.addEventListener('mousemove', show);
strip.addEventListener('mouseleave', scheduleHide);

// Dragging the window should not let the bar vanish mid-drag.
strip.addEventListener('mousedown', () => clearTimeout(hideTimer));
strip.addEventListener('mouseup', scheduleHide);

// --- buttons ---------------------------------------------------------------

pinBtn.addEventListener('click', () => {
  pinned = !pinned;
  pinBtn.setAttribute('aria-pressed', String(pinned));
  pinBtn.title = pinned ? 'Let this bar auto-hide' : 'Keep this bar visible';
  if (pinned) {
    clearTimeout(hideTimer);
    show();
  } else {
    scheduleHide();
  }
});

document.getElementById('min').addEventListener('click', () => window.dragbar.minimize());
document.getElementById('max').addEventListener('click', () => window.dragbar.toggleMaximize());
document.getElementById('close').addEventListener('click', () => window.dragbar.close());

// --- title -----------------------------------------------------------------

window.dragbar.onTitle((title) => {
  titleEl.textContent = title || 'MiniBrowser';
});

// Reveal briefly on startup so the user knows the strip is there.
show();
