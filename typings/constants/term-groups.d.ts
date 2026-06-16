export const TERM_GROUP_REQUEST = 'TERM_GROUP_REQUEST';
export const TERM_GROUP_EXIT = 'TERM_GROUP_EXIT';
export const TERM_GROUP_RESIZE = 'TERM_GROUP_RESIZE';
export const TERM_GROUP_EXIT_ACTIVE = 'TERM_GROUP_EXIT_ACTIVE';
export const TERM_GROUP_REORDER = 'TERM_GROUP_REORDER';
export enum DIRECTION {
  HORIZONTAL = 'HORIZONTAL',
  VERTICAL = 'VERTICAL'
}

export interface TermGroupRequestAction {
  type: typeof TERM_GROUP_REQUEST;
}
export interface TermGroupExitAction {
  type: typeof TERM_GROUP_EXIT;
  uid: string;
}
export interface TermGroupResizeAction {
  type: typeof TERM_GROUP_RESIZE;
  uid: string;
  sizes: number[];
}
export interface TermGroupExitActiveAction {
  type: typeof TERM_GROUP_EXIT_ACTIVE;
}
export interface TermGroupReorderAction {
  type: typeof TERM_GROUP_REORDER;
  fromUid: string;
  toIndex: number;
}

export const TERM_GROUP_SET_WEB_URL = 'TERM_GROUP_SET_WEB_URL';
export interface TermGroupSetWebUrlAction {
  type: typeof TERM_GROUP_SET_WEB_URL;
  uid: string;
  url: string | null;
}

export const TERM_GROUP_ADD_WEB_TAB = 'TERM_GROUP_ADD_WEB_TAB';
export interface TermGroupAddWebTabAction {
  type: typeof TERM_GROUP_ADD_WEB_TAB;
  url: string;
}

export const TERM_GROUP_ACTIVATE_WEB_TAB = 'TERM_GROUP_ACTIVATE_WEB_TAB';
export interface TermGroupActivateWebTabAction {
  type: typeof TERM_GROUP_ACTIVATE_WEB_TAB;
  uid: string;
}

export const TERM_GROUP_SET_WEB_NAME = 'TERM_GROUP_SET_WEB_NAME';
export interface TermGroupSetWebNameAction {
  type: typeof TERM_GROUP_SET_WEB_NAME;
  uid: string;
  name: string;
}

export const TERM_GROUP_SET_TAB_NAME = 'TERM_GROUP_SET_TAB_NAME';
export interface TermGroupSetTabNameAction {
  type: typeof TERM_GROUP_SET_TAB_NAME;
  // uid of any group in the tab — reducer walks up to the root group.
  uid: string;
  tabName: string;
}

export const TERM_GROUP_TOGGLE_TITLE_INHERITANCE = 'TERM_GROUP_TOGGLE_TITLE_INHERITANCE';
export interface TermGroupToggleTitleInheritanceAction {
  type: typeof TERM_GROUP_TOGGLE_TITLE_INHERITANCE;
  uid: string;
}

export const RESTORE_LAYOUT_STATE = 'RESTORE_LAYOUT_STATE';
export interface RestoreLayoutStateAction {
  type: typeof RESTORE_LAYOUT_STATE;
  savedState: any;
}

export const TERM_GROUP_POP_OUT_PANE = 'TERM_GROUP_POP_OUT_PANE';
export interface TermGroupPopOutPaneAction {
  type: typeof TERM_GROUP_POP_OUT_PANE;
  uid: string;
}

export type TermGroupActions =
  | TermGroupRequestAction
  | TermGroupExitAction
  | TermGroupResizeAction
  | TermGroupExitActiveAction
  | TermGroupReorderAction
  | TermGroupSetWebUrlAction
  | TermGroupAddWebTabAction
  | TermGroupActivateWebTabAction
  | TermGroupSetWebNameAction
  | TermGroupSetTabNameAction
  | TermGroupToggleTitleInheritanceAction
  | RestoreLayoutStateAction
  | TermGroupPopOutPaneAction;
