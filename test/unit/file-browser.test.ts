import type {Stats} from 'fs';

import test from 'ava';

import {fileBrowserLabel, isLocalDir} from '../../lib/utils/file-browser';

test('label names the platform file browser', (t) => {
  t.is(fileBrowserLabel('win32'), 'Open in Explorer');
  t.is(fileBrowserLabel('darwin'), 'Open in Finder');
  t.is(fileBrowserLabel('linux'), 'Open in File Manager');
  t.is(fileBrowserLabel('freebsd'), 'Open in File Manager');
});

test('label defaults to process.platform', (t) => {
  t.is(fileBrowserLabel(), fileBrowserLabel(process.platform));
});

const stat = (kind: 'dir' | 'file' | 'missing') => (): Stats => {
  if (kind === 'missing') throw new Error('ENOENT');
  return {isDirectory: () => kind === 'dir'} as Stats;
};

test('isLocalDir only accepts an existing directory', (t) => {
  t.true(isLocalDir('/some/dir', stat('dir')));
  t.false(isLocalDir('/some/file', stat('file')));
  t.false(isLocalDir('/remote/only', stat('missing')));
  t.false(isLocalDir('', stat('dir')));
  t.false(isLocalDir(null, stat('dir')));
  t.false(isLocalDir(undefined, stat('dir')));
});
