// Frozen IPC contract between sticky.html renderer modules and app/sticky.ts.
// Channel names must match the main-process listeners. Run channels follow
// plan/sticky-schedules/CONTRACT.md.
'use strict';

const SEND = Object.freeze([
  'sticky-toggle-seethrough',
  'sticky-open-external',
  'sticky-open-note',
  'sticky-color',
  'sticky-context-menu',
  'sticky-open-file',
  'sticky-close',
  'sticky-fit',
  'generate-summary-sticky',
  'open-matching-stickys'
]);

const ON = Object.freeze([
  'sticky-toast',
  'sticky-edit-link',
  'sticky-set-highlight',
  'sticky-bind-file',
  'sticky-unbind-file',
  'sticky-file-changed',
  'sticky-set-color',
  'sticky-copy-all',
  'sticky-run-state',
  'sticky-result',
  'note-updated',
  'sticky-rename',
  'sticky-delete',
  'stickys-changed'
]);

const INVOKE = Object.freeze([
  'sticky-pick-dir',
  'sticky-run-set',
  'sticky-run-clear',
  'sticky-run-now',
  'sticky-run-pause',
  'sticky-run-history',
  'sticky-run-panes',
  'sticky-n8-status',
  'sticky-n8-start'
]);

module.exports = {
  SEND,
  ON,
  INVOKE,
  ALL: Object.freeze([...SEND, ...ON, ...INVOKE])
};
