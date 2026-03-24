import Immutable from 'seamless-immutable';

import {
  SESSION_ADD,
  SESSION_PTY_EXIT,
  SESSION_USER_EXIT,
  SESSION_PTY_DATA,
  SESSION_SET_ACTIVE,
  SESSION_CLEAR_ACTIVE,
  SESSION_RESIZE,
  SESSION_SET_XTERM_TITLE,
  SESSION_SET_CWD,
  SESSION_SEARCH,
  SESSION_SET_DESCRIPTION
} from '../../typings/constants/sessions';
import type {sessionState, session, Mutable, ISessionReducer} from '../../typings/hyper';
import {decorateSessionsReducer} from '../utils/plugins';

const TAB_NAMES = [
  'Axolotl',
  'Quokka',
  'Pika',
  'Capybara',
  'Fennec',
  'Pangolin',
  'Numbat',
  'Chinchilla',
  'Tamarin',
  'Loris',
  'Dugong',
  'Kinkajou',
  'Bushbaby',
  'Puffin',
  'Wombat',
  'Hedgehog',
  'Otter',
  'Narwhal',
  'Void Kraken',
  'Star Reaver',
  'Nebula Fang',
  'Pulsar Maw',
  'Gravity Wyrm',
  'Plasma Hydra',
  'Cosmic Talon',
  'Dark Leviathan',
  'Rift Stalker',
  'Nova Scorpion',
  'Quasar Beast',
  'Ion Viper',
  'Warp Mantis',
  'Singularity Eel',
  'Flux Raptor',
  'Solar Barb',
  'Eclipse Shark',
  'Photon Wolf',
  'Comet Drake',
  'Aether Wasp'
];
let nameIndex = Math.floor(Math.random() * TAB_NAMES.length);
function nextTabName(): string {
  return TAB_NAMES[nameIndex++ % TAB_NAMES.length];
}

const initialState: sessionState = Immutable<Mutable<sessionState>>({
  sessions: {},
  activeUid: null
});

function Session(obj: Immutable.DeepPartial<session>) {
  const x: session = {
    uid: '',
    title: '',
    tabName: '',
    description: '',
    cols: null,
    rows: null,
    cleared: false,
    search: false,
    shell: '',
    pid: null,
    profile: ''
  };
  return Immutable(x).merge(obj);
}

function deleteSession(state: sessionState, uid: string) {
  return state.updateIn(['sessions'], (sessions: (typeof state)['sessions']) => {
    const sessions_ = sessions.asMutable();
    delete sessions_[uid];
    return sessions_;
  });
}

const reducer: ISessionReducer = (state = initialState, action) => {
  switch (action.type) {
    case SESSION_ADD: {
      const name = nextTabName();
      return state.set('activeUid', action.uid).setIn(
        ['sessions', action.uid],
        Session({
          cols: action.cols,
          rows: action.rows,
          uid: action.uid,
          title: name,
          tabName: name,
          description: '',
          shell: action.shell ? action.shell.split('/').pop() : null,
          pid: action.pid,
          profile: action.profile
        })
      );
    }

    case SESSION_SET_ACTIVE:
      return state.set('activeUid', action.uid);

    case SESSION_SEARCH:
      return state.setIn(['sessions', action.uid, 'search'], action.value);

    case SESSION_CLEAR_ACTIVE:
      return state.merge(
        {
          sessions: {
            [state.activeUid!]: {
              cleared: true
            }
          }
        },
        {deep: true}
      );

    case SESSION_PTY_DATA:
      // we avoid a direct merge for perf reasons
      // as this is the most common action
      if (state.sessions[action.uid]?.cleared) {
        return state.merge(
          {
            sessions: {
              [action.uid]: {
                cleared: false
              }
            }
          },
          {deep: true}
        );
      }
      return state;

    case SESSION_PTY_EXIT:
      if (state.sessions[action.uid]) {
        return deleteSession(state, action.uid);
      }
      console.log('ignore pty exit: session removed by user');
      return state;

    case SESSION_USER_EXIT:
      return deleteSession(state, action.uid);

    case SESSION_SET_XTERM_TITLE: {
      const newTitle = action.title.trim();
      // Ignore shell path titles — keep the cute name
      if (!newTitle || /[/\\]/.test(newTitle) || /^(cmd|powershell|bash|sh|zsh|Command Prompt)/i.test(newTitle)) {
        return state;
      }
      return state.setIn(['sessions', action.uid, 'title'], newTitle);
    }

    case SESSION_SET_DESCRIPTION:
      return state.setIn(['sessions', action.uid, 'description'], action.description);

    case SESSION_RESIZE:
      return state.setIn(
        ['sessions', action.uid],
        state.sessions[action.uid].merge({
          rows: action.rows,
          cols: action.cols,
          resizeAt: action.now
        })
      );

    case SESSION_SET_CWD:
      if (state.activeUid) {
        return state.setIn(['sessions', state.activeUid, 'cwd'], action.cwd);
      }
      return state;

    default:
      return state;
  }
};

export default decorateSessionsReducer(reducer);
