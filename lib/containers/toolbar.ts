import {connect} from 'react-redux';

import type {HyperState, HyperDispatch} from '../../typings/hyper';
import {requestTermGroup} from '../actions/term-groups';
import Toolbar from '../components/toolbar';

const mapStateToProps = (state: HyperState) => ({
  defaultProfile: state.ui.defaultProfile,
  profiles: state.ui.profiles.asMutable({deep: true})
});

const mapDispatchToProps = (dispatch: HyperDispatch) => ({
  openNewTab: (profile: string) => {
    dispatch(requestTermGroup(undefined, profile));
  }
});

export const ToolbarContainer = connect(mapStateToProps, mapDispatchToProps)(Toolbar);
