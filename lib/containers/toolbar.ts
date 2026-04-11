import {connect} from 'react-redux';

import type {HyperState, HyperDispatch} from '../../typings/hyper';
import {requestTermGroup, openWebPaneInNewTab} from '../actions/term-groups';
import Toolbar from '../components/toolbar';

const mapStateToProps = (state: HyperState) => ({
  defaultProfile: state.ui.defaultProfile,
  profiles: state.ui.profiles.asMutable({deep: true}) as any
});

const mapDispatchToProps = (dispatch: HyperDispatch) => ({
  openNewTab: (profile: string) => {
    dispatch(requestTermGroup(undefined, profile));
  },
  openWebPane: (url: string) => {
    dispatch(openWebPaneInNewTab(url) as any);
  }
});

export const ToolbarContainer = connect(mapStateToProps, mapDispatchToProps)(Toolbar);
