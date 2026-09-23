# Platypus implementation status

## Platypus source verdict: READY FOR EXTERNAL VALIDATION

This is not a runtime-fixed claim. No build and no test was run for this verdict. The user validates externally.

Platypus area is the principal-key permission ledger, the schema-2 grant migration, bind-consent requester keys, and the earlier stream-text and renderer reservation edits. Those are in source. `post_perm_respond`, delivery-store APIs, and replay metadata are other owners and were not changed in this pass. Root's stream anonymous rejection and unique pane match were left as landed.

What external validation should show:

- An agent registered as `codex` has ledger key `agent:codex`. An agent registered as `agent:codex` has ledger key `agent:agent:codex`. The second does not receive the first's grants.
- An unversioned `perms.json` is rewritten once to `"schema": 2`. A stored requester is kept only when `agents.json` makes it one identity. A string that is both a label and a key, or that matches no registered agent, is removed. Those callers must be approved again.
- A file that already has schema 2 is not reinterpreted on the next start.
- Drive, create, capability, owner, held-create, and bind consent compare `principal_key()`. `label()` is display-only. Bind approval accepts only `agent:<name>`.
- `/api/perms/check` uses that same registry decision. An ambiguous requester is not allowed. Live `authorize_drive` does not go through that string conversion; it uses the token's principal key.

No concrete source blocker remains in this area. Sticky-note and pulse creators still store display labels. That is outside the permission ledger.

## Review of Root's guarded legacy cleanup

Source only. No source edit this turn. No build and no test. Not a runtime-fixed claim.

**Verdict for this cleanup: READY FOR EXTERNAL VALIDATION.** No new concrete blocker.

Checked in `sidecar/src/bridge.rs`:

- `type_and_collect`, `pane_is_tui`, and `screen_tail_holds` are gone. `/api/type-and-collect` in `main.rs` still exists and calls `delivery_service::submit_input`, not the deleted helper.
- `is_agent_pane` is `classification_for` and `accepts_direct_input()`. The old name-substring check is gone.
- `deliver_keys` classifies, then calls `guarded_input` once. There is no screen read and no extra Enter. `guarded_input` holds `lock_input` and classifies again unless `control` is true. Pulses do not set `control`, so a foreground change while waiting fails closed and does not write.
- The mail notice and the same-tick pulse both go through `guarded_input`. The pulse loop starts only after the notice await returns.
- Pending notices stay while `pending` is true. The one-hour retain drops only completed bookkeeping. Closing the pane still removes that pane's notice entry.
- `No Electron client connected` and `Electron disconnected` do not consume the arm. Timeout, a dropped response channel, `submitted`, and `indeterminate` consume it and are not replayed. `deferred` and `failed` stay pending. `unread == 0` still clears the arm; that behavior was already accepted and is unchanged.
- `input_locks` keeps an entry when the pane is registered or `Arc::strong_count` is greater than 1. `lock_input` clones the `Arc` while holding the map mutex, so an in-flight or waiting transaction is counted. A closed pane with only the map's reference is removed.

A pulse still sets `last_fire` before `deliver_keys`. A disconnect on a pulse burns that interval. A mail notice does not. That is the existing pulse schedule, not a new mail-notice hole.

Coordinator contract: `plan/platypus-implementation-contract.md`. This file is the API the coordinator integrates. `main.rs` and `mcp.rs` were not edited. No route, no MCP tool, no consent UI.

**Not a fixed verdict.** The user builds and tests outside every agent container. Container runs below are earlier evidence only. This turn did not compile or run tests, and it did not change Rust or TypeScript. The only edit this turn is this document.

## External validation — run these on the user's machine

From the repository root. Do not point these at an agent container. `yarn test:unit` does not see the keyboard file (`ava.config.js` globs only `test/unit/*`). The cargo filter must be `pane_class::`, not `classify` (`classify` matches an ignored ghost test and skips the classifier).

```sh
yarn test:unit
```

The keyboard cases now live at `test/unit/alt-arrow-sequence.test.ts`, which `ava.config.js` includes. The helper stays at `lib/utils/alt-arrow-sequence.ts`. The xterm bundle assertion still reads `process.cwd()/node_modules/@xterm/xterm/lib/xterm.js`, so run this from the repository root. This move is untested here (no container runs this turn). The earlier 9-pass result was `yarn ava lib/utils/alt-arrow-sequence.test.ts` against the old path.

Expected keyboard names inside that suite: bare Alt+ArrowUp, bare Alt+ArrowDown, Electron Up/Down, Alt+Left/Right unclaimed, Ctrl+Up and Shift+Up and plain Up unclaimed, missing key, keyup does not emit, keydown Alt+Up, installed xterm 5.5 bundle rewrite.

```sh
cargo test --manifest-path sidecar/Cargo.toml --offline --no-default-features -- pane_class:: classification_for_missing -- --test-threads=8
```

Drop `--offline` if that machine has no cargo cache. `--no-default-features` skips TTS, which needs `alsa`. If alsa is installed and you want the default feature set, drop `--no-default-features` instead.

Expected: 15 passed, 0 failed. The 14 `bridge::pane_class::tests` names:

- `shell_prompt_requires_live_integrated_idle_shell`
- `empty_foreground_without_integration_is_unknown`
- `dead_pid_is_unknown_even_when_integration_says_codex`
- `codex_foreground_accepts_input_without_idle_silence`
- `focused_agent_defers_even_when_the_typing_timer_is_clear`
- `recent_typing_defers_an_unfocused_agent`
- `background_hyperia_does_not_count_as_foreground_focus`
- `shell_and_unknown_never_receive_agent_input`
- `n8_integration_with_docker_foreground_is_the_n8_transport`
- `docker_without_n8_integration_is_not_an_agent`
- `launcher_is_argv0_or_image_name_not_a_later_argument` (`echo codex`, `echo /usr/bin/codex`, `node /usr/bin/codex`, `bash -c codex`, `docker run n8`, `codex-cli`, argv0 `/usr/local/bin/codex`)
- `idle_integration_app_is_stale_and_is_not_an_agent`
- `alt_screen_blocks_shell_prompt_but_not_a_named_agent`
- `integration_running_without_a_child_is_shell_busy`

Plus `bridge::tests::classification_for_missing_pane_is_none_and_dead_pid_refuses_input`.

Live pane checks, still not run anywhere. Do not inject keys into the coordinator's pane.

- In a Codex pane, capture PTY input for a human Alt+Up. Expected bytes: `1b 5b 31 3b 33 41`. Not `1b 5b 31 3b 35 41`. With a queued message, Codex `edit_queued_message` runs. Alt+Down: `1b 5b 31 3b 33 42` and `prompt_stack_back`. Alt+Left still walks directory history.
- `Bridge::classification_for` on a pane whose foreground image is `echo` and whose cmdline is `echo codex` returns `Refuse`, not `Agent`. Same for an idle integration record whose `shell_app.name` is still `codex` and whose child list is empty: `ShellPrompt`, `terminal_run_allowed`, not `Agent`.

## Evidence ledger

| Evidence | What it covers | What it does not cover |
|---|---|---|
| Container `yarn ava lib/utils/alt-arrow-sequence.test.ts`, 9 passed | Current `lib/utils/alt-arrow-sequence.ts` and the xterm 5.5 bundle bytes on that container. ESLint on the helper, its test, and `term.tsx` exited 0 in that same container session. | A human key in a Codex pane. The user's `node_modules` bundle. |
| Container `cargo test --offline --no-default-features -- pane_class:: classification_for_missing`, 15 passed | Current `sidecar/src/pane_class.rs` launcher rule and idle-integration rule, plus the dead-pid `classification_for` path. This run was after those rules landed. | Default-feature sidecar (TTS/alsa failed earlier in the container). A live process table (`observe_process` on a real child). Routes, MCP, notices, unread counts. |
| Earlier container cargo filter `classify` | Nothing useful: 0 passed, 1 ignored (`live_classify_content`). | The classifier. Do not cite it. |
| Earlier 14-pass cargo run | The classifier before launcher tightening. That build still treated `node /usr/bin/codex` as `codex`. | The current source. Superseded by the 15-pass run. |
| This document after the 15-pass run | Prose only: API wording, the agent-token table, the test count, and this section. | No binary. |

Source review this turn, no code change: `app/session.ts` OSC 133 `A`/`B` replaces shell state with `{state:'idle'}` and drops `app`. OSC 133 `D` clears `app` explicitly. OSC 697 can attach `app` onto whatever state is current, including idle. The classifier ignores an app record while state is idle, which is the false-positive guard. OSC 133 `C` also replaces state and drops `app` until the next 697, so a just-started agent can look `ShellBusy` for that gap. That is a false negative, not a false positive. `observe_process` picks `children[0]` from a `HashMap`, so two children have no stable order. `is_agent_pane` still uses `contains("node")` and `contains("pi")` and is not what `classification_for` calls. Unread count is `messaging::unread_for_pane`, not this method.

## Decision reflected

`pane_send` is not an alias of `msg_send`. The earlier alias proposal is withdrawn.

| | `pane_send` | `msg_send` |
|---|---|---|
| Payload | The caller's text, as agent input | Durable mailbox record |
| Bytes on the PTY | The input, and only after the shared queue submits it | At most the existing fixed "you've got mail" notice, never the body |
| Recipient | A supported agent transport only | Mailbox identity from the shared ACL. A notice is armed only for that same supported agent |
| Shell / unknown / vim / node / docker-without-n8 | Refuse. Do not enqueue input | Store only if the mailbox ACL says the address is a recipient. Do not type a notice |
| Focused human pane, or recent typing | Defer on the shared queue. Do not write now | Suppress the notice. The mailbox row still exists |
| Working unfocused supported agent | Deliver. Do not wait for 10s of PTY silence | Arm the notice with `idle_silence_required: false` |
| Read | Not this call. A later recipient ack | Not implied by storage or by the notice |

Both calls go through the same recipient ACL and the same canonical identity (Aardvark) and the same operation queue (Ermine). This package does not authorize and does not hold approvals. `explicit_submit: true` on `Deliver` means the queue's submit step is separate from pasting the body. Do not glue Enter into the same write.

`Deliver` means eligible to submit. It is not `submitted` and it is not `read`. The coordinator records those after the queue and after the recipient ack.

## API — ready

`Bridge::classification_for` is the method root should call. Declared from `sidecar/src/bridge.rs` via `#[path = "pane_class.rs"]`. It does not write to the PTY, and it does not count mail.

Canonical unread count stays on the mailbox. Root already has `messaging::unread_for_pane` (`sidecar/src/messaging.rs`), which counts `mailbox::inbox(..., unread_only: true)` for the pane's bound principal. This helper does not duplicate that count and does not mark anything read. A notice's number comes from that function, not from `DeliveryCandidate`.

```rust
pub async fn classification_for(&self, uid: &str) -> Option<DeliveryCandidate>
```

`None` — no registered session.

```rust
pub struct DeliveryCandidate {
    pub classification: Classification, // class + summary
    pub focus_protected: bool,          // keyboard pane AND Hyperia is the OS foreground app
    pub actively_typed: bool,           // human typed in this pane within 15s
    pub pane_send: InputDisposition,
    pub notice: NoticeDisposition,
}

pub enum InputDisposition {
    Deliver { token: String, explicit_submit: bool }, // explicit_submit is always true
    Defer { token: String, reason: String },
    Refuse { reason: String },
}

pub enum NoticeDisposition {
    Arm { idle_silence_required: bool }, // idle_silence_required is always false
    Suppress { reason: String },
    Skip { reason: String },
}
```

`Classification::terminal_run_allowed()` is true only for `PaneClass::ShellPrompt`. `accepts_direct_input()` is true only for `PaneClass::Agent`. `summary` is the refusal string to return to the caller.

### How to wire (coordinator)

`pane_send`, after ACL and after the operation row exists:

1. `classification_for(uid)`.
2. `Deliver` → shared queue, body is the agent input, submit explicitly, state becomes `submitted` only after the write is accepted. Not a read.
3. `Defer` → same queue, do not write until a later check returns `Deliver`. State stays queued / awaiting, not submitted.
4. `Refuse` → do not enqueue input. Return `classification.summary`. Shell targets do not fall through to `terminal_run`.

`msg_send`, after the same ACL:

1. Store the mailbox row (existing path).
2. `notice == Arm` → arm the fixed notice. Do not require `IDLE_STALE_SECS`.
3. `Suppress` or `Skip` → do not type. `Skip` is mandatory for shell, unknown, and other foreground even when the pane is unfocused.

Do not replace `is_agent_pane` in place without reading this. That helper still uses `contains("node")` and `contains("pi")`. `classification_for` does not. Leave the old helper until the notice path is switched, or a substring match will keep classifying `pip` as an agent.

### Classes

Evidence is pid liveness, shell filename, foreground name and cmdline, and shell-integration fields. No screen text.

| Class | Rule |
|---|---|
| `Unknown` | `pid == 0` or the pid is not in the process table. Also: integration is absent and there is no foreign child (empty foreground is not a prompt). Also: the binary is neither a known shell nor an agent token. A dead pid stays `Unknown` even if integration still says `codex`. |
| `Agent { token }` | Exact launcher executable only: the process image name, or argv0 when the image name is missing. Later arguments are not the program. `echo codex`, `echo /usr/bin/codex`, `bash -c codex`, `docker run n8`, and `node /usr/bin/codex` are not agents. `/usr/local/bin/codex` as argv0 is `codex`. `codex-cli` is not `codex`. Tokens: `agy`, `aider`, `antigravity`, `claude`, `claude-code`, `codex`, `gemini`, `gemini-cli`, `grok`, `n8`, `nemesis8`, `ollama`, `opencode`. An idle shell-integration app record is stale and is ignored, so a leftover `shell_app` of `codex` on an idle prompt is `ShellPrompt`, not `Agent`. A live foreground `codex` is still `Agent` even if integration says idle. n8 is recognized while integration state is not idle and the app launcher is `n8`, including when the visible child is `docker`, `podman`, or `containerd`. The same n8 record while idle does not make `docker` an agent. |
| `OtherForeground` | Alt-screen when no agent token matched, or a child whose shell binary is not a known shell. |
| `ShellBusy` | Known shell (`bash`, `cmd`, `dash`, `fish`, `nu`, `powershell`, `pwsh`, `sh`, `zsh`) with a non-agent child, or integration state other than `idle` with no child and no agent. |
| `ShellPrompt` | Known shell, pid alive, integration present and `idle`, no app, no foreign child, alt-screen not `Some(true)`. |

Integration can disappear for a moment. While it is absent, an empty process list is `Unknown`, not `ShellPrompt`. A still-visible agent executable is still `Agent` from the process walk. Nothing is inferred from terminal text.

### Alt-screen plumbing, not done

`ClassEvidence.alt_screen` is implemented and tested. `classification_for` always passes `None`, because `SessionInfo` has no buffer-type field and reporting it would touch the renderer and session register. Proposed plumbing, separate change: renderer sends the xterm buffer type (`normal` / `alternate`) with session updates; `SessionInfo` stores `alt_screen: Option<bool>`; `classification_for` copies it. `Some(true)` blocks `ShellPrompt` and does not block an agent token (Codex often owns the alt screen).

### Focus predicate

`focus_protected` is true only when this pane is the active pane of the focused window and Hyperia is the OS-foreground app. The 15s typing timer is not part of that flag. `actively_typed` is separate and also defers. A focused pane inside a background Hyperia is not focus-protected; recent typing still defers.

Unfocused is not "safe to type." `vim`, `node`, `pip`, and a shell prompt all `Refuse` `pane_send` and `Skip` the notice.

## Keyboard

`lib/utils/alt-arrow-sequence.ts`, called from `lib/components/term.tsx` `keyboardHandler`.

- Keydown only. `keyup` and `keypress` return null, so the handler does not `preventDefault` and does not return false. xterm still sees the keyup.
- Bare Alt+Up / Alt+Down → `ESC [1;3A` / `ESC [1;3B` (`1b 5b 31 3b 33 41` / `1b 5b 31 3b 33 42`). The handler writes that once and returns false so xterm 5.5 cannot also emit its rewrite.
- Alt+Left / Alt+Right still take the directory-history path above the helper. The helper returns null for them.
- Ctrl+Up, Ctrl+Down, Shift+Up, plain arrows are null.

The installed bundle `node_modules/@xterm/xterm/lib/xterm.js` (5.5.0) contains the non-Mac rewrite `ESC [1;3A` → `ESC [1;5A` and the same for `B`. The unit test reads that file. No keys were sent to a live pane.

Live user-pane validation: **not run**.

## Tests run inside an agent container (earlier evidence, not the user's verdict)

See the evidence ledger above. Do not treat this section as a pass on the user's machine.

- `yarn ava lib/utils/alt-arrow-sequence.test.ts` — 9 passed, including the installed-bundle rewrite assertion and the keyup cases. That path is gone. The same cases are now `test/unit/alt-arrow-sequence.test.ts` (import `../../lib/utils/alt-arrow-sequence`). `yarn test:unit` will pick them up. The move itself has not been run.
- `cargo test --offline --no-default-features -- pane_class:: classification_for_missing` from `sidecar/` — 15 passed, 0 failed. That is 14 `pane_class` cases (including `echo codex` and stale idle integration) plus `classification_for` on a missing pane and a dead pid. Default features pull `alsa` via TTS; this container has no `alsa.pc`, so a default-feature build did not compile. The classifier tests do not need TTS. A first filter of `classify` matched only an ignored ghost test and was not the run above.

## Safety review

- Direct input reaches only a supported agent token. Shell prompt, busy shell, unknown, and other foregrounds refuse. That includes an unfocused shell.
- A focused foreground pane and a pane with recent typing defer. They do not drop the operation; the shared queue holds it. This helper does not hold it itself.
- A working unfocused agent is `Deliver` with no idle-silence requirement. Streaming output is not a reason to wait and not a reason to refuse.
- `msg_send` staying on the mailbox is what keeps a long body out of the composer. The notice path must not start typing that body.
- Submitted and read stay different fields. Nothing here marks a message read or claims the PTY accepted bytes.
- `is_agent_pane`'s substring list is still in `bridge.rs` and is still wrong for `pip` / bare `node`. The new method does not call it. Integrating the notice onto `is_agent_pane` would undo the token rule.
- Alt-screen is not visible to `classification_for` yet. Until the plumbing above lands, an alt-screen program with no agent token and no process child can be misread only if integration also says idle. A real alt-screen program usually has a child or a non-idle integration state. The gap is documented, not guessed from screen text.
- No approval map was touched. A `Defer` that never gets a queue record will still time out in whatever store the coordinator uses; this helper will not invent a second hold map.

## Ambiguous process tree — source change, not run

`observe_nodes` no longer picks `children[0]`. More than one child at any level sets `ProcessObs.ambiguous` and leaves the foreground name empty. `classification_for` copies that flag. `classify` then:

- Uses the shell-integration launcher only when state is `running` or `busy` and the app name and argv0 basename are the same non-empty token (either side may be absent, not contradictory).
- That launcher may be an agent (`codex` with cmdline `/usr/local/bin/codex chat`). `echo` with cmdline `echo codex` is `ShellBusy`, not an agent.
- Name `codex` with cmdline `echo codex` is a disagreement, so `Unknown`.
- Idle integration, missing integration, or a stuffed foreground name on an ambiguous tree is `Unknown`. Not `ShellPrompt`. Not `Agent`. `pane_send` refuses.

New tests, not executed this turn: `multiple_children_are_not_read_as_codex`, `a_single_child_chain_is_that_leaf`, `several_grandchildren_make_the_tree_ambiguous`, `ambiguous_tree_without_validated_integration_is_unknown`, `ambiguous_idle_integration_is_unknown_not_a_prompt_or_agent`, `ambiguous_tree_uses_validated_running_integration`.

External command, same as before, still not a verdict until you run it:

```sh
cargo test --manifest-path sidecar/Cargo.toml --offline --no-default-features -- pane_class:: -- --test-threads=8
```

## Interleaving proposal — not implemented

Root is reviewing serialization. This is the proposal only.

`GuardedInput` holds `inputAttempts` for the whole `submitInput` call, including the 150ms settle before Enter. `Keys` does not look at that set. `enqueueOrWrite` writes immediately when the human-activity timer is clear. Pulses still call `deliver_keys`, which sends `Keys`.

Same-tick order in `idle_monitor_tick` awaits the notice `send_command` through the 150ms, then runs `to_fire`. The pulse is therefore outside the reservation: Enter has already been sent and `inputAttempts` is cleared in `finally` before the pulse `Keys` land. A concurrent `terminal_keys` / `post_type` during those 150ms never sees the reservation at all, because the sidecar does not have one.

Proposed fix, one lease:

1. Renderer: `Keys` takes the same per-uid gate as `GuardedInput`. If `inputAttempts` contains the uid, return `deferred` and do not `pty.write`. Do not only queue behind `agentQueues`.
2. Sidecar: record an in-flight uid for the whole `GuardedInput` await. Skip `deliver_keys` for that uid in the same tick, including the pulse that currently runs after the await. A pulse for a pane that just accepted a notice waits for the next interval.
3. Do not extend the 150ms sleep to cover pulses. Two writers would still share one composer. The lease is the exclusion, and `Keys` has to honor it.

## Coordination — `plan/final-consent-coordination.md`

Read before this turn. No further code edit. User builds and tests. Root's replay change (body stored once, metadata compared separately) and Ermine's `post_perm_respond` were not touched. Aardvark's `consent_operations` wrapper was not touched. Stream and renderer reservation edits are already in `sidecar/src/stream.rs` and `app/bridge.ts`.

Canonical requester, the only ledger key:

| Caller | `principal_key()` | `label()` display only |
|---|---|---|
| Agent | `agent:<registered name>` | the name |
| Pane token | `pane:<session uid>` | `pane <session uid>` |
| System | `system` | `Hyperia` |
| Anonymous | empty; never stored as a grant | `anonymous` |

Bind approval compares `req.requester` with `agent:<name>` taken from action `bind:<name>`. A display name does not match. `MailActor.requester` is `principal_key()`, including a pane token whose mailbox principal is a bound agent. Held creates and owner stamps use that same string, which is what `post_perm_respond` already reads from `req.requester`.

## Blocker 8 — principal key for the permission ledger

Source only. Not compiled and not run. `post_perm_respond` was not edited. Replay size was not edited.

`CallerIdentity::principal_key` is `agent:<name>`, `pane:<uid>`, or `system`. `label()` stays the display string (`Hyperia`, the agent name, `pane <uid>`). Drive, audio, create, capability, request-access, owner stamps, held creates, and bind consent all store and compare that key. `MailActor.requester` is the same key. Approving a prompt still grants `req.requester`, so Ermine's respond path writes the key without a second namespace.

Unversioned `perms.json` is cut over once against `agents.json`, then saved as schema 2. A stored requester is kept only when the registry makes it unambiguous. A registered name becomes `agent:<name>`, so the registered name `agent:codex` becomes `agent:agent:codex` and does not receive the grants of an agent named `codex`. `agent:<name>` is kept only when that exact key belongs to a registered agent and is not also another agent's label. `Hyperia` becomes `system`. `pane <uid>` becomes `pane:<uid>`. A string that is both a label and a key, or that matches no registered agent, is dropped and must be approved again. Schema 2 is not reinterpreted on later loads. Grant targets are not rewritten. `/api/perms/check` uses the same registry decision and is not-allowed for an ambiguous string. There is no prefix-only rule. Root's stream anonymous rejection and unique pane match were not edited.

Changed files:

| File | Change |
|---|---|
| `sidecar/src/identity.rs` | `principal_key` and registry `cutover_requester`. A name equal to `agent:codex` is not treated as the key for `codex`. |
| `sidecar/src/perms.rs` | Schema 2. Unversioned files migrate requester keys from the agent registry, drop ambiguous rows, and save. |
| `sidecar/src/bridge.rs` | `authorize_drive`, `authorize_create`, `authorize_capability` use `principal_key`. |
| `sidecar/src/main.rs` | Consent creation, denial clear, owner stamp, and `hold_create` / `take_resolved_create` use the key. Not `post_perm_respond`. Display logs, sticky creators, and pulse creators still use `label()`. |
| `sidecar/src/messaging.rs` | `actor_from_identity` requester, bind consent, and `approve_binding` compare `agent:<name>`. |

## Assigned finish — tab input and renderer reservation

Source only. Not compiled and not run. Not a runtime fix.

Changed for this assignment:

| File | What changed |
|---|---|
| `sidecar/src/stream.rs` | `tab_handler` / `tab_loop` take `CallerIdentity`. `{t:"input"}` requires one pane match, `authorize_drive == Allow`, then `lock_input` and `Keys`. Empty id, zero matches, and several prefix matches error and do not write. Non-`Allow` does not queue and does not raise consent. |
| `app/bridge.ts` | `inputReserved` reads `inputAttempts`. `enqueueOrWrite` returns `deferred` before interrupt, queueing, and `session.write`. `drainQueues` leaves an existing human-activity queue in place and keeps the timer while reserved. |
| `plan/platypus-implementation-status.md` | This record. |

Not changed: `pane_raw_loop` binary auth and lock (`stream.rs` around the `Message::Binary` arm), the `GuardedInput` case in `app/bridge.ts`, `app/guarded-input.ts`, delivery worker, and `main.rs` routes.

Remaining source blockers, still not run:

1. `type_and_collect` holds `lock_input` for the whole quiet-collect, up to about 8s plus the nudge, not only the write. Ordering stays correct. That pane's other locked input waits.
2. `pane_is_tui` and `process.rs::deepest_child` still use `children[0]` when a process has several children. `classification_for` does not. `deliver_keys` can still pick bracketed paste versus a glued Enter from that arbitrary name.
3. A mail-notice `send_command` error consumes the arm. A deferred arm dies at `MSG_NOTIFY_TTL_SECS`. `unread == 0` clears an arm the pane principal cannot see. Pulses still send `Keys` through `deliver_keys`, serialized by the pane lock, not through `GuardedInput`.
4. `input_locks` entries are never removed.
5. Live Alt+Up capture and the moved `test/unit/alt-arrow-sequence.test.ts` have not been run. The ambiguous-tree classifier tests have not been run.

## Stream text input and renderer reservation — source edit, not run

`/ws/tab` text frames `{t:"input"}` now take `axum::Extension<CallerIdentity>` (the same middleware insert the binary pane socket already uses). `authorize_drive` must be `Allow` or the frame is an error and is not written. `NeedConsent`, `SoftWall`, `Denied`, and `RefuseHome` do not raise a consent prompt and do not queue `Keys`. An allowed frame takes `lock_input` for that pane, then `send_command` `Keys`, matching the binary pane path. The binary handler itself was not edited.

`enqueueOrWrite` returns before interrupt, the human-activity queue, and `session.write` when `inputAttempts` holds the uid. The text is not queued. The reply does not contain `queued`, so `deliver_keys` will not glue an Enter onto a queue entry that was never stored. `drainQueues` leaves an existing human-activity queue in place while that reservation holds and keeps the drain timer. The `GuardedInput` case was not edited.

Not executed. Not a runtime fix until the external run.

## Final source verdict (not a runtime fix)

Reviewed this turn, not executed: `Bridge::lock_input` / `guarded_input` / `deliver_keys` / `type_and_collect` (`sidecar/src/bridge.rs`), mail notice and pulse firing in `idle_monitor_tick`, `delivery_service` worker, `stream.rs` input frames, and `pane_class.rs` ambiguous-tree classification. No tests. The user's external run is still the runtime verdict.

Serialization of the paths that take `lock_input` is sound. The map mutex is dropped before `lock_owned`, and the owned guard is held across `send_command`, so the 150ms settle and Enter finish before the next locker for that pane runs. `guarded_input` (worker input and mail notices), `deliver_keys` (pulses and other legacy sends), and `type_and_collect` all take it. A mail notice and a same-tick pulse no longer interleave bytes: the notice's `GuardedInput` await includes the renderer settle, then the pulse's `deliver_keys` acquires the same pane lock. Nothing in those functions re-enters `lock_input` while holding it, so this task does not deadlock itself. `post_type` and `post_type_and_collect` go through `delivery_service::submit_input` → `guarded_input`, not a second writer.

Classifier fail-closed matches the last edit. More than one child sets `ambiguous` and stores no foreground name. `classification_for` copies the flag. An ambiguous tree is an agent only when integration is `running` or `busy` and the app name and argv0 basename are the same agent token. `echo codex`, a name/argv0 disagreement, idle integration, and no integration are not an agent and are not `ShellPrompt`. A single-child chain is still that leaf. Those tests are in the file and have not been run.

Concrete blockers:

1. Tab text input and renderer `Keys` reservation are edited in source (section above) and not run. The binary pane frame was already locked and was left as it was.
2. A `send_command` of `Keys` that still skips `lock_input` would depend on the renderer reservation alone. The tab text path now takes the lock before it sends.
3. `type_and_collect` holds the pane lock for the whole quiet-collect, up to about 8s plus the nudge window, not only for the write. Stream input and mail notices for that pane wait. Ordering stays correct. The pane is stalled for that long.
4. `pane_is_tui` and `process.rs::deepest_child` still take `children[0]` when a process has several children. That does not make `classification_for` call the child an agent. It can still choose bracketed paste versus a glued Enter for `deliver_keys` from an arbitrary child name.
5. Mail-notice gaps from the previous review are still in the source: a `send_command` error consumes the arm, a deferred arm dies at `MSG_NOTIFY_TTL_SECS`, and `unread == 0` consumes the arm when the pane principal cannot see an agent-addressed envelope. Pulses still use `Keys` inside `deliver_keys`, not `GuardedInput`. They are serialized with notices, not focus-checked by the renderer helper.

`input_locks` entries are never removed. That grows with pane ids. It is not an ordering bug.

## Source verdict — mail notice and GuardedInput

Reviewed, not executed: `idle_monitor_tick` mail block (`sidecar/src/bridge.rs` around 1180–1225), `app/guarded-input.ts`, `app/bridge.ts` `GuardedInput` (392–427). No tests this turn.

The main path matches the contract. A pending notice is sent only when `classification_for` returns `NoticeDisposition::Arm`. The count is `messaging::unread_for_pane`. The bytes go out as `GuardedInput` with `agent: true` and `submit: true`, so the renderer bracket-pastes the fixed notice and then sends Enter after 150ms. `submitted` and `indeterminate` clear that arm (`armed_at` must still match, so a newer arm survives). `deferred` and `failed` leave it pending. Unread 0 clears the arm without typing. `GuardedInput` writes nothing when the human is protected or the pane pid changed, withholds Enter if focus arrives after the body, and does not queue or replay inside the renderer.

Remaining gaps:

1. A `send_command` error (Electron disconnected, dropped channel, 10s timeout) takes the same branch as an unknown body and sets `consumed = true`. That drops the arm even when nothing was written. A later message can arm again. This one will not retry.
2. `msg_notify` retain keeps an entry only while `armed_at` is under `MSG_NOTIFY_TTL_SECS` (1h). A notice that stays deferred because the human is in the pane is deleted when the hour ends. The mailbox row remains. The hint does not.
3. `unread == 0` clears the arm. `unread_for_pane` uses the bound agent principal, or `Principal::Pane` when unbound. A canonical envelope addressed to the agent is invisible to the pane principal, so a missing binding reports 0 and the notice is discarded while the mail is still unread.
4. Sidecar `Arm` and renderer `protected()` are not one predicate. The sidecar uses focused-window plus `pane_active` plus OS `app_foreground`, and a hardcoded 15s typing window. The renderer uses `isUserActive` (lockout config) or `BrowserWindow.isFocused()` plus `tabActive` and `paneActive`. When only the renderer defers, the monitor retries every 2s. When only the sidecar suppresses, nothing is written.
5. The notice is a submitted line, not a side banner. An unfocused working agent receives it without an idle wait, by contract, and can treat it as a turn.
6. Pulses in the same tick still use `deliver_keys` and `is_agent_pane` (`contains("node")` / `contains("pi")`). They are not `GuardedInput`. A pulse already queued for that pane skips the notice for that tick only; the arm stays.
7. `observe_process` now fail-closes an ambiguous tree instead of picking a child. `process.rs::deepest_child` still picks `children[0]` for `pane_is_tui`. OSC 133 `C` still drops `app` until the next 697, so a just-started agent can look `ShellBusy` for that gap.
8. Keyboard live capture is still not run. The test-file move into `test/unit` is untested.

## Not in this change

Routes, MCP tool text, `terminal_run` gate, ghost registry, `post_type_and_collect`, mailbox ACL, `app/index.ts`, `lib/index.tsx`, permissions bus, consent UI. The mail-notice block above is root's integration; this review does not patch it.
