/* eslint-disable eslint-comments/disable-enable-pair */
import test from 'ava';

type FakeEvent = {
  stopPropagation: () => void;
  preventDefault: () => void;
};

type FakeListener = (e: FakeEvent) => void;

type FakeEl = {
  textContent: string;
  style: {display: string};
  value: string;
  listeners: Record<string, FakeListener[]>;
  addEventListener: (type: string, fn: FakeListener) => void;
  dispatch: (type: string, extra?: Partial<FakeEvent>) => void;
  focus: () => void;
  select: () => void;
};

type ChromeState = {
  isSearchMode: boolean;
  filePath: string;
  noteId: string;
  displayName: string;
  boundFilePath: string | null;
};

type ChromeMode = {
  name: string;
  state: ChromeState;
  expectCopy: string;
};

type ChromeCtx = {
  doc: {
    querySelector: (sel: string) => null;
    getElementById: (id: string) => null;
  };
  ipc: {
    on: (ch: string, fn: () => void) => void;
  };
  persist: {
    findNote: () => null;
    saveNote: () => void;
  };
  clipboard: {
    writeText: (s: string) => void;
  };
  els: {titleText: FakeEl; titleInput: FakeEl};
  state: ChromeState;
  timers: {
    setTimeout: (fn: () => void) => number;
    clearTimeout: () => void;
  };
};

type ChromeApi = {
  start: (ctx: ChromeCtx) => void;
  startRename: (ctx: ChromeCtx) => boolean;
};

type ChromeHarness = {
  ctx: ChromeCtx;
  titleText: FakeEl;
  titleInput: FakeEl;
  copied: string[];
  pending: Array<() => void>;
  ipcHandlers: Record<string, Array<() => void>>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chrome: ChromeApi = require('../../app/sticky-renderer/chrome');

function fakeEl(text: string): FakeEl {
  const el: FakeEl = {
    textContent: text || '',
    style: {display: ''},
    value: '',
    listeners: {},
    addEventListener(type: string, fn: FakeListener) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
    dispatch(type: string, extra?: Partial<FakeEvent>) {
      const ev: FakeEvent = Object.assign({stopPropagation() {}, preventDefault() {}}, extra);
      (this.listeners[type] || []).forEach((listener: FakeListener) => listener(ev));
    },
    focus() {},
    select() {}
  };
  return el;
}

function harness(state: ChromeState): ChromeHarness {
  const titleText = fakeEl(state.displayName);
  const titleInput = fakeEl('');
  titleInput.style.display = 'none';
  const copied: string[] = [];
  const pending: Array<() => void> = [];
  const ipcHandlers: Record<string, Array<() => void>> = {};
  const ctx: ChromeCtx = {
    doc: {
      querySelector: () => null,
      getElementById: () => null
    },
    ipc: {
      on(ch: string, fn: () => void) {
        ipcHandlers[ch] = ipcHandlers[ch] || [];
        ipcHandlers[ch].push(fn);
      }
    },
    persist: {findNote: () => null, saveNote() {}},
    clipboard: {
      writeText(s: string) {
        copied.push(s);
      }
    },
    els: {titleText, titleInput},
    state,
    timers: {
      setTimeout(fn: () => void) {
        pending.push(fn);
        return pending.length;
      },
      clearTimeout() {
        pending.length = 0;
      }
    }
  };
  chrome.start(ctx);
  return {ctx, titleText, titleInput, copied, pending, ipcHandlers};
}

const MODES: ChromeMode[] = [
  {
    name: 'note',
    state: {
      isSearchMode: false,
      filePath: '',
      noteId: 'note-171-abc1',
      displayName: 'Neat Hippo',
      boundFilePath: null
    },
    expectCopy: 'Neat Hippo (sticky abc1)'
  },
  {
    name: 'search',
    state: {
      isSearchMode: true,
      filePath: '',
      noteId: 'sticky-search-window',
      displayName: 'Search Stickys',
      boundFilePath: null
    },
    expectCopy: 'Search Stickys (sticky window)'
  },
  {
    name: 'code',
    state: {
      isSearchMode: false,
      filePath: '/tmp/a.ts',
      noteId: 'note-file-xyz9',
      displayName: 'a.ts',
      boundFilePath: null
    },
    expectCopy: 'a.ts (sticky xyz9)'
  }
];

for (const mode of MODES) {
  test(`title click copies in ${mode.name} mode`, (t) => {
    const h = harness(mode.state);
    h.titleText.dispatch('click');
    t.is(h.copied.length, 0, 'copy is delayed 230ms');
    t.true(h.pending.length >= 1);
    h.pending[0]();
    t.deepEqual(h.copied, [mode.expectCopy]);
    t.is(h.titleText.textContent, 'Copied ✓');
  });
}

for (const mode of MODES) {
  test(`sticky-rename IPC in ${mode.name} mode`, (t) => {
    const h = harness(mode.state);
    t.is((h.ipcHandlers['sticky-rename'] || []).length, 1);
    h.ipcHandlers['sticky-rename'][0]();
    if (mode.name === 'note') {
      t.is(h.titleInput.style.display, '');
      t.is(h.titleText.style.display, 'none');
    } else {
      t.is(h.titleInput.style.display, 'none');
      t.not(h.titleText.style.display, 'none');
    }
  });
}

test('startRename is a no-op in search and code (original guards)', (t) => {
  const search = harness(MODES[1].state);
  t.false(chrome.startRename(search.ctx));
  t.is(search.titleInput.style.display, 'none');
  const code = harness(MODES[2].state);
  t.false(chrome.startRename(code.ctx));
  t.is(code.titleInput.style.display, 'none');
  const note = harness(MODES[0].state);
  t.true(chrome.startRename(note.ctx));
  t.is(note.titleInput.style.display, '');
  t.is(note.titleText.style.display, 'none');
});
