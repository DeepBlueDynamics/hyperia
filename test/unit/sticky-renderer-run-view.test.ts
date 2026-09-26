/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable @typescript-eslint/no-var-requires */
import test from 'ava';

const {createRunView} = require('../../app/sticky-renderer/run-view');

type Listener = (e: unknown) => void;

// Just enough DOM for run-view: elements, classList, children, text/innerHTML.
class FakeEl {
  tagName: string;
  id = '';
  className = '';
  title = '';
  readOnly = false;
  innerHTML = '';
  style: Record<string, string> = {display: ''};
  children: FakeEl[] = [];
  listeners: Record<string, Listener[]> = {};
  private text = '';
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
    this.innerHTML = '';
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    const toggle = (c: string, on?: boolean) => {
      const has = list().includes(c);
      const want = on === undefined ? !has : on;
      if (want && !has) this.className = [...list(), c].join(' ');
      if (!want && has)
        this.className = list()
          .filter((x) => x !== c)
          .join(' ');
    };
    return {contains: (c: string) => list().includes(c), toggle, add: (c: string) => toggle(c, true)};
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
}

function setup(saved: Record<string, unknown>) {
  const ids: Record<string, FakeEl> = {scheduleBtn: new FakeEl('span')};
  const body = new FakeEl('body');
  const doc = {
    body,
    createElement: (t: string) => new FakeEl(t),
    getElementById: (id: string) => ids[id] || null,
    addEventListener: () => undefined
  };
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const invoked: unknown[][] = [];
  const ipc = {
    on: (ch: string, fn: (...a: unknown[]) => void) => (handlers[ch] = fn),
    send: () => undefined,
    invoke: (...a: unknown[]) => {
      invoked.push(a);
      return Promise.resolve([{status: 'ok'}, {status: 'failed'}]);
    }
  };
  const ctx = {
    doc,
    ipc,
    state: {noteId: 'n-1', saved},
    timers: {setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined},
    now: () => new Date(2026, 8, 26, 10, 0).getTime()
  };
  const view = createRunView(ctx);
  const textarea = new FakeEl('textarea');
  const content = new FakeEl('div');
  const promptWrap = new FakeEl('div');
  view.mount({textarea, content, promptWrap});
  const [resultEl, footerEl] = content.children;
  return {
    view,
    textarea,
    body,
    resultEl,
    footerEl,
    btn: ids.scheduleBtn,
    handlers,
    invoked,
    lockHint: promptWrap.children[0]
  };
}

const daily = {when: 'every', every: {kind: 'daily', time: '08:00'}, target: 'notify', history: {keep: true, limit: 7}};

test('run-view: armed state comes from the saved note before any push', async (t) => {
  const s = setup({run: daily, run_state: {next_run: new Date(2026, 8, 27, 8, 0).getTime()}, result: '**22°C**'});
  t.true(s.textarea.readOnly);
  t.true(s.body.classList.contains('sched-armed'));
  t.is(s.lockHint.style.display, '');
  t.is(s.lockHint.textContent, 'Pause to edit');
  t.true(s.btn.classList.contains('armed'));
  t.true(s.btn.title.includes('Next run: in 22h (08:00 tomorrow)'));
  t.is(s.resultEl.innerHTML, '<p><strong>22°C</strong></p>');
  t.true(s.footerEl.textContent.includes('next in 22h (08:00 tomorrow)'));
  await new Promise((r) => setImmediate(r));
  t.deepEqual(s.invoked[0], ['sticky-run-history', 'n-1', 7]);
  t.true(s.footerEl.textContent.includes('history (2)'));
});

test('run-view: paused runs unlock the prompt; plain notes hide result and footer', (t) => {
  const paused = setup({run: {...daily, paused: true}});
  t.false(paused.textarea.readOnly);
  t.true(paused.btn.classList.contains('paused'));
  t.is(paused.resultEl.textContent, 'No result yet.');
  const plain = setup({});
  t.false(plain.textarea.readOnly);
  t.is(plain.resultEl.style.display, 'none');
  t.is(plain.footerEl.style.display, 'none');
});

test('run-view: sticky-run-state and sticky-result pushes update live', (t) => {
  const s = setup({});
  s.handlers['sticky-run-state'](
    {},
    {last_status: 'failed', last_error: "nemesis8 isn't running", last_run: new Date(2026, 8, 26, 9, 0).getTime()},
    daily
  );
  t.true(s.textarea.readOnly);
  t.true(s.footerEl.textContent.includes('✗ failed 09:00 today'));
  t.true(s.footerEl.textContent.includes("nemesis8 isn't running"));
  s.handlers['sticky-result']({}, '# Tokyo\n<script>x</script>');
  t.is(s.resultEl.innerHTML, '<h1>Tokyo</h1><p>&lt;script&gt;x&lt;/script&gt;</p>');
  s.handlers['sticky-run-state']({}, {}, null);
  t.false(s.textarea.readOnly);
  t.false(s.body.classList.contains('sched-armed'));
});

test('run-view: history renders newest-first records with markdown results', (t) => {
  const s = setup({run: daily});
  const list = new FakeEl('div');
  s.view.renderHistory(list, [
    {status: 'ok', finished: new Date(2026, 8, 26, 8, 0).getTime(), target: 'notify', result: '- a'},
    {
      status: 'failed',
      finished: new Date(2026, 8, 25, 8, 0).getTime(),
      target: 'agent',
      agent: {provider: 'claude'},
      error: 'timeout'
    }
  ]);
  t.is(list.children.length, 2);
  t.true(list.children[0].textContent.includes('✓ ran'));
  t.is(list.children[0].children[1].innerHTML, '<ul><li>a</li></ul>');
  t.true(list.children[1].textContent.includes('claude'));
  t.true(list.children[1].textContent.includes('timeout'));
  const empty = new FakeEl('div');
  s.view.renderHistory(empty, []);
  t.is(empty.textContent, 'No runs recorded yet.');
});
