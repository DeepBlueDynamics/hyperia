# Platypus — input boundaries, pane_send, focus, Alt+Up

Role: Grotesque Platypus. Scope: shell-only `terminal_run`, the `pane_send` boundary, focus-aware notification, and Alt+Up in a Codex pane. Reviewed against `plan/messaging-delivery-refactor.md` and the current source.

Status: published for the coordinator. Shell classification and `pane_send` below are recommendations only — not integrated. The isolated keyboard helper is in tree (`lib/utils/alt-arrow-sequence.ts`, called from `lib/components/term.tsx`). Not touched: `app/index.ts`, `lib/index.tsx`, `lib/permissions-bus.ts`, consent UI, sidecar drive/ACL/approval.

Reviewed (evidence, not assumed):

- `sidecar/src/mcp.rs` — `terminal_run` (1187–1287), `pane_process_name` / `is_likely_ink_tui` (1004–1058), `focus_pane` (3624–3631), `terminal_ui_key` (2357–2373), `terminal_keys` (1130–1167).
- `sidecar/src/main.rs` — `post_type` (958–1063), `post_type_and_collect` (1065–1131), `post_focus` (1219–1272), `post_msg_send` (2577–2624).
- `sidecar/src/bridge.rs` — `is_agent_pane` (872–884), `user_active_recently` (858–866), `focused_pane` / `human_focus_report` (528–568), idle classification and mail notice (915–1199), `pane_is_tui` (1412–1427), `deliver_keys` (1453–1547), status `state` fallback (1907–1934), `SessionShellState` (2131–2153).
- `sidecar/src/process.rs` — `foreground_process_with` (12–24): no children returns empty, which is also what a missing pid looks like to callers.
- `sidecar/src/msgbus.rs` — `record` / `to_me` (61–120). Identity and ACL defects are Aardvark's; cited only where `pane_send` must not fork them.
- `app/bridge.ts` — `enqueueOrWrite` (233–308), `UIKey` (932–957), `SessionShellState` forward (1283–1291).
- `app/ui/window.ts` — human key bytes go `rpc 'data'` → `notifyUserActivity` → `session.write` (809–821). No second encoder.
- `lib/components/term.tsx` — `keyboardHandler` (1434–1523), `macOptionIsMeta` / `windowsPty` (91–109), `isTerminalBusy` (1624–1643), `detectInteractiveProgram` (2076–2114).
- `app/keymaps/win32.json` (full file), plus a search of `app/keymaps/` for `alt+up` / `alt+down`: no matches on darwin, linux, or win32.
- `app/index.ts:827` — `Menu.setApplicationMenu` is installed. Accelerators come from those keymaps.
- Installed `@xterm/xterm` 5.5.0 (`package.json` and `node_modules/@xterm/xterm/package.json`). The published bundle `lib/xterm.js` rewrites Alt+Up. Extracted from the bundle (verified this session):

```
case 38: if (modifiers) {
  key = ESC + "[1;" + (modifiers+1) + "A";
  if (!isMac && key === ESC + "[1;3A") key = ESC + "[1;5A";
}
case 40: same for B: non-Mac `[1;3B` becomes `[1;5B`.
```

- Codex default bindings, fetched from `openai/codex` `main` `codex-rs/tui/src/keymap.rs` during this review (upstream source, not the user's installed binary): `edit_queued_message` defaults to Alt+Up and Shift+Left; `prompt_stack_back` defaults to Alt+Down and Shift+Right. The same file's unit test asserts `edit_queued_message == [alt(Up), shift(Left)]`.

Live keypress in the user's Codex pane: not run. The rewrite is verified in the installed xterm 5.5.0 bundle (bytes below). The helper now emits CSI modifier 3 before xterm can rewrite it. A PTY capture on the running app is still the release check for outcome 6; it is not a reason to leave the encoder bug in the renderer.

---

## 1. Verified findings

### F1 — `terminal_run` injects into anything it can address

`terminal_run` (`mcp.rs:1187`) always posts the command plus a trailing `\r` to `/api/type-and-collect` when `submit` is true (`mcp.rs:1223–1243`). The tool text says it works for Codex, Python REPL, and vim. `post_type_and_collect` (`main.rs:1065`) resolves the pane, runs `enforce_drive`, and calls `type_and_collect`. There is no shell-class check and no "don't write" path for a busy shell, an agent, or an unknown process.

`submit=false` (`mcp.rs:1271–1286`) posts to `/api/type` through `post_text`, which does not forward the caller Authorization header (`post_text_as` is the variant that does). That branch still types bytes. A shell-only gate has to sit in front of both branches.

`sidecar/src/ghost/registry.rs:669–677` reads the screen, detects an interactive program, and then explicitly does not block: "terminal_run will send text as keystrokes." Enforcing the plan in MCP alone leaves this ghost path and any other HTTP caller on `/api/type-and-collect`.

The gate has to refuse before `enforce_drive`. Otherwise a doomed command still raises a consent prompt (and, once Ermine holds the payload, a held op for an action that must not run).

### F2 — Nothing in the sidecar is a positive "shell at prompt" signal

What exists:

| Signal | Where | What it actually says |
|---|---|---|
| `foreground_process_with` | `process.rs:18–23` | Empty when the pid is missing **or** the shell has no children. |
| Status `state` | `bridge.rs:1933–1934` | With no shell integration, `idle` if the process string is empty or equals the shell **and** the human has been quiet for 15s. Pid 0 takes the same empty-process branch. |
| `shell_has_integration` + `shell_state` + `shell_app` | `SessionShellState`, `bridge.rs:2131–2153` | Set only when the renderer emits integration. Authoritative when present. Absent on cmd.exe and bare containers (`term.tsx:1641`). |
| `is_agent_pane` | `bridge.rs:872–884` | Substring match of `shell_app.name` against a list that includes `node`, `pi`, and `n8`. Empty name (no integration) is **not** an agent. `"pip".contains("pi")` would match if that name ever landed in `shell_app`. |
| `pane_is_tui` | `bridge.rs:1412–1427` | `is_agent_pane` or a foreground-name substring (`node`, `codex`, …). Used to pick paste-vs-shell delivery, not to refuse. |
| `is_likely_ink_tui` | `mcp.rs:1053` | Same idea, shorter list, diagnostics only. |
| `detectInteractiveProgram` | `term.tsx:2076` | Screen-text sniffer. `isTerminalBusy` (`term.tsx:1633–1638`) already documents that it false-positives an idle shell whose transcript contains "claude" and `❯`. |
| Renderer `isTerminalBusy` | `term.tsx:1624` | OSC non-idle, alt-screen, or the sniffer. Published for close warnings. The sidecar drive path does not read it. |

So "process name empty" is not "at a shell prompt", and status `state: idle` is not either. The plan's "positively identified" bar is unmet by the current helpers. Reusing `is_agent_pane`'s substring list as the agent side of the gate would both miss Codex-without-integration and false-hit short tokens.

`terminal_run` also calls `focus_pane` (`mcp.rs:1193` → `3628`) with `force: false`. `post_focus` (`main.rs:1248–1270`) then bells the tab and does not move the view. Verified: a run does not steal focus. It does bell on every call. `pane_send` must not call this.

### F3 — `pane_send` does not exist; `msg_send` stores text and arms an idle PTY poke

No `pane_send` symbol exists outside the plan. `post_msg_send` (`main.rs:2577`) writes a JSONL record and, when `to_pane` is non-empty and not the sender, calls `arm_msg_notify` (`main.rs:2617–2622`). The response is `{ok, id, to}` with no delivery state. `record` returns `msg_<hex millis>` (`msgbus.rs:79–80`). That is storage, not submission, and not acknowledgement.

The idle monitor turns an armed notice into PTY bytes only when the pane classifies as `idle` (`bridge.rs:1118–1122`): not self-busy, not `user_active_recently` (15s, `bridge.rs:858–866`), and `last_output_at` older than `IDLE_STALE_SECS` (10, `bridge.rs:977–993`). It then drops the notice unless `is_agent_pane` (`bridge.rs:1135–1140`), and `deliver_keys` types a fixed one-line "you've got mail" plus Enter (`bridge.rs:1157–1162`). The message body is not typed. Cooldown is 45s (`MSG_NOTIFY_COOLDOWN_SECS`, `bridge.rs:132`).

Consequences, all from that code:

- A working agent (PTY bytes in the last 10s, or a live busy pulse) never gets the notice. The message is on disk; the agent is not told.
- An agent pane with no shell-integration app name is not `is_agent_pane`, so the pending bit is cleared and the notice is never retried. Codex launched without the integration hook falls in this bucket even after it goes idle.
- Label-only `to_label` leaves `to_pane` empty, so nothing is armed (`main.rs:2620`). Those recipients only see mail if they poll.
- The typed line is a sidecar-originated constant, not the caller's body, and it does not go through `enforce_drive` as the caller's keystrokes. That split is worth keeping: a message grant must not become permission to type the body at a prompt.

`terminal_keys` with `attribute=true` still types arbitrary text into an agent (`main.rs:1004–1051`, cap 512). That is a messaging path around the bus. The plan's constraint that generic terminal input must not bypass the message ACL applies here. `terminal_ui_key` is a third path and the wrong one for Codex (F5).

### F4 — "Human" is a 15s typing timer, not keyboard focus

`user_active_recently` is `last_user_activity` within 15s on that pane. The renderer sets it from human `rpc 'data'` (`window.ts:809–810`, `bridge.ts:1600–1603`). Agent `session.write` inside `enqueueOrWrite` does not go through that RPC, so agent writes do not refresh the timer. Good.

Keyboard focus is a different field. Status already computes `focused` as focused window plus `pane_active` (`bridge.rs:1913–1920`). `human_focus_report` (`bridge.rs:547`) also knows whether Hyperia is the OS-foreground app. The mail gate does not read either. A pane the human is looking at, without a keystroke for 15s, is injectable. A pane they are typing in is queued by `enqueueOrWrite` (`bridge.ts:250–307`) for `/api/type` Keys, which is what `deliver_keys` uses. `post_type_and_collect`'s comment at `main.rs:1093` ("No activity gate") is misleading: the gate is in the renderer, and this handler cannot ask for `interrupt`.

`enqueueOrWrite` protects recent typing in the target pane. It does not protect "this is the focused pane." It also does not protect other panes, which is correct.

### F5 — Alt+Up fails in the xterm 5.5 encoder, after Hyperia's own handler lets it through

Traced for a human keypress in the Codex pane:

1. **Keymaps.** `app/keymaps/{darwin,linux,win32}.json` contain no `alt+up` and no `alt+down`. Win32 `editor:movePreviousWord` / `moveNextWord` are `""`. Mousetrap (`lib/containers/hyper.tsx:93–113`) only binds decorated keymap entries, and it sets `e.catched` when it handles one. Alt+Up is not a Hyperia command. The plan's note that the Windows keymap has no Alt+Up binding is confirmed, and it is not the failure.
2. **`term.tsx` handler.** `keyboardHandler` (`term.tsx:1443–1452`) `preventDefault`s Alt+Left and Alt+Right and returns `false`, so xterm never sees them (directory history). Alt+Up is not in that handler. The function ends at `return !e.catched` (`term.tsx:1522`). With `catched` unset, xterm proceeds. The directory-navigator ArrowUp handler (`term.tsx:2552`) is on the navigator's search input, not the terminal.
3. **xterm 5.5.0, installed bundle.** For a non-Mac Alt+Up, modifiers produce `ESC [1;3A` and the next statement rewrites it to `ESC [1;5A`. VT modifier parameter 3 is Alt. Parameter 5 is Ctrl. Same rewrite for Alt+Down: `[1;3B` → `[1;5B`. The rewrite is skipped when `isMac` is true. Default `altIsMeta` is false (`lib/reducers/ui.ts:114`), so Mac Option is not forced into meta mode by config. This hack is the one xterm removed only on the 6.0 line (upstream discussion #5239 and issue #4538). Hyperia depends on 5.5.0.
4. **PTY.** `term.onData` (`term.tsx:1020–1025`) forwards that string. `window.ts:809–821` writes it to the session. There is no Hyperia transcoder on that path. Inferred, not verified inside node-pty: ConPTY input write does not decode CSI and re-encode it. The bytes xterm emits are the bytes to capture.
5. **Codex.** Upstream `keymap.rs` `built_in_defaults` binds `chat.edit_queued_message` to `alt(Up)` (and `shift(Left)`), and `chat.prompt_stack_back` to `alt(Down)` (and `shift(Right)`). crossterm's Alt+Up is the parameter-3 sequence, not parameter-5. Ctrl+Up does not press that binding. Shift+Left still would, which is why the key can look "dead" while another chord for the same action works.
6. **`terminal_ui_key` is not the fix.** The tool description (`mcp.rs:2357`) says Alt+Up is a Hyperia UI shortcut and tells the caller to bypass the PTY. `UIKey` (`app/bridge.ts:932–956`) synthesizes `keyDown`/`keyUp` on the focused window's `webContents`, with no pane id. If xterm's textarea has focus, the event falls into the same encoder and becomes Ctrl+Up on Windows and Linux. If some other element has focus, Codex's PTY sees nothing. The description is false for this key.

Electron's application menu is installed, and on Windows a bare Alt can highlight the menu. No accelerator in the three keymap files is Alt+Up, so the menu is not the rewrite. It remains a live-test confounder (a held Alt that the OS eats before keydown), which is why the PTY capture has to land before a patch.

Alt+Left/Right must stay as directory navigation. They never reach the xterm left/right hack, which is a separate rewrite (`[1;3D`/`[1;3C`). Do not "fix" those by letting them through.

---

## 2. Proposed `pane_send` API

Not implemented. This is the contract I will code against once Aardvark's send function and Ermine's operation record exist. `pane_send` does not type the body and does not call `post_focus`.

MCP tool `pane_send` and `POST /api/pane/send` both call that shared send function (auth, message ACL, ambiguous-address rejection, stable id). They do not duplicate `to_me`, receipts, or grants. If the service returns `awaiting_approval`, the retained payload is Ermine's operation record, keyed by operation id, not by destination pane.

Request:

```json
{
  "window": 1,
  "tab": "Codex",
  "pane": "pane-id-or-name",
  "to_agent": "nemesis8/n8-example",
  "to_label": null,
  "subject": "",
  "body": "text up to 16384 chars",
  "idempotency_key": "caller-supplied"
}
```

One of `pane` (with optional window/tab), `to_agent`, or `to_label` is required. Anonymous, empty, and ambiguous addresses reject. `idempotency_key` is Ermine's retry key; a replay returns the existing record's state.

Response:

```json
{
  "ok": true,
  "id": "msg_…",
  "state": "queued",
  "transport": "stored",
  "to_pane": "uid-or-null",
  "to_agent": "name-or-null"
}
```

`state` is one of `awaiting_approval`, `queued`, `notice_submitted`, `failed`, `denied`, `expired`. `transport` is `stored` unless the fixed one-line mail notice was actually written to the PTY, in which case `transport` is `notice_submitted` and `state` is `notice_submitted`. Neither value means the recipient read the body. Read acknowledgement stays a separate recipient event.

Refusals, no PTY write and no JSONL command row:

- Target classifies as `ShellPrompt` → 400, error tells the caller to use `terminal_run`.
- Body empty or over 16 KB → 400.
- Anonymous caller → 401.
- ACL deny → 403.
- Address does not resolve → 404.

Notice bytes (the existing constant "you've got mail" line, never the body) are written only when the recipient pane classifies as `Agent`, is not the human's keyboard pane (`focused` and Hyperia foreground), is not `user_active_recently`, and is not self-busy or inside the output-stale window. Otherwise the message stays `queued` and inbox-visible. A working unfocused agent receives the message by reading the inbox, not by stdin during the turn.

`terminal_keys` with `attribute=true` refuses and names `pane_send`. Unattributed `terminal_keys` stays the drive-gated raw input tool.

## 3. Shell classification — recommendation only, do not integrate yet

Nothing in this change calls a classifier. Integrate only after the coordinator accepts the table. Do not treat status `state == "idle"` or an empty `foreground_process` string as a shell prompt: both are true for a missing pid (`process.rs:18–23`, `bridge.rs:1933–1934`).

Put one function in a new `sidecar/src/pane_class.rs`. `terminal_run` and `post_type_and_collect` call it and return before `enforce_drive` and before any write. No screen-text sniffer (`detectInteractiveProgram` false-positives an idle shell whose transcript contains "claude" and `❯`, `term.tsx:1633–1638`).

Inputs: `pid`, shell binary name, foreground name from the process walk, optional foreground cmdline, `shell_has_integration`, `shell_state`, `shell_app`, and an alt-screen boolean plumbed from the renderer (the sidecar cannot see the xterm buffer type today).

| Class | When | `terminal_run` |
|---|---|---|
| `ShellPrompt` | `pid > 0`, shell process exists, foreground walk empty or equal to the shell binary, shell name is `bash`, `zsh`, `fish`, `sh`, `pwsh`, `powershell`, `cmd`, or `nu` (`.exe` already stripped), not alt-screen. If integration is present: `shell_state == "idle"` and `shell_app` is none. Integration `running` wins over an empty walk. | Allow. Focus alone does not refuse. The existing 15s typing lockout still queues. |
| `ShellBusy` | Known shell, and the child in front is not an agent. | Refuse. No bytes. Say the shell is busy. |
| `Agent` | Filename (not substring) of the integration app or the foreground process is `codex`, `claude`, `claude-code`, `aider`, `gemini`, `ollama`, `opencode`, `grok`, `nemesis8`, `antigravity`, or `agy`. Cmdline may match those tokens when the filename is `node`. Do not use `contains("node")` or `contains("pi")` (`pip` would match `pi`). | Refuse. Name `pane_send`. No bytes. |
| `OtherForeground` | Any other child (`vim`, `python`, `ssh`, a bare `node` server). | Refuse. Name unattributed `terminal_keys`. No bytes. |
| `Unknown` | `pid == 0`, process missing, or a binary that is neither a known shell nor an agent. | Refuse. Name `terminal_status`. No bytes. Unknown does not default to shell. |

Refusal body includes `pid`, shell name, foreground name, and integration state. `submit=false` takes the same gate. The `submit=false` HTTP call must use `post_text_as` so the Authorization header is forwarded (`mcp.rs:1284` currently uses `post_text`).

Edit order when this is integrated: classification early-return in `post_type_and_collect` first, then Ermine's approval hold. I do not add the hold. Ghost `registry.rs:669–677` must stop treating an interactive program as a reason to let `terminal_run` through. That ghost edit is part of integration, not this keyboard change.

## 4. Focus-aware notice (recommendation, not coded)

Same rule as section 2. Detail for the integrator:

The mailbox is how a working agent receives the message. Stdin is only a hint, and only when it cannot corrupt a turn or a human.

Write the fixed one-line notice only when all of these hold:

- Recipient resolved to a pane that classifies as `Agent`.
- Pane is not the human keyboard pane: not (`focused` and Hyperia foreground). Watching a pane is enough to suppress stdin.
- Not `user_active_recently` on that pane.
- Not self-busy, and no PTY output inside the stale window. This is "between turns," not "any time."
- Still one coalesced line, still not the body, still not charged against the poke rate limiter.

Otherwise store, arm nothing into the PTY, and leave state `queued`. Do not clear `pending` just because `is_agent_pane` is false today; a pane that later classifies as `Agent` (integration arrives, or the foreground name shows up) can still get the idle hint. Pending TTL stays.

A working unfocused agent "receives" the message because `msg_inbox` returns it immediately. I will not inject the notice into a streaming turn to satisfy the word "while working." A non-stdin signal (existing agent-status light or a bell that does not move focus) can be added for the human's benefit; it is optional and must not be described as agent acknowledgement.

`deliver_keys` already withholds Enter when the human becomes active during the settle (`bridge.rs:1510–1512`). The notice path keeps using it. I do not change Ermine's approval flush except that a flushed message notice obeys the same focus rules.

## 5. Alt+Up / Alt+Down — helper landed, live capture not run

Implemented in this change, isolated from the drive path:

- `lib/utils/alt-arrow-sequence.ts` exports `altArrowSequence`. Bare Alt+Up / Alt+Down (DOM `ArrowUp`/`ArrowDown` or Electron `Up`/`Down`, no Ctrl/Meta/Shift) returns `ESC [1;3A` / `ESC [1;3B`. Every other chord returns null, including Alt+Left/Right, Ctrl+Up, Shift+Up, and plain arrows.
- `lib/components/term.tsx` `keyboardHandler` still handles Alt+Left/Right as directory history, then calls the helper. On a sequence it `preventDefault`s, writes that one string through `onData`, and returns `false` so xterm 5.5 does not also encode. One writer on Mac and on Windows/Linux. That is the "always own the bytes" option from the earlier note, chosen so macOS cannot double-send.
- `lib/utils/alt-arrow-sequence.test.ts` covers those cases. `ava.config.js` only globs `test/unit/*`, so the default `yarn test:unit` does not see this file. Verified command: `yarn ava lib/utils/alt-arrow-sequence.test.ts` — 6 passed.

Not done, and out of this change: `terminal_ui_key` description still claims Alt+Up is a UI shortcut (`mcp.rs:2357`). That text is wrong. Correcting it edits the sidecar, which this pass does not touch. No xterm 6 upgrade.

Live PTY capture in a Codex pane is not run. Until that capture shows `1b 5b 31 3b 33 41` on the wire and Alt+Left still navigates directory history, outcome 6 is not closed. The unit test locks the bytes the handler writes; it does not prove the running Hyperia process has loaded this renderer.

---

## 6. Plan objections

1. **Outcome 5 / the Focus row say a busy unfocused agent receives "notification/input" while working.** If "input" means stdin, the only implementation that satisfies the sentence corrupts the turn `deliver_keys` was written to avoid (`bridge.rs:1453–1463` documents Ink paste and glued Enter). The behavior I will implement is: the message is readable immediately; stdin notice waits for an unfocused, quiet, non-human agent pane. I need the plan sentence changed to that, or I will not match the matrix and will not inject mid-turn.

2. **"Positively identified shell" cannot be status `state == idle` or an empty process name.** Both are true for a dead pid and, after 15s of quiet, for a pane we failed to inspect (`bridge.rs:1933–1934`, `process.rs:18–23`). Section 3 is the contract to accept before anyone wires `terminal_run`. Objections to the known-shell list or the agent filename list should land before that integration.

3. **Aardvark handoff 6.2 is not sufficient for this package.** It says "never inject if user-active or focused" and "remove the 10s silence," and it treats Alt+Up as a reminder that `terminal_focus` is not a routing step. Focus suppression without a replacement for the idle gate means either mid-turn injection or a silent drop. Alt+Up's failure is the xterm rewrite in F5, which that handoff does not mention. I am not accepting 6.2 as the keyboard or the notice contract.

4. **Shell-only `terminal_run` without closing attributed `terminal_keys` does not meet the "no messaging ACL bypass" constraint.** I am treating the `attribute=true` refusal as part of this package. If the coordinator wants that left open, the acceptance row "pane_send does not execute agent prose at a shell prompt" can pass while agents keep typing prose through `terminal_keys`.

5. **`pane_send` must not grow its own approval or identity code.** Ermine's review (D1–D5) and Aardvark's principal model are preconditions for honest states. I can stub `pane_send` against today's `post_msg_send` only as a temporary call, and I will not claim ACL, exactly-once, or restart durability from this package. Those rows stay theirs.

6. **Do not interpret "focused human input protected" as "the focused pane refuses `terminal_run`."** The human watches shells on purpose. Protection that already exists is: don't write into a pane they typed in during the lockout (`enqueueOrWrite`), and don't move their view (`post_focus` default). I will add: don't write message bodies or mail notices into the focused pane. I will not refuse a positively identified idle shell merely because it is focused, once the lockout is clear. If the plan meant the stricter reading, say so; it changes every agent workflow that runs a command in the pane the human is looking at.

7. **The keyboard helper is not a closed outcome 6.** The swallowing layer is the xterm 5.5 bundle rewrite (verified) plus Codex's Alt+Up binding (upstream `keymap.rs`, not the user's binary). The coordinator asked for the isolated helper on that evidence, and it is in `term.tsx`. A live capture that shows `1b 5b 31 3b 33 41` in the Codex pane is still required before anyone calls the user-facing bug fixed. I am not changing keymaps or `terminal_ui_key` in this pass.

---

## 7. Tests

Keyboard unit tests are in `lib/utils/alt-arrow-sequence.test.ts` and passed (`yarn ava lib/utils/alt-arrow-sequence.test.ts`, 6 tests). They assert the helper's bytes. They do not mount `term.tsx`, so they do not assert `preventDefault` or `onData` on the class. The handler calls `altArrowSequence` and, when it returns a string, writes that string and returns false.

Classifier and `pane_send` tests below are not written. They belong with integration, after section 3 is accepted. Each refusal test must assert the writer was not called.

**Classifier / `terminal_run`**

- Integration idle, shell `bash`, no child → `ShellPrompt`, write happens once.
- Integration `running`, empty process walk → refuse `ShellBusy` or `Agent` from `shell_app`, no write.
- No integration, pid live, no child, shell `pwsh` → `ShellPrompt`.
- No integration, pid 0 or process missing → `Unknown`, no write. This fails on today's status fallback, which reports idle.
- Foreground `sleep` → `ShellBusy`, no write.
- Foreground `codex` → `Agent`, refusal names `pane_send`, no write.
- Foreground `vim` → `OtherForeground`, refusal names `terminal_keys`, no write.
- Foreground `node` with cmdline not an agent → not `Agent` (guards the `contains("node")` bug).
- Name `pip` → not `Agent` (guards `contains("pi")`).
- Alt-screen set → not `ShellPrompt`.
- `submit=false` on an agent pane → no write, and the request that would have been sent carries the caller Authorization (regression for `post_text`).

**`pane_send` / notice**

- Send stores through the message service and returns its id. Body bytes never appear in the PTY mock. Writer call count is 0 when the pane is busy, focused, or recently typed.
- Idle, unfocused, agent, not recently typed → at most one notice, text is the fixed mail line, not the body. Second send inside the cooldown does not write again.
- Shell-prompt target → refusal, no JSONL record of a command, no PTY write.
- `attribute=true` on `terminal_keys` → refusal that names `pane_send`, no write.
- `focus_pane` / `post_focus` not called by `pane_send`. `pane_active` unchanged.
- Non-agent pane does not get the mail line typed at its prompt (keep today's "don't poke a human shell" outcome) but a later flip to `Agent` can still deliver the hint (today's code clears `pending` forever; the test locks the new behavior).

**Keyboard — covered by `lib/utils/alt-arrow-sequence.test.ts` (passed)**

- Alt+ArrowUp → `\x1b[1;3A` bytes `1b 5b 31 3b 33 41`, not `\x1b[1;5A`.
- Alt+ArrowDown → `\x1b[1;3B`, not `\x1b[1;5B`.
- Electron names `Up` / `Down` with Alt match the same sequences.
- Alt+Left, Alt+Right, Ctrl+Up, Shift+Up, Alt+Shift+Up, plain Up, Alt+Meta+Down → null so xterm or the directory-history handler keeps them.
- Mac and non-Mac are the same return value. The handler's `return false` is what stops a second encode. That return is in `term.tsx` and is not executed by the unit test.

**Live, not run**

- In a Codex pane, capture PTY input for Alt+Up after this renderer is loaded. Expected: `1b 5b 31 3b 33 41`, and with a queued message present, Codex's edit-queued action runs. Repeat for Alt+Down and `prompt_stack_back`.
- Confirm Alt+Left still changes directory history and does not move the cursor by a word.
- One real `pane_send` at a busy unfocused agent: inbox shows the body, the pane's screen does not gain the body, focus stays put. Depends on Aardvark's ACL and Ermine's approval being in the binary under test. Not-tested, not failed.

Rust tests: not run. Default `yarn test:unit` (the `test/unit/*` glob): not run. The Alt+arrow file was run by explicit path, result above.

---

## 8. What integration still needs

Keyboard helper is in. Do not integrate classification or `pane_send` until these are accepted:

- Section 3 classifier, including "unknown refuses" and the explicit agent filename list.
- Section 2: `pane_send` stores through the shared message service, never types the body, and reports `stored` versus `notice_submitted`.
- Working-agent delivery means inbox availability, not stdin, while the pane is busy or focused.
- Attributed `terminal_keys` closes with the `pane_send` work, not with the keyboard helper.
- Edit order on `post_type_and_collect`: classification early-return, then Ermine's hold.

Status: report published. Shell classification is a recommendation only. Isolated Alt+Up/Down helper and its unit tests are in `lib/`. Sidecar, permissions bus, consent UI, `app/index.ts`, and `lib/index.tsx` were not edited.
