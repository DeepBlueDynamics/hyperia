// Sticky note windows — frameless, always-on-top, colored floating notes.
// Facade re-exporting cohesive sticky sub-modules under app/sticky/.

export {initSticky} from './sticky/ipc';
export {readStickyHidden} from './sticky/preferences';
export {clearRun, pauseRun, runNow, setRun} from './sticky/scheduler';
export {getNote, readAllNotes, setResult, setRunState} from './sticky/store';
export type {
  NoteData,
  RunEvery,
  RunRecord,
  StickyColor,
  StickyRef,
  StickyRun,
  StickyRunState,
  StickyWin
} from './sticky/types';
export {
  anyStickyHidden,
  anyStickyVisible,
  closeStickyNote,
  createStickyNote,
  deleteStickyNote,
  listOpenStickyRefs,
  updateStickyNote
} from './sticky/window';
