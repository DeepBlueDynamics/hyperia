import {ipcRenderer} from 'electron';

// ONE shared poller for /api/pulse/status. Every pane band used to run its own
// 5s setInterval against the same GLOBAL endpoint — with N panes that's N
// identical requests per tick (observed flooding the audit trail at ~3-4/sec).
// Here: a single interval while anyone is subscribed, fanned out to all bands.

type Listener = (activePanes: ReadonlySet<string>) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastActive: ReadonlySet<string> = new Set();

async function poll(): Promise<void> {
  try {
    const txt = (await ipcRenderer.invoke('pulse:status')) as string;
    const list = (JSON.parse(txt)?.pulses || []) as Array<{pane: string; paused: boolean}>;
    lastActive = new Set(list.filter((p) => !p.paused).map((p) => p.pane));
  } catch {
    /* sidecar unreachable — keep last known state */
  }
  listeners.forEach((cb) => cb(lastActive));
}

/** Subscribe to the set of pane ids with an active (unpaused) pulse. Fires
 *  immediately with the last known state; polling runs only while at least one
 *  subscriber exists. */
export function subscribePulseStatus(cb: Listener): () => void {
  listeners.add(cb);
  cb(lastActive);
  if (!timer) {
    void poll();
    timer = setInterval(() => void poll(), 5000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Force an immediate refresh (e.g. right after setting/clearing a pulse). */
export function refreshPulseStatus(): void {
  void poll();
}
