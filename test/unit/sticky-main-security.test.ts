/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

import {createStickyFixture, type FakeBrowserWindow} from '../helpers/sticky-main-fixture';

// ── 1. WebPreferences & Security Flags ──────────────────────────────────────

test.serial(
  'security: factory window webPreferences enforces explicit webSecurity:true and allowRunningInsecureContent:false',
  (t) => {
    const f = createStickyFixture(t);
    const res = f.sticky.createStickyNote({text: 'security check'});
    const win = res.win as FakeBrowserWindow;

    t.truthy(win.opts.webPreferences, 'webPreferences must be defined');
    t.is(win.opts.webPreferences.webSecurity, true, 'webSecurity must be explicitly true');
    t.is(
      win.opts.webPreferences.allowRunningInsecureContent,
      false,
      'allowRunningInsecureContent must be explicitly false'
    );
  }
);

// ── 2. Navigation & Window Open Guards ──────────────────────────────────────

test.serial(
  'security: factory window webContents installs navigation, redirect, new-window, and webview guards',
  (t) => {
    const f = createStickyFixture(t);
    const res = f.sticky.createStickyNote({text: 'guard check'});
    const win = res.win as FakeBrowserWindow;
    const wc = win.webContents;

    t.is(typeof wc.windowOpenHandler, 'function', 'setWindowOpenHandler must be installed');
    t.deepEqual(wc.windowOpenHandler!({url: 'https://evil.com'} as any), {action: 'deny'});

    const willNavigate = wc.listeners['will-navigate'];
    t.truthy(willNavigate && willNavigate.length > 0, 'will-navigate listener must be registered');
    let navPrevented = false;
    willNavigate[0](
      {
        preventDefault: () => {
          navPrevented = true;
        }
      },
      'https://malicious.example.com'
    );
    t.true(navPrevented, 'will-navigate must prevent external navigation');

    const willRedirect = wc.listeners['will-redirect'];
    t.truthy(willRedirect && willRedirect.length > 0, 'will-redirect listener must be registered');
    let redirectPrevented = false;
    willRedirect[0](
      {
        preventDefault: () => {
          redirectPrevented = true;
        }
      },
      'https://malicious.example.com'
    );
    t.true(redirectPrevented, 'will-redirect must prevent redirects');

    const willAttachWebview = wc.listeners['will-attach-webview'];
    t.truthy(willAttachWebview && willAttachWebview.length > 0, 'will-attach-webview listener must be registered');
    let webviewPrevented = false;
    willAttachWebview[0]({
      preventDefault: () => {
        webviewPrevented = true;
      }
    });
    t.true(webviewPrevented, 'will-attach-webview must prevent webview attachment');
  }
);

// ── 3. Sticky-Highlight IPC Channel Validation ──────────────────────────────

test.serial('security: sticky-highlight rejects foreign or unregistered webContents sender', async (t) => {
  const f = createStickyFixture(t);
  t.true(f.ipcHasHandler('sticky-highlight'), 'sticky-highlight IPC handler must be registered');

  // Foreign webContents not associated with any sticky window
  const foreignSender = {mainFrame: {parent: null}};
  const event = {sender: foreignSender, senderFrame: foreignSender.mainFrame};
  const res = await f.ipcInvoke('sticky-highlight', event, {content: 'const a = 1;'});

  t.is(res.ok, false);
  t.regex(res.error || '', /not a registered sticky window|unregistered|unauthorized/i);
});

test.serial('security: sticky-highlight rejects subframe or iframe senderFrame', async (t) => {
  const f = createStickyFixture(t);
  const note = f.sticky.createStickyNote({text: 'frame check'});
  const win = note.win as FakeBrowserWindow;

  // Registered sticky webContents, but senderFrame is a child frame/iframe
  const subframe = {parent: win.webContents.mainFrame};
  const event = {sender: win.webContents, senderFrame: subframe};
  const res = await f.ipcInvoke('sticky-highlight', event, {content: 'const a = 1;'});
  t.is(res.ok, false);
  t.regex(res.error || '', /frame/i);

  // Missing senderFrame entirely
  const resMissingFrame = await f.ipcInvoke('sticky-highlight', {sender: win.webContents}, {content: 'const a = 1;'});
  t.is(resMissingFrame.ok, false);

  // Missing mainFrame on sender
  const origMainFrame = win.webContents.mainFrame;
  (win.webContents as any).mainFrame = null;
  try {
    const resNoMain = await f.ipcInvoke(
      'sticky-highlight',
      {sender: win.webContents, senderFrame: {}},
      {content: 'const a = 1;'}
    );
    t.is(resNoMain.ok, false);
    t.regex(resNoMain.error || '', /frame/i);
  } finally {
    (win.webContents as any).mainFrame = origMainFrame;
  }
});

test.serial('security: sticky-highlight rejects invalid payload and oversize content (>4000 chars)', async (t) => {
  const f = createStickyFixture(t);
  const note = f.sticky.createStickyNote({text: 'payload check'});
  const win = note.win as FakeBrowserWindow;
  const event = {sender: win.webContents, senderFrame: win.webContents.mainFrame};

  // Missing or non-string payload
  const resNull = await f.ipcInvoke('sticky-highlight', event, null);
  t.is(resNull.ok, false);

  const resNonString = await f.ipcInvoke('sticky-highlight', event, {content: 12345});
  t.is(resNonString.ok, false);

  // Oversize payload > 4000 chars
  const oversizeText = 'a'.repeat(4001);
  const resOversize = await f.ipcInvoke('sticky-highlight', event, {content: oversizeText});
  t.is(resOversize.ok, false);
  t.regex(resOversize.error || '', /oversize|length|bound/i);

  // Exactly 4000 chars succeeds without oversize rejection
  const originalFetch = (global as any).fetch;
  (global as any).fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({rules: []})
    });
  try {
    const res4000 = await f.ipcInvoke('sticky-highlight', event, {content: 'a'.repeat(4000)});
    t.is(res4000.ok, true);
  } finally {
    (global as any).fetch = originalFetch;
  }
});

test.serial('security: sticky-highlight handles sidecar timeout and error status gracefully', async (t) => {
  const f = createStickyFixture(t);
  const note = f.sticky.createStickyNote({text: 'timeout check'});
  const win = note.win as FakeBrowserWindow;
  const event = {sender: win.webContents, senderFrame: win.webContents.mainFrame};

  // Mock global.fetch to simulate timeout or failure
  const originalFetch = (global as any).fetch;
  (global as any).fetch = () => Promise.reject(new Error('Connection refused to sidecar'));

  try {
    const res = await f.ipcInvoke('sticky-highlight', event, {content: 'console.log("hello");'});
    t.is(res.ok, false);
    t.deepEqual(res.rules, []);
    t.truthy(res.error);
  } finally {
    (global as any).fetch = originalFetch;
  }
});

test.serial('security: sticky-highlight processes valid registered request with content <= 4000', async (t) => {
  const f = createStickyFixture(t);
  const note = f.sticky.createStickyNote({text: 'valid check'});
  const win = note.win as FakeBrowserWindow;
  const event = {sender: win.webContents, senderFrame: win.webContents.mainFrame};

  const originalFetch = (global as any).fetch;
  let requestedUrl = '';
  let requestedBody = '';

  (global as any).fetch = (url: string, init: any) => {
    requestedUrl = url;
    requestedBody = init?.body || '';
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({rules: [{pattern: 'test', class: 'keyword'}]})
    });
  };

  try {
    const sampleCode = 'function hello() { return 42; }';
    const res = await f.ipcInvoke('sticky-highlight', event, {content: sampleCode});
    t.is(res.ok, true);
    t.deepEqual(res.rules, [{pattern: 'test', class: 'keyword'}]);
    t.true(requestedUrl.includes('/api/notes/highlight'));
    t.is(JSON.parse(requestedBody).content, sampleCode);
  } finally {
    (global as any).fetch = originalFetch;
  }
});
