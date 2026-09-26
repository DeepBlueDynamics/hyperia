# Sticky notes and runs

A sticky is a floating note. It can also carry a **run**, which executes it now, at a set time, or on a schedule.

## Prompt, result and footer

| Part | What it holds | Who writes it |
|---|---|---|
| **Prompt** | The note's text: what gets sent when it runs. | The human, or the agent that created the note. A run never overwrites it. |
| **Result** | The latest answer, rendered as Markdown. Each run **replaces** it. | The agent doing the run, with `sticky_note_update {id, result}`. |
| **Footer** | Last run (ok, failed or halted, with the reason), next run, target, and a history link. | The engine. |

Nothing is scraped from an agent's output or from a pane. If the agent never writes a result, the result stays as it was and the footer just records the run.

## When

| When | Fields | Behaviour |
|---|---|---|
| `now` | none | Runs once, immediately. |
| `at` | `at`: ISO 8601, e.g. `2026-10-01T08:00` | Runs once at that moment. A time in the past runs once on the next launch. |
| `every` | `every`: one of the shapes below | Recurring until it's paused or removed. Missed runs catch up once. |

`every` shapes (local time):

- `{kind:"interval", minutes:N}`, where N is at least 1
- `{kind:"daily", time:"HH:MM"}`
- `{kind:"weekly", days:[0..6], time:"HH:MM"}`, where 0 is Sunday
- `{kind:"cron", expr:"<5 fields>"}`

## Run targets

| Target | What happens at fire time |
|---|---|
| `notify` | The sticky comes to the front with an OS toast. Nothing executes. |
| `agent` | A one-shot, headless nemesis8 agent runs in its container. Fields: `agent: {provider, dir, danger?, model?}`. `dir` is required: it is the folder mounted as the agent's workspace. The prompt it gets names the sticky, so the agent can read it and write its result. |
| `pane` | The sticky's name, id and prompt are sent to an existing, open pane (`pane: {uid}`, from `terminal_status`), with the same guarded delivery as `pane_send`. If the pane has closed, a recurring run pauses itself and a one-shot halts; the footer says why. |

## Approvals

| Who creates the run | `notify` | `agent` | `pane` |
|---|---|---|---|
| The human (sticky UI or a System caller) | armed at once | armed at once | **approval prompt** |
| An agent or pane token | **approval prompt** | **approval prompt** | **approval prompt** |

While approval is pending, `sticky_note_run` returns `{ok:true, status:"awaiting_approval"}` and the run does not fire. Approving arms it. Denying clears it. Don't retry while you wait. The prompt spells out the request, e.g. *"Latin Flea wants Claude to run 'weather in Tokyo' daily at 08:00 in ~/Code (danger)"*.

Other rules:

- A run records `created_by` (`human`, `agent:<name>` or `pane:<uid>`). Callers can't set `approved`; only the server sets it.
- **Prompt lock:** while a run is set and not paused, changing the prompt is refused with **409** *"Pause or unschedule this sticky before editing its prompt"*. This applies to every caller except Hyperia itself, human-made notes included. Writing `result` is always allowed.
- **Sticky access during a run:** a nemesis8 agent (`agent:nemesis8/*`) may read and update the sticky it was started for without a consent prompt, but only while that sticky's approved `agent` or `pane` run is in flight (`run_state.last_status == "running"`). The allowance is per request and is logged. Touching any other sticky goes through normal consent.

## History

When `history: {keep: true, limit: N}` is set (N from 1 to 500, default 50), each run is appended to `~/.hyperia/stickys/runs.jsonl` as `{note, run_id, started, finished, status, error?, target, agent?, pane?, result?}`. The sticky still shows only the latest result. With history on, the agent also receives the previous results as context, so prompts like "trend over the last week" work.

## Links

Results are Markdown. `https://…` opens a web pane (or the browser, per `webPaneLinkTarget`). `[[Other Sticky]]` and `sticky:<id>` bring that sticky to the front. `file:///…` and local paths open the file browser or a code sticky.

## MCP tools

| Tool | Use |
|---|---|
| `sticky_note_create`, `sticky_note_read`, `sticky_note_list`, `sticky_note_search` | Create and find notes. |
| `sticky_note_update {id, text?, result?}` | Set the prompt and/or the result. |
| `sticky_note_run {id, when, at?, every?, target, agent?, pane?, history?}` | Arm or replace a run. Returns `{ok, next_run?, status}` or `{ok:false, error}`. |
| `sticky_note_runs` | Every run you can see, with its `run_state`. |
| `sticky_note_history {id, limit?}` | Past runs, newest first. |
| `sticky_note_pause {id, paused}` | Pause or resume a run. |
| `sticky_note_unschedule {id}` | Remove the run. |

For a quick "poke me when I go idle", use `pane_on_idle`, not a sticky run.

## HTTP (sidecar, port 9800)

| Route | Purpose |
|---|---|
| `POST /api/notes/{id}/run` | Body: a run, `{clear:true}`, or `{paused:bool}`. Returns 400 for an invalid run, 404 for an unknown note, and 401 without an identity. |
| `GET /api/notes/{id}/runs?limit=` | History for one note. |
| `GET /api/notes/runs` | Every note with a run that the caller can see. |
| `PATCH /api/notes/{id}` | `{text?, result?}`. Returns 409 when the prompt is locked. |
