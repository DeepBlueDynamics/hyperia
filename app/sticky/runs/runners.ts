// The three run targets. Each returns an outcome; the scheduler owns state and history.
import {homedir} from 'os';
import {join} from 'path';

import {Notification} from 'electron';

import type {NoteData, RunRecord, RunStatus} from '../types';

import {buildAgentPrompt, buildPanePrompt} from './prompt';
import {listOpenPanes, replyError, sidecarRequest} from './sidecar';

export type RunOutcome = {
  status: Exclude<RunStatus, 'running' | 'skipped'>;
  error?: string;
  pause?: boolean; // disable an Every schedule (pane gone)
  notice?: string; // appended to the note's result
};

export type RunContext = {
  runId: string;
  history: RunRecord[]; // newest first, already limited
  onTrigger?: (triggerId: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const N8_INSTALL_URL = 'https://nemesis8.nuts.services';
export const N8_POLL_MS = 5000;
export const N8_TIMEOUT_MS = 15 * 60 * 1000;

export function n8ConfigPath(): string {
  return join(homedir(), '.nemesis8', 'config.toml');
}

export function n8Notice(reason: 'missing' | 'down'): string {
  const what = reason === 'missing' ? "isn't installed" : "couldn't start";
  return `nemesis8 ${what}. See Config → nemesis8 (${n8ConfigPath()}) or ${N8_INSTALL_URL}`;
}

// ── notify ────────────────────────────────────────────────────────────────

// Retained so a shown toast isn't garbage-collected before the user clicks it.
const liveToasts = new Set<Notification>();

export function runNotify(
  note: NoteData,
  bringForward: (id: string) => void,
  openNote: (id: string) => void
): RunOutcome {
  bringForward(note.id);
  if (Notification.isSupported()) {
    const n = new Notification({
      title: `⏰ ${note.name || 'Sticky'}`,
      body: (note.text || '').slice(0, 140) || 'Scheduled sticky'
    });
    liveToasts.add(n);
    const release = () => liveToasts.delete(n);
    n.on('click', () => {
      release();
      openNote(note.id);
    });
    n.on('close', release);
    setTimeout(release, 10 * 60 * 1000);
    n.show();
  }
  return {status: 'ok'};
}

// ── agent (nemesis8 gateway via the sidecar) ──────────────────────────────

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Make sure the n8 gateway is up; undefined means ready, otherwise the halt outcome. */
export async function ensureN8(): Promise<RunOutcome | undefined> {
  const st = await sidecarRequest('GET', '/api/n8/status');
  if (!st.ok) return {status: 'failed', error: `nemesis8 status check failed: ${replyError(st)}`};
  if (!st.data?.installed) {
    return {status: 'halted', error: "nemesis8 isn't installed.", notice: n8Notice('missing')};
  }
  if (st.data.running) return undefined;
  const started = await sidecarRequest('POST', '/api/n8/start', {}, 20000);
  if (started.ok && started.data?.running) return undefined;
  const why = started.ok ? started.data?.error || 'no answer on /health' : replyError(started);
  return {status: 'halted', error: `nemesis8 isn't running and couldn't be started: ${why}`, notice: n8Notice('down')};
}

/** Poll an n8 trigger until it has fired and resolved, then delete it. */
export async function pollAgentRun(
  triggerId: string,
  startedAt: number,
  ctx: Pick<RunContext, 'sleep' | 'now'> = {}
): Promise<RunOutcome> {
  const sleep = ctx.sleep || defaultSleep;
  const now = ctx.now || Date.now;
  let outcome: RunOutcome | undefined;
  while (!outcome) {
    if (now() - startedAt > N8_TIMEOUT_MS) {
      outcome = {status: 'failed', error: 'timeout: the agent run took longer than 15 minutes'};
      break;
    }
    await sleep(N8_POLL_MS);
    const r = await sidecarRequest('GET', `/api/n8/run/${encodeURIComponent(triggerId)}`);
    if (r.status === 404) {
      outcome = {status: 'failed', error: `nemesis8 lost trigger ${triggerId}`};
    } else if (r.ok && r.data?.last_fired && r.data?.last_status) {
      outcome =
        r.data.last_status === 'ok'
          ? {status: 'ok'}
          : {status: 'failed', error: r.data.last_error || `agent run ended with ${r.data.last_status}`};
    }
    // Other errors are treated as transient until the timeout.
  }
  await sidecarRequest('DELETE', `/api/n8/run/${encodeURIComponent(triggerId)}`);
  return outcome;
}

export async function runAgent(note: NoteData, ctx: RunContext): Promise<RunOutcome> {
  const a = note.run?.agent;
  if (!a) return {status: 'failed', error: 'No agent configured.'};
  const blocked = await ensureN8();
  if (blocked) return blocked;
  const started = (ctx.now || Date.now)();
  const r = await sidecarRequest('POST', '/api/n8/run', {
    note: note.id,
    name: note.name || note.id,
    prompt: buildAgentPrompt(note, ctx.history),
    provider: a.provider,
    model: a.model || undefined,
    dir: a.dir,
    danger: !!a.danger
  });
  if (!r.ok) return {status: 'failed', error: replyError(r)};
  const triggerId = r.data?.trigger_id;
  if (typeof triggerId !== 'string' || !triggerId) return {status: 'failed', error: 'nemesis8 returned no trigger id'};
  ctx.onTrigger?.(triggerId);
  return pollAgentRun(triggerId, started, ctx);
}

// ── pane (guarded agent input) ────────────────────────────────────────────

export async function runPane(note: NoteData, ctx: RunContext): Promise<RunOutcome> {
  const run = note.run;
  const pane = run?.pane;
  if (!run || !pane) return {status: 'failed', error: 'No pane configured.'};
  if (!run.approved)
    return {status: 'awaiting_approval', error: 'Waiting for a human to approve sending to this pane.'};
  const open = await listOpenPanes();
  if (!open.ok) return {status: 'failed', error: open.error};
  if (!open.panes.some((p) => p.uid === pane.uid)) {
    const label = pane.name || pane.uid;
    return run.when === 'every'
      ? {status: 'halted', error: `Pane ${label} closed; schedule paused`, pause: true}
      : {status: 'halted', error: `Pane ${label} is closed`};
  }
  const r = await sidecarRequest('POST', '/api/pane/send', {
    pane: pane.uid,
    text: buildPanePrompt(note, ctx.history),
    submit: true,
    idempotency_key: `sticky-${note.id}-${ctx.runId}`
  });
  if (!r.ok) return {status: 'failed', error: replyError(r)};
  return {status: 'ok'};
}
