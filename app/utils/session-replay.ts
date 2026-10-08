// What a pane re-sends to the sidecar right after (re)registering. The sidecar
// starts every register from "idle, no app, no cwd", and the shell only
// re-announces at its next prompt — hours away for a running agent. Replaying
// what main already knows keeps the pane's state across a reconnect.

export interface ReplaySource {
  /** True once the shell has sent any integration mark (OSC 133/697). */
  integrationSeen?: boolean;
  shellState?: {
    state: 'idle' | 'running';
    lastExit?: number;
    app?: {name: string; path: string; cmdline: string; pid: number};
  };
  cwd?: string;
}

export function sessionReplayMessages(uid: string, s: ReplaySource): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // Shells without integration must not be replayed as if they had it.
  if (s.integrationSeen && s.shellState) {
    out.push({
      type: 'SessionShellState',
      uid,
      state: s.shellState.state,
      lastExit: s.shellState.lastExit,
      app: s.shellState.app || null
    });
  }
  if (s.cwd) out.push({type: 'SessionCwd', uid, cwd: s.cwd});
  return out;
}
