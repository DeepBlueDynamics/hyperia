#!/usr/bin/env node
// Drive a dev Hyperia renderer over Chrome DevTools Protocol. See docs/ui-debugging.md.
//
//   node scripts/cdp.js targets                 list debuggable pages
//   node scripts/cdp.js eval "<js expression>"   evaluate in the main window, print result as JSON
//   node scripts/cdp.js shot out.png [x y w h]   screenshot (optional clip in CSS px, rendered at 2x)
//   node scripts/cdp.js reload                   reload the renderer (like Ctrl+R)
//   node scripts/cdp.js quit                     quit the app cleanly (state saves)
//
// Env: CDP_PORT (default 9333). Needs Node 22+ (global fetch + WebSocket).
'use strict';
const fs = require('fs');

const port = process.env.CDP_PORT || '9333';

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  if (cmd === 'targets') {
    for (const t of targets) console.log(`${t.type}\t${t.title}\t${t.url}`);
    return;
  }
  // The main window is target/index.html; the many sticky windows are not.
  const win = targets.find((t) => t.type === 'page' && /[\\/]target[\\/]index\.html$/.test(decodeURI(t.url)));
  if (!win) throw new Error(`main window not found on :${port}; run "targets" to see what is there`);

  const ws = new WebSocket(win.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({id, method, params}));
    });
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };

  if (cmd === 'eval') {
    console.log(JSON.stringify(await evaluate(arg), null, 1));
  } else if (cmd === 'shot') {
    const params = {format: 'png'};
    if (rest.length === 4) {
      const [x, y, width, height] = rest.map(Number);
      params.clip = {x, y, width, height, scale: 2};
    }
    const r = await send('Page.captureScreenshot', params);
    fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('saved', arg);
  } else if (cmd === 'reload') {
    await send('Page.reload');
    console.log('reloaded');
  } else if (cmd === 'quit') {
    await evaluate("setTimeout(() => require('@electron/remote').app.quit(), 100), 'quitting'");
    console.log('quitting');
  } else {
    throw new Error(`unknown command "${cmd}" (targets | eval | shot | reload | quit)`);
  }
  ws.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
