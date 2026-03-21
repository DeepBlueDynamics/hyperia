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

// Session registry: uid → { session, rows, cols, name }
interface TrackedSession {
  session: Session;
  rows: number;
  cols: number;
  name: string;
}
const trackedSessions = new Map<string, TrackedSession>();

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
    send({type: 'Heartbeat'});
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
    rows: tracked.rows,
    cols: tracked.cols,
    pid: tracked.session.pty?.pid ?? 0
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
        rows: t.rows,
        cols: t.cols,
        pid: t.session.pty?.pid ?? 0
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
      const win = getFocusedHyperiaWindow();
      if (win) {
        // Use session data send to trigger focus via the renderer's Redux store.
        // The renderer listens for 'session data send' with a uid to focus that pane.
        const targetUid = msg.uid as string | undefined;
        if (targetUid) {
          win.rpc.emit('session data send', {uid: targetUid, data: '', escaped: false});
        }
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'No focused window');
      }
      break;
    }

    case 'Close': {
      const win = getFocusedHyperiaWindow();
      if (win) {
        win.rpc.emit('termgroup close req');
        sendResult(seq, 'ok');
      } else {
        sendResult(seq, 'No focused window');
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
                  session.write(command + '\r\n');
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
export function registerSession(uid: string, session: Session, rows: number, cols: number, name: string = 'shell') {
  const tracked: TrackedSession = {session, rows, cols, name};
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

/** Notify the bridge of a resize event. */
export function notifyResize(uid: string, rows: number, cols: number) {
  const tracked = trackedSessions.get(uid);
  if (tracked) {
    tracked.rows = rows;
    tracked.cols = cols;
  }
  send({type: 'Resize', uid, rows, cols});
}

/** Signal user activity on a session. Defers agent input for AGENT_DEFER_MS. */
export function notifyUserActivity(uid: string) {
  lastUserActivity.set(uid, Date.now());
}

/** Set an external command handler for custom downstream messages. */
export function setCommandHandler(handler: CommandHandler) {
  commandHandler = handler;
}
