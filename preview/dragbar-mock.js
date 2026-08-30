/* Mock of the dragbar bridge for browser preview. Not shipped. */
window.dragbar = {
  expand: (v) => parent.postMessage({ type: 'expand', value: v }, '*'),
  minimize: () => {},
  toggleMaximize: () => {},
  close: () => {},
  onTitle: (fn) => { setTimeout(() => fn('The quick brown fox — Preview'), 400); return () => {}; }
};
