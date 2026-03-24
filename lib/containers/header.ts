import {createSelector} from 'reselect';

import type {HyperState, HyperDispatch, ITab} from '../../typings/hyper';
import {closeTab, changeTab, maximize, openHamburgerMenu, unmaximize, minimize, close} from '../actions/header';
import {setSessionDescription} from '../actions/sessions';
import {requestTermGroup} from '../actions/term-groups';
import Header from '../components/header';
import {getRootGroups} from '../selectors';
import {connect} from '../utils/plugins';

const isMac = /Mac/.test(navigator.userAgent);

const getSessions = ({sessions}: HyperState) => sessions.sessions;
const getActiveRootGroup = ({termGroups}: HyperState) => termGroups.activeRootGroup;
const getActiveSessions = ({termGroups}: HyperState) => termGroups.activeSessions;
const getActivityMarkers = ({ui}: HyperState) => ui.activityMarkers;
const getAgentStatuses = ({ui}: HyperState) => ui.agentStatuses;
const getTabs = createSelector(
  [getSessions, getRootGroups, getActiveSessions, getActiveRootGroup, getActivityMarkers, getAgentStatuses],
  (sessions, rootGroups, activeSessions, activeRootGroup, activityMarkers, agentStatuses) =>
    rootGroups.map((t): ITab => {
      const activeSessionUid = activeSessions[t.uid];
      const session = sessions[activeSessionUid];
      return {
        uid: t.uid,
        title: session.title,
        tabName: session.tabName || session.title,
        description: session.description || '',
        isActive: t.uid === activeRootGroup,
        hasActivity: activityMarkers[session.uid],
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
      dispatch(setSessionDescription(uid, description) as any);
    }
  };
};

export const HeaderContainer = connect(mapStateToProps, mapDispatchToProps, null)(Header, 'Header');

export type HeaderConnectedProps = ReturnType<typeof mapStateToProps> & ReturnType<typeof mapDispatchToProps>;
