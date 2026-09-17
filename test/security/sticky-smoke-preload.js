// Test-only injection: the production renderer must never see the real notes directory.
'use strict';

const path = require('path');
const bootstrap = require('../../app/sticky-renderer/bootstrap');
const flag = process.argv.find((arg) => arg.startsWith('--sticky-smoke-root='));
if (!flag) throw new Error('Missing isolated sticky smoke directory');
const root = flag.slice('--sticky-smoke-root='.length);
if (!path.isAbsolute(root)) throw new Error('Smoke directory must be absolute');

const boot = bootstrap.boot;
bootstrap.boot = (opts) => {
  const result = boot({...opts, persistDeps: {homedir: root}});
  window.__stickySmoke = result;
  return result;
};
window.__stickySmokeErrors = [];
window.addEventListener('error', (event) => {
  if (event.message) window.__stickySmokeErrors.push(event.message);
});
