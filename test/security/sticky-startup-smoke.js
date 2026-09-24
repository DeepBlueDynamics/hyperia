// Isolated cold-renderer test: real sticky factory and HTML, no renderer preload.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {app, BrowserWindow} = require('electron');

const root = fs.mkdtempSync(path.resolve(__dirname, '../../.hyperia-test-temp/sticky-startup-'));
process.env.USERPROFILE = root;
process.env.HOME = root;
const assetRoot = process.argv[2] || path.resolve(__dirname, '../../app');
process.env.ELECTRON_IS_DEV = process.argv[2] ? '0' : '1';
if (process.argv[2]) app.getAppPath = () => assetRoot;
assert.equal(os.homedir(), root, 'main process must use the isolated home');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
const notesDir = path.join(root, '.hyperia/stickys');
fs.mkdirSync(notesDir, {recursive: true});
const fixture = {
  id: 'startup-note',
  name: 'Startup fixture',
  text: 'Persisted startup note content',
  open: true
};
const fixtures = Array.from({length: 20}, (_, i) => ({
  ...fixture,
  id: i ? 'startup-note-' + i : fixture.id
}));
fs.writeFileSync(path.join(notesDir, 'notes.json'), JSON.stringify(fixtures));
fs.writeFileSync(path.join(notesDir, 'state.json'), JSON.stringify({hidden: true}));
require('ts-node').register({
  transpileOnly: true,
  project: path.resolve(__dirname, '../../app/tsconfig.json')
});
const {createStickyNote} = require(path.join(assetRoot, 'sticky/window'));
const {reveal} = require(path.join(assetRoot, 'sticky/visibility'));
console.log('Assets: ' + assetRoot + '; version: ' + require(path.join(assetRoot, 'package.json')).version);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

async function run() {
  await app.whenReady();
  const created = fixtures.map((note) => createStickyNote({id: note.id, startHidden: true}).win);
  const win = created[0];
  assert.ok(win);
  for (const restored of created) {
    restored.setFocusable(false);
    restored.setOpacity(0);
    restored.webContents.once('did-finish-load', () => {
      if (!restored.isDestroyed() && !restored.isVisible()) restored.show();
    });
  }
  const failsafe = setTimeout(() => {
    for (const restored of created) {
      if (!restored.isDestroyed() && !restored.isVisible()) restored.show();
    }
  }, 2000);
  win.once('ready-to-show', () => {
    win.setOpacity(0);
    win.setBounds({x: -32000, y: -32000});
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_details, callback) => {
    callback({cancel: true});
  });
  win.webContents.on('did-fail-load', (_event, code, description) => failures.push({code, description}));
  win.webContents.on('render-process-gone', (_event, details) => failures.push(details));
  win.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') failures.push({console: details.message});
  });
  for (let n = 0; n < 100 && win.webContents.isLoading(); n++) await delay(50);
  await delay(3000);
  clearTimeout(failsafe);
  console.log(
    'Restored window counts: ' +
      JSON.stringify({
        total: created.length,
        visible: created.filter((w) => w.isVisible()).length
      })
  );
  assert.equal(created.filter((w) => w.isVisible()).length, 0);
  const rendered = await win.webContents.executeJavaScript(`({
    home: require('os').homedir(),
    title: document.getElementById('title')?.textContent,
    text: document.getElementById('noteText')?.value,
    bodyLength: document.body?.innerHTML.length,
    url: location.href
  })`);
  console.log('Cold startup renderer: ' + JSON.stringify({rendered, failures, visible: win.isVisible()}));
  assert.equal(rendered.home, root, 'renderer must use the isolated home');
  assert.equal(rendered.text, fixture.text, 'cold renderer loads persisted note content without a test preload');
  assert.equal(win.isVisible(), false, 'restored hidden note stays hidden');
  win.showInactive();
  await delay(100);
  assert.equal(win.isVisible(), false, 'stray startup show remains blocked');
  reveal(fixture.id);
  await delay(100);
  assert.equal(win.isVisible(), true, 'explicit open reveals the initialized note');
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("noteText").value'), fixture.text);
  console.log('PASS cold sticky startup and explicit reopen');
  console.log('Isolated artifacts: ' + root);
}

const watchdog = setTimeout(() => {
  console.error('FAIL cold startup timeout; artifacts: ' + root);
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
    console.error('Artifacts: ' + root);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(1);
  }
);
