/**
 * Workspace capture — the Electron half of named workspaces (epic #146).
 *
 * The sidecar owns workspace files (`sidecar/src/workspace.rs`); this module
 * owns the multi-window snapshot. The old save path was fire-and-forget: the
 * bridge asked every window for its layout and replied 'ok' before anything
 * came back, and every window's reply overwrote the same config key — with
 * two windows open, last write won. Capture fixes that with a correlated
 * round trip: each request carries a `requestId`, every window's reply is
 * collected against it, and the assembled result (geometry + layout per
 * window) resolves a single promise.
 *
 * Replies WITHOUT a requestId still belong to the legacy close-time save and
 * are not touched here (window.ts routes them to the old writer).
 */
import {randomBytes} from 'crypto';

import {screen} from 'electron';
import type {BrowserWindow} from 'electron';

export type WindowGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  displayId?: number;
  isMaximized: boolean;
  isFullScreen: boolean;
};

export type CapturedWindow = {geometry: WindowGeometry; layout: Record<string, any>};

export type CaptureResult = {
  windows: CapturedWindow[];
  /** BrowserWindow ids that never replied within the timeout. */
  missing: number[];
};

type PendingCapture = {
  expected: Set<number>;
  collected: Map<number, CapturedWindow>;
  resolve: (result: CaptureResult) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, PendingCapture>();

const geometryOf = (win: BrowserWindow): WindowGeometry => {
  const bounds = win.getBounds();
  let displayId: number | undefined;
  try {
    displayId = screen.getDisplayMatching(bounds).id;
  } catch {
    // screen module unavailable (tests) — geometry still useful without it.
  }
  return {
    ...bounds,
    displayId,
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen()
  };
};

/**
 * Normalize one window's raw layout reply into workspace shape. Pure —
 * exported for unit tests.
 *
 * - drops the reply's transport envelope (`requestId`)
 * - strips `pid` from every session (a restored PTY is a new process; the
 *   sidecar rejects files that carry one)
 * - tolerates old-shape replies that still have a bare `lastCommand` by
 *   folding it into `annotations.lastCommand`
 */
export const toWorkspaceLayout = (reply: Record<string, any>): Record<string, any> => {
  const layout: Record<string, any> = {...reply};
  delete layout.requestId;
  const sessions: Record<string, any> = {};
  Object.keys(layout.sessions || {}).forEach((uid) => {
    const session: Record<string, any> = {...(layout.sessions[uid] || {})};
    delete session.pid;
    const last = session.annotations?.lastCommand ?? session.lastCommand;
    delete session.lastCommand;
    if (last) {
      session.annotations = {...session.annotations, lastCommand: last};
    }
    sessions[uid] = session;
  });
  return {...layout, sessions};
};

/**
 * Route a renderer's `layout-state-reply` into a waiting capture.
 * Returns true when the reply was consumed (callers skip the legacy writer).
 */
export const deliverLayoutReply = (requestId: string, win: BrowserWindow, reply: Record<string, any>): boolean => {
  const capture = pending.get(requestId);
  if (!capture || !capture.expected.has(win.id)) {
    return false;
  }
  capture.collected.set(win.id, {geometry: geometryOf(win), layout: toWorkspaceLayout(reply)});
  if (capture.collected.size === capture.expected.size) {
    finish(requestId);
  }
  return true;
};

const finish = (requestId: string) => {
  const capture = pending.get(requestId);
  if (!capture) {
    return;
  }
  pending.delete(requestId);
  clearTimeout(capture.timer);
  const missing = [...capture.expected].filter((id) => !capture.collected.has(id));
  capture.resolve({windows: [...capture.collected.values()], missing});
};

/**
 * Snapshot every given window: geometry + layout. Resolves when all windows
 * reply or the timeout elapses (stragglers are reported in `missing`, and the
 * capture still succeeds with what arrived).
 */
export const captureAllWindows = (windows: BrowserWindow[], timeoutMs = 3000): Promise<CaptureResult> => {
  const live = windows.filter((w) => w && !w.isDestroyed() && (w as any).rpc);
  if (live.length === 0) {
    return Promise.resolve({windows: [], missing: []});
  }
  const requestId = randomBytes(8).toString('hex');
  return new Promise<CaptureResult>((resolve) => {
    pending.set(requestId, {
      expected: new Set(live.map((w) => w.id)),
      collected: new Map(),
      resolve,
      timer: setTimeout(() => finish(requestId), timeoutMs)
    });
    live.forEach((w) => {
      (w as any).rpc.emit('get-layout-state-req', {requestId});
    });
  });
};
