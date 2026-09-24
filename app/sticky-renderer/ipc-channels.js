// Frozen IPC contract between sticky.html renderer modules and app/sticky.ts.
// Channel names must match the main-process listeners. Structural extraction
// does not rename any of these.
'use strict';

const SEND = Object.freeze([
  'sticky-toggle-seethrough',
  'sticky-open-external',
  'sticky-open-note',
  'sticky-color',
  'sticky-context-menu',
  'sticky-open-file',
  'sticky-schedule',
  'sticky-unschedule',
  'sticky-close',
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
  'sticky-lock',
  'sticky-armed',
  'note-updated',
  'sticky-rename',
  'sticky-delete',
  'stickys-changed'
]);

const INVOKE = Object.freeze(['sticky-pick-dir']);

module.exports = {
  SEND,
  ON,
  INVOKE,
  ALL: Object.freeze([...SEND, ...ON, ...INVOKE])
};
