# Sticky runs: shared contract for the three build branches

This contract is binding. Read `plan/sticky-schedules/REDESIGN.md` for the design and the reasons behind it. Where this file and REDESIGN differ, this file wins.

## Branches
- Integration branch: `feat/sticky-runs`. Each part branches from it and opens a PR **into `feat/sticky-runs`**, not canary:
  - **A (engine):** `feat/sticky-runs-engine`
  - **B (UI):** `feat/sticky-runs-ui`
  - **C (API/safety):** `feat/sticky-runs-api`
- Stay inside your own file ownership (listed below). If you need something from another part, code against this contract and stub it. Don't edit their files.

## Data model (`app/sticky/types.ts`; A owns it, the others import it)

```ts
type RunEvery =
  | {kind: 'interval'; minutes: number}                 // >= 1
  | {kind: 'daily'; time: string}                       // "HH:MM", local time
  | {kind: 'weekly'; days: number[]; time: string}      // 0=Sun..6=Sat
  | {kind: 'cron'; expr: string};                       // 5-field, validated

type StickyRun = {
  when: 'now' | 'at' | 'every';
  at?: string;                 // ISO 8601, required for 'at'
  every?: RunEvery;            // required for 'every'
  target: 'notify' | 'agent' | 'pane';
  agent?: {provider: string; model?: string; image: 'default'; dir: string; danger: boolean};
  pane?: {uid: string; name: string};
  history?: {keep: boolean; limit: number};   // limit = runs kept (default 50)
  paused?: boolean;
  created_by?: string;         // principal key ("human" | "agent:<name>" | "pane:<uid>")
  approved?: {at: number};     // set once a human approves (agent-created runs, and every pane target)
};

type StickyRunState = {
  next_run?: number;           // epoch ms
  last_run?: number;
  last_status?: 'ok' | 'failed' | 'halted' | 'skipped' | 'running' | 'awaiting_approval';
  last_error?: string;
  trigger_id?: string;         // n8 trigger for the in-flight agent run
  run_id?: string;             // in-flight run id
};

// On NoteData:
//   text: the PROMPT (existing field; never written by runs)
//   result?: string   // RESULT; written only by the engine or an agent through sticky_note_update {result}
//   run?: StickyRun | null
//   run_state?: StickyRunState
// The legacy `schedule` field is ignored and dropped on the first write (no migration; there are 0 active schedules).
```

Run history is kept in `~/.hyperia/stickys/runs.jsonl`, one JSON object per line: `{note, run_id, started, finished, status, error?, target, agent?, pane?, result?}`. `result` is a snapshot of `note.result` when the run finishes.

## IPC: renderer ↔ main (A implements main; B calls it)
| Channel | Kind | Payload | Returns |
|---|---|---|---|
| `sticky-run-set` | invoke | `(id, run: StickyRun)` | `{ok:true, next_run?, status}` or `{ok:false, error}`. `status:'awaiting_approval'` when approval is pending |
| `sticky-run-clear` | invoke | `(id)` | `{ok}` |
| `sticky-run-now` | invoke | `(id)` | `{ok}` or `{ok:false, error}`: fire once now, keeping the schedule |
| `sticky-run-pause` | invoke | `(id, paused:boolean)` | `{ok, next_run?}` |
| `sticky-run-history` | invoke | `(id, limit)` | `RunRecord[]`, newest first |
| `sticky-run-panes` | invoke | `()` | `[{uid, name, tab, window, app}]`: the panes open now |
| `sticky-n8-status` | invoke | `()` | `{installed, running, version?, providers:[{name, installed}], config_path, install_url}` |
| `sticky-n8-start` | invoke | `()` | `{ok, running, error?}` |
| `sticky-run-state` | main → renderer (send to that note's window) | `(run_state, run)` | sent on every change, and once on window create (**fixes lost armed state**) |
| `sticky-result` | main → renderer | `(result)` | sent when the result changes |

## Sidecar HTTP (C implements; A calls the n8 ones)
- `POST /api/notes/{id}/run`: body is a `StickyRun` or `{clear:true}`. MCP path: validates, records `created_by`, then goes to the bridge `NoteRun`, which calls A's `setRun`. Agent callers get `awaiting_approval` until a human approves (PermStore request action `sticky_run`). Pane targets always need approval.
- `GET /api/notes/{id}/runs?limit=`: history.
- `GET /api/notes/runs`: all armed runs with state (for the list and MCP).
- `PATCH` note (the existing `patch_note`):
  - rejects `text` changes while `run` is set and not paused, with **409** "Pause or unschedule this sticky before editing its prompt";
  - accepts `result`;
  - the lock applies to every caller except System.
- n8 client, in **sidecar Rust** (`sidecar/src/n8.rs`, **owned by A**):
  - reads the keychain with the `keyring` crate: service `nemesis8`, user `NEMESIS8_AUTH_TOKEN`;
  - talks HTTP to `127.0.0.1:9801`;
  - exposes to main (System token only):
    - `GET /api/n8/status`
    - `POST /api/n8/start` (runs `n8 serve --background --port 9801`, never piping stdout, then polls `/health` for 5 s)
    - `POST /api/n8/run` `{note, name, prompt, provider, model?, dir, danger}` → `POST /triggers` with `once{at:now}`, `tags:["hyperia-sticky", note]` → `{trigger_id}`
    - `GET /api/n8/run/{trigger_id}` → `{last_fired, last_status, last_error}`
    - `DELETE /api/n8/run/{trigger_id}`
- Sticky-access grant on first touch (C): allow an `agent:nemesis8/*` caller `sticky_note_read`/`sticky_note_update` for note X without a prompt if all of these hold:
  - X has an approved `run`;
  - `run_state.last_status === 'running'` (a run is in flight);
  - the call arrives before the run finishes or times out.

  To check this, C reads `notes.json` through the same accessor the sidecar already uses.

## MCP tools (C)
- `sticky_note_run {id, when, at?, every?, target, agent?, pane?, history?}` → `{ok, next_run?, status}` or an error.
- `sticky_note_runs {}` → the armed runs.
- `sticky_note_history {id, limit?}`.
- `sticky_note_pause {id, paused}`.
- `sticky_note_unschedule {id}`.
- `sticky_note_update` gains `result`.
- `sticky_note_schedule` is **removed**.
- The server instructions list the new tools. Agents are told a run's result is written with `sticky_note_update {result}`.

## Prompt handed to an agent (A builds it)
```
You're working on Hyperia sticky `<id>` "<name>". Read it with sticky_note_read.
If you have a result, write it with sticky_note_update {id, result} (it replaces the previous result; keep it concise, Markdown ok).
Task: <note.text>
[If history.keep: "Previous results (newest first):" + last N {finished ISO, result}]
```
For pane targets, the same text is prefixed with `Sticky "<name>" (<id>):`.

## Rules for all parts
- Code comments: 1 line, 2 at most, saying why.
- Don't bump versions. Don't build installers. Don't run `yarn start`/electron. Don't kill Hyperia.
- Never bind 0.0.0.0. Tests use 127.0.0.1 and `CARGO_TARGET_DIR=C:/Users/kordl/Code/DeepBlueDynamics/hyperia/sidecar/target`.
- Never put real usernames or home paths in code.
- Unit tests: ava in `test/unit`, and `#[test]` for Rust. Lint the files you touch.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XfpWaeh4JixaiRhdcNukHy`
- `git push --no-verify`.
- PR into `feat/sticky-runs`. The body ends with the Claude Code line and the session link. Don't merge.
