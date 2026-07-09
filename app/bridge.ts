// Electron ↔ Sidecar WebSocket bridge
// Connects to the Rust sidecar's /ws endpoint and streams PTY session data.
// The sidecar can send commands back (Keys, Split, Focus, Close, etc.) to
// control terminal panes as an agent peer.
//
// Agent input is deferred while the user is actively typing/interacting
// with a session. Per-session queues drain once the user goes idle.

import {app} from 'electron';
import type {BrowserWindow} from 'electron';

import isDev from 'electron-is-dev';
import WebSocket from 'ws';

import {getProfiles, getConfig} from './config';
import type Session from './session';
import {
  createStickyNote,
  closeStickyNote,
  deleteStickyNote,
  updateStickyNote,
  scheduleSticky,
  unscheduleSticky
} from './sticky';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 5000;
const AGENT_DEFER_MS = 15000; // defer agent writes this long after last user activity
const DRAIN_INTERVAL_MS = 200; // how often to check queues
const MAX_QUEUE_DEPTH = 100; // reject agent writes past this

let ws: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let sidecarPort = 9800;
let stopped = false;

// Session registry: uid → { session, rows, cols, name, tabName, description }
interface TrackedSession {
  session: Session;
  rows: number;
  cols: number;
  name: string;
  tabName: string;
  description: string;
  rootTabUid: string; // uid of the root tab group — splits share this
  windowId: number; // Electron BrowserWindow id
  splitLabel: string;
  tabOrder: number;
  tabActive: boolean;
  paneActive: boolean;
  bspX: number; // BSP bounding box (0–100 percentage units)
  bspY: number;
  bspW: number;
  bspH: number;
  manualTitle?: boolean;
  /** Current web-pane URL, when this session's pane is (or carries) a web pane.
   *  Kept for layout capture (#82/#84) so save needs no renderer roundtrip. */
  webUrl?: string | null;
}
const trackedSessions = new Map<string, TrackedSession>();

// Web-pane URLs per window, keyed by TERM GROUP uid (#84). Modern web panes
// have NO session (TERM_GROUP_SET_WEB_URL nulls sessionUid), so they can't live
// in trackedSessions — the renderer's web-url middleware pushes a full snapshot
// {groupUid → url} whenever any group's webUrl changes, and layout save (#82)
// reads it via getWebPaneUrls(windowId) without an IPC roundtrip.
const windowWebUrls = new Map<number, Record<string, string>>();
let focusedWindowId: number | null = null;

// Agent input queue: per-session deferral when user is active
const lastUserActivity = new Map<string, number>();

interface QueuedWrite {
  keys: string;
  seq: number | undefined;
}
const agentQueues = new Map<string, QueuedWrite[]>();
let drainTimer: NodeJS.Timeout | null = null;

// Callback for downstream commands from sidecar
type CommandHandler = (msg: Record<string, unknown>) => void;
let commandHandler: CommandHandler | null = null;

// Pending startup command for next new session
let pendingCommand: ((uid: string, session: Session) => void) | null = null;

interface PendingSessionCallback {
  seq: number;
  timer: NodeJS.Timeout;
}
let pendingSessionCallback: PendingSessionCallback | null = null;

function clearPendingSessionCallback() {
  if (pendingSessionCallback) {
    clearTimeout(pendingSessionCallback.timer);
    pendingSessionCallback = null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  if (stopped) return;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${sidecarPort}/ws`);
  } catch (err) {
    console.warn('[bridge] WebSocket create error:', err);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    isDev && console.log('[bridge] Connected to sidecar');
    reconnectDelay = RECONNECT_BASE_MS;
    for (const [uid, tracked] of trackedSessions) {
      sendSessionRegister(uid, tracked);
    }
    // Replay window bounds now that the socket is live. The per-window
    // create/focus/resize sends can fire before the sidecar WS connects
    // (connect happens last at launch), so send() no-ops silently — this
    // guarantees the sidecar learns every window's pixel size on connect.
    try {
      const winList: BrowserWindow[] = Array.from((app as any).getWindows?.() || []);
      for (const w of winList) updateWindowBounds(w);
    } catch { /* best-effort */ }
    startHeartbeat();
  });

  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      handleCommand(msg);
    } catch (err) {
      console.warn('[bridge] Bad message from sidecar:', err);
    }
  });

  ws.on('close', () => {
    stopHeartbeat();
    ws = null;
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ECONNREFUSED' && code !== 'ECONNRESET') {
      isDev && console.warn('[bridge] WebSocket error:', err.message);
    }
  });
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    // Include session count so sidecar can detect drift
    const uids = Array.from(trackedSessions.keys());
    send({type: 'Heartbeat', sessionCount: uids.length, sessionUids: uids});
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function send(msg: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendSessionRegister(uid: string, tracked: TrackedSession) {
  send({
    type: 'SessionRegister',
    uid,
    name: tracked.name,
    tabName: tracked.tabName,
    description: tracked.description,
    rows: tracked.rows,
    cols: tracked.cols,
    pid: tracked.session.pty?.pid ?? 0,
    rootTabUid: tracked.rootTabUid,
    windowId: tracked.windowId,
    splitLabel: tracked.splitLabel,
    tabOrder: tracked.tabOrder,
    tabActive: tracked.tabActive,
    paneActive: tracked.paneActive,
    // Per-pane identity token (injected into this pane's PTY env) so the
    // sidecar can resolve an in-pane agent's Authorization header → this pane.
    agentToken: tracked.session?.agentToken || ''
  });
}

// ---------------------------------------------------------------------------
// Agent input queue — defers writes while user is active
// ---------------------------------------------------------------------------

function getAgentDeferMs(): number {
  const config = getConfig() as any;
  const lockout = config.lockout || {};
  const enabled = lockout.enabled !== false;
  if (!enabled) {
    return 0;
  }
  const durationSecs = typeof lockout.duration_secs === 'number' ? lockout.duration_secs : AGENT_DEFER_MS / 1000;
  return durationSecs * 1000;
}

function isUserActive(uid: string): boolean {
  const last = lastUserActivity.get(uid) || 0;
  return Date.now() - last < getAgentDeferMs();
}

function enqueueOrWrite(uid: string, keys: string, seq: number | undefined, interrupt = false) {
  const tracked = trackedSessions.get(uid);
  if (!tracked) {
    sendResult(seq, `No session: ${uid}`);
    return;
  }

  // interrupt=true bypasses the human-activity queue and writes immediately —
  // used to interrupt a running process (e.g. Ctrl-C) even while the human is
  // active here. We still tell the agent it was an override so it's aware it
  // took the pane from the human.
  if (interrupt) {
    tracked.session.write(keys);
    sendResult(seq, isUserActive(uid) ? 'ok — interrupt override (a human was recently active in this pane)' : 'ok');
    return;
  }

  if (!isUserActive(uid)) {
    // User idle — write immediately
    tracked.session.write(keys);
    sendResult(seq, 'ok');
    return;
  }

  // User active — queue it and deliver automatically when they go idle. Reply
  // NOW with a clear notice so the agent knows the keys were not sent yet (and
  // how to force them). The queued entry carries no seq, so drainQueues won't
  // send a second, duplicate result for it.
  let queue = agentQueues.get(uid);
  if (!queue) {
    queue = [];
    agentQueues.set(uid, queue);
  }

  if (queue.length >= MAX_QUEUE_DEPTH) {
    sendResult(
      seq,
      'queued: agent queue full — a human is active in this pane. Wait for them to go idle, or resend with interrupt=true to send immediately.'
    );
    return;
  }

  queue.push({keys, seq: undefined});
  ensureDrainTimer();
  sendResult(
    seq,
    'queued: a human is active in this pane — your keys will be delivered automatically when they go idle. To send immediately (e.g. to interrupt a running process), resend with interrupt=true.'
  );
}

function ensureDrainTimer() {
  if (drainTimer) return;
  drainTimer = setInterval(drainQueues, DRAIN_INTERVAL_MS);
}

function drainQueues() {
  let anyRemaining = false;

  for (const [uid, queue] of agentQueues) {
    if (queue.length === 0) {
      agentQueues.delete(uid);
      continue;
    }

    if (isUserActive(uid)) {
      anyRemaining = true;
      continue;
    }

    // User went idle — execute queued agent input now
    const tracked = trackedSessions.get(uid);
    if (tracked) {
      for (const entry of queue) {
        tracked.session.write(entry.keys);
        sendResult(entry.seq, 'ok');
      }
    } else {
      for (const entry of queue) {
        sendResult(entry.seq, `Session gone: ${uid}`);
      }
    }
    queue.length = 0;
    agentQueues.delete(uid);
  }

  if (!anyRemaining && drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFocusedHyperiaWindow(): BrowserWindow | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  return (app as any).getLastFocusedWindow?.() || null;
}

function getHyperiaWindowById(windowId: number): BrowserWindow | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument
  const windows: BrowserWindow[] = Array.from((app as any).getWindows?.() || []);
  return windows.find((win) => win.id === windowId) || null;
}

// ---------------------------------------------------------------------------
// Downstream command handling (sidecar → Electron)
// ---------------------------------------------------------------------------

function handleCommand(msg: Record<string, unknown>) {
  console.log('[bridge] Received command:', JSON.stringify(msg));
  const type = msg.type as string;
  const seq = msg.seq as number | undefined;

  switch (type) {
    case 'ResyncSessions': {
      // The sidecar lost these sessions to a crash/disconnect race but still
      // sees them in our heartbeat — re-send their registration so it can
      // rebuild its map. Self-heals the "pane visible in UI but missing from
      // hyper status / unreachable by agents" drift without recreating the pane.
      const uids = Array.isArray(msg.uids) ? (msg.uids as string[]) : [];
      for (const uid of uids) {
        const tracked = trackedSessions.get(uid);
        if (tracked) {
          console.log(`[bridge] ResyncSessions: re-registering ${uid} at sidecar request`);
          sendSessionRegister(uid, tracked);
        }
      }
      break;
    }
    case 'Keys': {
      const uid = msg.uid as string;
      const keys = msg.keys as string;
      const interrupt = msg.interrupt === true;
      enqueueOrWrite(uid, keys, seq, interrupt);
      break;
    }

    case 'Cd': {
      const uid = msg.uid as string;
      const path = msg.path as string;
      const sidecarState = msg.state as 'idle' | 'running';

      const result = executeSessionCd(uid, path, sidecarState, false);
      sendResult(seq, JSON.stringify(result));
      break;
    }

    case 'SaveLayoutState': {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const windows: any[] = Array.from((app as any).getWindows?.() || []);
      if (windows.length > 0) {
        for (const w of windows) {
          if (w?.rpc) {
            w.rpc.emit('get-layout-state-req', undefined);
          }
        }
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'No windows available');
      }
      break;
    }

    case 'Screen': {
      sendResult(seq, 'Screen reads handled sidecar-side');
      break;
    }

    case 'Status': {
      const panes = Array.from(trackedSessions.entries()).map(([uid, t], idx) => ({
        id: idx,
        uid,
        name: t.name,
        tabName: t.tabName,
        splitLabel: t.splitLabel,
        rows: t.rows,
        cols: t.cols,
        pid: t.session.pty?.pid ?? 0,
        windowId: t.windowId,
        bsp: {x: t.bspX, y: t.bspY, width: t.bspW, height: t.bspH}
      }));
      // Include OS and available shell profiles so the agent knows what shells to use
      const profiles = (getProfiles() || []).map((p: any) => ({
        name: p.name as string,
        shell: p.config?.shell as string | undefined,
        isDefault: p.name === (getConfig() as any).defaultProfile
      }));
      // Per-window OS pixel size so the agent can answer "how big is the window"
      // and resize relative to it (terminal_set_window_size).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const winList: BrowserWindow[] = Array.from((app as any).getWindows?.() || []);
      const windowSizes = winList.map((w) => {
        const b = w.getBounds();
        return {id: w.id, width: b.width, height: b.height, x: b.x, y: b.y, focused: w.isFocused()};
      });
      sendResult(
        seq,
        JSON.stringify({
          panes,
          platform: process.platform,
          profiles,
          windowSizes
        })
      );
      break;
    }

    case 'Split': {
      // If the caller named a pane to split, target the window that owns it so
      // the split lands there regardless of UI focus. No uid → focused window.
      const splitTargetUid = msg.uid as string | undefined;
      const splitTracked = splitTargetUid ? trackedSessions.get(splitTargetUid) : undefined;
      const win = (splitTracked ? getHyperiaWindowById(splitTracked.windowId) : null) ?? getFocusedHyperiaWindow();
      if (win) {
        const dir = (msg.direction as string) || 'vertical';
        const profile = (msg.profile as string) || 'default'; // Programmatic split defaults to 'default' shell, not 'picker'
        const command = (msg.command as string) || '';
        const url = (msg.url as string) || ''; // If set, the new split is a web pane (no shell), not a PTY.

        clearPendingSessionCallback();
        // Only a SHELL split spawns a PTY whose SessionRegister resolves this seq.
        // A web-pane split (url set) never emits a PTY registration, so arming the
        // wait would always fire a bogus "Timeout waiting for pane registration"
        // even though the web pane opened fine. Skip it for url splits; they reply
        // ok:true immediately below.
        if (!url && seq !== undefined) {
          const currentSeq = seq;
          const timer = setTimeout(() => {
            if (pendingSessionCallback && pendingSessionCallback.seq === currentSeq) {
              sendResult(currentSeq, JSON.stringify({ok: false, error: 'Timeout waiting for pane registration'}));
              pendingSessionCallback = null;
            }
          }, 5000);
          pendingSessionCallback = {seq: currentSeq, timer};
        }

        // If a startup command was provided, write it to the new session once it's ready
        if (command) {
          const onNewSession = (_uid: string, session: Session) => {
            const tryWrite = (attempts: number) => {
              if (session.pty?.pid) {
                setTimeout(() => {
                  session.write(command + '\r');
                }, 800);
              } else if (attempts > 0) {
                setTimeout(() => tryWrite(attempts - 1), 200);
              }
            };
            tryWrite(15);
          };
          pendingCommand = onNewSession;
        }

        if (url) {
          // Clean web-pane split — no shell/PTY dragged along. Honors the same
          // direction as a shell split (horizontal = below, vertical = right).
          win.rpc.emit('split web pane req', {
            activeUid: splitTargetUid ?? undefined,
            url,
            direction: dir === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL',
            isAgentInitiated: true
          });
          // Web pane has no PTY to wait on — acknowledge the open immediately.
          sendResult(seq, JSON.stringify({ok: true, type: 'web-pane', url}));
        } else {
          const splitOpts = {profile, activeUid: splitTargetUid ?? undefined, isAgentInitiated: true};
          if (dir === 'horizontal') {
            win.rpc.emit('split request horizontal', splitOpts);
          } else {
            win.rpc.emit('split request vertical', splitOpts);
          }
        }
      } else {
        sendResult(seq, 'No focused window');
      }
      break;
    }

    case 'Focus': {
      const targetUid = msg.uid as string | undefined;
      const tracked = targetUid ? trackedSessions.get(targetUid) : undefined;
      const win = tracked ? getHyperiaWindowById(tracked.windowId) : null;
      if (win && targetUid) {
        win.rpc.emit('session set active', {uid: targetUid});
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'No matching pane/window');
      }
      break;
    }

    case 'PermissionRequest': {
      // Cross-pane consent prompt. Broadcast to every window's renderer; the
      // permissions-bus keys by targetPane, so only the band owning that pane
      // slides the panel down.
      const payload = {
        id: msg.id as string,
        requester: (msg.requester as string) || 'Unknown agent',
        // Friendly display name (pane codename) — the `requester` label stays
        // the grant-ledger key; this one is what the human sees.
        requesterName: (msg.requesterName as string) || '',
        requesterPane: (msg.requesterPane as string) || '',
        targetPane: msg.targetPane as string,
        purpose: (msg.purpose as string) || ''
      };
      for (const w of (app as any).getWindows?.() || []) {
        if (w?.rpc) w.rpc.emit('permission request', payload);
      }
      break;
    }

    case 'TabBell': {
      // An agent nudged a pane WITHOUT forcing focus (terminal_focus default, or
      // an internal auto-focus). Flash/bell that pane's tab so it's noticeable in
      // the bar — but never move the human's view (focus-never-steal). The
      // renderer's markTabBell keys off the paneId to find the owning tab.
      const uid = msg.uid as string;
      for (const w of (app as any).getWindows?.() || []) {
        if (w?.rpc) w.rpc.emit('tab bell', {uid});
      }
      break;
    }

    case 'PermissionResolved': {
      const payload = {
        id: msg.id as string,
        targetPane: msg.targetPane as string,
        decision: (msg.decision as string) || 'deny'
      };
      for (const w of (app as any).getWindows?.() || []) {
        if (w?.rpc) w.rpc.emit('permission resolved', payload);
      }
      break;
    }

    case 'AgentToast': {
      // Create-consent prompt — a window-level toast (no target pane).
      const payload = {
        id: msg.id as string,
        requester: (msg.requester as string) || 'Unknown agent',
        requesterName: (msg.requesterName as string) || '',
        action: (msg.action as string) || 'create'
      };
      for (const w of (app as any).getWindows?.() || []) {
        if (w?.rpc) w.rpc.emit('agent toast', payload);
      }
      break;
    }

    case 'Close': {
      const targetUid = msg.uid as string | undefined;
      if (targetUid) {
        const tracked = trackedSessions.get(targetUid);
        const win = tracked ? getHyperiaWindowById(tracked.windowId) : null;
        if (win) {
          win.rpc.emit('session set active', {uid: targetUid});
          setTimeout(() => win.rpc.emit('termgroup close req'), 80);
          sendResult(seq, 'ok');
        } else {
          sendResult(seq, 'No tab at that uid');
        }
      } else {
        const win = getFocusedHyperiaWindow();
        if (win) {
          win.rpc.emit('termgroup close req');
          sendResult(seq, 'ok');
        } else {
          sendResult(seq, 'No focused window');
        }
      }
      break;
    }

    case 'NewTab': {
      const win = getFocusedHyperiaWindow();
      if (win) {
        const profile = (msg.profile as string) || '';
        const command = (msg.command as string) || '';

        clearPendingSessionCallback();
        if (seq !== undefined) {
          const currentSeq = seq;
          const timer = setTimeout(() => {
            if (pendingSessionCallback && pendingSessionCallback.seq === currentSeq) {
              sendResult(currentSeq, JSON.stringify({ok: false, error: 'Timeout waiting for pane registration'}));
              pendingSessionCallback = null;
            }
          }, 5000);
          pendingSessionCallback = {seq: currentSeq, timer};
        }

        win.rpc.emit('termgroup add req', {
          profile: profile || undefined,
          isAgentInitiated: true
        });

        // If a startup command was provided, write it to the new session once it's ready
        if (command) {
          const onNewSession = (_uid: string, session: Session) => {
            // Wait for shell to be ready, then write command
            const tryWrite = (attempts: number) => {
              if (session.pty?.pid) {
                setTimeout(() => {
                  session.write(command + '\r');
                }, 800);
              } else if (attempts > 0) {
                setTimeout(() => tryWrite(attempts - 1), 200);
              }
            };
            tryWrite(15); // Try for up to 3 seconds
          };
          // Listen for the next session registration
          pendingCommand = onNewSession;
        }
      } else {
        sendResult(seq, 'No focused window');
      }
      break;
    }

    case 'NewWindow': {
      const createWin = (app as any).createWindow as (() => void) | undefined;
      if (createWin) {
        createWin();
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'createWindow not available');
      }
      break;
    }

    case 'SetWindowSize': {
      // Resize a window to an exact content size — used by the agent to take
      // consistent screenshots (set size, then tab_image). Agent-only; no UI.
      const targetWindowId = msg.windowId as number | undefined;
      const width = Math.round(Number(msg.width));
      const height = Math.round(Number(msg.height));
      const win = targetWindowId ? getHyperiaWindowById(targetWindowId) : getFocusedHyperiaWindow();
      if (!win || win.isDestroyed()) {
        sendResult(seq, 'No matching window');
      } else if (!(width > 0 && height > 0)) {
        sendResult(seq, 'width and height must be positive integers');
      } else {
        win.setContentSize(width, height);
        const b = win.getContentBounds();
        sendResult(seq, JSON.stringify({ok: true, width: b.width, height: b.height}));
      }
      break;
    }

    case 'Rename': {
      const targetUid = msg.uid as string | undefined;
      const id = msg.id as number | undefined;
      const name = msg.name as string;
      const entries = Array.from(trackedSessions.entries());
      const entry =
        targetUid !== undefined
          ? entries.find(([sessionUid]) => sessionUid === targetUid)
          : id !== undefined && id >= 0 && id < entries.length
            ? entries[id]
            : undefined;
      if (entry) {
        const [sessionUid, tracked] = entry;
        const rootTab = tracked.rootTabUid;
        // Update ALL sessions in the tab group and notify sidecar for each
        for (const [uid, t] of trackedSessions) {
          if (t.rootTabUid === rootTab) {
            t.tabName = name;
            t.manualTitle = true;
            send({type: 'SessionTabName', uid, tabName: name});
          }
        }
        // Tell the owning renderer to update the tab name immediately.
        const win = getHyperiaWindowById(tracked.windowId);
        if (win) {
          win.rpc.emit('session rename', {uid: sessionUid, name});
        }
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'No matching tab session');
      }
      break;
    }

    case 'AgentStatus': {
      // Resolve sessionUid: use explicit uid, or resolve from pane index, or fall back to first session
      let sessionUid = msg.sessionUid as string | undefined;
      if (!sessionUid && msg.pane !== undefined) {
        const paneIdx = msg.pane as number;
        const entries = Array.from(trackedSessions.entries());
        if (paneIdx >= 0 && paneIdx < entries.length) {
          sessionUid = entries[paneIdx][0];
        }
      }
      if (!sessionUid) {
        // Fall back to first tracked session
        const first = trackedSessions.keys().next();
        if (!first.done) {
          sessionUid = first.value;
        }
      }

      const statusData = {
        sessionUid,
        connected: (msg.connected as boolean) ?? true,
        working: msg.working as boolean | undefined,
        label: msg.label as string | undefined,
        humanPercent: msg.humanPercent as number | undefined
      };
      // Broadcast to all windows
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      for (const win of (app as any).getWindows?.() || []) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        win.rpc?.emit('agent status', statusData);
      }
      // Fallback: try focused window
      const focWin = getFocusedHyperiaWindow();
      if (focWin) {
        focWin.rpc.emit('agent status', statusData);
      }
      sendResult(seq, 'ok');
      break;
    }

    case 'UIKey': {
      // Dispatch a keyboard event directly to a window's webContents —
      // bypasses the PTY and hits React's event system. This is how you send
      // Escape, Ctrl+C, Alt+Up etc. to apps like Claude Code that handle
      // keyboard shortcuts at the UI layer, not the terminal layer.
      const keyCode = msg.keyCode as string;
      const modifiers = (msg.modifiers as string[]) || [];
      const targetWindowId = msg.windowId as number | undefined;

      const win = targetWindowId ? getHyperiaWindowById(targetWindowId) : getFocusedHyperiaWindow();

      if (win && keyCode) {
        const eventBase = {
          keyCode,
          modifiers
        } as any;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        win.webContents.sendInputEvent({...eventBase, type: 'keyDown'});
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        win.webContents.sendInputEvent({...eventBase, type: 'keyUp'});
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, win ? 'No keyCode specified' : 'No matching window');
      }
      break;
    }

    case 'OpenWebPane': {
      const url = msg.url as string | undefined;
      const win = getFocusedHyperiaWindow();
      if (win && url) {
        win.rpc.emit('open web pane req', {url});
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, win ? 'No url provided' : 'No focused window');
      }
      break;
    }

    case 'WebPaneReload': {
      const uid = msg.uid as string | undefined;
      if (uid) {
        const tracked = trackedSessions.get(uid);
        const win = tracked ? getHyperiaWindowById(tracked.windowId) : null;
        if (win && (win as any).rpc) {
          (win as any).rpc.emit('web-pane-reload', uid);
        } else {
          // Broadcast to all windows
          const windows: BrowserWindow[] = Array.from((app as any).getWindows?.() || []);
          for (const w of windows) {
            if (w && (w as any).rpc) {
              (w as any).rpc.emit('web-pane-reload', uid);
            }
          }
        }
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'No uid provided');
      }
      break;
    }

    case 'WebPaneContent': {
      // Read the CURRENT page (live URL + title + visible text) from a web pane's
      // webview. Mirrors WebPaneClick: ask the renderer, await the result.
      const uid = msg.uid as string | undefined;
      if (!uid) {
        sendResult(seq, JSON.stringify({success: false, error: 'No uid provided'}));
        break;
      }
      const tracked = trackedSessions.get(uid);
      const win = tracked ? getHyperiaWindowById(tracked.windowId) : getFocusedHyperiaWindow();
      if (win && (win as any).rpc) {
        const timeout = setTimeout(() => {
          (win as any).rpc.emitter.off('web-pane-read-result', onResult);
          sendResult(seq, JSON.stringify({success: false, error: 'Timeout waiting for page content'}));
        }, 8000);

        const onResult = (res: any) => {
          if (res && res.uid === uid) {
            clearTimeout(timeout);
            (win as any).rpc.emitter.off('web-pane-read-result', onResult);
            sendResult(seq, JSON.stringify(res.result));
          }
        };

        (win as any).rpc.emitter.on('web-pane-read-result', onResult);
        (win as any).rpc.emit('web-pane-read', {uid});
      } else {
        sendResult(seq, JSON.stringify({success: false, error: 'No matching window or RPC connection found'}));
      }
      break;
    }

    case 'WebPaneEval': {
      // Inject + run arbitrary JS in a web pane, return its serializable value.
      const uid = msg.uid as string | undefined;
      const js = msg.js as string | undefined;
      if (!uid || !js) {
        sendResult(seq, JSON.stringify({success: false, error: 'uid and js are required'}));
        break;
      }
      const tracked = trackedSessions.get(uid);
      const win = tracked ? getHyperiaWindowById(tracked.windowId) : getFocusedHyperiaWindow();
      if (win && (win as any).rpc) {
        const timeout = setTimeout(() => {
          (win as any).rpc.emitter.off('web-pane-eval-result', onResult);
          sendResult(seq, JSON.stringify({success: false, error: 'Timeout waiting for eval result'}));
        }, 15000);
        const onResult = (res: any) => {
          if (res && res.uid === uid) {
            clearTimeout(timeout);
            (win as any).rpc.emitter.off('web-pane-eval-result', onResult);
            sendResult(seq, JSON.stringify(res.result));
          }
        };
        (win as any).rpc.emitter.on('web-pane-eval-result', onResult);
        (win as any).rpc.emit('web-pane-eval', {uid, js});
      } else {
        sendResult(seq, JSON.stringify({success: false, error: 'No matching window or RPC connection found'}));
      }
      break;
    }

    case 'WebPaneMouse': {
      // Move / click at a pixel coordinate, with the 👻 ghost cursor.
      const uid = msg.uid as string | undefined;
      if (!uid) {
        sendResult(seq, JSON.stringify({success: false, error: 'No uid provided'}));
        break;
      }
      const x = Number(msg.x) || 0;
      const y = Number(msg.y) || 0;
      const action = (msg.action as string) === 'click' ? 'click' : 'move';
      const tracked = trackedSessions.get(uid);
      const win = tracked ? getHyperiaWindowById(tracked.windowId) : getFocusedHyperiaWindow();
      if (win && (win as any).rpc) {
        const timeout = setTimeout(() => {
          (win as any).rpc.emitter.off('web-pane-mouse-result', onResult);
          sendResult(seq, JSON.stringify({success: false, error: 'Timeout waiting for mouse result'}));
        }, 8000);
        const onResult = (res: any) => {
          if (res && res.uid === uid) {
            clearTimeout(timeout);
            (win as any).rpc.emitter.off('web-pane-mouse-result', onResult);
            sendResult(seq, JSON.stringify(res.result));
          }
        };
        (win as any).rpc.emitter.on('web-pane-mouse-result', onResult);
        (win as any).rpc.emit('web-pane-mouse', {uid, x, y, action});
      } else {
        sendResult(seq, JSON.stringify({success: false, error: 'No matching window or RPC connection found'}));
      }
      break;
    }

    case 'WebPaneClick': {
      const uid = msg.uid as string | undefined;
      const text = msg.text as string | undefined;
      const selector = msg.selector as string | undefined;
      if (!uid) {
        sendResult(seq, JSON.stringify({success: false, error: 'No uid provided'}));
        break;
      }
      if (!text && !selector) {
        sendResult(seq, JSON.stringify({success: false, error: 'Either text or selector is required'}));
        break;
      }

      // Find target window
      const tracked = trackedSessions.get(uid);
      const win = tracked ? getHyperiaWindowById(tracked.windowId) : getFocusedHyperiaWindow();
      if (win && (win as any).rpc) {
        const timeout = setTimeout(() => {
          (win as any).rpc.emitter.off('web-pane-click-result', onResult);
          sendResult(seq, JSON.stringify({success: false, error: 'Timeout waiting for click result'}));
        }, 8000);

        const onResult = (res: any) => {
          if (res && res.uid === uid) {
            clearTimeout(timeout);
            (win as any).rpc.emitter.off('web-pane-click-result', onResult);
            sendResult(seq, JSON.stringify(res.result));
          }
        };

        (win as any).rpc.emitter.on('web-pane-click-result', onResult);
        (win as any).rpc.emit('web-pane-click', {uid, text, selector});
      } else {
        sendResult(seq, JSON.stringify({success: false, error: 'No matching window or RPC connection found'}));
      }
      break;
    }

    case 'NoteCreate': {
      const text = msg.text as string | undefined;
      const color = msg.color as string | undefined;
      const filePath = msg.filePath as string | undefined;
      const creator = msg.creator as string | undefined;
      const res = createStickyNote({text, color, filePath, creator}) as any;
      if (res?.error) {
        // e.g. an unreachable code-sticky file — report it instead of "ok".
        sendResult(seq, JSON.stringify({ok: false, error: res.error}));
      } else {
        // Return the note's id + name so the caller doesn't have to look it up.
        sendResult(seq, JSON.stringify({ok: true, id: res?.id, name: res?.name}));
      }
      break;
    }

    case 'NoteClose': {
      const noteId = msg.id as string;
      const closed = closeStickyNote(noteId);
      sendResult(seq, closed ? 'ok' : 'Note not found or not open');
      break;
    }

    case 'NoteOpen': {
      const noteId = msg.id as string;
      const res = createStickyNote({id: noteId}) as any;
      sendResult(seq, res?.win ? 'ok' : 'Note not found');
      break;
    }

    case 'NoteDelete': {
      const noteId = msg.id as string;
      const deleted = deleteStickyNote(noteId);
      sendResult(seq, deleted ? 'ok' : 'Note not found');
      break;
    }

    case 'NoteUpdate': {
      const noteId = msg.id as string;
      const text = msg.text as string;
      const updated = updateStickyNote(noteId, text);
      sendResult(seq, updated ? 'ok' : 'Note not found');
      break;
    }

    case 'NoteSchedule': {
      const noteId = msg.id as string;
      const sched = msg.schedule as any;
      if (sched) {
        scheduleSticky(noteId, sched);
      } else {
        unscheduleSticky(noteId);
      }
      sendResult(seq, 'ok');
      break;
    }

    default:
      if (commandHandler) {
        commandHandler(msg);
      } else if (seq !== undefined) {
        sendResult(seq, `Unknown command: ${type}`);
      }
  }
}

function sendResult(seq: number | undefined, result: string) {
  if (seq !== undefined) {
    send({type: 'ToolResult', seq, result});
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the bridge. Call once after sidecar spawn. */
/**
 * Tell the sidecar whether a Hyperia window is the OS-foreground app. false →
 * the human is in another application (e.g. Chrome). Powers the human-location
 * report so an agent can see whether forcing a focus would steal the view.
 */
export function sendAppFocus(foreground: boolean) {
  send({type: 'AppFocus', foreground});
}

export function startBridge(port: number = 9800) {
  sidecarPort = port;
  stopped = false;
  connect();
}

/** Stop the bridge. Call on app quit. */
export function stopBridge() {
  stopped = true;
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  agentQueues.clear();
  lastUserActivity.clear();
  if (ws) {
    ws.close();
    ws = null;
  }
}

/** Register a PTY session with the bridge. Call after session creation. */
export function registerSession(
  uid: string,
  session: Session,
  rows: number,
  cols: number,
  name: string = 'shell',
  tabName: string = '',
  rootTabUid: string = '',
  windowId: number = 0
) {
  const tracked: TrackedSession = {
    session,
    rows,
    cols,
    name,
    tabName: tabName || name,
    description: '',
    rootTabUid: rootTabUid || uid,
    windowId,
    splitLabel: '',
    tabOrder: 0,
    tabActive: false,
    paneActive: !Array.from(trackedSessions.values()).some((existing) => existing.windowId === windowId),
    bspX: 0,
    bspY: 0,
    bspW: 100,
    bspH: 100
  };
  trackedSessions.set(uid, tracked);

  // Stream PTY output to sidecar as base64-encoded SessionData
  if (session.pty) {
    isDev && console.log(`[bridge] Hooking PTY data for ${uid} (pid=${session.pty.pid})`);
    session.pty.onData((chunk: string) => {
      const b64 = Buffer.from(chunk).toString('base64');
      send({type: 'SessionData', uid, data: b64});
    });
  } else {
    isDev && console.warn(`[bridge] No PTY on session ${uid} at registration time`);
  }

  session.on('shellstate', (state: any) => {
    send({
      type: 'SessionShellState',
      uid,
      state: state.state,
      lastExit: state.lastExit,
      app: state.app || null
    });
  });

  // Clean up on exit
  session.on('exit', () => {
    const exitingSession = trackedSessions.get(uid);
    console.log(`[bridge] Session exit: ${uid} (${exitingSession?.tabName || 'unknown'})`);
    trackedSessions.delete(uid);
    lastUserActivity.delete(uid);
    // Fail any queued agent writes
    const queue = agentQueues.get(uid);
    if (queue) {
      for (const entry of queue) {
        sendResult(entry.seq, `Session exited: ${uid}`);
      }
      agentQueues.delete(uid);
    }
    send({type: 'SessionExit', uid});
  });

  sendSessionRegister(uid, tracked);

  // Resolve pending session callback if one was set (from Split or NewTab)
  if (pendingSessionCallback) {
    const seq = pendingSessionCallback.seq;
    clearPendingSessionCallback();
    sendResult(
      seq,
      JSON.stringify({
        ok: true,
        paneId: uid
      })
    );
  }

  // Execute pending startup command if one was set
  if (pendingCommand) {
    const cmd = pendingCommand;
    pendingCommand = null;
    cmd(uid, session);
  }
}

/** Update the tab name for a session (called on xterm title change). */
export function updateSessionTabName(uid: string, tabName: string, manual = false) {
  const rootTabUid = trackedSessions.get(uid)?.rootTabUid || uid;
  const current = trackedSessions.get(uid);
  if (current && !manual && current.manualTitle) {
    return;
  }
  for (const [sessionUid, t] of trackedSessions) {
    if (t.rootTabUid === rootTabUid) {
      t.tabName = tabName;
      if (manual) {
        t.manualTitle = true;
      }
      send({type: 'SessionTabName', uid: sessionUid, tabName});
    }
  }
}

/** Record a web-pane URL on a session-backed pane (#84). No-op for unknown
 *  uids — modern web panes are session-less and live in windowWebUrls instead. */
export function updateSessionWebUrl(uid: string, url: string | null) {
  const tracked = trackedSessions.get(uid);
  if (tracked) tracked.webUrl = url;
}

/** Replace a window's {termGroupUid → url} web-pane snapshot (#84). Pushed by
 *  the renderer's web-url middleware on every webUrl change (open / convert /
 *  split / in-page navigation / clear). Also mirrors onto any session-backed
 *  pane that shares the uid (legacy groups that kept a session). */
export function updateWindowWebUrls(windowId: number, urls: Record<string, string>) {
  windowWebUrls.set(windowId, urls || {});
  for (const [uid, url] of Object.entries(urls || {})) {
    updateSessionWebUrl(uid, url);
  }
}

/** Web-pane URLs for a window, keyed by term-group uid — layout save (#82)
 *  reads this directly, no renderer roundtrip. */
export function getWebPaneUrls(windowId: number): Record<string, string> {
  return windowWebUrls.get(windowId) || {};
}

/** Drop a closed window's web-url snapshot. */
export function clearWindowWebUrls(windowId: number) {
  windowWebUrls.delete(windowId);
}

export function updateSessionActive(uid: string, windowId: number) {
  const tracked = trackedSessions.get(uid);
  if (!tracked) return;

  for (const [, session] of trackedSessions) {
    if (session.windowId === windowId) {
      session.paneActive = false;
    }
  }

  tracked.paneActive = true;
  focusedWindowId = windowId;
  notifyUserActivity(uid);
  send({type: 'SessionActive', uid, windowId});
}

export function updateWindowFocus(windowId: number) {
  focusedWindowId = windowId;
  send({type: 'WindowFocus', windowId});
}

/** Report a window's OS pixel bounds to the sidecar so terminal_status can
 *  answer "how big is the window" and resize relative to it. Sent on window
 *  create + resize/move. */
export function updateWindowBounds(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  send({type: 'WindowBounds', windowId: win.id, width: b.width, height: b.height, x: b.x, y: b.y});
}

/** Update the description for a session. */
export function updateSessionDescription(uid: string, description: string) {
  let tracked = trackedSessions.get(uid);
  // Might be a termGroup uid — find by rootTabUid
  if (!tracked) {
    for (const [, t] of trackedSessions) {
      if (t.rootTabUid === uid) {
        tracked = t;
        break;
      }
    }
  }
  if (tracked) {
    tracked.description = description;
    send({type: 'SessionDescribe', uid, description});
  }
}

/** Update the working directory for a session. */
export function updateSessionCwd(uid: string, cwd: string) {
  const tracked = trackedSessions.get(uid);
  if (tracked) {
    send({type: 'SessionCwd', uid, cwd});
  }
}

export function updateSessionLayout(
  tabs: Array<{
    rootGroupUid: string;
    order: number;
    active: boolean;
    panes: Array<{
      uid: string;
      splitLabel: string;
      isWeb: boolean;
      isAi: boolean;
      title: string;
      shellName?: string;
      url?: string;
      active: boolean;
    }>;
    bsp?: Array<{
      uid: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  }>
) {
  const seen = new Set<string>();

  for (const tab of tabs) {
    const bspMap = new Map((tab.bsp || []).map((b) => [b.uid, b]));
    for (const pane of tab.panes) {
      let tracked = trackedSessions.get(pane.uid);
      if (!tracked) {
        if (pane.isWeb) {
          const fakeTracked: any = {
            session: {pty: null} as any,
            rows: 24,
            cols: 80,
            name: pane.isAi ? 'ai' : 'web',
            tabName: tab.rootGroupUid,
            description: '',
            rootTabUid: tab.rootGroupUid,
            windowId: focusedWindowId || 1,
            splitLabel: pane.splitLabel,
            tabOrder: tab.order,
            tabActive: tab.active,
            paneActive: pane.active,
            bspX: 0,
            bspY: 0,
            bspW: 100,
            bspH: 100
          };
          trackedSessions.set(pane.uid, fakeTracked);
          tracked = fakeTracked;

          sendSessionRegister(pane.uid, fakeTracked);
        } else {
          continue;
        }
      }

      if (!tracked) continue;

      tracked.rootTabUid = tab.rootGroupUid || tracked.rootTabUid;
      tracked.splitLabel = pane.splitLabel || '';
      tracked.tabOrder = tab.order;
      tracked.tabActive = tab.active;
      tracked.paneActive = pane.active;

      const bsp = bspMap.get(pane.uid);
      tracked.bspX = bsp?.x ?? 0;
      tracked.bspY = bsp?.y ?? 0;
      tracked.bspW = bsp?.width ?? 100;
      tracked.bspH = bsp?.height ?? 100;
      seen.add(pane.uid);

      send({
        type: 'SessionLayout',
        uid: pane.uid,
        rootTabUid: tracked.rootTabUid,
        splitLabel: tracked.splitLabel,
        tabOrder: tracked.tabOrder,
        tabActive: tracked.tabActive,
        bsp: {
          x: tracked.bspX,
          y: tracked.bspY,
          width: tracked.bspW,
          height: tracked.bspH
        }
      });

      if (pane.title) {
        send({type: 'SessionTitle', uid: pane.uid, title: pane.title});
      }
      if (pane.shellName) {
        send({type: 'SessionName', uid: pane.uid, name: pane.shellName});
      }
      if (pane.url) {
        send({type: 'SessionCwd', uid: pane.uid, cwd: pane.url});
      }
    }
  }

  for (const [uid, tracked] of trackedSessions) {
    if (seen.has(uid)) continue;
    // Reap a pane that's vanished from the layout when it can't host anything:
    // web/ai panes (no PTY by design) and shell panes whose PTY is dead or never
    // spawned (pid:0 husks — e.g. a stillborn split). Otherwise terminal_status
    // keeps reporting a ghost pane with no tile in the UI. A LIVE shell (real pid)
    // that's only transiently absent from the layout is preserved below.
    const hasLivePty = !!tracked.session?.pty?.pid;
    if (tracked.name === 'web' || tracked.name === 'ai' || !hasLivePty) {
      trackedSessions.delete(uid);
      lastUserActivity.delete(uid);
      agentQueues.delete(uid);
      send({type: 'SessionExit', uid});
    } else {
      tracked.splitLabel = '';
      tracked.tabActive = false;
      send({
        type: 'SessionLayout',
        uid,
        rootTabUid: tracked.rootTabUid,
        splitLabel: '',
        tabOrder: tracked.tabOrder,
        tabActive: false
      });
    }
  }
}

/** Notify the bridge of a resize event. */
export function notifyResize(uid: string, rows: number, cols: number) {
  const tracked = trackedSessions.get(uid);
  if (tracked) {
    tracked.rows = rows;
    tracked.cols = cols;
  }
  send({type: 'Resize', uid, rows, cols});
}

/** Force-remove a session from bridge tracking and notify sidecar. Fallback for when session.on('exit') doesn't fire. */
export function forceRemoveSession(uid: string) {
  if (trackedSessions.has(uid)) {
    console.log(`[bridge] Force removing session: ${uid}`);
    trackedSessions.delete(uid);
    lastUserActivity.delete(uid);
    agentQueues.delete(uid);
    send({type: 'SessionExit', uid});
  }
}

/** Get the rootTabUid for a session. Used to inherit tab grouping on splits. */
export function getSessionRootTab(uid: string): string {
  const tracked = trackedSessions.get(uid);
  return tracked ? tracked.rootTabUid : '';
}

/** Signal user activity on a session. Defers agent input for AGENT_DEFER_MS. */
export function notifyUserActivity(uid: string) {
  lastUserActivity.set(uid, Date.now());
  send({type: 'UserActivity', uid});
}

/** Set an external command handler for custom downstream messages. */
export function setCommandHandler(handler: CommandHandler) {
  commandHandler = handler;
}

/** Execute a cd command on a session/pane, safely gating, queueing, or applying it immediately. */
export function executeSessionCd(
  uid: string,
  path: string,
  sidecarState?: 'idle' | 'running',
  bypassUserActiveCheck = false
): { applied?: boolean; queued?: boolean; refused?: boolean; reason?: string } {
  const tracked = trackedSessions.get(uid);
  if (!tracked) {
    return { refused: true, reason: `No session: ${uid}` };
  }

  if (tracked.session.shellState) {
    // Shell integration is active!
    try {
      const fs = require('fs');
      const pathMod = require('path');
      const ctlDir = pathMod.join(app.getPath('userData'), 'panes', uid);
      const cdFilePath = pathMod.join(ctlDir, 'cd');
      const tmpPath = `${cdFilePath}.tmp`;

      fs.writeFileSync(tmpPath, path, 'utf8');
      fs.renameSync(tmpPath, cdFilePath);

      const isIdle = tracked.session.shellState.state === 'idle';
      const userActive = isUserActive(uid);
      if (isIdle && (bypassUserActiveCheck || !userActive)) {
        tracked.session.write('\r');
        return { applied: true };
      } else if (isIdle) {
        return { queued: true, reason: 'human active' };
      } else {
        return { queued: true, reason: 'foreground app running' };
      }
    } catch (err: any) {
      return { refused: true, reason: err.message };
    }
  } else {
    // Fallback mechanism (no shell integration)
    const shell = (tracked.session.shell || '').toLowerCase();
    const escapedPath = path.replace(/'/g, "'\\''");
    let keys = `cd '${escapedPath}'\r`;
    if (shell.endsWith('cmd.exe') || shell.endsWith('cmd')) {
      keys = `cd /d "${path}"\r`;
    }

    const isIdle = sidecarState === 'idle';
    const userActive = isUserActive(uid);
    // bypassUserActiveCheck relaxes ONLY the human-active gate (the human
    // explicitly asked — e.g. via the directory picker). It must NEVER skip the
    // idle check: writing keys while a foreground app owns the tty injects `cd`
    // into that app instead of the shell (the bug #116 closes). When there is no
    // idle signal here — the renderer RPC passes sidecarState=undefined for a
    // pane without shell integration — isIdle is false, so we queue, never write.
    if (isIdle && (bypassUserActiveCheck || !userActive)) {
      tracked.session.write(keys);
      return { applied: true };
    } else {
      let queue = agentQueues.get(uid);
      if (!queue) {
        queue = [];
        agentQueues.set(uid, queue);
      }
      if (queue.length >= MAX_QUEUE_DEPTH) {
        return { refused: true, reason: 'Queue full' };
      } else {
        queue.push({ keys, seq: undefined });
        ensureDrainTimer();
        return { queued: true, reason: 'foreground app running or human active' };
      }
    }
  }
}
