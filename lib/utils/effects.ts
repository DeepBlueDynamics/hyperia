import type {Dispatch, Middleware} from 'redux';

import type {HyperActions, HyperState} from '../../typings/hyper';
/**
 * Simple redux middleware that executes
 * the `effect` field if provided in an action
 * since this is preceded by the `plugins`
 * middleware. It allows authors to interrupt,
 * defer or add to existing side effects at will
 * as the result of an action being triggered.
 */
const effectsMiddleware: Middleware<{}, HyperState, Dispatch<HyperActions>> = () => (next) => (action) => {
  const ret = next(action);
  if (action.effect) {
    action.effect();
    delete action.effect;
  }

  return ret;
};
export default effectsMiddleware;
