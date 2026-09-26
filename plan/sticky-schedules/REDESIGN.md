# Sticky runs: redesign

*2026-09-26. A clean-slate plan built from Kord's walkthrough, reconciled with the audit (`BRIEF.md`). It ignores what the code does today.*

## The idea in one example

Open a sticky and type **"weather in Tokyo"**. Pick **When: Every day 8:00** and **Run: Agent → Claude**. Each morning an agent runs once, headless, in nemesis8, and **replaces** the sticky's result with today's weather.

The sticky always shows *the* answer, not a pile of timestamped entries.

Turn on **Keep history** and ask "weather in Tokyo, trend over the last week". The agent then gets the previous results as context and can write a weekly view into the same sticky.

---

## Primitives

### 1. A sticky has three parts

```
┌ Weather Tokyo ─────────────────────── ⏰ 08:00 daily · Claude ┐
│ weather in Tokyo                                   ← PROMPT   │
│ ───────────────────────────────────────────────────────────── │
│ Tokyo: 22°C, light rain, clears by noon.            ← RESULT  │
│ Tomorrow 24°C sunny.                                          │
│ ───────────────────────────────────────────────────────────── │
│ ✓ ran 08:00 today · next 08:00 tomorrow · history (7)  ← FOOT │
└────────────────────────────────────────────────────────────── ┘
```

| Part | Who writes it | Notes |
|---|---|---|
| **Prompt** | The human, or the agent that created the note | What gets sent to the agent or pane. Never overwritten by a run. |
| **Result** | Each run | **Replaced** every run, not appended. Rendered as Markdown, so links work. |
| **Footer** | The engine | Last run (✓, ✗ or halted, plus the reason), next run, agent/target, a history link. Errors show here, e.g. "Pane *Naval Tern* is gone; schedule stopped." |

Keeping the prompt separate from the result means a run never executes previous output. That fixes audit P2 #12.

A plain sticky with no runs is just the prompt area, as today.

### 2. When: three choices

| When | Pickers that appear | Behaviour |
|---|---|---|
| **Now** | none | Run once immediately, fill in the result, done. |
| **At** | date + time | Run once at that moment, then done. |
| **Every** | **interval** (every N min/h), **daily** at HH:MM, **weekly** on days at HH:MM, or **advanced** cron | Recurring until paused or deleted. Shows the next run. |

Details:
- The pickers only open for At and Every.
- The default is **Now**, which is safe because Run defaults to Notify.
- Cron is only available under Advanced, uses a real parser, and is validated on save.

### 3. Run: what happens at fire time

| Run | What it does | Needs |
|---|---|---|
| **Notify** | Brings the sticky to the front at that time, with an OS toast. Nothing executes. | — |
| **Agent** | **Always nemesis8, through its gateway HTTP API** (:9801), never the `n8` CLI. Starts a one-shot, headless agent with the chosen provider, mounted directory and danger flag. The prompt names the sticky: *"You're working on sticky `<id>` '<name>': <prompt>"*. No pane opens. | The agent, the image, the directory to mount, and danger |
| **Pane** | Sends the sticky to an **existing open pane** by the sticky's **name**, e.g. *"Sticky 'Weather Tokyo' (`<id>`): weather in Tokyo"*, using the same guarded delivery as `pane_send`. **Needs approval** (see Safety). | Choosing a target pane |

**Result capture:** nothing is scraped from stdout or from the pane. The agent, whether headless or in a pane, reads the sticky and **decides whether to update it** through Hyperia's MCP (`sticky_note_read` / `sticky_note_update`, which writes only the Result area). If it never updates, the Result stays as it was and the footer just records the run.

**Agent run fields:**
- **Agent:** a pulldown of nemesis8 providers from `n8 providers --json` (Claude Code, Codex, Grok, Hermes, …). Only installed ones are listed.
- **Image:** fixed to **default** for now, with the note *"Picking a specific image: coming soon"* (ties into #252).
- **Directory:** the folder mounted into the container as the workspace. It defaults to the last one used for this sticky, else home. It has a folder picker.
- **Danger:** a **☐ danger mode** checkbox, passed as n8's `danger` flag. Its state is remembered per sticky.

**When nemesis8 isn't usable, the Agent option shows why instead of silently failing:**
- **Installed but the gateway isn't running:** Hyperia **tries to start it** (the supported start command, to confirm with the n8 session). If that fails, the run halts and the sticky's footer says *"nemesis8 isn't running and couldn't be started"*, with a link to fix it.
- **Not installed:** the sticky gets a notice *"nemesis8 isn't installed. See Config → nemesis8"*, **linking to the config path**. The Agent option in the panel is disabled, with the same link.
- **Image lacks the chosen agent:** the pulldown hides it. A saved schedule whose agent disappears halts with a footer message.

**Pane target rules:**
- The picker lists the panes that are open right now (name, tab, and what's running).
- **If the pane is gone at fire time:**
  - **Every:** the schedule **disables itself and stops**. The footer says "Pane *X* closed; schedule paused." Pick a pane again to re-enable it.
  - **Now / At:** the run **halts**, and the footer explains why. Nothing is retried.
- The message carries the **sticky's name and id**, so the pane's agent can find and update it.
- The pane's reply is **not captured** automatically. It lands in the sticky only if that agent chooses to update the sticky. The footer records "sent to *X* at 08:00".

### 4. History (optional, per sticky)

- **Keep history** toggle, with a window: last N runs, or last 7 or 30 days.
- Each run is appended to `~/.hyperia/stickys/runs.jsonl`: `{note, run_id, started, finished, status, error, agent, target, result}`.
- The sticky still shows **only the latest result**. The footer's **history (N)** link opens a list of past results with their times.
- **With history on, the agent gets context:** the prompt it receives is followed by *"Previous results (newest first):"* and the last N results with timestamps. So "trend over the last week" works with no extra plumbing.
- History off means only `last_run`/`last_status` are kept.

### 5. Links in stickies

The result (and the prompt, when rendered) is Markdown. Links must work.

| Link | Opens |
|---|---|
| `https://…` | A Hyperia web pane (or the OS browser, per the `webPaneLinkTarget` setting). |
| `[[Other Sticky]]` or `sticky:<id>` | That sticky, brought to the front. |
| `file:///…` or a local path | The file browser, or a code sticky for source files. |

Clicks must not start a drag or edit. Links probably don't work today, so this needs verifying and fixing (see Open questions).

---

## Safety (from the audit)

| Rule | Why |
|---|---|
| Runs execute **as an identity, never SYSTEM**. Human-made schedules run as the human. Agent-made ones run as that agent. | Audit P0 #1: the consent bypass. |
| A schedule **created by an agent** needs **human approval** of the exact prompt, agent/target and When. The prompt reads e.g. *"Latin Flea wants Claude to run 'weather in Tokyo' daily at 08:00 in ~/Code"*. | No silent agent-created runs. |
| The **Pane** target **requires approval**. **At creation**, Hyperia notifies you and asks *"Send sticky 'Weather Tokyo' to Naval Tern daily at 08:00?"*. Approving grants the delivery for this schedule. | Nothing gets typed into a pane you didn't OK. |
| **Sticky access for the agent** (Agent or Pane target) is granted **at creation**, as part of the same approval, and scoped to *that* sticky. The agent doesn't get a second prompt when it reads or updates it. If it touches any other sticky, the normal access consent applies. | "Ask on create, or just add it then." |
| An armed sticky's **prompt is locked server-side**: editing it requires pausing or unscheduling. The result and footer stay writable by the engine only. | Audit P0 #2: the cosmetic lock. |
| **One atomic writer** for `notes.json` (main process). The sidecar and renderer go through it. | Audit P2 #14: torn reads wiping every note. |
| Agent runs happen inside nemesis8's container, mounting only the chosen directory. | No host shell execution from stickies. The old `shell` runner is removed. |

---

## Engine

- **Where it lives:** the main-process scheduler, with one source of truth in `notes.json`: `note.run = {when, at, every, run, agent, image, dir, danger, pane, history, paused}`.
- **Run state on the note:** `next_run`, `last_run`, `last_status` (ok | failed | halted | skipped), `last_error`.
- **Next run and time zones:** `next_run` is computed on save and after every fire, in local time with DST handled correctly. The UI and MCP show it.
- **Validation on save:** returns a readable error, never a silent `ok`.
- **Now / At:** the run is marked done only after it finishes (ok, failed or halted).
- **Overlap:** if the previous run of the same sticky is still going, the new one is **skipped** and recorded as skipped.
- **Missed runs:** if the machine was asleep or the app closed, **Every** runs once on launch when a run was missed (one catch-up, not all of them). **At** in the past runs once on launch.
- **Pause and resume:** available on every recurring sticky.
- **Timeouts:** an agent run has a default timeout (10 min, configurable). A timed-out run records `failed: timeout`.
- **Execution:**
  - **Agent:** Hyperia calls the n8 gateway over HTTP (see *nemesis8 integration* below), starts the run, and watches its state until it finishes, fails or times out. Status and errors go to the footer. The result is whatever the agent wrote into the sticky.

---

## nemesis8 integration (from the n8 session, n8 0.26.3)

**Hyperia owns the timing.** Now, At and Every all live in Hyperia's scheduler, with cron, history, pause and catch-up. n8 is only the executor.

At fire time Hyperia creates a **one-shot n8 trigger that fires immediately**. n8's own daily/interval triggers aren't used: they have no cron, and daily ignores its timezone.

| Step | Call | Notes |
|---|---|---|
| Health | `GET http://127.0.0.1:9801/health` | Returns 200 `{status, version}`. Needs no auth. |
| Start if down | `n8 serve --background --port 9801`, then poll `/health` (about 5 s, every 200 ms) | Don't pipe its stdout; the daemon inherits it. If it doesn't come up, the run halts with a footer notice. |
| Auth | Read the OS keychain entry, service `nemesis8`, account `NEMESIS8_AUTH_TOKEN`. On Windows that's Credential Manager target `NEMESIS8_AUTH_TOKEN.nemesis8`. Send it as `Authorization: Bearer <token>`. | There's no file or command that prints it; reading the keychain is the supported way. Every route except `/health` returns 401 without it. |
| Run | `POST /triggers` with `{title, prompt_text, schedule:{"type":"once","at":<now>}, workspace:<dir>, provider, model, danger, tags:["hyperia-sticky", <note id>]}` | The only route that honours workspace, provider, model and danger (`/agents/spawn` and `/completion` drop them). A past `at` fires on the next 30 s tick. Returns a trigger record with its `id`. |
| Track | Poll `GET /triggers/{id}`: `last_fired`, `last_status` ok\|error, `last_error` | While it runs, `GET /agents` shows the container as Running. |
| Clean up | `DELETE /triggers/{id}` once it has finished | Keeps n8's trigger list clean. |
| Agents list | `GET /providers` once n8 PR #126 ships | Held for Kord's go. Until then the pulldown uses a fixed list. |
| Not installed | Presence check: `n8 --version`. Link: https://nemesis8.nuts.services | The notice in the sticky shows the install one-liner and a link to Config → nemesis8. |

**Passing the sticky:** the sticky id and name go in `prompt_text`, e.g. *"You're working on Hyperia sticky `<id>` 'Weather Tokyo'. Read it with sticky_note_read, and update its result with sticky_note_update if you have one. Task: <prompt>"*. There's no per-run env or label field yet.

**Binding the approved sticky access to the run:** the container's Hyperia identity (`nemesis8/<random-name>`) is chosen at launch, so a grant can't be issued for it in advance. Until n8 changes that:
- The grant is added **on first access**, which is the "or just add it then" option.
- When an agent calls `sticky_note_read` or `sticky_note_update` on a sticky, Hyperia allows it without prompting if all of these hold:
  - that sticky has an approved schedule;
  - one of its runs is in flight now (a trigger has fired, and the run hasn't finished or timed out);
  - the caller is a `nemesis8/*` agent.
- The grant is scoped to that sticky and expires when the run ends.
- **Weakness:** during a run's window, any other n8 agent could also claim that sticky. That's acceptable for v1, and fixed by the n8 asks below.

**n8 asks** (the n8 session is taking these to Kord):
1. `env` (and `identity` or `labels`) on `POST /triggers`, so Hyperia can pass `HYPERIA_STICKY_ID` and a pre-minted identity, and bind the grant exactly.
2. `last_agent_id` and `last_session_id` on the trigger record, so a run links to its container and session.
3. A per-trigger `timeout_secs`, since `/completion` defaults to 120 s. Confirm what trigger runs use.
4. Fix the daily trigger ignoring its timezone. That doesn't affect this design, but it's a real bug.
  - **Pane** uses guarded delivery (two-phase submit, busy/idle gating) through the sidecar, as the sticky's identity.

---

## UI

**Sticky panel** (the ⏰ button):
```
When   ( Now )( At )( Every )        [date/time or schedule pickers appear here]
Run    ( Notify )( Agent )( Pane )
       Agent  [ Claude Code      ▾]   Image [ default ▾ ]  coming soon: pick an image
       Dir    [ ~/Code/project   📁]  ☑ danger
       — or —
       Pane   [ Naval Tern · tab Research · claude ▾ ]
History ☑ keep  [ last 7 days ▾ ]
                                         [ Cancel ]  [ Run now ] / [ Schedule ]
```

**Everywhere else:**
- **Title bar:** ⏰ plus the next run; it pulses while running. Armed state survives restarts.
- **Schedules list:** from the tray/sticky menu, and later a Control Deck panel. Every armed sticky with its next run, last status, pause, run-now and delete.

## MCP (for agents)

- **`sticky_note_run`**: `{id, when: now|at|every, at?, every?: {interval|daily|weekly|cron}, run: notify|agent|pane, agent?, dir?, pane?, history?}`. It returns `{ok, next_run}` or `{ok:false, error}`. Agent-created runs return `awaiting_approval` until the human approves.
- **`sticky_note_runs`**: list armed stickies with their next and last status.
- **`sticky_note_history`**: `{id, limit}`, returning past results.
- **`sticky_note_pause`** / **`sticky_note_unschedule`**.
- **Notification:** the agent that created a schedule gets each result by `msg_send`, if it asks for that.

---

## Phases
1. **Model and engine:**
   - prompt / result / footer split;
   - When = Now/At/Every with pickers;
   - Run = Notify;
   - validation, `next_run`, footer status;
   - armed state survives restart;
   - one atomic writer;
   - server-side lock.
2. **Agent run via nemesis8:**
   - the agent pulldown from `n8 providers --json`;
   - image "default · coming soon", directory, danger;
   - the not-installed and not-running states, with Config/Start actions;
   - headless `n8 run`, with the result written into the sticky.
3. **Pane target:** guarded delivery, and the disable/halt rules with a footer message.
4. **History:** `runs.jsonl`, the history view, and previous results fed to the agent.
5. **Links** (http, `[[sticky]]`, file), the Schedules list, the MCP tools and the approval flow for agent-created runs.
6. **Later:** image picking (#252), and possibly handing **Every** to n8's own trigger scheduler.

## Decisions (Kord, 2026-09-26)
- **Run has three options:** Notify, Agent, Pane. Pane targets an open pane, carries the sticky name, and requires approval.
- **n8 is driven through its HTTP endpoints,** not the CLI. Ask the n8 session for API details.
- **Danger** is a checkbox.
- **The reply is captured only if the agent decides to update the sticky** (by reading it and writing it back).
- **If n8 isn't running, try to start it.** If it isn't installed, put a notice in the sticky that links to the config path.

## Still open
- **n8 API: answered,** see *nemesis8 integration*. What's left is the n8-side asks 1–4 (per-run env/identity, last agent/session on the trigger, per-trigger timeout, daily timezone bug).

## Earlier questions (answered above)
1. **Run options:** you said "Run only has two". I've written three: Notify, Agent and Pane. Is Pane its own Run option, or a destination for the Agent's output instead?
2. **Headless agent output:** is stdout from `n8 run` the right result, or should the agent write the result into the sticky itself through `sticky_note_update`? stdout is simpler and needs no MCP.
3. **Danger default for headless runs:** on (nobody's there to approve) or off?
4. **Pane target:** should the pane's *reply* be captured back into the sticky's result? That's hard to do reliably. Or is "sent to X" enough?
5. **Every when n8 isn't running:** skip that run with a footer note, or try to start n8 automatically?
