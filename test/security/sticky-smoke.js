// Run with the checkout's Electron executable, never the installed Hyperia.
// No Hyperia entrypoint, sidecar, real notes, visible windows, or package build.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const {app, BrowserWindow, ipcMain} = require('electron');

require('ts-node').register({transpileOnly: true, project: path.join(__dirname, '../../app/tsconfig.json')});
const {
  STICKY_WEB_PREFERENCES,
  installStickySecurityGuards,
  handleStickyHighlight
} = require('../../app/sticky/security');
const {stickyWindows} = require('../../app/sticky/registry');

const tempParent = path.resolve(__dirname, '../../.hyperia-test-temp');
fs.mkdirSync(tempParent, {recursive: true});
const root = fs.mkdtempSync(path.join(tempParent, 'sticky-security-'));
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
const notesDir = path.join(root, '.hyperia', 'stickys');
fs.mkdirSync(notesDir, {recursive: true});
const noteText = '<img src=x onerror="window.__unsafe=1"> plain note';
fs.writeFileSync(
  path.join(notesDir, 'notes.json'),
  JSON.stringify([{id: 'smoke-note', name: 'Smoke', text: noteText}])
);
const filePath = path.join(root, 'sample.js');
const fileText = 'const marker = "<img src=x onerror=1>";';
fs.writeFileSync(filePath, fileText);
const blockedFile = path.join(root, 'blocked.html');
fs.writeFileSync(blockedFile, '<!doctype html><title>Unexpected navigation</title>');

let failHighlight = false;
let highlightCalls = 0;
global.fetch = async (url, options) => {
  highlightCalls++;
  assert.equal(url, 'http://localhost:9800/api/notes/highlight');
  assert.equal(options.method, 'POST');
  if (failHighlight) return new Response('unavailable', {status: 503});
  return new Response(
    JSON.stringify({
      rules: [
        {pattern: 'const', className: 'hljs-keyword', color: '#aabbcc'},
        {pattern: 'marker', className: 'hljs-title" onclick="window.__unsafe=1', color: '#fff" data-unsafe="yes'}
      ]
    }),
    {status: 200, headers: {'Content-Type': 'application/json'}}
  );
};
ipcMain.handle('sticky-highlight', handleStickyHighlight);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(win, expression) {
  for (let n = 0; n < 100; n++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + expression);
}

async function openMode(mode) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      ...STICKY_WEB_PREFERENCES,
      preload: path.join(__dirname, 'sticky-smoke-preload.js'),
      additionalArguments: ['--sticky-smoke-root=' + root],
      partition: 'sticky-security-smoke-' + process.pid
    }
  });
  assert.equal(win.webContents.getLastWebPreferences().webSecurity, true);
  assert.equal(win.webContents.getLastWebPreferences().allowRunningInsecureContent, false);
  installStickySecurityGuards(win.webContents);
  stickyWindows.set(mode, win);
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // A test must never talk to a live HTTP service, even if renderer code regresses.
  win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_details, callback) => {
    callback({cancel: true});
  });
  const params = new URLSearchParams({id: 'smoke-note'});
  if (mode === 'search') params.set('mode', 'search');
  if (mode === 'code') params.set('file', filePath);
  await win.loadFile(path.resolve(__dirname, '../../app/sticky.html'), {search: params.toString()});
  await waitFor(win, 'Boolean(window.__stickySmoke)');
  assert.equal(await win.webContents.executeJavaScript('window.__stickySmoke.mode'), mode);
  assert.deepEqual(await win.webContents.executeJavaScript('window.__stickySmokeErrors'), []);
  assert.equal(win.isVisible(), false);
  assert.equal(
    await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("schedOverlay")).display'),
    'none',
    'CSP preserves the initially hidden schedule panel'
  );
  assert.equal(await win.webContents.executeJavaScript('document.styleSheets.length >= 5'), true);
  return win;
}

async function run() {
  await app.whenReady();
  const note = await openMode('note');
  assert.equal(await note.webContents.executeJavaScript('document.getElementById("noteText").value'), noteText);
  await openMode('search');
  const code = await openMode('code');
  assert.equal(
    await code.webContents.executeJavaScript('document.querySelector("#codeBlock code").textContent'),
    fileText
  );
  await code.webContents.executeJavaScript(`
    (() => {
      const {ctx} = window.__stickySmoke;
      ctx.state.highlightMode = 'agent';
      return ctx.syntax.applyHighlight('const marker', document.querySelector('#codeBlock code'));
    })()
  `);
  await waitFor(code, 'document.querySelector("#codeBlock code .hljs-keyword") !== null');
  assert.equal(highlightCalls, 1, 'AI mode used the real IPC handler with mocked HTTP');
  assert.equal(
    await code.webContents.executeJavaScript(
      'document.querySelector("#codeBlock code [onclick], #codeBlock code [data-unsafe]") === null'
    ),
    true
  );
  failHighlight = true;
  await code.webContents.executeJavaScript(`
    window.__stickySmoke.ctx.syntax.applyHighlight('let fallback = 2;', document.querySelector('#codeBlock code'))
  `);
  await waitFor(
    code,
    'document.querySelector("#codeBlock code").textContent === "let fallback = 2;" && document.querySelector("#codeBlock code .hljs-keyword") !== null'
  );
  assert.equal(highlightCalls, 2, 'failed IPC response falls back to local highlighting');

  const csp = await code.webContents.executeJavaScript(`
    (async () => {
      const button = document.createElement('button');
      button.setAttribute('onclick', 'window.__unsafe = 1');
      document.body.appendChild(button);
      button.click();
      const script = document.createElement('script');
      script.textContent = 'window.__unsafe = 2';
      document.body.appendChild(script);
      let fetchBlocked = false;
      try { await window.fetch('data:text/plain,blocked'); } catch { fetchBlocked = true; }
      return {unsafe: window.__unsafe || 0, fetchBlocked};
    })()
  `);
  assert.deepEqual(csp, {unsafe: 0, fetchBlocked: true});
  const count = BrowserWindow.getAllWindows().length;
  await code.webContents.executeJavaScript('window.open("about:blank"); void 0');
  await delay(100);
  assert.equal(BrowserWindow.getAllWindows().length, count, 'popup denied');
  const originalUrl = code.webContents.getURL();
  const navigationEvents = [];
  code.webContents.on('will-navigate', (_event, url) => navigationEvents.push(url));
  const blockedUrl = pathToFileURL(blockedFile).href;
  await code.webContents.executeJavaScript('window.location.href = ' + JSON.stringify(blockedUrl) + '; void 0');
  await delay(100);
  assert.ok(navigationEvents.includes(blockedUrl), 'ordinary file navigation emitted the guard event');
  assert.equal(code.webContents.getURL(), originalUrl, 'navigation to untrusted local HTML denied');

  // Upstream Electron #21136: about:blank may bypass will-navigate entirely.
  // Record this separately; never call the event guard a complete isolation boundary.
  const beforeBlank = navigationEvents.length;
  await code.webContents.executeJavaScript('window.location.href = "about:blank"; void 0');
  await delay(100);
  console.log(
    'about:blank diagnostic: ' +
      JSON.stringify({
        url: code.webContents.getURL(),
        emittedWillNavigate: navigationEvents.length > beforeBlank
      })
  );
  console.log(
    'PASS sticky Electron security smoke: note/search/code, IPC/fallback, malicious attributes, CSP, popup/local-file navigation'
  );
  console.log('Isolated artifacts: ' + root);
}

const watchdog = setTimeout(() => {
  console.error('FAIL sticky smoke timeout');
  app.exit(1);
}, 20000);

run().then(
  () => {
    clearTimeout(watchdog);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(0);
  },
  (err) => {
    clearTimeout(watchdog);
    console.error(err);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(1);
  }
);
