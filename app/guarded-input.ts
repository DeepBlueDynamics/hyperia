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
    transport.write(input.agent ? `\x1b[200~${input.text}\x1b[201~` : input.text);
    if (input.submit) {
      if (input.agent) await transport.settle();
      if (!transport.alive() || transport.protected()) {
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
