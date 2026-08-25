module.exports = {
  files: ['test/*'],
  extensions: ['ts'],
  require: ['ts-node/register/transpile-only'],
  // Cold CI VMs need real time: packaged-app first launch spawns the sidecar
  // and the before-hook sleeps 5s after firstWindow. 30s flaked on win/mac.
  timeout: '120s'
};
