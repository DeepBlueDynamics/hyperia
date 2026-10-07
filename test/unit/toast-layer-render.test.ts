/* eslint-disable eslint-comments/disable-enable-pair */
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require('../../app/toast-layer/render');

// Minimal DOM stand-in: enough of createElement/appendChild/textContent for
// render.js, which deliberately never touches innerHTML.
type FakeNode = {
  tag: string;
  className: string;
  textContent: string;
  title: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  handlers: Record<string, Array<() => void>>;
  firstChild: FakeNode | null;
  appendChild: (n: FakeNode) => void;
  removeChild: (n: FakeNode) => void;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  addEventListener: (type: string, fn: () => void) => void;
  click: () => void;
};

function node(tag: string): FakeNode {
  const n: FakeNode = {
    tag,
    className: '',
    textContent: '',
    title: '',
    attrs: {},
    children: [],
    handlers: {},
    get firstChild() {
      return n.children[0] || null;
    },
    appendChild(c) {
      n.children.push(c);
    },
    removeChild(c) {
      n.children = n.children.filter((x) => x !== c);
    },
    setAttribute(k, v) {
      n.attrs[k] = v;
    },
    getAttribute(k) {
      return k in n.attrs ? n.attrs[k] : null;
    },
    addEventListener(type, fn) {
      (n.handlers[type] = n.handlers[type] || []).push(fn);
    },
    click() {
      (n.handlers.click || []).forEach((fn) => fn());
    }
  };
  return n;
}

const fakeDoc = () => {
  const vars = new Map<string, string>();
  return {
    createElement: (tag: string) => node(tag),
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => vars.set(k, v),
        removeProperty: (k: string) => vars.delete(k)
      }
    },
    vars
  };
};

// Flatten every text node under `n`, in order.
const text = (n: FakeNode): string => (n.textContent || '') + n.children.map(text).join('');

test('render: a card gets its name, phrase and one button per action', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  const clicks: string[] = [];
  const n = R.render(
    doc,
    root,
    [
      {
        id: 'req-1',
        kind: 'card',
        emoji: '🤖',
        who: 'Severe Booby',
        text: 'wants to open a web pane.',
        buttons: [
          {id: 'deny', label: 'Deny', style: 'deny'},
          {id: 'always', label: 'Always', style: 'allow'}
        ]
      }
    ],
    (id: string, b: string) => clicks.push(`${id}:${b}`)
  );
  t.is(n, 1);
  const card = root.children[0];
  t.is(card.className, 'hy-tl-card');
  t.is(card.attrs['data-toast-id'], 'req-1');
  t.true(text(card).includes('Severe Booby wants to open a web pane.'));
  const buttons = card.children[1].children;
  t.deepEqual(
    buttons.map((b) => [b.textContent, b.className]),
    [
      ['Deny', 'hy-tl-btn hy-tl-btn-deny'],
      ['Always', 'hy-tl-btn hy-tl-btn-allow']
    ]
  );
  buttons[1].click();
  t.deepEqual(clicks, ['req-1:always']);
});

test('render: a pill is one clickable row that reports "click"', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  const clicks: string[] = [];
  R.render(
    doc,
    root,
    [{id: 'pill', kind: 'pill', emoji: '🛂', text: 'bob is waiting — click to review'}],
    (id: string, b: string) => clicks.push(`${id}:${b}`)
  );
  const pill = root.children[0];
  t.is(pill.className, 'hy-tl-pill');
  t.is(pill.attrs.role, 'button');
  t.true(text(pill).includes('bob is waiting'));
  pill.click();
  t.deepEqual(clicks, ['pill:click']);
});

test('render: agent-supplied text is never interpreted as markup', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  R.render(doc, root, [{id: 'x', kind: 'card', who: '<img onerror=1>', text: '<b>bold</b>'}], () => {});
  // Only textContent assignments happen — the markup survives verbatim as text.
  t.true(text(root.children[0]).includes('<img onerror=1> <b>bold</b>'));
});

test('render: re-render replaces, and junk items are skipped', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  R.render(doc, root, [{id: 'a', kind: 'card', text: 'one'}], () => {});
  const n = R.render(doc, root, [null, {kind: 'card', text: 'no id'}, {id: 'b', kind: 'pill', text: 'two'}], () => {});
  t.is(n, 3, 'returns the payload length so boot.js knows whether anything is up');
  t.deepEqual(
    root.children.map((c) => c.attrs['data-toast-id']),
    ['b']
  );
  t.is(
    R.render(doc, root, [], () => {}),
    0
  );
  t.is(root.children.length, 0);
});

test('applyTheme: mirrors only the known host variables', (t) => {
  const doc = fakeDoc();
  R.applyTheme(doc, {'--accent-primary': ' #ff0000 ', '--font-sans': 'Inter', '--evil': 'x', '--text-primary': ''});
  t.is(doc.vars.get('--accent-primary'), '#ff0000');
  t.is(doc.vars.get('--font-sans'), 'Inter');
  t.false(doc.vars.has('--evil'));
  t.false(doc.vars.has('--text-primary'));
});

test('layer page assets exist and the page wires them with a CSP', (t) => {
  const dir = join(__dirname, '../../app/toast-layer');
  for (const name of ['preload.js', 'render.js', 'boot.js', 'toast-layer.css']) {
    t.true(existsSync(join(dir, name)), name);
  }
  const html = readFileSync(join(__dirname, '../../app/toast-layer.html'), 'utf8');
  t.regex(html, /Content-Security-Policy/);
  t.regex(html, /toast-layer\/render\.js/);
  t.regex(html, /toast-layer\/boot\.js/);
  t.regex(html, /toast-layer\/toast-layer\.css/);
  // The renderer's theme list must match the page's.
  const client = readFileSync(join(__dirname, '../../lib/toast-layer.ts'), 'utf8');
  for (const v of R.THEME_VARS) t.true(client.includes(`'${v}'`), `${v} mirrored by lib/toast-layer.ts`);
});

test('render: a bottom-right toast has its text, links and a close that reports "close"', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  const clicks: string[] = [];
  R.render(
    doc,
    root,
    [
      {
        id: 'note-update',
        kind: 'toast',
        text: 'Version 1.2.3 ready.',
        buttons: [{id: 'notes', label: 'Notes'}],
        dismissable: true
      },
      {id: 'stack-1', kind: 'toast', tone: 'error', text: "Couldn't copy"}
    ],
    (id: string, b: string) => clicks.push(`${id}:${b}`)
  );
  const [update, error] = root.children;
  t.is(update.className, 'hy-tl-toast');
  t.true(text(update).includes('Version 1.2.3 ready.'));
  const close = update.children[update.children.length - 1];
  t.is(close.className, 'hy-tl-close');
  close.click();
  update.children[1].children[1].children[0].click();
  t.deepEqual(clicks, ['note-update:close', 'note-update:notes']);
  t.is(error.className, 'hy-tl-toast hy-tl-toast-error');
  t.false(
    error.children.some((c) => c.className === 'hy-tl-close'),
    'no × unless dismissable'
  );
});

test('render: unchanged items keep their node so their entry animation does not replay', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  R.render(doc, root, [{id: 'a', kind: 'toast', text: 'one'}], () => {});
  const first = root.children[0];
  R.render(
    doc,
    root,
    [
      {id: 'a', kind: 'toast', text: 'one'},
      {id: 'b', kind: 'toast', text: 'two'}
    ],
    () => {}
  );
  t.is(root.children[0], first);
  R.render(doc, root, [{id: 'a', kind: 'toast', text: 'changed'}], () => {});
  t.not(root.children[0], first, 'a changed item is rebuilt');
  t.true(text(root.children[0]).includes('changed'));
});

test('render: a toast with progress gets a bar sized to the fraction, -1 is indeterminate', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  R.render(
    doc,
    root,
    [
      {id: 'a', kind: 'toast', text: 'file.zip', detail: '1 MB of 4 MB · 25%', progress: 0.25},
      {id: 'b', kind: 'toast', text: 'stream.bin', progress: -1}
    ],
    () => {}
  );
  const body = root.children[0].children[1];
  t.true(text(body).includes('1 MB of 4 MB'));
  const track = body.children.find((c) => c.className.startsWith('hy-tl-progress'))!;
  t.is(track.children[0].attrs.style, 'width:25%');
  const busy = root.children[1].children[1].children.find((c) => c.className.startsWith('hy-tl-progress'))!;
  t.is(busy.className, 'hy-tl-progress hy-tl-progress-busy');
});

test('render: an updated item is rebuilt without replaying its entry animation', (t) => {
  const doc = fakeDoc();
  const root = node('div');
  R.render(doc, root, [{id: 'a', kind: 'toast', text: 'f', progress: 0.1}], () => {});
  t.false(root.children[0].className.includes('hy-tl-noanim'));
  R.render(doc, root, [{id: 'a', kind: 'toast', text: 'f', progress: 0.2}], () => {});
  t.true(root.children[0].className.includes('hy-tl-noanim'));
});
