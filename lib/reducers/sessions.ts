import Immutable from 'seamless-immutable';
import {uniqueNamesGenerator, adjectives, animals} from 'unique-names-generator';

import {
  SESSION_ADD,
  SESSION_PTY_EXIT,
  SESSION_USER_EXIT,
  SESSION_PTY_DATA,
  SESSION_SET_ACTIVE,
  SESSION_CLEAR_ACTIVE,
  SESSION_SET_TAB_NAME,
  SESSION_RESIZE,
  SESSION_SET_XTERM_TITLE,
  SESSION_SET_CWD,
  SESSION_SEARCH,
  SESSION_SET_DESCRIPTION
} from '../../typings/constants/sessions';
import type {sessionState, session, Mutable, ISessionReducer} from '../../typings/hyper';
import {decorateSessionsReducer} from '../utils/plugins';

const generatedTabNames = new Set<string>();

function nextTabName(): string {
  const prefixes = [
    'Project', 'Scheme', 'Plan', 'Codename', 'Operation', 'Taskforce',
    'Protocol', 'Endeavor', 'Mission', 'Quest', 'Venture', 'Initiative',
    'Enterprise', 'Campaign', 'Maneuver', 'Blueprint', 'Strategy', 'Crusade'
  ];
  const adjs = [
    'Shimmering', 'Preposterous', 'Gigantic', 'Turbulent', 'Furious', 'Whispering',
    'Obsolete', 'Cybernetic', 'Hypnotic', 'Invisible', 'Explosive', 'Scurrying',
    'Spicy', 'Gelatinous', 'Cosmic', 'Polka-Dot', 'Retro', 'Electric', 'Volatile',
    'Bizarre', 'Fuzzy', 'Microscopic', 'Hyperactive', 'Delirious', 'Sassy'
  ];
  const suffixes = [
    'NUCLEAR ☢️', 'Octopus 🐙', 'Slipper 🥿', 'Sausage 🌭', 'Mongoose 🦡',
    'Tornado 🌪️', 'Glitch 👾', 'Banana 🍌', 'Thunder ⚡', 'Whisper 🤫',
    'Flamingo 🦩', 'Taco 🌮', 'Waffle 🧇', 'Unicorn 🦄', 'Zombie 🧟',
    'Laser 🔫', 'Quantum 🌀', 'Rhubarb 🥬', 'Pickle 🥒', 'Bacon 🥓',
    'Sputnik 🚀', 'Dynamite 🧨', 'Jellyfish 🪼', 'Cactus 🌵', 'Marshmallow 🍢',
    'Sloth 🦥', 'Wombat 🐨', 'Noodle 🍜', 'Meatball 🧆', 'Teapot 🫖',
    'Balloon 🎈', 'Disaster 💥', 'Specter 👻', 'Goblin 👺', 'Kraken 🦑',
    'Pineapple 🍍', 'Accordion 🪗', 'Boomerang 🪃', 'Lollipop 🍭', 'Disco 🪩',
    'Gumball 🍬', 'Capybara 🦦', 'Panda 🐼', 'Lobster 🦞', 'Caterpillar 🐛',
    'Dragon 🐉', 'Dinosaur 🦖', 'Mammoth 🦣', 'Robot 🤖', 'Alien 👽',
    'Firefly 🪰', 'Jellybean 🍬', 'Cupcake 🧁', 'Doughnut 🍩', 'Avocado 🥑',
    'Broccoli 🥦', 'Garlic 🧄', 'Croissant 🥐', 'Pretzel 🥨', 'Cheese 🧀'
  ];

  let name = '';
  let retries = 0;
  while (retries < 100) {
    const p = prefixes[Math.floor(Math.random() * prefixes.length)];
    const adj = adjs[Math.floor(Math.random() * adjs.length)];
    const s = suffixes[Math.floor(Math.random() * suffixes.length)];
    name = `${p} ${adj} ${s}`;
    if (!generatedTabNames.has(name)) {
      generatedTabNames.add(name);
      break;
    }
    retries++;
  }
  return name;
}

function nextShellName(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: ' ',
    style: 'capital',
    length: 2
  });
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
    profile: '',
    shellName: ''
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
      const inheritedTabName =
        (action.splitDirection || !action.isNewGroup) && action.activeUid
          ? state.sessions[action.activeUid]?.description ||
            state.sessions[action.activeUid]?.tabName ||
            state.sessions[action.activeUid]?.title ||
            ''
          : '';
      const name = inheritedTabName || nextTabName();
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
          profile: action.profile,
          cwd: action.cwd || '',
          shellName: nextShellName()
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
      if (action.manual) {
        return state.setIn(['sessions', action.uid, 'title'], newTitle);
      }
      // Ignore shell path titles — keep the cute name
      if (!newTitle || /[/\\]/.test(newTitle) || /^(cmd|powershell|bash|sh|zsh|Command Prompt)/i.test(newTitle)) {
        return state;
      }
      return state.setIn(['sessions', action.uid, 'title'], newTitle);
    }

    case SESSION_SET_DESCRIPTION:
      return state
        .setIn(['sessions', action.uid, 'description'], action.description)
        .setIn(['sessions', action.uid, 'tabName'], action.tabName);

    case SESSION_SET_TAB_NAME:
      return state.setIn(['sessions', action.uid, 'tabName'], action.tabName);

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
      if (action.uid && state.sessions[action.uid]) {
        return state.setIn(['sessions', action.uid, 'cwd'], action.cwd);
      }
      if (state.activeUid) {
        return state.setIn(['sessions', state.activeUid, 'cwd'], action.cwd);
      }
      return state;

    default:
      return state;
  }
};

export default decorateSessionsReducer(reducer);
