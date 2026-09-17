/* eslint-disable eslint-comments/disable-enable-pair */
import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chrome = require('../../app/sticky-renderer/chrome');

function fakeEl(text) {
  return {
    textContent: text || '',
    style: {display: ''},
    value: '',
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
    dispatch(type, extra) {
      const ev = Object.assign({stopPropagation() {}, preventDefault() {}}, extra);
      (this.listeners[type] || []).forEach((fn: (e: unknown) => void) => fn(ev));
    },
    focus() {},
    select() {}
  };
}

function harness(state) {
  const titleText = fakeEl(state.displayName);
  const titleInput = fakeEl('');
  titleInput.style.display = 'none';
  const copied: string[] = [];
  const pending: Array<() => void> = [];
  const ipcHandlers: Record<string, Array<() => void>> = {};
  const ctx = {
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

const MODES = [
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
