module.exports = {
  files: ['test/unit/*'],
  extensions: ['ts'],
  require: ['ts-node/register/transpile-only'],
  cache: false,
  // Windows: ava's parallel workers race to write+rename its
  // import-from-project.mjs loader shim under node_modules/.cache/ava,
  // intermittently throwing EPERM (operation not permitted, rename ...).
  // Serializing workers eliminates the race. The unit suite is tiny so
  // there's no meaningful runtime cost.
  concurrency: 1,
  workerThreads: false
};
