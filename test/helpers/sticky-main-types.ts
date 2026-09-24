import type {createStickyNote} from '../../app/sticky';

import type {FakeBrowserWindow, FakeNotification} from './sticky-main-fixture';

export type StickyTestCreateNoteResult = Omit<ReturnType<typeof createStickyNote>, 'win'> & {
  win: FakeBrowserWindow | null;
};

export type StickyTestApi = Omit<typeof import('../../app/sticky'), 'createStickyNote'> & {
  createStickyNote: (...args: Parameters<typeof createStickyNote>) => StickyTestCreateNoteResult;
};

export interface StickyFixture {
  testDir: string;
  stickysDir: string;
  notesFile: string;
  stateFile: string;
  defaultsFile: string;
  sticky: StickyTestApi;
  ipcEmit: (channel: string, ...args: any[]) => boolean;
  ipcInvoke: (channel: string, event: any, ...args: any[]) => Promise<any>;
  ipcHasHandler: (channel: string) => boolean;
  triggerStartupRestore: () => void;
  triggerSchedulerTick: () => Promise<void> | void;
  teardown: () => void;
  windows: FakeBrowserWindow[];
  notifications: FakeNotification[];
}
