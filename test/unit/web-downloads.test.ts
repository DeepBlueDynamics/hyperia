import test from 'ava';

import {safeDownloadName, uniqueDownloadName} from '../../app/utils/download-name';
import {downloadDetail, downloadProgress, formatBytes, isActiveDownload} from '../../lib/utils/download-format';

test('safeDownloadName: strips path parts and characters Windows rejects', (t) => {
  t.is(safeDownloadName('../../etc/passwd'), 'passwd');
  t.is(safeDownloadName('a<b>:c?.txt'), 'a_b__c_.txt');
  t.is(safeDownloadName(''), 'download');
  t.is(safeDownloadName('..'), 'download');
});

test('uniqueDownloadName: numbers duplicates before the extension, Chrome-style', (t) => {
  const taken = new Set(['report.pdf', 'report (1).pdf']);
  t.is(
    uniqueDownloadName('report.pdf', (c) => taken.has(c)),
    'report (2).pdf'
  );
  t.is(
    uniqueDownloadName('new.pdf', (c) => taken.has(c)),
    'new.pdf'
  );
  t.is(
    uniqueDownloadName('README', (c) => c === 'README'),
    'README (1)'
  );
});

test('uniqueDownloadName: keeps .tar.gz together', (t) => {
  t.is(
    uniqueDownloadName('src.tar.gz', (c) => c === 'src.tar.gz'),
    'src (1).tar.gz'
  );
});

test('formatBytes: readable units', (t) => {
  t.is(formatBytes(512), '512 B');
  t.is(formatBytes(1536), '1.5 KB');
  t.is(formatBytes(27 * 1024 * 1024), '27 MB');
  t.is(formatBytes(-1), '0 B');
});

test('downloadProgress: a fraction, or -1 when the size is unknown', (t) => {
  t.is(downloadProgress({received: 50, total: 200}), 0.25);
  t.is(downloadProgress({received: 50, total: 0}), -1);
});

test('downloadDetail: sizes while running, outcome after', (t) => {
  const mb = 1024 * 1024;
  t.is(downloadDetail({state: 'progressing', received: 12 * mb, total: 27 * mb}), '12 MB of 27 MB · 44%');
  t.is(downloadDetail({state: 'paused', received: mb, total: 0}), 'Paused · 1.0 MB');
  t.is(downloadDetail({state: 'completed', received: 27 * mb, total: 27 * mb}), 'Done · 27 MB');
  t.is(downloadDetail({state: 'cancelled', received: 0, total: 0}), 'Cancelled');
  t.regex(downloadDetail({state: 'interrupted', received: 0, total: 0}), /^Failed/);
  t.true(isActiveDownload({state: 'paused'}));
  t.false(isActiveDownload({state: 'completed'}));
});
