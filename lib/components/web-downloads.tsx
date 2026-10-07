// Web-pane downloads (app/web-downloads.ts) on the bottom-right toast layer:
// a progress toast per running download, a result toast when it ends, and a
// Downloads panel (the web pane's download button) listing recent history.
// Everything draws on the native layer, so it stays visible over web pages.

import {ipcRenderer} from 'electron';
import React from 'react';

import type {DownloadRecord} from '../../app/web-downloads';
import {onToastLayerAction, setLayerToasts, useToastLayer} from '../toast-layer';
import type {ToastLayerItem} from '../toast-layer';
import {downloadDetail, downloadProgress, isActiveDownload} from '../utils/download-format';

import {dismissStickyToast, pushStickyToast, pushToast} from './toast-stack';

export const TOGGLE_DOWNLOADS_EVENT = 'hyperia-toggle-downloads';

// A finished download's toast stays up this long (it stays in the panel).
const RESULT_TTL_MS = 30000;
const PANEL_MAX = 15;

type Update = {downloads: DownloadRecord[]; mine: string[]};

function act(id: string | undefined, action: string): void {
  void ipcRenderer
    .invoke('web-downloads:action', {id, action})
    .then((r: {ok: boolean; error?: string}) => {
      if (r && !r.ok && r.error) pushToast(r.error, {kind: 'error'});
    })
    .catch(() => {});
}

function rowItem(r: DownloadRecord, prefix: string): ToastLayerItem {
  const active = isActiveDownload(r);
  const failed = r.state === 'cancelled' || r.state === 'interrupted';
  const buttons: ToastLayerItem['buttons'] = active
    ? [
        r.state === 'paused' ? {id: 'resume', label: 'Resume'} : {id: 'pause', label: 'Pause'},
        {id: 'cancel', label: 'Cancel'}
      ]
    : failed
      ? []
      : [
          {id: 'open', label: 'Open'},
          {id: 'show', label: 'Show in folder'}
        ];
  return {
    id: `${prefix}${r.id}`,
    kind: 'toast',
    emoji: active ? '⬇' : failed ? '⚠' : '✓',
    tone: failed ? 'error' : 'info',
    text: r.filename,
    detail: downloadDetail(r),
    progress: active ? downloadProgress(r) : undefined,
    buttons,
    // × on a finished row: removes it from the panel, or just hides the toast.
    dismissable: !active
  };
}

export default function WebDownloads(): React.ReactElement | null {
  const [data, setData] = React.useState<Update>({downloads: [], mine: []});
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = React.useState(Date.now());
  const layer = useToastLayer();

  React.useEffect(() => {
    const onUpdate = (_e: unknown, u: Update) => setData(u);
    ipcRenderer.on('web-downloads:update', onUpdate);
    void ipcRenderer
      .invoke('web-downloads:list')
      .then((u: Update) => u && setData(u))
      .catch(() => {});
    const onToggle = () => setPanelOpen((o) => !o);
    window.addEventListener(TOGGLE_DOWNLOADS_EVENT, onToggle);
    return () => {
      ipcRenderer.removeListener('web-downloads:update', onUpdate);
      window.removeEventListener(TOGGLE_DOWNLOADS_EVENT, onToggle);
    };
  }, []);

  const mine = React.useMemo(() => new Set(data.mine), [data.mine]);
  // This window's toasts: running downloads + recently finished ones.
  const toastRows = data.downloads.filter(
    (r) =>
      mine.has(r.id) &&
      !hidden.has(r.id) &&
      (isActiveDownload(r) || (r.endedAt !== undefined && now - r.endedAt < RESULT_TTL_MS))
  );

  // Re-check expiry while a finished toast is up.
  const anyFinishedUp = toastRows.some((r) => !isActiveDownload(r));
  React.useEffect(() => {
    if (!anyFinishedUp) return undefined;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [anyFinishedUp]);

  const items = ((): ToastLayerItem[] => {
    if (!panelOpen) return toastRows.map((r) => rowItem(r, 'dl:'));
    const rows = data.downloads.slice(0, PANEL_MAX);
    const header: ToastLayerItem = {
      id: 'dl-panel',
      kind: 'toast',
      emoji: '⬇',
      text: 'Downloads',
      detail: rows.length
        ? `${data.downloads.length} recent · saved to your Downloads folder`
        : 'Nothing downloaded yet',
      buttons: [
        {id: 'folder', label: 'Open folder'},
        ...(rows.some((r) => !isActiveDownload(r)) ? [{id: 'clear', label: 'Clear list'}] : [])
      ],
      dismissable: true
    };
    return [header, ...rows.map((r) => rowItem(r, 'dlp:'))];
  })();

  // The hub drops identical re-sends, so this can run every render.
  React.useEffect(() => {
    if (layer) setLayerToasts('downloads', 2, items, 'bottom-right');
  });
  React.useEffect(() => () => setLayerToasts('downloads', 2, [], 'bottom-right'), []);

  React.useEffect(() => {
    if (!layer) return undefined;
    return onToastLayerAction(({toastId, buttonId}) => {
      if (toastId === 'dl-panel') {
        if (buttonId === 'close') setPanelOpen(false);
        else act(undefined, buttonId);
        return;
      }
      const inPanel = toastId.startsWith('dlp:');
      if (!inPanel && !toastId.startsWith('dl:')) return;
      const id = toastId.slice(inPanel ? 4 : 3);
      if (buttonId === 'close') {
        if (inPanel) act(id, 'remove');
        else setHidden((s) => new Set(s).add(id));
        return;
      }
      act(id, buttonId);
    });
  }, [layer]);

  // No layer: fall back to the DOM toast stack (text only).
  const fallbackKey = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (layer) return;
    for (const r of data.downloads) {
      if (!mine.has(r.id)) continue;
      const key = `download:${r.id}`;
      if (isActiveDownload(r)) {
        fallbackKey.current.add(key);
        pushStickyToast(key, `⬇ ${r.filename} — ${downloadDetail(r)}`);
      } else if (fallbackKey.current.has(key)) {
        fallbackKey.current.delete(key);
        dismissStickyToast(key);
        pushToast(`${r.filename} — ${downloadDetail(r)}`, {kind: r.state === 'completed' ? 'info' : 'error'});
      }
    }
  }, [layer, data, mine]);

  return null;
}
