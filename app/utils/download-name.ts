// Pure helpers for web-pane downloads (app/web-downloads.ts).

import {basename, extname} from 'path';

/** A filesystem-safe name; falls back to "download" for empty or dot-only names. */
export function safeDownloadName(name: string): string {
  // Control characters are invalid in Windows file names.
  // eslint-disable-next-line no-control-regex
  const bad = /[<>:"/\\|?*\x00-\x1f]/g;
  const cleaned = basename(String(name || ''))
    .replace(bad, '_')
    .trim();
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'download';
}

/**
 * Chrome-style unique name: "report.pdf", then "report (1).pdf", "report (2).pdf"…
 * `taken` says whether a candidate is already used (on disk or by another
 * in-flight download).
 */
export function uniqueDownloadName(name: string, taken: (candidate: string) => boolean): string {
  const safe = safeDownloadName(name);
  if (!taken(safe)) return safe;
  // ".tar.gz" stays together.
  const ext = /\.tar\.(gz|bz2|xz)$/i.test(safe) ? safe.slice(safe.toLowerCase().lastIndexOf('.tar.')) : extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}
