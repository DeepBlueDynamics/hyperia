import {combineReducers} from 'redux';
import type {Reducer} from 'redux';

import type {HyperActions, HyperState} from '../../typings/hyper';

import sessions from './sessions';
import termGroups from './term-groups';
import ui, {seeActiveTabBells} from './ui';

const combinedReducer = combineReducers({
  ui,
  sessions,
  termGroups
}) as Reducer<HyperState, HyperActions>;

const reducer: Reducer<HyperState, HyperActions> = (state, action) => {
  const next = combinedReducer(state, action);
  if (state?.termGroups.activeRootGroup === next.termGroups.activeRootGroup) return next;
  const nextUi = seeActiveTabBells(next.ui, next.termGroups);
  return nextUi === next.ui ? next : {...next, ui: nextUi};
};

export default reducer;
