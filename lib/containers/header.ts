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

const getSessions = ({sessions}: HyperState) => sessions.sessions;
const getActiveRootGroup = ({termGroups}: HyperState) => termGroups.activeRootGroup;
const getActiveSessions = ({termGroups}: HyperState) => termGroups.activeSessions;
const getActivityMarkers = ({ui}: HyperState) => ui.activityMarkers;
const getBellMarkers = ({ui}: HyperState) => ui.bellMarkers;
const getAgentStatuses = ({ui}: HyperState) => ui.agentStatuses;
const getTabs = createSelector(
  [
    getSessions,
    getRootGroups,
    getActiveSessions,
    getActiveRootGroup,
    getActivityMarkers,
    getBellMarkers,
    getAgentStatuses
  ],
  (sessions, rootGroups, activeSessions, activeRootGroup, activityMarkers, bellMarkers, agentStatuses) =>
    rootGroups.map((t): ITab => {
      const activeSessionUid = activeSessions[t.uid];
      const session = sessions[activeSessionUid];
      if (!session) {
        // Web pane tab — derive title from custom name or URL
        const webUrl = (t as any).webUrl as string | undefined;
        const webName = (t as any).webName as string | undefined;
        let title = 'Web Pane';
        if (webName) {
          title = webName;
        } else if (webUrl) {
          try {
            title = new URL(webUrl).hostname || webUrl;
          } catch {
            title = webUrl;
          }
        }
        return {
          uid: t.uid,
          title,
          tabName: title,
          description: '',
          isActive: t.uid === activeRootGroup,
          hasActivity: false,
          hasBell: false,
          agentStatus: undefined,
          isWebPane: true,
          webUrl: webUrl || undefined
        };
      }
      // Source of truth for the tab label: the root group's tabName.
      // Falls back to per-session fields for tabs created before this change.
      const groupTabName = (t as any).tabName as string | null | undefined;
      return {
        uid: t.uid,
        title: session.title,
        tabName: groupTabName || session.tabName || session.title,
        description: session.description || '',
        isActive: t.uid === activeRootGroup,
        hasActivity: activityMarkers[session.uid],
        hasBell: !!bellMarkers[session.uid],
        agentStatus: agentStatuses[session.uid]
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
      dispatch(((d: HyperDispatch, getState: () => HyperState) => {
        const group = getState().termGroups.termGroups[uid];
        if ((group as any)?.webUrl !== undefined) {
          d({type: TERM_GROUP_SET_WEB_NAME, uid, name: description} as any);
        } else {
          // The rename UI surfaces this as a "describe" hook but for terminal
          // tabs it just renames the tab. Route directly to the tab-name setter
          // so we update the root group's tabName (the source of truth) without
          // touching session.description.
          d(setSessionTabName(uid, description) as any);
        }
      }) as any);
    },

    onMoveTab: (fromUid: string, toIndex: number) => {
      dispatch({type: 'TERM_GROUP_REORDER', fromUid, toIndex} as any);
    }
  };
};

export const HeaderContainer = connect(mapStateToProps, mapDispatchToProps, null)(Header, 'Header');

export type HeaderConnectedProps = ReturnType<typeof mapStateToProps> & ReturnType<typeof mapDispatchToProps>;
