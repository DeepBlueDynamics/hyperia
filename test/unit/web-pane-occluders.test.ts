// Guard: every fixed-position element in the renderer must say how it stays
// visible over web panes. Native web panes paint above ALL renderer DOM, so a
// fixed toast/menu/modal that can land over the pane area is invisible there
// unless it uses one of:
//   'layer'    — draws on the native toast layer (lib/toast-layer.ts); the DOM
//                copy is only the fallback when the layer is unavailable
//   'suppress' — holds web panes off-screen while open (useSuppressWebPanes)
//   'chrome'   — window chrome that never overlaps the pane area
//   'gap'      — known to hide under web panes; say why it's accepted
// A new fixed element fails this test until it's added below with a strategy.

import {readdirSync, readFileSync, statSync} from 'fs';
import {join, relative} from 'path';

import test from 'ava';

type Strategy = 'layer' | 'suppress' | 'chrome' | 'gap';

const OCCLUDERS: Record<string, {count: number; strategy: Strategy; note: string}> = {
  'lib/components/agent-toast.tsx': {count: 2, strategy: 'layer', note: 'create-consent cards + waiting pill'},
  'lib/components/consent-modal.tsx': {
    count: 2,
    strategy: 'suppress',
    note: 'full prompt suppresses; pill is on the layer'
  },
  'lib/components/close-confirm-modal.tsx': {count: 1, strategy: 'suppress', note: 'window/tab/quit confirm'},
  'lib/components/notifications.tsx': {count: 1, strategy: 'layer', note: 'font/resize/update/message notices'},
  'lib/components/toast-stack.tsx': {count: 1, strategy: 'layer', note: 'drag-drop copy results, audio notices'},
  'lib/components/workspace-save-toast.tsx': {count: 1, strategy: 'suppress', note: 'Save Tab card'},
  'lib/components/web-pane-dialog.tsx': {count: 1, strategy: 'suppress', note: 'Open Browser dialog'},
  'lib/components/tabs.tsx': {count: 1, strategy: 'suppress', note: 'tabs modal; hover menus suppress too'},
  'lib/components/pane-band.tsx': {count: 1, strategy: 'suppress', note: 'pulse popover'},
  'lib/components/term.tsx': {
    count: 1,
    strategy: 'gap',
    note: 'hover-only path tooltip that can overhang a neighboring web pane; suppressing on every hover would freeze-swap neighbors constantly'
  },
  'lib/components/header.tsx': {count: 1, strategy: 'chrome', note: 'title bar'},
  'lib/components/toolbar.tsx': {count: 1, strategy: 'chrome', note: 'toolbar strip'},
  'lib/components/status-bar.tsx': {count: 1, strategy: 'chrome', note: 'status bar'},
  'lib/components/split-pane.tsx': {count: 1, strategy: 'chrome', note: 'invisible full-window drag shim'},
  'lib/containers/hyper.tsx': {count: 1, strategy: 'chrome', note: 'app root layout'},
  'lib/toast-layer.ts': {count: 1, strategy: 'chrome', note: 'invisible no-drag box mirroring the layer'},
  'lib/utils/webview-scripts.ts': {count: 1, strategy: 'chrome', note: 'injected into the web page itself'}
};

const ROOT = join(__dirname, '..', '..');
const FIXED = /position\s*[:=]\s*['"]?fixed/;

function fixedCounts(dir: string, out: Record<string, number> = {}): Record<string, number> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      fixedCounts(p, out);
      continue;
    }
    if (!/\.(tsx?|css)$/.test(name)) continue;
    let n = 0;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (FIXED.test(line)) n++;
    }
    if (n) out[relative(ROOT, p).replace(/\\/g, '/')] = n;
  }
  return out;
}

test('every fixed-position renderer element declares how it shows over web panes', (t) => {
  const actual = fixedCounts(join(ROOT, 'lib'));
  const problems: string[] = [];
  for (const [file, count] of Object.entries(actual)) {
    const known = OCCLUDERS[file];
    if (!known) problems.push(`${file}: ${count} fixed element(s) with no web-pane strategy`);
    else if (known.count !== count)
      problems.push(`${file}: ${count} fixed element(s), manifest says ${known.count} — check the new one`);
  }
  for (const file of Object.keys(OCCLUDERS)) {
    if (!actual[file]) problems.push(`${file}: listed but has no fixed elements any more — remove it`);
  }
  t.deepEqual(problems, [], `\n${problems.join('\n')}\nSee the header of test/unit/web-pane-occluders.test.ts.`);
});

test('the manifest never accepts a gap without a reason', (t) => {
  for (const [file, o] of Object.entries(OCCLUDERS)) {
    if (o.strategy === 'gap') t.true(o.note.length > 20, `${file}: explain why the gap is accepted`);
  }
  t.pass();
});
