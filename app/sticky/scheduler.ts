// Sticky run engine: Now / At / Every timing, overlap guard, catch-up, and state + history.
import {readStickyHidden} from './preferences';
import {appendHistory, readHistory} from './runs/history';
import {pollAgentRun, runAgent, runNotify, runPane} from './runs/runners';
import type {RunOutcome} from './runs/runners';
import {firstRun, historyLimit, needsApproval, nextEvery, validateRun} from './runs/schedule';
import {getNote, readAllNotes, setResult, setRunState, writeRun} from './store';
import type {NoteData, RunStatus, StickyRun, StickyRunState} from './types';
import {reveal} from './visibility';

export const TICK_MS = 15000;

type Opener = (options: {id?: string; focus?: boolean}) => void;
let stickyNoteOpener: Opener | null = null;

export function setSchedulerNoteOpener(opener: Opener): void {
  stickyNoteOpener = opener;
}

/** noteId → in-flight run id (this process only). */
const inFlight = new Map<string, string>();

export function isRunning(id: string): boolean {
  return inFlight.has(id);
}

export type SetRunResult =
  | {ok: true; next_run?: number; status: RunStatus | 'scheduled' | 'paused'}
  | {ok: false; error: string};

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(run: StickyRun, human: boolean, now: number): StickyRun {
  const out: StickyRun = {...run};
  if (out.agent) out.agent = {...out.agent, image: 'default', danger: !!out.agent.danger};
  if (out.history) out.history = {keep: !!out.history.keep, limit: historyLimit(out)};
  if (out.when !== 'at') delete out.at;
  if (out.when !== 'every') delete out.every;
  if (out.target !== 'agent') delete out.agent;
  if (out.target !== 'pane') delete out.pane;
  // The sticky panel is the human choosing this run, so it counts as approval.
  if (human) {
    out.created_by = 'human';
    out.approved = {at: now};
  }
  return out;
}

/** Validate, store and arm a run. `human` = set from the sticky UI (not via MCP/bridge). */
export function setRun(id: string, run: StickyRun, opts: {human?: boolean} = {}): SetRunResult {
  const note = getNote(id);
  if (!note) return {ok: false, error: 'Note not found'};
  const now = Date.now();
  const error = validateRun(run, now);
  if (error) return {ok: false, error};
  const armed = normalize(run, !!opts.human, now);
  const next = firstRun(armed, now);
  if (needsApproval(armed)) {
    const saved = writeRun(note.id, armed, {next_run: next, last_status: 'awaiting_approval', last_error: undefined});
    if (!saved) return {ok: false, error: 'notes.json is unreadable; run not saved'};
    return {ok: true, next_run: next, status: 'awaiting_approval'};
  }
  const prev = note.run_state?.last_status;
  const saved = writeRun(note.id, armed, {
    next_run: armed.paused ? undefined : next,
    last_error: undefined,
    last_status: prev === 'awaiting_approval' ? undefined : prev
  });
  if (!saved) return {ok: false, error: 'notes.json is unreadable; run not saved'};
  startScheduler();
  if (armed.paused) return {ok: true, status: 'paused'};
  if (armed.when === 'now') void fire(note.id);
  return {ok: true, next_run: next, status: armed.when === 'now' ? 'running' : 'scheduled'};
}

export function clearRun(id: string): {ok: boolean; error?: string} {
  const note = getNote(id);
  if (!note) return {ok: false, error: 'Note not found'};
  // An in-flight agent run keeps going in n8; its finish is still recorded.
  const saved = writeRun(note.id, null, {next_run: undefined});
  return saved ? {ok: true} : {ok: false, error: 'notes.json is unreadable'};
}

export function pauseRun(id: string, paused: boolean): {ok: boolean; next_run?: number; error?: string} {
  const note = getNote(id);
  if (!note?.run) return {ok: false, error: note ? 'This sticky has no run' : 'Note not found'};
  const run: StickyRun = {...note.run, paused};
  const next = paused ? undefined : firstRun(run, Date.now());
  const patch: Partial<StickyRunState> = {next_run: next};
  // Resuming re-arms a pane schedule that paused itself; it clears the old halt reason.
  if (!paused && note.run_state?.last_status === 'halted') patch.last_error = undefined;
  const saved = writeRun(note.id, run, patch);
  return saved ? {ok: true, next_run: next} : {ok: false, error: 'notes.json is unreadable'};
}

/** Fire once now; the schedule (and next_run) are kept. */
export function runNow(id: string): {ok: boolean; status?: RunStatus; error?: string} {
  const note = getNote(id);
  if (!note?.run) return {ok: false, error: note ? 'This sticky has no run' : 'Note not found'};
  if (needsApproval(note.run)) return {ok: false, error: 'This run is waiting for approval'};
  if (inFlight.has(note.id)) return {ok: false, error: 'A run is already in progress'};
  void fire(note.id, {manual: true});
  return {ok: true, status: 'running'};
}

// ── Firing ─────────────────────────────────────────────────────────────────

function bringForward(id: string): void {
  // Never un-hide a Hide-All, never reopen a closed note, never take focus.
  if (!readStickyHidden()) reveal(id, false);
}

function openNote(id: string): void {
  if (getNote(id) && stickyNoteOpener) stickyNoteOpener({id, focus: true});
}

async function execute(note: NoteData, runId: string): Promise<RunOutcome> {
  const run = note.run as StickyRun;
  const history = run.history?.keep ? readHistory(note.id, historyLimit(run)) : [];
  const ctx = {runId, history, onTrigger: (t: string) => void setRunState(note.id, {trigger_id: t})};
  if (run.target === 'notify') return runNotify(note, bringForward, openNote);
  if (run.target === 'agent') return runAgent(note, ctx);
  if (run.target === 'pane') return runPane(note, ctx);
  return {status: 'failed', error: `Unknown target ${String(run.target)}`};
}

function sameRun(a: StickyRun | null | undefined, b: StickyRun): boolean {
  if (!a) return false;
  const strip = (r: StickyRun) => JSON.stringify({...r, paused: undefined});
  return strip(a) === strip(b);
}

function recordSkip(note: NoteData, run: StickyRun, now: number): void {
  appendHistory(
    {
      note: note.id,
      run_id: newRunId(),
      started: now,
      finished: now,
      status: 'skipped',
      error: 'previous run still running',
      target: run.target
    },
    historyLimit(run)
  );
  // last_status stays 'running' for the in-flight run; only the clock advances.
  if (run.when === 'every' && run.every) setRunState(note.id, {next_run: nextEvery(run.every, now)});
}

/** Finish bookkeeping: state, one-shot completion, pane auto-pause, history. */
function finish(
  id: string,
  run: StickyRun,
  runId: string,
  started: number,
  outcome: RunOutcome,
  manual: boolean
): void {
  const fresh = getNote(id);
  if (!fresh) return;
  if (outcome.notice && !(fresh.result || '').includes(outcome.notice)) {
    setResult(id, fresh.result ? `${fresh.result}\n\n> ${outcome.notice}` : `> ${outcome.notice}`);
  }
  const patch: Partial<StickyRunState> = {
    last_status: outcome.status,
    last_error: outcome.error,
    run_id: undefined,
    trigger_id: undefined
  };
  const cur = fresh.run;
  let after: NoteData | undefined;
  if (cur && sameRun(cur, run)) {
    const oneShot = cur.when === 'now' || (cur.when === 'at' && !manual);
    if (outcome.status === 'awaiting_approval') {
      after = setRunState(id, patch);
    } else if (oneShot) {
      // Now/At are done only once they finish (ok, failed or halted).
      after = writeRun(id, null, {...patch, next_run: undefined});
    } else if (outcome.pause) {
      after = writeRun(id, {...cur, paused: true}, {...patch, next_run: undefined});
    } else {
      after = setRunState(id, patch);
    }
  } else {
    after = setRunState(id, patch);
  }
  appendHistory(
    {
      note: id,
      run_id: runId,
      started,
      finished: Date.now(),
      status: outcome.status,
      error: outcome.error,
      target: run.target,
      agent: run.agent,
      pane: run.pane,
      result: run.history?.keep ? (after || fresh).result : undefined
    },
    historyLimit(run)
  );
}

export async function fire(id: string, opts: {manual?: boolean} = {}): Promise<void> {
  const note = getNote(id);
  const run = note?.run;
  if (!note || !run) return;
  const now = Date.now();
  if (inFlight.has(note.id)) {
    recordSkip(note, run, now);
    return;
  }
  const runId = newRunId();
  inFlight.set(note.id, runId);
  const patch: Partial<StickyRunState> = {
    last_status: 'running',
    last_run: now,
    last_error: undefined,
    run_id: runId,
    trigger_id: undefined
  };
  // Every advances now so the next tick can't refire; one-shots keep next_run until they finish.
  if (run.when === 'every' && run.every && !opts.manual) patch.next_run = nextEvery(run.every, now);
  setRunState(note.id, patch);
  let outcome: RunOutcome;
  try {
    outcome = await execute(note, runId);
  } catch (e) {
    outcome = {status: 'failed', error: String((e as Error)?.message || e)};
  } finally {
    inFlight.delete(note.id);
  }
  finish(note.id, run, runId, now, outcome, !!opts.manual);
}

/** One scheduler pass. Exported for tests; the interval calls it every 15 s. */
export async function tick(now: number = Date.now()): Promise<void> {
  const fires: Promise<void>[] = [];
  for (const note of readAllNotes()) {
    const run = note.run;
    if (!run || run.paused || needsApproval(run)) continue;
    const st = note.run_state || {};
    let next = st.next_run;
    if (next === undefined) {
      // A run without a clock (restored, or hand-edited) gets one; a finished one-shot is already cleared.
      next = firstRun(run, now);
      if (next === undefined) continue;
      if (run.when === 'every') {
        setRunState(note.id, {next_run: next});
        continue;
      }
    }
    if (next > now) continue;
    if (inFlight.has(note.id)) {
      if (run.when === 'every') recordSkip(note, run, now);
      continue;
    }
    // A missed Every catches up once: fire() recomputes next_run from now, not from the stale time.
    fires.push(fire(note.id));
  }
  await Promise.all(fires);
}

/** Runs marked 'running' by a previous process: resume n8 polling, or record the interruption. */
function recoverInterrupted(): void {
  for (const note of readAllNotes()) {
    const st = note.run_state;
    if (st?.last_status !== 'running' || inFlight.has(note.id)) continue;
    const run = note.run;
    const runId = st.run_id || newRunId();
    const started = st.last_run || Date.now();
    if (run && run.target === 'agent' && st.trigger_id) {
      inFlight.set(note.id, runId);
      void pollAgentRun(st.trigger_id, started)
        .catch((e) => ({status: 'failed', error: String(e)}) as RunOutcome)
        .then((outcome) => {
          inFlight.delete(note.id);
          finish(note.id, run, runId, started, outcome, false);
        });
    } else if (run) {
      finish(note.id, run, runId, started, {status: 'failed', error: 'Interrupted by an app restart'}, false);
    } else {
      setRunState(note.id, {last_status: 'failed', last_error: 'Interrupted by an app restart', run_id: undefined});
    }
  }
}

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  try {
    recoverInterrupted();
  } catch (e) {
    console.error('[sticky] run recovery failed:', e);
  }
  // Returns the tick promise (never rejects) so tests can await a pass.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  setInterval(() => tick().catch((e) => console.error('[sticky] scheduler tick failed:', e)), TICK_MS);
}

export function stopSchedulerForTests(): void {
  schedulerStarted = false;
  inFlight.clear();
}
