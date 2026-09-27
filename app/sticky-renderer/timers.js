// Default timer set for modules that accept injectable ctx.timers (tests pass fakes).
// Each call goes through the global, never as a method of this object: in the
// renderer these are window.setTimeout & co., which throw "Illegal invocation"
// when called with any other `this`.
'use strict';

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id)
  };
}

module.exports = {defaultTimers};
