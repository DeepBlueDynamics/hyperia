import Immutable from 'seamless-immutable';
import type {Immutable as ImmutableType} from 'seamless-immutable';
import {v4 as uuidv4} from 'uuid';

import {SESSION_ADD, SESSION_SET_ACTIVE} from '../../typings/constants/sessions';
import type {SessionAddAction} from '../../typings/constants/sessions';
import {
  TERM_GROUP_EXIT,
  TERM_GROUP_RESIZE,
  TERM_GROUP_REORDER,
  TERM_GROUP_SET_WEB_URL,
  TERM_GROUP_ADD_WEB_TAB,
  TERM_GROUP_ACTIVATE_WEB_TAB,
  TERM_GROUP_SET_WEB_NAME,
  TERM_GROUP_SET_TAB_NAME,
  TERM_GROUP_TOGGLE_TITLE_INHERITANCE,
  RESTORE_LAYOUT_STATE,
  TERM_GROUP_POP_OUT_PANE
} from '../../typings/constants/term-groups';
import type {ITermGroup, ITermState, ITermGroups, ITermGroupReducer, Mutable} from '../../typings/hyper';
import {decorateTermGroupsReducer} from '../utils/plugins';
import findBySession, {countPathHorizontalStacks} from '../utils/term-groups';

const MIN_SIZE = 0.05;
const initialState: ITermState = Immutable<Mutable<ITermState>>({
  termGroups: {},
  activeSessions: {},
  activeRootGroup: null
});

function TermGroup(obj: Immutable.DeepPartial<Mutable<ITermGroup>>) {
  const x: Mutable<ITermGroup> = {
    uid: '',
    sessionUid: null,
    parentUid: null,
    direction: null,
    sizes: null,
    children: []
  };
  return Immutable(x).merge(obj);
}

// Recurse upwards until we find a root term group (no parent).
const findRootGroup = (termGroups: ITermGroups, uid: string): ITermGroup => {
  const current = termGroups[uid];
  if (!current.parentUid) {
    return current;
  }

  return findRootGroup(termGroups, current.parentUid);
};

const setActiveGroup = (state: ITermState, action: {uid: string}) => {
  if (!action.uid) {
    const currentActive = state.activeRootGroup;
    if (currentActive && state.termGroups[currentActive]) {
      return state;
    }
    return state.set('activeRootGroup', null);
  }

  const childGroup = findBySession(state, action.uid);
  // Guard: a dangling session pointer (its pane was closed or the tree desynced)
  // makes findBySession return undefined; the old non-null assertion then threw on
  // childGroup.uid, which silently bricked tab selection (the "dead tab you can't
  // select" bug). Leave active state unchanged instead of crashing, so a later
  // valid selection can recover the tab.
  if (!childGroup) {
    return state;
  }
  const rootGroup = findRootGroup(state.termGroups, childGroup.uid);
  return state
    .set('activeRootGroup', rootGroup.uid)
    .setIn(['activeSessions', rootGroup.uid], action.uid)
    .set('activeTermGroup', childGroup.uid);
};

// Reduce existing sizes to fit a new split:
const insertRebalance = (oldSizes: ImmutableType<number[]>, index: number) => {
  const newSize = 1 / (oldSizes.length + 1);
  // We spread out how much each pane should be reduced
  // with based on their existing size:
  const balanced = oldSizes.map((size) => size - newSize * size);
  return [...balanced.slice(0, index).asMutable(), newSize, ...balanced.slice(index).asMutable()];
};

// Spread out the removed size to all the existing sizes:
const removalRebalance = (oldSizes: ImmutableType<number[]>, index: number) => {
  const removedSize = oldSizes[index];
  const increase = removedSize / (oldSizes.length - 1);
  return Immutable(
    oldSizes
      .asMutable()
      .filter((_size: number, i: number) => i !== index)
      .map((size: number) => size + increase)
  );
};

const splitGroup = (state: ITermState, action: SessionAddAction) => {
  const {splitDirection, uid, activeUid} = action;
  let activeGroup = findBySession(state, activeUid!);
  if (!activeGroup && state.termGroups[activeUid!]) {
    activeGroup = state.termGroups[activeUid!];
  }
  if (!activeGroup) return state;

  if (splitDirection === 'HORIZONTAL') {
    const stacks = countPathHorizontalStacks(activeGroup.uid, state.termGroups);
    if (stacks >= 11) {
      return state;
    }
  }
  // If we're splitting in the same direction as the current active
  // group's parent - or if it's the first split for that group -
  // we want the parent to get another child:
  let parentGroup = activeGroup.parentUid ? state.termGroups[activeGroup.parentUid] : activeGroup;
  // If we're splitting in a different direction, we want the current
  // active group to become a new parent instead:
  if (parentGroup.direction && parentGroup.direction !== splitDirection) {
    parentGroup = activeGroup;
  }

  // If the group has a session (i.e. we're creating a new parent)
  // we need to create two new groups,
  // one for the existing session and one for the new split:
  //                          P
  //      P      ->         /   \
  //                       G     G
  const newSession = TermGroup({
    uid: uuidv4(),
    sessionUid: uid,
    parentUid: parentGroup.uid,
    webUrl: (action as any).profile === 'Web Pane' ? (action as any).url || '' : undefined
  });

  state = state.setIn(['termGroups', newSession.uid], newSession);
  if (parentGroup.sessionUid || (parentGroup as any).webUrl !== undefined) {
    const existingSession = TermGroup({
      uid: uuidv4(),
      sessionUid: parentGroup.sessionUid,
      parentUid: parentGroup.uid,
      webUrl: (parentGroup as any).webUrl
    });

    return state.setIn(['termGroups', existingSession.uid], existingSession).setIn(
      ['termGroups', parentGroup.uid],
      parentGroup.merge({
        sessionUid: '',
        webUrl: undefined,
        direction: splitDirection,
        children: [existingSession.uid, newSession.uid]
      })
    );
  }

  const {children} = parentGroup;
  // Insert the new child pane right after the active one:
  const index = children.indexOf(activeGroup.uid) + 1;
  const newChildren = [...children.slice(0, index).asMutable(), newSession.uid, ...children.slice(index).asMutable()];
  state = state.setIn(
    ['termGroups', parentGroup.uid],
    parentGroup.merge({
      direction: splitDirection,
      children: newChildren
    })
  );

  if (parentGroup.sizes) {
    const newSizes = insertRebalance(parentGroup.sizes, index);
    state = state.setIn(['termGroups', parentGroup.uid, 'sizes'], newSizes);
  }

  return state;
};

// Like splitGroup, but the NEW leaf is a clean WEB PANE (webUrl set, NO session,
// NO shell) — for "open this link in a new web pane below". Avoids the terminal-
// split path entirely (which dragged along a shell/blank phantom pane). The
// resulting group is identical in shape to what the chooser's setWebPaneUrl makes.
const splitWebGroup = (state: ITermState, action: any) => {
  const {splitDirection, activeUid, url} = action;
  let activeGroup = findBySession(state, activeUid);
  if (!activeGroup && state.termGroups[activeUid]) {
    activeGroup = state.termGroups[activeUid];
  }
  if (!activeGroup) return state;

  if (splitDirection === 'HORIZONTAL') {
    const stacks = countPathHorizontalStacks(activeGroup.uid, state.termGroups);
    if (stacks >= 11) return state;
  }

  let parentGroup = activeGroup.parentUid ? state.termGroups[activeGroup.parentUid] : activeGroup;
  if (parentGroup.direction && parentGroup.direction !== splitDirection) {
    parentGroup = activeGroup;
  }

  const newSession = TermGroup({
    uid: uuidv4(),
    sessionUid: null,
    parentUid: parentGroup.uid,
    webUrl: url || ''
  });
  state = state.setIn(['termGroups', newSession.uid], newSession);

  if (parentGroup.sessionUid || (parentGroup as any).webUrl !== undefined) {
    const existingSession = TermGroup({
      uid: uuidv4(),
      sessionUid: parentGroup.sessionUid,
      parentUid: parentGroup.uid,
      webUrl: (parentGroup as any).webUrl
    });
    return state
      .setIn(['termGroups', existingSession.uid], existingSession)
      .setIn(['activeSessions', parentGroup.uid], null as any)
      .setIn(
        ['termGroups', parentGroup.uid],
        parentGroup.merge({
          sessionUid: '',
          webUrl: undefined,
          direction: splitDirection,
          children: [existingSession.uid, newSession.uid]
        })
      )
      .set('activeTermGroup', newSession.uid);
  }

  const {children} = parentGroup;
  const index = children.indexOf(activeGroup.uid) + 1;
  const newChildren = [...children.slice(0, index).asMutable(), newSession.uid, ...children.slice(index).asMutable()];
  state = state.setIn(
    ['termGroups', parentGroup.uid],
    parentGroup.merge({direction: splitDirection, children: newChildren})
  );
  if (parentGroup.sizes) {
    const newSizes = insertRebalance(parentGroup.sizes, index);
    state = state.setIn(['termGroups', parentGroup.uid, 'sizes'], newSizes);
  }
  return state.set('activeTermGroup', newSession.uid);
};

// Replace the parent by the given child in the tree,
// used when we remove another child and we're left
// with a one-to-one mapping between parent and child.
const replaceParent = (state: ITermState, parent: ITermGroup, child: ITermGroup) => {
  if (!child) return state;
  if (parent.parentUid) {
    const parentParent = state.termGroups[parent.parentUid];
    // If the parent we're replacing has a parent,
    // we need to change the uid in its children array
    // with `child`:
    const newChildren = parentParent.children.map((uid: string) => (uid === parent.uid ? child.uid : uid));

    state = state.setIn(['termGroups', parentParent.uid, 'children'], newChildren);
  } else {
    // This means the given child will be
    // a root group, so we need to set it up as such:
    const newSessions = state.activeSessions.without(parent.uid).set(child.uid, state.activeSessions[parent.uid]);

    state = state.set('activeSessions', newSessions);

    if (state.activeRootGroup === parent.uid) {
      state = state.set('activeRootGroup', child.uid);
    }
    if (state.activeTermGroup === parent.uid) {
      state = state.set('activeTermGroup', child.uid);
    }

    // Copy tab-level properties to the new root group
    let updatedChild = state.termGroups[child.uid];
    if (parent.tabName !== undefined) {
      updatedChild = updatedChild.set('tabName', parent.tabName);
    }
    if (parent.disableTitleInheritance !== undefined) {
      updatedChild = updatedChild.set('disableTitleInheritance', parent.disableTitleInheritance);
    }
    state = state.setIn(['termGroups', child.uid], updatedChild);
  }

  return state
    .set('termGroups', state.termGroups.without(parent.uid))
    .setIn(['termGroups', child.uid, 'parentUid'], parent.parentUid);
};

const removeGroup = (state: ITermState, uid: string) => {
  const group = state.termGroups[uid];
  // when close tab with multiple panes, it remove group from parent to child. so maybe the parentUid exists but parent group have removed.
  // it's safe to remove the group.
  if (group.parentUid && state.termGroups[group.parentUid]) {
    const parent = state.termGroups[group.parentUid];
    const newChildren = parent.children.filter((childUid) => childUid !== uid);
    if (newChildren.length === 1) {
      // Since we only have one child left,
      // we can merge the parent and child into one group:
      const child = state.termGroups[newChildren[0]];
      if (child) {
        state = replaceParent(state, parent, child);
      } else {
        state = removeGroup(state, parent.uid);
      }
    } else {
      state = state.setIn(['termGroups', group.parentUid, 'children'], newChildren);
      if (parent.sizes) {
        const childIndex = parent.children.indexOf(uid);
        const newSizes = removalRebalance(parent.sizes, childIndex);
        state = state.setIn(['termGroups', group.parentUid, 'sizes'], newSizes);
      }
    }
  }

  return state
    .set('termGroups', state.termGroups.without(uid))
    .set('activeSessions', state.activeSessions.without(uid));
};

const resizeGroup = (state: ITermState, uid: string, sizes: number[]) => {
  // Make sure none of the sizes fall below MIN_SIZE:
  if (sizes.find((size) => size < MIN_SIZE)) {
    return state;
  }

  return state.setIn(['termGroups', uid, 'sizes'], sizes);
};

const reducer: ITermGroupReducer = (state = initialState, action) => {
  const act = action as any;
  switch (act.type) {
    case SESSION_ADD: {
      if (act.isRestore) {
        return state;
      }

      if (act.groupUid) {
        state = state
          .setIn(['termGroups', act.groupUid, 'sessionUid'], act.uid)
          .setIn(['activeSessions', act.groupUid], act.uid)
          .setIn(['termGroups', act.groupUid, 'webUrl'], undefined);
        return setActiveGroup(state, act);
      }

      if (act.splitDirection) {
        state = splitGroup(state, act);
        return setActiveGroup(state, act);
      }

      const uid = uuidv4();
      const termGroup = TermGroup({
        uid,
        sessionUid: act.uid,
        webUrl: act.profile === 'Web Pane' ? act.url || '' : undefined
      });

      return state
        .setIn(['termGroups', uid], termGroup)
        .setIn(['activeSessions', uid], act.uid)
        .set('activeRootGroup', uid)
        .set('activeTermGroup', uid);
    }
    case RESTORE_LAYOUT_STATE: {
      const {savedState} = act;
      return state
        .set('termGroups', Immutable(savedState.termGroups))
        .set('activeSessions', Immutable(savedState.activeSessions))
        .set('activeRootGroup', savedState.activeRootGroup)
        .set('activeTermGroup', savedState.activeTermGroup || null);
    }
    case SESSION_SET_ACTIVE:
      return setActiveGroup(state, act);
    case TERM_GROUP_RESIZE:
      return resizeGroup(state, act.uid, act.sizes);
    case TERM_GROUP_EXIT:
      return removeGroup(state, act.uid);

    case TERM_GROUP_SET_WEB_URL: {
      const {uid, url} = act;
      if (url !== null && url !== undefined) {
        const rootGroup = state.termGroups[uid] ? findRootGroup(state.termGroups, uid) : null;
        let nextState = state
          .setIn(['termGroups', uid, 'webUrl'], url)
          .setIn(['termGroups', uid, 'sessionUid'], null)
          .set('activeTermGroup', uid);
        if (rootGroup) {
          nextState = nextState.setIn(['activeSessions', rootGroup.uid], null as any);
        }
        return nextState;
      }
      return state.setIn(['termGroups', uid, 'webUrl'], url);
    }
    case TERM_GROUP_ADD_WEB_TAB: {
      const {url} = act;
      const uid = uuidv4();
      const termGroup = TermGroup({uid});
      return state
        .setIn(['termGroups', uid], termGroup)
        .setIn(['termGroups', uid, 'webUrl'], url)
        .setIn(['activeSessions', uid], null as any)
        .set('activeRootGroup', uid)
        .set('activeTermGroup', uid);
    }
    case 'TERM_GROUP_SPLIT_WEB' as any: {
      return splitWebGroup(state, act);
    }
    case TERM_GROUP_ACTIVATE_WEB_TAB: {
      const {uid} = act;
      return state.set('activeRootGroup', uid).set('activeTermGroup', uid);
    }
    case TERM_GROUP_SET_WEB_NAME: {
      const {uid, name} = act;
      return state.setIn(['termGroups', uid, 'webName'], name);
    }
    case TERM_GROUP_SET_TAB_NAME: {
      const {uid, tabName, manual} = act;
      // uid may be a session uid OR a term-group uid — resolve to the root group.
      let groupUid: string | null = null;
      if (state.termGroups[uid]) {
        groupUid = findRootGroup(state.termGroups, uid).uid;
      } else {
        const child = findBySession(state, uid);
        if (child) groupUid = findRootGroup(state.termGroups, child.uid).uid;
      }
      if (!groupUid) return state;
      // manualTabName is true ONLY for a non-empty user-typed rename. Agent/auto
      // renames (manual=false) and clears (empty) leave it false, so the
      // "Use Automatic Name" revert stays hidden unless the human set the name.
      const manualTabName = !!manual && !!tabName;
      return state
        .setIn(['termGroups', groupUid, 'tabName'], tabName)
        .setIn(['termGroups', groupUid, 'manualTabName'], manualTabName);
    }
    case 'TERM_GROUP_SET_ACTIVE': {
      const {uid} = act;
      if (!state.termGroups[uid]) return state;
      const rootGroup = findRootGroup(state.termGroups, uid);
      return state
        .set('activeRootGroup', rootGroup.uid)
        .set('activeTermGroup', uid)
        .setIn(['activeSessions', rootGroup.uid], null as any);
    }
    case TERM_GROUP_TOGGLE_TITLE_INHERITANCE: {
      const {uid} = act;
      const rootGroup = state.termGroups[uid] ? findRootGroup(state.termGroups, uid) : null;
      if (!rootGroup) return state;
      const val = !rootGroup.disableTitleInheritance;
      return state.setIn(['termGroups', rootGroup.uid, 'disableTitleInheritance'], val);
    }
    case TERM_GROUP_POP_OUT_PANE: {
      const {uid} = act;
      const group = state.termGroups[uid];
      if (!group || !group.parentUid) return state;

      const parent = state.termGroups[group.parentUid];
      if (!parent) return state;

      const newChildren = parent.children.filter((childUid) => childUid !== uid);

      if (newChildren.length === 1) {
        const child = state.termGroups[newChildren[0]];
        if (child) {
          state = replaceParent(state, parent, child);
        } else {
          state = removeGroup(state, parent.uid);
        }
      } else {
        state = state.setIn(['termGroups', group.parentUid, 'children'], newChildren);
        if (parent.sizes) {
          const childIndex = parent.children.indexOf(uid);
          const newSizes = removalRebalance(parent.sizes, childIndex);
          state = state.setIn(['termGroups', group.parentUid, 'sizes'], newSizes);
        }
      }

      state = state.setIn(['termGroups', uid, 'parentUid'], null);

      let sessionUid = group.sessionUid;
      if (!sessionUid) {
        const getFirstLeafSession = (gUid: string): string | null => {
          const g = state.termGroups[gUid];
          if (!g) return null;
          if (g.sessionUid) return g.sessionUid;
          if (g.children && g.children.length > 0) {
            for (const childUid of g.children) {
              const res = getFirstLeafSession(childUid);
              if (res) return res;
            }
          }
          return null;
        };
        sessionUid = getFirstLeafSession(uid);
      }

      state = state.setIn(['activeSessions', uid], sessionUid || (null as any));
      return state.set('activeRootGroup', uid).set('activeTermGroup', uid);
    }
    case TERM_GROUP_REORDER: {
      const {fromUid, toIndex} = act;
      // Get root group UIDs in current order
      const rootUids = Object.keys(state.termGroups).filter((uid) => !state.termGroups[uid].parentUid);
      const fromIndex = rootUids.indexOf(fromUid);
      if (fromIndex < 0 || fromIndex === toIndex || toIndex < 0 || toIndex >= rootUids.length) {
        return state;
      }
      // Move fromUid to toIndex
      rootUids.splice(fromIndex, 1);
      rootUids.splice(toIndex, 0, fromUid);
      // Rebuild termGroups with root groups in new order, preserving child groups
      const childUids = Object.keys(state.termGroups).filter((uid) => !!state.termGroups[uid].parentUid);
      const newOrder = [...rootUids, ...childUids];
      const reordered: Record<string, any> = {};
      for (const uid of newOrder) {
        reordered[uid] = state.termGroups[uid];
      }
      return state.set('termGroups', Immutable(reordered as any));
    }
    default:
      return state;
  }
};

export default decorateTermGroupsReducer(reducer);
