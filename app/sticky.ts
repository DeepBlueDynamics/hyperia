// Sticky note windows — frameless, always-on-top, colored floating notes.
// Facade re-exporting cohesive sticky sub-modules under app/sticky/.

export {initSticky} from './sticky/ipc';
export {readStickyHidden} from './sticky/preferences';
export {scheduleSticky, unscheduleSticky} from './sticky/scheduler';
export {readAllNotes} from './sticky/store';
export type {NoteData, StickyColor, StickyRef, StickySchedule, StickyWin} from './sticky/types';
export {
  anyStickyHidden,
  anyStickyVisible,
  closeStickyNote,
  createStickyNote,
  deleteStickyNote,
  listOpenStickyRefs,
  updateStickyNote
} from './sticky/window';
