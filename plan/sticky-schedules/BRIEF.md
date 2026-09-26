# Sticky schedules: audit brief

*2026-09-26. Four read-only audits: engine, targets, UI/MCP, and evidence on this machine. Line numbers are from `origin/canary` @ dcda8cb4.*

## TL;DR

Schedules are **mostly a notification timer with a "open a new tab and type into it" runner bolted on**.

- **Which agent runs? None.** The only agent runner (`n8agent`) POSTs to `/api/notes/{id}/agent-run`, **a route that doesn't exist**. The failure is silent. There's no field for agent, provider, model or pane anywhere.
- **Sticky → shell doesn't work** because there is **no "send to an existing pane" target at all**.
  - The `shell` runner always opens a *new* tab in whatever window has focus.
  - It types the note text raw, after a fixed 800 ms delay.
  - It fails silently in common cases: no terminal window open, HTTP errors, a different port, or cmd.exe as the last-used shell.
- **It runs as SYSTEM, which is a consent bypass.** Any agent can create a note and schedule `runner:'shell'`. That opens a tab and runs the note text with no consent prompt. The "locked" note isn't actually locked either: `sticky_note_update` can rewrite it after it's armed.
- **It looks broken after a restart.** The armed/lock state is sent before any sticky window exists and is never re-sent, so armed notes show as un-armed and editable.
- **Common cron never fires.** `0 9 * * 1-5` doesn't work (ranges unsupported), and bad input is accepted with `ok`.

**Evidence on this box:** 202 notes, **0 active schedules**. 5 notes have `schedule: null`, which means a one-shot either fired or was cleared; the two can't be told apart. The only fires in 10 days were **3 `shell` runs today (19:13–19:16Z) from "Sly Wolf" (`ls`)**. All three opened PowerShell panes. Nothing records whether `ls` actually ran, or which note triggered the tab.

---

## How it works today

| Piece | Where |
|---|---|
| Storage | Inline `NoteData.schedule` in `~/.hyperia/stickys/notes.json` (`app/sticky/types.ts:11-22,38`). No separate store, no run history. |
| Engine | Electron main, `startScheduler()` from `initSticky()` on app ready (`app/sticky/ipc.ts:72`). Re-reads the whole `notes.json` every 15 s (`scheduler.ts:160-194`). |
| Kinds | `once` (UI default, not in the type), `reminder` (delay m/h/d), `at` (datetime-local), `cron` (hand-rolled 5-field subset). |
| Runners | `notify` (OS toast), `shell` (new tab via sidecar `/api/pane/new`), `n8shell` (same, with `profile:'n8'`), `n8agent` (dead route). |
| Command | The note's ```` ```run ```` blocks, else **the whole note text** (`scheduler.ts:76-82`). |
| Set from | The ⏰ panel in the sticky window (`app/sticky.html:66-135`, `schedule-ui.js`), or MCP `sticky_note_schedule` → sidecar `/api/notes/{id}/schedule` → bridge → `scheduleSticky`. Both always return `ok`. |

## Answers to your two questions

### "Which agent is run?"
None.
- There's no agent field.
- `n8agent` is dead: `scheduler.ts:151` has no auth, errors are swallowed, and the route is missing from `main.rs:4559-4565`.
- The sidecar's built-in agent (ghost) isn't involved. It can't even schedule stickies: `sticky_note_schedule` isn't in the sticky door's `ghost_tools` (`doors.rs:183-193`).
- The UI label "Nemesis8 agent — hand the note to the agent" doesn't say which agent, and nothing ever runs.

### "Stickies to a shell don't work"
There's no target for an existing pane. The `shell` runner opens a new tab and fails in these cases:
1. **No terminal window focused.** Only stickies or the tray are open → `NewTab` returns "No focused window" as a success (`bridge.ts:870`). The scheduler never checks the status. The toast shows and nothing else happens.
2. **HTTP errors ignored.** `fetch` doesn't throw on 401/403/202 (consent held)/500, and the local fallback only runs on a network exception (`scheduler.ts:129-149`).
3. **Hardcoded `localhost:9800`.** It ignores `HYPERIA_PORT` (`scheduler.ts:11`). In external-sidecar mode the SYSTEM token doesn't resolve, so the request gets a 401, and that's swallowed.
4. **Whatever shell was last used.** The empty profile resolves to the last-used shell. If that's cmd.exe, `cd "X"; cmd` breaks. If it's ssh or WSL, the command runs somewhere else.
5. **Raw typing after 800 ms.** There's no prompt wait and no two-phase submit. Multi-line run blocks are joined with `\n` and sent with one `\r`.
6. **One global `pendingCommand` slot** (`bridge.ts:92,868,1418`). If another pane registers first (a restore, an agent split), the command goes into the wrong pane.
7. **One-shots are cleared before the runner runs** (`scheduler.ts:187`). A failed run is gone, with no retry and no report.
8. **`n8shell` runs on the host.** It asks for profile `'n8'`, but the detected profile is named `Nemesis8`, so it falls back to the base shell.

---

## Ranked findings

### P0: security
1. **The scheduler bypasses consent.** Runners use `SYSTEM_TOKEN` (`scheduler.ts:133`, `bridge.rs:570`). The schedule endpoint only checks note access (`main.rs:4068`). Scenario: an agent is refused create-consent, so it writes its own note (`rm -rf …`) and schedules `shell, once`. A tab opens and the command runs.
2. **The lock is cosmetic.** Read-only is enforced only in the renderer. `sticky_note_update` → `patch_note` (`main.rs:3999`) and `store.updateNote` ignore it, so an armed note's command can be changed after the human reviewed it. Human-created notes have no `creator`, so any caller can edit or schedule them (`main.rs:2006`).
3. **`dir` is interpolated unescaped** into `cd "${dir}"` (`scheduler.ts:127,141`).

### P1: silently never runs
4. **`n8agent` is a dead route** (see above).
5. **Cron subset.**
   - Ranges (`1-5`), names (`MON`), `7`=Sunday, `a-b/n`, `@daily` and `*/0` never match.
   - Day-of-month and day-of-week are **AND**ed; standard cron is OR.
   - `*/n` on 1-based fields is offset: dom `*/5` gives 5,10…, not 1,6,11.
   - There's no validation, so the note stays armed and locked forever (`scheduler.ts:63-74`).
6. **Runner HTTP errors are swallowed**; there's no fallback for `n8shell` (`scheduler.ts:129-149`).
7. **Bad `at` or unknown `when`/`runner`** is armed forever, and the API still says `ok` (`scheduler.ts:27-31,186`; `bridge.ts:1274`).
8. **The MCP "omit fields to clear" instruction is wrong.** Omitting the fields sends `reminder` + `notify` with no delay, which fires within 15 s (`mcp.rs:2985,2994-3002`; `scheduler.ts:25`). Only `unschedule=true` clears.

### P1: looks broken
9. **Armed state is lost after a restart or reopen.** `sticky-lock`/`sticky-armed` are sent before any window exists (`scheduler.ts:164-169`, restore runs 400 ms later), and `createStickyNote` never re-sends them. **This is the most likely cause of "seems busted".**
10. **No status anywhere.**
    - `fire_at` and `last_run` are stored but never shown.
    - There's no `last_error`.
    - One-shots erase all trace when they fire.
    - The MCP reply is `{"ok":true}` only.
    - The only output is an OS toast, which may not show on Windows dev builds or under Focus Assist. The Notification object isn't retained either.
11. **Dangerous default.** "Once — run now" is preselected (`sticky.html:77`). Rescheduling silently restarts a reminder's countdown (`scheduler.ts:48`).

### P2: correctness and robustness
12. **Previous output runs as a command.** With no run block the whole note is the command, and after a fallback run the appended ```` ```result ```` block and any prose get executed on the next cron fire.
13. **Missed cron runs aren't caught up** (`last_run` is never read). A restart within the same minute can double-fire. DST skips or doubles runs. A `d` reminder is a fixed 24 h.
14. **Three writers of `notes.json`:** main (atomic), renderer (not atomic), sidecar (not atomic). Readers treat a parse error as `[]`, and `upsertNote` then writes back a single note. **A torn read can wipe every note and schedule.** If the `schedule:null` write fails, a one-shot re-fires every 15 s.
15. **No overlap guard.** An every-minute cron opens a tab every minute.
16. **Exec fallback problems.**
    - The timeout doesn't kill child processes.
    - Output is truncated to the first 6000 chars (errors are usually at the tail).
    - The exit code is dropped when there's output.
17. **Agents are told to use this for timed checks** (`bridge.rs:714,1176,1186`), but no runner can reach an agent's pane. The agent is never woken.
18. **Docs and tests:**
    - The server instructions omit `sticky_note_schedule`.
    - There's no `docs/stickies.md`.
    - `docs/mcp-tools.md` covers schedules in one line.
    - There are no tests for `cronMatches`, `computeFireAt` or the runners.

---

## Proposed redesign (for your go)

### 1. Make targets explicit
Replace `runner` with a **target**:

| Target | What it does |
|---|---|
| `notify` | OS toast plus an in-app toast. |
| `pane` | Deliver the note (its run block or text) to an **existing pane**, chosen by pane uid, with the tab and window names shown in the UI. Goes through **`deliver_keys` / guarded input** (two-phase submit, busy/idle gating), the same as `pane_send`. If the pane is gone, the schedule fails loudly. |
| `new-pane` | Open a pane with an **explicit profile** (a shell, or an agent like Claude or `n8 --provider X`, using the #252 catalog), a cwd, and the command as the launch argv, not typed text. |
| `agent` | Hand the note to a **named agent**: Hyperia's built-in agent via `/shell`, or a specific agent pane via `pane_send`, or an n8 provider via `n8 run`. The UI shows exactly which. |
| `exec` | Background run with output captured back into the note (today's fallback, made explicit). |

### 2. Consent and safety
- Schedules created by an agent run **as that agent's identity**, never SYSTEM.
- `pane` and `agent` targets go through the normal pane-access consent **when the schedule is created**, with a clear prompt: "Latin Flea wants to send 'X' to Naval Tern every day at 9:00". After approval, runs need no further prompt.
- `exec` and `new-pane` scheduled by an agent need **explicit human approval** of the exact command.
- The lock is enforced in the sidecar and main process: an armed note can't be edited without first unscheduling it.

### 3. Engine
- Replace the cron matcher with a real parser (`cron-parser` or `croner`), in local time with DST handled correctly.
- Validate on save, and **return errors** to the UI and MCP. Compute and return `next_run`.
- Add a per-schedule run history in `~/.hyperia/stickys/runs.jsonl` (append-only): `{note, target, started, finished, status, error, output_ref}`. Keep `last_run`, `last_status` and `last_error` on the note.
- Only clear a one-shot after its run succeeds or fails, and record which.
- Catch up missed cron runs once on launch (configurable). Add an overlap guard.
- Add pause and resume.
- Route all `notes.json` writes through one atomic writer in main. The sidecar and renderer go through IPC/bridge.
- Use the configured sidecar port and a real per-run identity.

### 4. UI
- **The schedule panel shows:** target (with the pane or agent picker), next run, last run with status and error, and a history link. Default to **Reminder**, not "run now".
- The ⏰ tooltip shows the next run. Armed state is restored after restart, and notify schedules also get the border.
- Add a **Schedules list** (tray/sticky menu, and a Control Deck panel): every armed schedule with its next run, pause, run now and delete.

### 5. MCP
- Add `sticky_note_schedule` params `target`, `pane`, `agent` and `profile`, as enums with validation.
- The reply includes `next_run` and any error.
- Add `sticky_note_schedules` to list them, and let agents receive run results via `msg_send`.
- Fix the description ("omit to clear" becomes `unschedule=true`), and add the tool to the server instructions.

### Phases
1. **Stop the bleeding.**
   - Consent: agent schedules run as the agent.
   - The lock is enforced server-side.
   - Check HTTP status; use the configured port; restore armed state after restart.
   - Hide `n8agent` until it works; set the default to Reminder; validate input.
   - Fix the MCP description.
2. **`pane` target** via guarded delivery, and the **status fields** (next run, last run/status/error) in the UI and MCP.
3. **Real cron**, run history, catch-up, pause, and a single atomic writer.
4. **`agent` and `new-pane` targets** with an explicit agent or profile (ties into #252), plus the Schedules list and a Control Deck panel.
