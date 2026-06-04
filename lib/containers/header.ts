import {createSelector} from 'reselect';

import {TERM_GROUP_SET_WEB_NAME} from '../../typings/constants/term-groups';
import type {HyperState, HyperDispatch, ITab} from '../../typings/hyper';
import {closeTab, changeTab, maximize, openHamburgerMenu, unmaximize, minimize, close} from '../actions/header';
import {setSessionTabName} from '../actions/sessions';
import {requestTermGroup} from '../actions/term-groups';
import Header from '../components/header';
import {getRootGroups} from '../selectors';
import {connect} from '../utils/plugins';

const isMac = /Mac/.test(navigator.userAgent);

const PALETTE = [
  'var(--text-success)', // Green
  'var(--text-info)', // Blue
  'var(--text-warning)', // Yellow/Orange
  'var(--text-danger)', // Red
  '#ec4899', // Pink
  '#8b5cf6', // Purple
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#10b981' // Emerald
];

const hashCode = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
};

const getSessions = ({sessions}: HyperState) => sessions.sessions;
const getActiveRootGroup = ({termGroups}: HyperState) => termGroups.activeRootGroup;
const getActiveSessions = ({termGroups}: HyperState) => termGroups.activeSessions;
const getActivityMarkers = ({ui}: HyperState) => ui.activityMarkers;
const getBellMarkers = ({ui}: HyperState) => ui.bellMarkers;
const getAgentStatuses = ({ui}: HyperState) => ui.agentStatuses;
const getTermGroups = ({termGroups}: HyperState) => termGroups.termGroups;
const getLeaves = (termGroups: Record<string, any>, group: any): Record<string, any>[] => {
  if (!group) return [];
  if (!group.children || group.children.length === 0) {
    return [group] as Record<string, any>[];
  }
  const children = (group.children || []) as string[];
  const leavesList: Record<string, any>[] = [];
  for (const cUid of children) {
    leavesList.push(...getLeaves(termGroups, termGroups[cUid]));
  }
  return leavesList;
};

const getTabs = createSelector(
  [
    getSessions,
    getRootGroups,
    getActiveSessions,
    getActiveRootGroup,
    getActivityMarkers,
    getBellMarkers,
    getAgentStatuses,
    getTermGroups
  ],
  (sessions, rootGroups, activeSessions, activeRootGroup, activityMarkers, bellMarkers, agentStatuses, termGroups) =>
    rootGroups.map((t: any): ITab => {
      const leaves = getLeaves(termGroups, t);
      const firstLeaf = leaves[0];
      const isFirstLeafWeb = firstLeaf && !firstLeaf.sessionUid;
      const groupTabName: string | null | undefined = t.tabName;

      let title = groupTabName || '';
      if (isFirstLeafWeb) {
        if (!title && !t.disableTitleInheritance) {
          title = (firstLeaf.webName as string) || '';
        }
        if (!title && firstLeaf.webUrl) {
          const urlStr = firstLeaf.webUrl as string;
          if (urlStr.startsWith('ai://')) {
            title = 'ask';
          } else {
            try {
              title = new URL(urlStr).hostname || urlStr;
            } catch {
              title = urlStr;
            }
          }
        }
        if (!title) title = 'Browser';
      } else {
        if (!title) {
          const firstSessionUid = firstLeaf ? (firstLeaf.sessionUid as string) : null;
          const session = firstSessionUid ? sessions[firstSessionUid] : null;
          title = session ? session.tabName || session.title : 'Terminal';
        }
      }

      // Collect pane colors
      const startIdx = hashCode(t.uid as string) % PALETTE.length;
      const mapLeafToColor = (leaf: any, idx: number): string => {
        const url = leaf ? leaf.webUrl : null;
        if (typeof url === 'string' && url.startsWith('ai://')) {
          return 'var(--text-ai)';
        }
        // Align tab colors directly with the pane's rotating TINTS
        const splitLabel = leaf ? leaf.splitLabel : '';
        const paneIdx = splitLabel ? splitLabel.charCodeAt(0) - 97 : idx;
        const TINTS = [
          'var(--text-success)',
          'var(--text-info)',
          'var(--text-warning)',
          'var(--text-danger)'
        ];
        return TINTS[(startIdx + paneIdx) % TINTS.length];
      };
      const paneColors = leaves.map((leaf, idx) => mapLeafToColor(leaf, idx));

      // Check overall activity and bell markers across all sessions in this tab
      const hasActivity = leaves.some((leaf) => leaf.sessionUid && activityMarkers[leaf.sessionUid]);
      const hasBell = leaves.some((leaf) => leaf.sessionUid && bellMarkers[leaf.sessionUid]);

      // Agent status from active session or first session
      const activeSessionUid = activeSessions[t.uid];
      const agentSessionUid = (activeSessionUid || (firstLeaf ? firstLeaf.sessionUid : null)) as string;
      const agentStatus = agentSessionUid ? agentStatuses[agentSessionUid] : undefined;

      return {
        uid: t.uid,
        title,
        tabName: title,
        description: (firstLeaf?.sessionUid && sessions[firstLeaf.sessionUid]?.description) || '',
        isActive: t.uid === activeRootGroup,
        hasActivity,
        hasBell,
        agentStatus,
        isWebPane: isFirstLeafWeb,
        webUrl: isFirstLeafWeb && firstLeaf ? firstLeaf.webUrl || undefined : undefined,
        paneColors,
        groupTabName: groupTabName || undefined,
        disableTitleInheritance: !!t.disableTitleInheritance
      };
    })
);

const mapStateToProps = (state: HyperState) => {
  return {
    // active is an index
    isMac,
    tabs: getTabs(state),
    activeMarkers: state.ui.activityMarkers,
    borderColor: state.ui.borderColor,
    backgroundColor: state.ui.backgroundColor,
    maximized: state.ui.maximized,
    fullScreen: state.ui.fullScreen,
    showHamburgerMenu: state.ui.showHamburgerMenu,
    showWindowControls: state.ui.showWindowControls,
    defaultProfile: state.ui.defaultProfile,
    profiles: state.ui.profiles
  };
};

const mapDispatchToProps = (dispatch: HyperDispatch) => {
  return {
    onCloseTab: (i: string) => {
      dispatch(closeTab(i));
    },

    onChangeTab: (i: string) => {
      dispatch(changeTab(i));
    },

    maximize: () => {
      dispatch(maximize());
    },

    unmaximize: () => {
      dispatch(unmaximize());
    },

    openHamburgerMenu: (coordinates: {x: number; y: number}) => {
      dispatch(openHamburgerMenu(coordinates));
    },

    minimize: () => {
      dispatch(minimize());
    },

    close: () => {
      dispatch(close());
    },

    openNewTab: (profile: string) => {
      dispatch(requestTermGroup(undefined, profile));
    },

    onDescribe: (uid: string, description: string) => {
      dispatch(((d: HyperDispatch) => {
        // Always set session tab name on the root term group for both web and terminal tabs
        // to persist it across reloads and navigation.
        d(setSessionTabName(uid, description) as any);
      }) as any);
    },

    onToggleTitleInheritance: (uid: string) => {
      dispatch({type: 'TERM_GROUP_TOGGLE_TITLE_INHERITANCE', uid} as any);
    },

    onMoveTab: (fromUid: string, toIndex: number) => {
      dispatch({type: 'TERM_GROUP_REORDER', fromUid, toIndex} as any);
    }
  };
};

export const HeaderContainer = connect(mapStateToProps, mapDispatchToProps, null)(Header, 'Header');

export type HeaderConnectedProps = ReturnType<typeof mapStateToProps> & ReturnType<typeof mapDispatchToProps>;
