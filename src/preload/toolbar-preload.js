'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface exposed to the toolbar renderer.
 *
 * Note what is NOT here: no ipcRenderer, no require, no fs, no generic
 * "invoke(channel)" escape hatch. Every function maps to one hard-coded,
 * main-process-validated channel.
 */

const listeners = {
  'nav:state': new Set(),
  'nav:loading': new Set(),
  'nav:blocked': new Set(),
  'page:find-result': new Set()
};

for (const channel of Object.keys(listeners)) {
  ipcRenderer.on(channel, (_event, payload) => {
    for (const fn of listeners[channel]) {
      try {
        fn(payload);
      } catch {
        /* a broken UI listener must never break the bridge */
      }
    }
  });
}

function subscribe(channel) {
  return (fn) => {
    if (typeof fn !== 'function') return () => {};
    listeners[channel].add(fn);
    return () => listeners[channel].delete(fn);
  };
}

contextBridge.exposeInMainWorld('mini', {
  go: (url) => ipcRenderer.invoke('nav:go', String(url)),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: (hard) => ipcRenderer.invoke('nav:reload', Boolean(hard)),
  stop: () => ipcRenderer.invoke('nav:stop'),
  home: () => ipcRenderer.invoke('nav:home'),
  state: () => ipcRenderer.invoke('nav:state'),

  zoom: (direction) => ipcRenderer.invoke('view:zoom', String(direction)),

  clearData: () => ipcRenderer.invoke('privacy:clear'),
  grant: (permission) => ipcRenderer.invoke('privacy:grant', String(permission)),
  privacyReport: () => ipcRenderer.invoke('privacy:report'),

  pin: (value) => ipcRenderer.invoke('bar:pin', Boolean(value)),
  resizeBar: (height) => ipcRenderer.invoke('bar:resize', Number(height)),

  minimize: () => ipcRenderer.invoke('win:minimize'),
  fullscreen: () => ipcRenderer.invoke('win:fullscreen'),
  center: () => ipcRenderer.invoke('win:center'),
  moveBy: (dx, dy) => ipcRenderer.invoke('win:move-by', Number(dx), Number(dy)),
  snap: (where) => ipcRenderer.invoke('win:snap', String(where)),

  find: (query, forward) => ipcRenderer.invoke('page:find', String(query), forward !== false),
  findStop: () => ipcRenderer.invoke('page:find-stop'),
  print: () => ipcRenderer.invoke('page:print'),
  copyUrl: () => ipcRenderer.invoke('page:copy-url'),
  edit: (action) => ipcRenderer.invoke('page:edit', String(action)),
  toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
  close: () => ipcRenderer.invoke('win:close'),
  focusContent: () => ipcRenderer.invoke('win:focus'),
  openExternal: (url) => ipcRenderer.invoke('shell:external', String(url)),

  onState: subscribe('nav:state'),
  onLoading: subscribe('nav:loading'),
  onBlocked: subscribe('nav:blocked'),
  onFindResult: subscribe('page:find-result'),

  platform: process.platform
});
