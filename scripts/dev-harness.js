#!/usr/bin/env node
// Sandboxed end-to-end harness for pane/tab lifecycle bugs. See docs/ui-debugging.md.
//
//   node scripts/dev-harness.js            build, launch a sandboxed dev copy, run all scenarios
//   node scripts/dev-harness.js --no-build skip tsc/webpack (use the current target/)
//   node scripts/dev-harness.js --only s1,s4
//
// Sandbox: temp USERPROFILE/HOME/APPDATA (your ~/.hyperia is never touched), sidecar on
// :9801, CDP on :9333, 127.0.0.1 only. Refuses to run while an installed Hyperia or any
// hyperia-sidecar.exe is running (dev startup kills sidecars by image name).
'use strict';
const {spawn, execSync} = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CDP_PORT = 9333;
// Not 9801: that is the n8 gateway's port, and it outlives Hyperia.
const SIDECAR_PORT = 9811;
const args = process.argv.slice(2);
const ONLY = (args.find((a) => a.startsWith('--only')) || '').split('=')[1] || args[args.indexOf('--only') + 1] || '';
const only = ONLY && !ONLY.startsWith('--') ? new Set(ONLY.split(',')) : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[harness]', ...a);

// ---------- preflight ----------
function running(image) {
  try {
    return execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, {encoding: 'utf8'})
      .toLowerCase()
      .includes(image.toLowerCase());
  } catch {
    return false;
  }
}
async function portFree(port) {
  return new Promise((res) => {
    const s = require('net').createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

// ---------- CDP ----------
async function mainTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`, {signal: AbortSignal.timeout(5000)})).json();
  return targets.find((t) => t.type === 'page' && /[\\/]target[\\/]index\.html$/.test(decodeURI(t.url)));
}
// One CDP call on a fresh socket, bounded so a vanished window can't hang the run.
async function cdp(method, params = {}, timeoutMs = 60000) {
  const t = await mainTarget();
  if (!t) throw new Error('main window not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
        return await new Promise((res) => {
          ws.onmessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.id === 1) res(d);
          };
          ws.send(JSON.stringify({id: 1, method, params}));
        });
      })(),
      new Promise((_r, rej) => (timer = setTimeout(() => rej(new Error(`CDP ${method} timed out`)), timeoutMs)))
    ]);
  } finally {
    clearTimeout(timer);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}
// Run fn(...args) in the renderer; fn must be self-contained.
async function run(fn, ...fnArgs) {
  const expression = `(${fn.toString()})(...${JSON.stringify(fnArgs)})`;
  const r = await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'renderer eval failed');
  }
  return r.result?.result?.value;
}

// Renderer-side helpers, injected once per page load.
const HELPERS = function () {
  if (window.__h) return true;
  const S = () => (window.store || window.rpc.store).getState();
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const roots = () => Object.values(S().termGroups.termGroups).filter((g) => !g.parentUid);
  const rootOf = (g) => {
    const tg = S().termGroups.termGroups;
    while (g && g.parentUid) g = tg[g.parentUid];
    return g;
  };
  const paneSessions = (rootUid) =>
    Object.values(S().termGroups.termGroups)
      .filter((g) => g.sessionUid && rootOf(g)?.uid === rootUid)
      .map((g) => g.sessionUid);
  const pressOnPicker = async (key) => {
    const cont = [...document.querySelectorAll('.term_pickerContainer')].find((c) => c.offsetParent);
    if (!cont) throw new Error('no visible picker');
    for (const t of ['keydown', 'keypress', 'keyup'])
      cont.dispatchEvent(new KeyboardEvent(t, {key, code: 'Key' + key.toUpperCase(), bubbles: true}));
  };
  const newPickerTab = async () => {
    window.rpc.emit('new', {isNewGroup: true, profile: 'picker'});
    await pause(2500);
    const root = S().termGroups.activeRootGroup;
    return {root, session: S().termGroups.activeSessions[root]};
  };
  const closeTab = async (rootUid) => {
    const idx = roots().findIndex((g) => g.uid === rootUid);
    const x = [...document.querySelectorAll('.tab_tab')][idx]?.querySelector('.tab_icon');
    if (!x) throw new Error('tab close control not found');
    x.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    x.click();
    await pause(2500);
  };
  const win = () => require('@electron/remote').getCurrentWindow();
  window.__h = {S, pause, roots, paneSessions, pressOnPicker, newPickerTab, closeTab, win};
  return true;
};
const h = async () => run(HELPERS);

// The sandbox's own sidecar: listening on SIDECAR_PORT, named
// hyperia-sidecar.exe, and descended from the Electron this harness launched.
// Never matches the user's Hyperia.
function sandboxSidecarPid(rootPid) {
  const procs = JSON.parse(
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"',
      {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}
    )
  );
  const parent = new Map(procs.map((x) => [x.ProcessId, x.ParentProcessId]));
  const listening = execSync('netstat -ano -p tcp', {encoding: 'utf8'})
    .split(/\r?\n/)
    .filter((l) => /LISTENING/.test(l) && new RegExp(`:${SIDECAR_PORT}\\s`).test(l))
    .map((l) => Number(l.trim().split(/\s+/).pop()));
  return procs
    .filter((x) => listening.includes(x.ProcessId) && /^hyperia-sidecar\.exe$/i.test(x.Name))
    .map((x) => x.ProcessId)
    .find((pid) => {
      for (let cur = pid, i = 0; cur && i < 12; cur = parent.get(cur), i++) if (cur === rootPid) return true;
      return false;
    });
}
async function sidecarPane(uid) {
  const j = await (
    await fetch(`http://127.0.0.1:${SIDECAR_PORT}/api/status`, {signal: AbortSignal.timeout(5000)})
  ).json();
  for (const w of j.windows || [])
    for (const t of w.tabs || [])
      for (const pn of t.panes || []) {
        if (pn.paneId === uid) return {state: pn.state, app: pn.app?.name || '', cwd: pn.cwd || ''};
      }
  return null;
}

// ---------- scenarios ----------
// Each returns {pass, detail}. `ctx` carries the harness log file and a page server.
const scenarios = [
  {
    id: 's1',
    name: 'Picker -> shell closes the old picker session',
    async run() {
      await h();
      const r = await run(async () => {
        const {S, pause, newPickerTab, pressOnPicker} = window.__h;
        const {root, session: picker} = await newPickerTab();
        await pressOnPicker('s');
        await pause(3500);
        const now = S().termGroups.activeSessions[root];
        return {
          picker,
          now,
          profile: S().sessions.sessions[now]?.profile,
          pickerInStore: !!S().sessions.sessions[picker]
        };
      });
      const pass = r.now !== r.picker && !r.pickerInStore;
      return {pass, detail: `pane now ${r.profile}; old picker still in store: ${r.pickerInStore}`, data: r};
    }
  },
  {
    id: 's2',
    name: 'Closing the last tab when split [shell | picker] exits both panes',
    async run(ctx) {
      await h();
      const r = await run(async () => {
        const {S, pause, roots, paneSessions, newPickerTab, pressOnPicker, closeTab} = window.__h;
        const {root} = await newPickerTab();
        await pressOnPicker('s');
        await pause(3500);
        window.rpc.emit('split request vertical', {activeUid: S().termGroups.activeSessions[root]});
        await pause(2500);
        for (const g of roots()) if (g.uid !== root) await closeTab(g.uid);
        return {root, panes: paneSessions(root).map((u) => ({u, profile: S().sessions.sessions[u]?.profile}))};
      });
      // Closing the last tab may close the window, so fire it and read main's log.
      await run((root) => {
        setTimeout(() => window.__h.closeTab(root), 50);
        return true;
      }, r.root);
      await wait(6000);
      const mainLog = ctx.mainLog();
      const exits = r.panes.map((p) => ({...p, n: mainLog.split(`exit request: ${p.u}`).length - 1}));
      const pass = exits.length === 2 && exits.every((e) => e.n > 0);
      return {pass, detail: `panes ${exits.map((e) => `${e.u.slice(0, 8)}(${e.profile}):exit x${e.n}`).join(' ')}`};
    }
  },
  {
    id: 's3',
    name: 'No stray tabs appear after the orphan sweep window',
    async run(ctx) {
      await h();
      const before = await run(() => window.__h.roots().length);
      await wait(20000);
      const after = await run(() => window.__h.roots().length);
      const reattached = (ctx.mainLog().match(/\[recover\] auto re-attached/g) || []).length;
      return {
        pass: after === before && reattached === 0,
        detail: `tabs ${before} -> ${after}; auto re-attaches logged: ${reattached}`
      };
    }
  },
  {
    id: 's4',
    name: 'Reloading the renderer removes web pane views (no stuck native view)',
    async run(ctx) {
      await h();
      await run(async (url) => {
        (window.store || window.rpc.store).dispatch({type: 'TERM_GROUP_ADD_WEB_TAB', url, name: 'harness'});
        await window.__h.pause(3000);
      }, ctx.pageUrl);
      const before = await run(() => window.__h.win().contentView.children.length);
      await cdp('Page.reload');
      await wait(6000);
      await h();
      const r = await run(() => {
        const {S, win} = window.__h;
        const webGroups = Object.values(S().termGroups.termGroups).filter((g) => g.webUrl).length;
        // The native toast layer (#298) is a permanent, non-web-pane child view.
        const kids = win().contentView.children.map((v) => {
          try {
            return v.webContents.getURL();
          } catch {
            return '?';
          }
        });
        const views = kids.filter((u) => !/toast-layer.html/.test(u));
        return {views: views.length, webGroups, urls: kids.map((u) => u.split('/').pop()).join(', ')};
      });
      return {
        pass: before >= 1 && r.views <= r.webGroups,
        detail: `views before reload ${before}; after reload ${r.views} web view(s) for ${r.webGroups} web pane(s) [all child views: ${r.urls}]`
      };
    }
  },
  {
    id: 's5',
    name: 'Autosave: a cd writes the saved tab and pulses the tab line',
    async run() {
      await h();
      const r = await run(async () => {
        const {S, pause, newPickerTab, pressOnPicker} = window.__h;
        const {root} = await newPickerTab();
        await pressOnPicker('s');
        await pause(3500);
        const uid = S().termGroups.activeSessions[root];
        window.dispatchEvent(
          new CustomEvent('hyperia-save-tab-workspace', {detail: {rootUid: root, defaultName: 'harness-autosave'}})
        );
        await pause(500);
        const label = [...document.querySelectorAll('label')].find((l) => /Autosave changes/.test(l.innerText));
        if (!label) return {error: 'no autosave checkbox (is #284 in this build?)'};
        const cb = label.querySelector('input');
        if (!cb.checked) cb.click();
        const events = [];
        const t0 = Date.now();
        const onRes = (res) => events.push({ms: Date.now() - t0, ok: res.ok, autosave: !!res.autosave});
        window.rpc.on('save tab workspace result', onRes);
        [...document.querySelectorAll('button')].find((b) => /^(Save|Overwrite)$/.test(b.innerText.trim())).click();
        let manualPulse = false;
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('.tab_autosavePulse')) manualPulse = true;
          await pause(100);
        }
        const t1 = Date.now();
        window.rpc.emit('data', {uid, data: 'cd ..' + String.fromCharCode(13)});
        let pulseAt = null;
        while (Date.now() - t1 < 6000) {
          if (pulseAt === null && document.querySelector('.tab_autosavePulse')) pulseAt = Date.now() - t1;
          await pause(100);
        }
        window.rpc.removeListener('save tab workspace result', onRes);
        return {log: events, manualPulse, pulseAt, autosaveWrites: events.filter((l) => l.autosave && l.ok).length};
      });
      if (r.error) return {pass: false, detail: r.error};
      const pass = r.autosaveWrites > 0 && r.pulseAt !== null && r.manualPulse;
      return {
        pass,
        detail: `autosave writes after cd: ${r.autosaveWrites}; pulse after cd: ${r.pulseAt === null ? 'none' : r.pulseAt + 'ms'}; pulse on manual Save: ${r.manualPulse}`
      };
    }
  },
  {
    id: 's6',
    name: 'Autosave still writes while titles keep changing (busy agent)',
    async run() {
      await h();
      const r = await run(async () => {
        const {S, pause} = window.__h;
        const root = S().termGroups.activeRootGroup;
        const uid = S().termGroups.activeSessions[root];
        let writes = 0;
        const onRes = (res) => res.autosave && res.ok && writes++;
        window.rpc.on('save tab workspace result', onRes);
        window.rpc.emit('data', {uid, data: 'cd ~' + String.fromCharCode(13)});
        const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴'];
        const t0 = Date.now();
        let i = 0;
        while (Date.now() - t0 < 16000) {
          // What an agent CLI's animated title does (OSC 0 via the pty).
          window.rpc.emit('data', {
            uid,
            data: `$host.ui.RawUI.WindowTitle='${spin[i++ % spin.length]} working'` + String.fromCharCode(13)
          });
          await pause(400);
        }
        window.rpc.removeListener('save tab workspace result', onRes);
        return {writes, titleNow: S().sessions.sessions[uid]?.title};
      });
      return {
        pass: r.writes > 0,
        detail: `autosave writes during 16 s of title churn: ${r.writes} (title now "${r.titleNow}")`
      };
    }
  },
  {
    id: 's9',
    name: 'Restoring an autosave tab keeps autosaving (a cd writes and pulses)',
    async run() {
      await h();
      const r = await run(async () => {
        const {S, pause, roots} = window.__h;
        const before = new Set(roots().map((g) => g.uid));
        window.rpc.emit('restore tab workspace', {name: 'harness-autosave'});
        await pause(5000);
        const root = roots().find((g) => !before.has(g.uid));
        if (!root) return {error: 'restore produced no new tab'};
        const sess = Object.values(S().termGroups.termGroups).find(
          (g) =>
            g.sessionUid &&
            (function up(x) {
              while (x && x.parentUid) x = S().termGroups.termGroups[x.parentUid];
              return x;
            })(g)?.uid === root.uid
        );
        let writes = 0;
        const onRes = (res) => res.autosave && res.ok && writes++;
        window.rpc.on('save tab workspace result', onRes);
        let pulsed = false;
        window.rpc.emit('data', {uid: sess.sessionUid, data: 'cd ..' + String.fromCharCode(13)});
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          if (document.querySelector('.tab_autosavePulse')) pulsed = true;
          await pause(100);
        }
        window.rpc.removeListener('save tab workspace result', onRes);
        return {writes, pulsed, active: S().termGroups.activeRootGroup === root.uid};
      });
      if (r.error) return {pass: false, detail: r.error};
      return {
        pass: r.writes > 0,
        detail: `writes after cd in restored tab: ${r.writes}; pulse: ${r.pulsed} (restored tab active: ${r.active})`
      };
    }
  },
  {
    id: 's10',
    name: 'Deleting an autosaved tab stops autosave from re-creating it',
    async run() {
      await h();
      const r = await run(async () => {
        const {S, pause} = window.__h;
        const listed = () =>
          new Promise((res) => {
            const f = ({rows}) => {
              window.rpc.removeListener('tab workspaces list', f);
              res((rows || []).map((x) => x.name));
            };
            window.rpc.on('tab workspaces list', f);
            window.rpc.emit('list tab workspaces');
          });
        window.rpc.emit('delete tab workspace', {name: 'harness-autosave'});
        await pause(1500);
        const afterDelete = await listed();
        const root = S().termGroups.activeRootGroup;
        const uid = S().termGroups.activeSessions[root];
        if (uid) window.rpc.emit('data', {uid, data: 'cd ~' + String.fromCharCode(13)});
        await pause(5000);
        const later = await listed();
        return {deleted: !afterDelete.includes('harness-autosave'), recreated: later.includes('harness-autosave')};
      });
      return {
        pass: r.deleted && !r.recreated,
        detail: `deleted: ${r.deleted}; re-created by autosave afterwards: ${r.recreated}`
      };
    }
  },
  {
    id: 's11',
    name: 'Double-clicking inside the + menu never maximizes; empty header space still does',
    async run() {
      await h();
      const r = await run(async () => {
        const {pause, win} = window.__h;
        const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
        const w = win();
        if (w.isMaximized()) w.unmaximize();
        await pause(600);
        const menuItem = document.querySelector('.tabs_newTab_tooltip .tabs_layout_item, .tabs_newTab_tooltip div');
        if (!menuItem) return {error: 'no + menu content found'};
        dbl(menuItem);
        await pause(800);
        const afterMenu = w.isMaximized();
        dbl(document.querySelector('.tabs_dragSpace'));
        await pause(800);
        const afterEmpty = w.isMaximized();
        if (afterEmpty) w.unmaximize();
        await pause(400);
        return {afterMenu, afterEmpty};
      });
      if (r.error) return {pass: false, detail: r.error};
      return {
        pass: !r.afterMenu && r.afterEmpty,
        detail: `maximized after menu double-click: ${r.afterMenu}; after empty-space double-click: ${r.afterEmpty}`
      };
    }
  },
  {
    id: 's7',
    name: 'Saved-tabs menu: pane count is a visible badge next to the delete button',
    async run() {
      await h();
      const r = await run(async () => {
        const {pause} = window.__h;
        window.rpc.emit('list tab workspaces');
        await pause(800);
        const menu = [...document.querySelectorAll('.tabs_newTab_tooltip')].find((m) => /Saved Tabs/.test(m.innerText));
        if (!menu) return {error: 'no Saved Tabs section in the + menu'};
        menu.setAttribute('data-harness', '1');
        const st = document.createElement('style');
        st.id = 'harness-show';
        st.textContent = '[data-harness]{display:block!important;visibility:visible!important;opacity:1!important}';
        document.head.appendChild(st);
        await pause(300);
        const trash = menu.querySelector('.ti-trash');
        const row = trash && trash.closest('div');
        const badge = row && row.querySelector('[aria-label$="pane"],[aria-label$="panes"],[aria-label*="panes ("]');
        const rect = (el) => el.getBoundingClientRect();
        const out = {hasBadge: !!badge};
        if (badge && trash) {
          const b = rect(badge);
          const t = rect(trash.parentElement);
          out.gap = Math.round(t.left - b.right);
          out.centerDelta = Math.abs(b.top + b.height / 2 - (t.top + t.height / 2)).toFixed(1);
          out.color = getComputedStyle(badge).color;
        } else if (row) {
          out.text = row.innerText.replace(/\s+/g, ' ');
        }
        st.remove();
        menu.removeAttribute('data-harness');
        return out;
      });
      if (r.error) return {pass: false, detail: r.error};
      const pass = r.hasBadge && r.gap <= 12 && Number(r.centerDelta) <= 1.5;
      return {
        pass,
        detail: r.hasBadge
          ? `badge ${r.color}; gap to delete ${r.gap}px; vertical offset ${r.centerDelta}px`
          : `no badge; row reads "${r.text}"`
      };
    }
  },
  {
    id: 's8',
    name: 'A web view destroyed outside the manager does not crash main',
    async run(ctx) {
      await h();
      await run(async (url) => {
        (window.store || window.rpc.store).dispatch({type: 'TERM_GROUP_ADD_WEB_TAB', url, name: 'harness'});
        await window.__h.pause(3000);
        const v = window.__h.win().contentView.children[0];
        window.__hadView = !!v;
        if (v) v.webContents.close();
        await window.__h.pause(500);
        (window.store || window.rpc.store).dispatch({type: 'TERM_GROUP_ADD_WEB_TAB', url, name: 'harness'});
        await window.__h.pause(3000);
      }, ctx.pageUrl).catch(() => {});
      await wait(1000);
      const crashed = /main:uncaughtException/.test(ctx.mainLog());
      let alive = true;
      try {
        await run(() => 1);
      } catch {
        alive = false;
      }
      const hadView = alive && (await run(() => !!window.__hadView).catch(() => false));
      return {
        pass: hadView && !crashed && alive,
        detail: `web view existed: ${hadView}; main uncaught exception: ${crashed}; renderer reachable: ${alive}`
      };
    }
  },
  {
    id: 's12',
    name: 'Bottom-right toasts draw on the native layer above a web pane',
    async run(ctx) {
      await h();
      const r = await run(async (url) => {
        const {pause, win} = window.__h;
        (window.store || window.rpc.store).dispatch({type: 'TERM_GROUP_ADD_WEB_TAB', url, name: 'harness'});
        await pause(3000);
        window.rpc.emitter.emit('pane copy files done', {uid: 'x', ok: true, dir: '/tmp', count: 1, names: ['a.txt']});
        await pause(1500);
        const w = win();
        const [cw, ch] = w.getContentSize();
        const kids = w.contentView.children;
        const info = kids.map((v, i) => {
          let page = '?';
          try {
            page = v.webContents.getURL().split('/').pop();
          } catch {
            /* gone */
          }
          const b = v.getBounds();
          const visible = typeof v.getVisible === 'function' ? v.getVisible() : null;
          return {i, url: page, b, visible};
        });
        const layers = info.filter((k) => /toast-layer.html/.test(k.url) && k.visible !== false);
        const bottom = layers.find((k) => k.b.x + k.b.width >= cw - 1 && k.b.y + k.b.height >= ch - 1 && k.b.y > 0);
        const lastWeb = Math.max(-1, ...info.filter((k) => !/toast-layer.html/.test(k.url)).map((k) => k.i));
        // The DOM fallback must not render while the layer is up.
        const domToast = [...document.querySelectorAll('div')].some(
          (d) => d.style.position === 'fixed' && d.style.bottom === '16px' && d.innerText.includes('a.txt')
        );
        return {cw, ch, info, bottom: bottom || null, lastWeb, domToast};
      }, ctx.pageUrl);
      const pass = !!r.bottom && r.bottom.i > r.lastWeb && !r.domToast;
      return {
        pass,
        detail: `bottom-right layer ${r.bottom ? JSON.stringify(r.bottom.b) : 'missing'} (window ${r.cw}x${r.ch}); above web view: ${r.bottom ? r.bottom.i > r.lastWeb : false}; DOM fallback shown: ${r.domToast}`
      };
    }
  },
  {
    id: 's13',
    name: 'Web-pane suppression is held until the LAST overlay lets go',
    async run(ctx) {
      await h();
      const r = await run(async (url) => {
        const {pause, win} = window.__h;
        const {ipcRenderer} = require('electron');
        (window.store || window.rpc.store).dispatch({type: 'TERM_GROUP_ADD_WEB_TAB', url, name: 'harness'});
        await pause(3000);
        const webView = () =>
          win().contentView.children.find((v) => {
            try {
              return !/toast-layer.html/.test(v.webContents.getURL());
            } catch {
              return false;
            }
          });
        const vis = () => {
          const v = webView();
          return v && typeof v.getVisible === 'function' ? v.getVisible() : null;
        };
        const send = (holder, suppressed) => ipcRenderer.send('web-panes:suppress', {holder, suppressed});
        const start = vis();
        send('harness-a', true);
        send('harness-b', true);
        await pause(600);
        const both = vis();
        send('harness-a', false);
        await pause(600);
        const oneLeft = vis();
        send('harness-b', false);
        await pause(600);
        return {start, both, oneLeft, end: vis()};
      }, ctx.pageUrl);
      const pass = r.start === true && r.both === false && r.oneLeft === false && r.end === true;
      return {
        pass,
        detail: `visible: start ${r.start}, both held ${r.both}, after first release ${r.oneLeft}, after last ${r.end}`
      };
    }
  },
  {
    id: 's14',
    name: "A sidecar restart keeps a running command's shell state (reconnect replay)",
    async run(ctx) {
      await h();
      const {uid} = await run(async () => {
        const {S, pause, newPickerTab, pressOnPicker} = window.__h;
        const {root} = await newPickerTab();
        await pressOnPicker('s');
        await pause(4000);
        const id = S().termGroups.activeSessions[root];
        window.rpc.emit('data', {uid: id, data: 'ping -t 127.0.0.1' + String.fromCharCode(13)});
        await pause(4000);
        return {uid: id};
      });
      const before = await sidecarPane(uid);
      const pid = sandboxSidecarPid(ctx.child.pid);
      if (!pid) return {pass: false, detail: 'sandbox sidecar not found; not killing anything'};
      execSync(`taskkill /F /PID ${pid}`, {stdio: 'ignore'});
      // Main restarts a crashed sidecar after 2s, then the bridge reconnects.
      let after = null;
      for (let i = 0; i < 20 && !after; i++) {
        await wait(1000);
        after = await sidecarPane(uid).catch(() => null);
      }
      await run((id) => window.rpc.emit('data', {uid: id, data: String.fromCharCode(3)}), uid).catch(() => {});
      const pass =
        !!before && before.state === 'running' && !!after && after.state === 'running' && after.app === before.app;
      return {
        pass,
        detail: `before restart: ${JSON.stringify(before)}; after: ${JSON.stringify(after)} (killed sandbox sidecar pid ${pid})`
      };
    }
  }
];

// ---------- main ----------
// Scenarios that can end the window or crash main get their own fresh launch.
const GROUPS = [['s1', 's3', 's4', 's5', 's6', 's9', 's7', 's10', 's11', 's12', 's13'], ['s2'], ['s8'], ['s14']];

async function launch(pageUrl) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperia-harness-'));
  fs.mkdirSync(path.join(sandbox, 'AppData', 'Roaming'), {recursive: true});
  fs.mkdirSync(path.join(sandbox, 'AppData', 'Local'), {recursive: true});
  const logFile = path.join(sandbox, 'main.log');
  const out = fs.openSync(logFile, 'a');
  const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, ['target', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: REPO,
    env: {
      ...process.env,
      USERPROFILE: sandbox,
      HOME: sandbox,
      APPDATA: path.join(sandbox, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(sandbox, 'AppData', 'Local'),
      HYPERIA_PORT: String(SIDECAR_PORT)
    },
    stdio: ['ignore', out, out]
  });
  const ctx = {sandbox, child, pageUrl, mainLog: () => fs.readFileSync(logFile, 'utf8')};
  for (let i = 0; i < 60; i++) {
    try {
      if (await mainTarget()) break;
    } catch {
      /* not up yet */
    }
    await wait(1000);
  }
  for (let i = 0; i < 30; i++) {
    try {
      if (await run(() => !!(window.store || window.rpc?.store) && document.querySelectorAll('.tab_tab').length > 0))
        break;
    } catch {
      /* renderer booting */
    }
    await wait(1000);
  }
  await wait(3000);
  return ctx;
}

async function teardown(ctx) {
  try {
    await cdp('Runtime.evaluate', {expression: "setTimeout(() => require('@electron/remote').app.quit(), 100)"}, 5000);
  } catch {
    /* already gone */
  }
  await wait(3000);
  try {
    execSync(`taskkill /T /F /PID ${ctx.child.pid}`, {stdio: 'ignore'});
  } catch {
    /* exited */
  }
  try {
    execSync('taskkill /F /IM hyperia-sidecar.exe', {stdio: 'ignore'});
  } catch {
    /* none */
  }
  await wait(1500);
  const errs = (() => {
    try {
      return fs
        .readFileSync(path.join(ctx.sandbox, '.hyperia', 'logs', 'renderer-errors.log'), 'utf8')
        .split('\n')
        .filter((l) => /Uncaught|Process gone/.test(l));
    } catch {
      return [];
    }
  })();
  return {rendererErrors: errs, mainUncaught: (ctx.mainLog().match(/main:uncaughtException/g) || []).length};
}

(async () => {
  if (running('Hyperia.exe') || running('hyperia-sidecar.exe')) {
    console.error('[harness] Close Hyperia first (installed app or a sidecar is running).');
    process.exit(2);
  }
  for (const p of [CDP_PORT, SIDECAR_PORT]) {
    if (!(await portFree(p))) {
      console.error(`[harness] Port ${p} is busy.`);
      process.exit(2);
    }
  }
  if (!args.includes('--no-build')) {
    log('building (tsc --build, webpack)...');
    execSync('npx tsc --build', {cwd: REPO, stdio: 'inherit'});
    execSync('npx webpack', {cwd: REPO, stdio: 'ignore'});
  }
  // A tiny local page for web-pane scenarios (127.0.0.1 only).
  const server = http.createServer((_q, s) => s.end('<html><body style="height:3000px">harness page</body></html>'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const results = [];
  const health = [];
  for (const group of GROUPS) {
    const todo = group.filter((id) => !only || only.has(id));
    if (!todo.length) continue;
    log(`launch for ${todo.join(', ')}`);
    const ctx = await launch(pageUrl);
    log(`  sandbox ${ctx.sandbox}`);
    try {
      for (const id of todo) {
        const s = scenarios.find((x) => x.id === id);
        log(`${s.id}: ${s.name}`);
        const t0 = Date.now();
        let res;
        try {
          res = await s.run(ctx);
        } catch (e) {
          res = {pass: false, detail: 'harness error: ' + e.message.split('\n')[0]};
        }
        res.secs = ((Date.now() - t0) / 1000).toFixed(1);
        results.push({id: s.id, name: s.name, ...res});
        log(`  ${res.pass ? 'PASS' : 'FAIL'}  ${res.detail}`);
      }
    } finally {
      health.push({group: todo.join(','), sandbox: ctx.sandbox, ...(await teardown(ctx))});
    }
  }
  server.close();

  console.log('\n' + '='.repeat(100));
  for (const r of results)
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}\n        ${r.detail}  (${r.secs}s)`);
  console.log('');
  for (const hh of health) {
    const uniq = [...new Set(hh.rendererErrors.map((l) => l.replace(/^\S+ \[renderer\] /, '').slice(0, 130)))];
    console.log(
      `[${hh.group}] renderer errors: ${hh.rendererErrors.length}; main uncaught: ${hh.mainUncaught}${uniq.length ? '\n    ' + uniq.join('\n    ') : ''}`
    );
    console.log(`    logs: ${hh.sandbox}`);
  }
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
})();
