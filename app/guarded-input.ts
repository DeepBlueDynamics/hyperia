/** One transport attempt. The durable sidecar queue owns retries; this never queues or replays input. */
export interface InputAttempt {
  text: string;
  submit: boolean;
  agent: boolean;
}
export interface InputTransport {
  alive(): boolean;
  protected(): boolean;
  write(text: string): void;
  settle(): Promise<void>;
  /** Text is in the composer but Enter was withheld; main may submit it later (see pendingEnterDecision). */
  enterWithheld?(writtenAt: number): void;
}
export interface InputOutcome {
  state: 'deferred' | 'submitted' | 'failed' | 'indeterminate';
  detail: string;
}
export async function submitInput(input: InputAttempt, transport: InputTransport): Promise<InputOutcome> {
  if (!transport.alive()) return {state: 'failed', detail: 'Target pane incarnation is gone.'};
  if (transport.protected()) return {state: 'deferred', detail: 'Human focus or typing protects this pane.'};
  let attempted = false;
  try {
    attempted = true;
    // Stamped before the write so typing during settle counts as the human's.
    const writtenAt = Date.now();
    transport.write(input.agent ? `\x1b[200~${input.text}\x1b[201~` : input.text);
    if (input.submit) {
      if (input.agent) await transport.settle();
      if (!transport.alive() || transport.protected()) {
        if (input.agent && transport.alive()) transport.enterWithheld?.(writtenAt);
        return {
          state: 'indeterminate',
          detail: 'Text was written; Enter withheld because the pane changed or the human took focus. Do not replay.'
        };
      }
      transport.write('\r');
    }
    return {
      state: 'submitted',
      detail: input.submit
        ? 'Text and Enter accepted by the PTY transport; recipient read is unverified.'
        : 'Text accepted by the PTY transport; Enter was not sent.'
    };
  } catch (err) {
    return {state: attempted ? 'indeterminate' : 'failed', detail: String(err)};
  }
}

/** Agent text whose Enter was withheld; retried until the human intervenes or it times out. */
export interface PendingEnter {
  uid: string;
  pid: number;
  writtenAt: number;
}
export const PENDING_ENTER_POLL_MS = 500;
export const PENDING_ENTER_MAX_MS = 30_000;

export interface PendingEnterState {
  now: number;
  /** Same pane and same PTY pid as when the text was written. */
  sameIncarnation: boolean;
  protected: boolean;
  /** Last recorded human keystroke/activity on this pane, if any. */
  lastUserActivityAt?: number;
}
export type PendingEnterDecision =
  | {action: 'wait'}
  | {action: 'send'}
  | {action: 'abandon'; reason: 'incarnation' | 'human-typed' | 'timeout'};

/** Never sends Enter over the human's own typing: any activity since the write abandons it. */
export function pendingEnterDecision(pending: PendingEnter, state: PendingEnterState): PendingEnterDecision {
  if (!state.sameIncarnation) return {action: 'abandon', reason: 'incarnation'};
  if (state.lastUserActivityAt !== undefined && state.lastUserActivityAt >= pending.writtenAt) {
    return {action: 'abandon', reason: 'human-typed'};
  }
  if (state.now - pending.writtenAt > PENDING_ENTER_MAX_MS) return {action: 'abandon', reason: 'timeout'};
  if (state.protected) return {action: 'wait'};
  return {action: 'send'};
}
