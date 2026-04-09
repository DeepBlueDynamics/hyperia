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

import type Session from './session';
import {createStickyNote, closeStickyNote, deleteStickyNote, updateStickyNote} from './sticky';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 5000;
const AGENT_DEFER_MS = 1000; // defer agent writes this long after last user activity
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
}
const trackedSessions = new Map<string, TrackedSession>();
let focusedWindowId: number | null = null; // eslint-disable-line @typescript-eslint/no-unused-vars

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
    paneActive: tracked.paneActive
  });
}

// ---------------------------------------------------------------------------
// Agent input queue — defers writes while user is active
// ---------------------------------------------------------------------------

function isUserActive(uid: string): boolean {
  const last = lastUserActivity.get(uid) || 0;
  return Date.now() - last < AGENT_DEFER_MS;
}

function enqueueOrWrite(uid: string, keys: string, seq: number | undefined) {
  const tracked = trackedSessions.get(uid);
  if (!tracked) {
    sendResult(seq, `No session: ${uid}`);
    return;
  }

  if (!isUserActive(uid)) {
    // User idle — write immediately
    tracked.session.write(keys);
    sendResult(seq, 'ok');
    return;
  }

  // User active — queue it
  let queue = agentQueues.get(uid);
  if (!queue) {
    queue = [];
    agentQueues.set(uid, queue);
  }

  if (queue.length >= MAX_QUEUE_DEPTH) {
    sendResult(seq, 'Agent queue full — user is active, try again');
    return;
  }

  queue.push({keys, seq});
  ensureDrainTimer();
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
  const type = msg.type as string;
  const seq = msg.seq as number | undefined;

  switch (type) {
    case 'Keys': {
      const uid = msg.uid as string;
      const keys = msg.keys as string;
      enqueueOrWrite(uid, keys, seq);
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
        windowId: t.windowId
      }));
      sendResult(seq, JSON.stringify({panes}));
      break;
    }

    case 'Split': {
      const win = getFocusedHyperiaWindow();
      if (win) {
        const dir = (msg.direction as string) || 'vertical';
        if (dir === 'horizontal') {
          win.rpc.emit('split request horizontal', {});
        } else {
          win.rpc.emit('split request vertical', {});
        }
        sendResult(seq, 'ok');
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
        win.rpc.emit('termgroup add req', profile ? {profile} : {});

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

        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'No focused window');
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

    case 'NoteCreate': {
      const text = msg.text as string | undefined;
      const color = msg.color as string | undefined;
      createStickyNote({text, color});
      sendResult(seq, 'ok');
      break;
    }

    case 'NoteClose': {
      const noteId = msg.id as string;
      const closed = closeStickyNote(noteId);
      sendResult(seq, closed ? 'ok' : 'Note not found or not open');
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
    paneActive: !Array.from(trackedSessions.values()).some((existing) => existing.windowId === windowId)
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

  // Execute pending startup command if one was set
  if (pendingCommand) {
    const cmd = pendingCommand;
    pendingCommand = null;
    cmd(uid, session);
  }
}

/** Update the tab name for a session (called on xterm title change). */
export function updateSessionTabName(uid: string, tabName: string) {
  const rootTabUid = trackedSessions.get(uid)?.rootTabUid || uid;
  for (const [sessionUid, t] of trackedSessions) {
    if (t.rootTabUid === rootTabUid) {
      t.tabName = tabName;
      send({type: 'SessionTabName', uid: sessionUid, tabName});
    }
  }
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
  send({type: 'SessionActive', uid, windowId});
}

export function updateWindowFocus(windowId: number) {
  focusedWindowId = windowId;
  send({type: 'WindowFocus', windowId});
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

export function updateSessionLayout(
  tabs: Array<{
    rootGroupUid: string;
    order: number;
    active: boolean;
    panes: Array<{uid: string; splitLabel: string}>;
  }>
) {
  const seen = new Set<string>();

  for (const tab of tabs) {
    for (const pane of tab.panes) {
      const tracked = trackedSessions.get(pane.uid);
      if (!tracked) continue;
      tracked.rootTabUid = tab.rootGroupUid || tracked.rootTabUid;
      tracked.splitLabel = pane.splitLabel || '';
      tracked.tabOrder = tab.order;
      tracked.tabActive = tab.active;
      seen.add(pane.uid);
      send({
        type: 'SessionLayout',
        uid: pane.uid,
        rootTabUid: tracked.rootTabUid,
        splitLabel: tracked.splitLabel,
        tabOrder: tracked.tabOrder,
        tabActive: tracked.tabActive
      });
    }
  }

  for (const [uid, tracked] of trackedSessions) {
    if (seen.has(uid)) continue;
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
}

/** Set an external command handler for custom downstream messages. */
export function setCommandHandler(handler: CommandHandler) {
  commandHandler = handler;
}
