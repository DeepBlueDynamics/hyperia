// Heartbeat-ack watchdog for the sidecar WebSocket. Pure state so it can be
// unit-tested without a socket; bridge.ts owns the timer and the terminate.

/** Heartbeats go out every 5s; three unanswered means the sidecar reader is wedged. */
export const ACK_TIMEOUT_MS = 15000;

export interface AckWatch {
  /** When this connection opened, or the last HeartbeatAck arrived. */
  lastAckAt: number;
  /** Set on the first ack; a sidecar too old to ack is never timed out. */
  ackSeen: boolean;
}

export function newAckWatch(now: number): AckWatch {
  return {lastAckAt: now, ackSeen: false};
}

export function recordAck(watch: AckWatch, now: number): void {
  watch.lastAckAt = Math.max(watch.lastAckAt, now);
  watch.ackSeen = true;
}

/** True when the socket should be terminated and reconnected. */
export function ackOverdue(watch: AckWatch, now: number, timeoutMs: number = ACK_TIMEOUT_MS): boolean {
  return watch.ackSeen && now - watch.lastAckAt > timeoutMs;
}
