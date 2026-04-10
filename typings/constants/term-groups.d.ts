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

export type TermGroupActions =
  | TermGroupRequestAction
  | TermGroupExitAction
  | TermGroupResizeAction
  | TermGroupExitActiveAction
  | TermGroupReorderAction
  | TermGroupSetWebUrlAction;
