'use strict';

/**
 * Pure-logic tests for the security helpers. Run with: npm test
 * Electron is stubbed so these run under plain Node in CI.
 */

const path = require('path');
const Module = require('module');
const assert = require('assert');

// --- stub electron ---------------------------------------------------------
const stub = {
  app: {
    enableSandbox() {},
    getAppPath: () => path.join(__dirname, '..'),
    commandLine: { appendSwitch() {} }
  },
  session: {},
  shell: { openExternal: async () => {} }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const { normalizeInput } = require('../src/main/security');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('normalizeInput');
check('upgrades bare hostnames to https', () => {
  assert.strictEqual(normalizeInput('example.com'), 'https://example.com/');
});
check('keeps explicit https urls', () => {
  assert.strictEqual(normalizeInput('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});
check('allows localhost with a port', () => {
  assert.strictEqual(normalizeInput('localhost:3000'), 'https://localhost:3000/');
});
check('rejects javascript: urls', () => {
  assert.strictEqual(normalizeInput('javascript:alert(1)'), null);
  assert.strictEqual(normalizeInput('JaVaScRiPt:alert(1)'), null);
});
check('rejects file: and chrome: urls', () => {
  assert.strictEqual(normalizeInput('file:///etc/passwd'), null);
  assert.strictEqual(normalizeInput('chrome://settings'), null);
  assert.strictEqual(normalizeInput('devtools://x'), null);
});
check('falls back to an encoded search query', () => {
  assert.strictEqual(normalizeInput('how are you'), 'https://duckduckgo.com/?q=how%20are%20you');
});
check('ignores empty input', () => {
  assert.strictEqual(normalizeInput('   '), null);
});

console.log(`\n${passed} checks passed.`);
