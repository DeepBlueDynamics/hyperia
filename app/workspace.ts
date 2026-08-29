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
import {existsSync} from 'fs';

import {app, screen} from 'electron';
import type {BrowserWindow} from 'electron';

import {v4 as uuidv4} from 'uuid';

import {boundsAreVisible} from './window-state';

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
// ---------------------------------------------------------------------------
// Restore (chunk 2: #168) — additive, into NEW windows. Live windows and their
// PTYs are never touched; every uid in the saved layout is remapped to a fresh
// one first, so a restore can never collide with live sessions or the orphan-
// reattach sweep. Each new window applies its layout through the same
// per-window init callback the boot restore uses.
// ---------------------------------------------------------------------------

/**
 * Rewrite every session/termGroup uid in a saved layout to a fresh uuid,
 * preserving all structure (parent links, children order, active pointers).
 * Pure — exported for unit tests.
 */
export const remapUids = (layout: Record<string, any>, makeUid: () => string = uuidv4): Record<string, any> => {
  const mapping = new Map<string, string>();
  const fresh = (old: string): string => {
    if (!mapping.has(old)) {
      mapping.set(old, makeUid());
    }
    return mapping.get(old)!;
  };
  const mapMaybe = (old: unknown): unknown => (typeof old === 'string' && old ? fresh(old) : old);

  const termGroups: Record<string, any> = {};
  Object.keys(layout.termGroups || {}).forEach((uid) => {
    const g = layout.termGroups[uid] || {};
    termGroups[fresh(uid)] = {
      ...g,
      uid: fresh(uid),
      parentUid: mapMaybe(g.parentUid),
      sessionUid: mapMaybe(g.sessionUid),
      children: Array.isArray(g.children) ? g.children.map((c: string) => fresh(c)) : g.children
    };
  });

  const sessions: Record<string, any> = {};
  Object.keys(layout.sessions || {}).forEach((uid) => {
    const s = layout.sessions[uid] || {};
    sessions[fresh(uid)] = {...s, uid: fresh(uid)};
  });

  const activeSessions: Record<string, any> = {};
  Object.keys(layout.activeSessions || {}).forEach((groupUid) => {
    activeSessions[fresh(groupUid)] = mapMaybe(layout.activeSessions[groupUid]);
  });

  return {
    ...layout,
    termGroups,
    sessions,
    activeSessions,
    activeUid: mapMaybe(layout.activeUid),
    activeRootGroup: mapMaybe(layout.activeRootGroup),
    activeTermGroup: mapMaybe(layout.activeTermGroup)
  };
};

/**
 * Annotate sessions whose cwd no longer exists so the substitution is loud:
 * createSession falls back to home silently, and the renderer surfaces
 * `restoreNotice` as a banner in the pane. Pure — exported for unit tests.
 */
export const annotateMissingResources = (
  layout: Record<string, any>,
  dirExists: (cwd: string) => boolean = existsSync
): {layout: Record<string, any>; notices: string[]} => {
  const notices: string[] = [];
  const sessions: Record<string, any> = {};
  Object.keys(layout.sessions || {}).forEach((uid) => {
    const s = {...(layout.sessions[uid] || {})};
    if (typeof s.cwd === 'string' && s.cwd && !dirExists(s.cwd)) {
      s.restoreNotice = `Saved directory ${s.cwd} no longer exists — opened in your home directory instead.`;
      notices.push(`${uid}: ${s.restoreNotice}`);
    }
    sessions[uid] = s;
  });
  return {layout: {...layout, sessions}, notices};
};

export type RestoredSummary = {created: number; notices: string[]};

/**
 * Apply a workspace file: one NEW BrowserWindow per saved window, layout fed
 * through the window's init callback (the same hook the boot restore uses).
 * Saved geometry is display-clamped; maximize/fullscreen re-applied.
 */
export const restoreWorkspace = (ws: {
  windows: Array<{geometry: any; layout: Record<string, any>}>;
}): RestoredSummary => {
  const createWindow = (app as any).createWindow as
    | ((
        fn?: (win: BrowserWindow) => void,
        options?: {size?: [number, number]; position?: [number, number]}
      ) => BrowserWindow)
    | undefined;
  if (!createWindow) {
    throw new Error('app.createWindow not ready (app still booting?)');
  }
  const allNotices: string[] = [];
  let created = 0;
  for (const saved of ws.windows || []) {
    const remapped = remapUids(saved.layout || {});
    const {layout, notices} = annotateMissingResources(remapped);
    allNotices.push(...notices);
    const g = saved.geometry || {};
    const size: [number, number] | undefined = g.width && g.height ? [Number(g.width), Number(g.height)] : undefined;
    // Clamp: only honor a saved position still visible on an attached display
    // (the saved monitor may be gone); otherwise let createWindow pick.
    const position: [number, number] | undefined =
      size && typeof g.x === 'number' && typeof g.y === 'number' && boundsAreVisible(g.x, g.y, size[0], size[1])
        ? [g.x, g.y]
        : undefined;
    const win = createWindow(
      (w: BrowserWindow) => {
        (w as any).rpc.emit('restore-layout-state', layout);
      },
      {size, position}
    );
    if (g.isFullScreen) {
      win.setFullScreen(true);
    } else if (g.isMaximized) {
      win.maximize();
    }
    created += 1;
  }
  return {created, notices: allNotices};
};

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
