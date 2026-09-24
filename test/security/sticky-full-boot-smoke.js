// Launch the packaged main entry in a disposable profile; never start/kill a sidecar.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {app, BrowserWindow, session} = require('electron');
const assert = require('assert/strict');
const assetRoot = process.argv[2];
if (!assetRoot || !path.isAbsolute(assetRoot)) throw new Error('Pass an absolute packaged app.asar path');
const root = fs.mkdtempSync(path.resolve(__dirname, '../../.hyperia-test-temp/sticky-full-boot-'));
process.env.USERPROFILE = root;
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.ELECTRON_IS_DEV = '0';
process.env.HYPERIA_USE_EXTERNAL_SIDECAR = '1';
process.env.HYPERIA_PORT = '19893';
assert.equal(os.homedir(), root);
fs.mkdirSync(path.join(root, 'appData'), {recursive: true});
app.setPath('appData', path.join(root, 'appData'));
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
app.setPath('home', root);
app.getAppPath = () => assetRoot;
global.fetch = () => Promise.reject(new Error('HTTP blocked by isolated boot test'));
const base = path.join(root, '.hyperia');
fs.mkdirSync(path.join(base, 'stickys'), {recursive: true});
fs.mkdirSync(path.join(base, 'workspaces'), {recursive: true});
fs.mkdirSync(path.join(root, 'config/Hyperia'), {recursive: true});
fs.writeFileSync(
  path.join(root, 'config/Hyperia/hyperia.json'),
  JSON.stringify({
    config: {useExternalSidecar: true},
    plugins: [],
    localPlugins: []
  })
);
const notes = Array.from({length: 20}, (_, i) => ({
  id: 'boot-note-' + i,
  name: 'Fixture ' + i,
  text: 'Persisted text ' + i,
  open: true,
  x: 20,
  y: 20,
  width: 280,
  height: 220,
  color: '#fff9c4'
}));
fs.writeFileSync(path.join(base, 'stickys/notes.json'), JSON.stringify(notes));
fs.writeFileSync(path.join(base, 'stickys/state.json'), JSON.stringify({hidden: true}));
fs.writeFileSync(
  path.join(base, 'workspaces/last-session.json'),
  JSON.stringify({
    kind: 'hyperia-workspace',
    schemaVersion: 1,
    name: 'last-session',
    windows: [
      {
        geometry: {x: 0, y: 0, width: 800, height: 600},
        layout: {termGroups: {}, sessions: {}}
      }
    ],
    stickys: notes.map(({id, x, y, width, height, open}) => ({
      id,
      x,
      y,
      width,
      height,
      open
    }))
  })
);
const errors = [];
const shown = [];
app.on('browser-window-created', (_event, win) => {
  let painted = false;
  win.once('ready-to-show', () => {
    painted = true;
  });
  win.on('show', () =>
    shown.push({
      id: win.id,
      painted,
      loading: win.webContents.isLoading(),
      url: win.webContents.getURL()
    })
  );
  win.setOpacity(0);
  win.setFocusable(false);
  win.webContents.on('did-fail-load', (_e, code, description, url) =>
    errors.push({id: win.id, code, description, url})
  );
  win.webContents.on('render-process-gone', (_e, details) => errors.push({id: win.id, ...details}));
});
app.on('ready', () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest(
    {urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']},
    (_d, callback) => callback({cancel: true})
  );
  setTimeout(() => {
    void finish();
  }, 8000);
});
async function finish() {
  try {
    const records = [];
    for (const win of BrowserWindow.getAllWindows()) {
      records.push({
        id: win.id,
        visible: win.isVisible(),
        url: win.webContents.getURL(),
        renderer: await win.webContents.executeJavaScript(
          '({title: document.title, bodyLength: document.body?.innerHTML.length, note: document.getElementById("noteText")?.value})'
        )
      });
    }
    console.log(
      'FULL BOOT RESULT: ' +
        JSON.stringify({
          total: records.length,
          loadedNotes: records.filter((w) => w.renderer.note).length,
          visibleNotes: records.filter((w) => w.url.includes('sticky.html') && w.visible).length,
          stickyShowCount: shown.filter((w) => w.url.includes('sticky.html')).length,
          shownBeforePaint: shown.filter((w) => w.url.includes('sticky.html') && !w.painted).length,
          errors,
          root,
          userData: app.getPath('userData')
        })
    );
    assert.ok(app.getPath('userData').startsWith(root), 'Electron profile is isolated');
    assert.deepEqual(errors, [], 'startup has no page-load or renderer-process failures');
    const terminalWindows = records.filter((w) => w.renderer.title === 'Hyperia');
    assert.equal(terminalWindows.length, 1, 'the saved terminal window is restored');
    assert.equal(terminalWindows[0].visible, true, 'terminal startup presentation still works');
    assert.equal(
      shown.filter((w) => w.url.includes('sticky.html')).length,
      0,
      'hidden notes must never be shown, including before first paint'
    );
    assert.equal(records.filter((w) => w.url.includes('sticky.html') && w.visible).length, 0);
    assert.equal(records.filter((w) => w.url.includes('sticky.html')).length, 20);
    assert.ok(
      records.filter((w) => w.url.includes('sticky.html')).every((w) => w.renderer.note?.startsWith('Persisted text '))
    );
    console.log('PASS packaged full boot hidden notes');
    cleanup(0);
  } catch (error) {
    console.error(error);
    cleanup(1);
  }
}
function cleanup(code) {
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.exit(code);
}
setTimeout(() => {
  console.error('FAIL full boot watchdog; artifacts: ' + root);
  cleanup(1);
}, 25000);
console.log('ISOLATED FULL BOOT: ' + root);
// Patch only after normal loading, so production config initialization order is preserved.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function loadIsolatedBootModule(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  const resolved = Module._resolveFilename(request, parent);
  if (resolved === path.join(assetRoot, 'utils/cli-install.js')) loaded.installCLI = () => {};
  if (resolved === path.join(assetRoot, 'plugins/install.js')) loaded.install = (done) => done(null);
  return loaded;
};
try {
  require(path.join(assetRoot, 'index.js'));
} catch (error) {
  console.error(error);
  cleanup(1);
}
