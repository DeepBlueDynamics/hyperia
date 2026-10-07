// Pure formatting for web-pane downloads (lib/components/web-downloads.tsx).

import type {DownloadRecord} from '../../app/web-downloads';

export function isActiveDownload(r: Pick<DownloadRecord, 'state'>): boolean {
  return r.state === 'progressing' || r.state === 'paused';
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** 0..1, or -1 when the server didn't say how big the file is. */
export function downloadProgress(r: Pick<DownloadRecord, 'received' | 'total'>): number {
  return r.total > 0 ? Math.min(1, r.received / r.total) : -1;
}

/** The line under the file name: sizes while running, the outcome after. */
export function downloadDetail(r: Pick<DownloadRecord, 'state' | 'received' | 'total'>): string {
  switch (r.state) {
    case 'progressing':
    case 'paused': {
      const head = r.state === 'paused' ? 'Paused · ' : '';
      if (r.total > 0) {
        return `${head}${formatBytes(r.received)} of ${formatBytes(r.total)} · ${Math.floor(downloadProgress(r) * 100)}%`;
      }
      return `${head}${formatBytes(r.received)}`;
    }
    case 'completed':
      return `Done · ${formatBytes(r.total > 0 ? r.total : r.received)}`;
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Failed — the download was interrupted';
  }
}
