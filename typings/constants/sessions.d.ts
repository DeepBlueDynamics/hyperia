export const SESSION_ADD = 'SESSION_ADD';
export const SESSION_RESIZE = 'SESSION_RESIZE';
export const SESSION_REQUEST = 'SESSION_REQUEST';
export const SESSION_ADD_DATA = 'SESSION_ADD_DATA';
export const SESSION_PTY_DATA = 'SESSION_PTY_DATA';
export const SESSION_PTY_EXIT = 'SESSION_PTY_EXIT';
export const SESSION_USER_EXIT = 'SESSION_USER_EXIT';
export const SESSION_SET_ACTIVE = 'SESSION_SET_ACTIVE';
export const SESSION_CLEAR_ACTIVE = 'SESSION_CLEAR_ACTIVE';
export const SESSION_USER_DATA = 'SESSION_USER_DATA';
export const SESSION_SET_TAB_NAME = 'SESSION_SET_TAB_NAME';
export const SESSION_SET_XTERM_TITLE = 'SESSION_SET_XTERM_TITLE';
export const SESSION_SET_CWD = 'SESSION_SET_CWD';
export const SESSION_SEARCH = 'SESSION_SEARCH';
export const SESSION_SET_DESCRIPTION = 'SESSION_SET_DESCRIPTION';
export const SESSION_SET_SHELL_STATE = 'SESSION_SET_SHELL_STATE';
export const SESSION_SET_BUSY = 'SESSION_SET_BUSY';
export const SESSION_PANE_RENAME = 'SESSION_PANE_RENAME';

export interface SessionAddAction {
  type: typeof SESSION_ADD;
  uid: string;
  shell: string | null;
  pid: number | null;
  cols: number | null;
  rows: number | null;
  splitDirection?: 'HORIZONTAL' | 'VERTICAL';
  activeUid: string | null;
  now: number;
  profile: string;
  groupUid?: string;
  url?: string;
  cwd?: string;
  isNewGroup?: boolean;
  shellState?: { state: 'idle' | 'busy'; lastExit?: number; command?: string };
}
export interface SessionResizeAction {
  type: typeof SESSION_RESIZE;
  uid: string;
  cols: number;
  rows: number;
  isStandaloneTerm: boolean;
  now: number;
}
export interface SessionRequestAction {
  type: typeof SESSION_REQUEST;
}
export interface SessionAddDataAction {
  type: typeof SESSION_ADD_DATA;
}
export interface SessionPtyDataAction {
  type: typeof SESSION_PTY_DATA;
  data: string;
  uid: string;
  now: number;
}
export interface SessionPtyExitAction {
  type: typeof SESSION_PTY_EXIT;
  uid: string;
}
export interface SessionUserExitAction {
  type: typeof SESSION_USER_EXIT;
  uid: string;
}
export interface SessionSetActiveAction {
  type: typeof SESSION_SET_ACTIVE;
  uid: string;
}
export interface SessionClearActiveAction {
  type: typeof SESSION_CLEAR_ACTIVE;
}
export interface SessionUserDataAction {
  type: typeof SESSION_USER_DATA;
}
export interface SessionSetTabNameAction {
  type: typeof SESSION_SET_TAB_NAME;
  uid: string;
  tabName: string;
}
export interface SessionSetXtermTitleAction {
  type: typeof SESSION_SET_XTERM_TITLE;
  uid: string;
  title: string;
  manual?: boolean;
}
export interface SessionSetCwdAction {
  type: typeof SESSION_SET_CWD;
  uid?: string;
  cwd: string;
}
export interface SessionSearchAction {
  type: typeof SESSION_SEARCH;
  uid: string;
  value: boolean;
}
export interface SessionSetDescriptionAction {
  type: typeof SESSION_SET_DESCRIPTION;
  uid: string;
  description: string;
  tabName: string;
}

export interface SessionSetShellStateAction {
  type: typeof SESSION_SET_SHELL_STATE;
  uid: string;
  shellState: { state: 'idle' | 'busy'; lastExit?: number; command?: string };
}

export interface SessionSetBusyAction {
  type: typeof SESSION_SET_BUSY;
  uid: string;
  busy: boolean;
}

export interface SessionPaneRenameAction {
  type: typeof SESSION_PANE_RENAME;
  uid: string;
  name: string;
}

export type SessionActions =
  | SessionPaneRenameAction
  | SessionAddAction
  | SessionResizeAction
  | SessionRequestAction
  | SessionAddDataAction
  | SessionPtyDataAction
  | SessionPtyExitAction
  | SessionUserExitAction
  | SessionSetActiveAction
  | SessionClearActiveAction
  | SessionUserDataAction
  | SessionSetTabNameAction
  | SessionSetXtermTitleAction
  | SessionSetCwdAction
  | SessionSearchAction
  | SessionSetDescriptionAction
  | SessionSetShellStateAction
  | SessionSetBusyAction;
