# Messaging and delivery refactor

## Validation ownership update

The user will build and test externally, outside all agent containers. Agents continue implementation and source review, but start no further container builds/tests. Earlier completed test results remain historical evidence only. Supply an external validation checklist; final agreement about fixed behavior depends on the user's results against the completed changes.


Status: implementation plan under shared review. Aardvark and Ermine have submitted research; their isolated mailbox and delivery modules are assigned. Platypus is tracing tool boundaries and Alt+Up. No implementation is claimed complete.

Coordinator decisions: `pane_send` delivers agent input; `msg_send` retains inbox mail. They share canonical identity/ACL and delivery infrastructure but expose different intent. Inbox/search are pure; an explicit check operation may acknowledge only returned messages. Pending operation state receives separate durable JSON persistence without replacing the user's existing mail JSONL format. Ermine owns requester-scoped idempotency for pending delivery. After a crash, uncertain submission is `indeterminate` and is never blindly replayed. See the per-agent implementation contracts for exact boundaries.

Transport diagnostic: existing conversation MCP connector returned -32602; a fresh MCP initialize/initialized/tools-call session using current identity successfully called terminal_status against the same running server. This bounds the failure to the old connection/session or client transport, not terminal_status's request schema. Baseline `cargo test --no-default-features msgbus::tests` passed all six tests; these do not cover the identified security/delivery failures.

## Outcomes

1. Approving a pending operation performs that operation automatically, exactly once within the running delivery service. A timeout never discards it while claiming it is held.
2. Agent messaging has an explicit API separate from shell command execution. `terminal_run` accepts only a positively identified shell at its command prompt. Busy shells, agent TUIs, other foreground programs, and unknown targets return an actionable refusal without sending input.
3. `pane_send` addresses an agent explicitly, authenticates the sender, checks a message-specific ACL, queues for approval if needed, and returns a message/delivery identifier plus an honest state. Whether full input delivery or inbox notification is desired is under review; do not equate storage, input submission, and recipient acknowledgement.
4. Inbox, search, and acknowledgement use the same authenticated mailbox identity and cannot read or acknowledge another recipient's mail through display-name collisions or arbitrary pane arguments.
5. A nonfocused agent can receive the intended message/notification while working. Human input focus remains protected. Sending never changes focus.
6. Alt+Up reaches the intended recipient when it is not a documented Hyperia shortcut. Reproduce and identify the swallowing layer before changing key encoding.
7. Every reviewer independently checks the result against the acceptance matrix below. Any failing or untested required criterion keeps the refactor incomplete.

## Verified starting defects

- `sidecar/src/main.rs` message handlers record and fetch with display-label/pane matching and no message ACL; mark-read does not verify ownership or existence.
- `sidecar/src/msgbus.rs` separates bodies and read receipts into append-only JSONL, matches recipient label OR pane ID, keys receipts by label, derives IDs from millisecond time, and suppresses write failures.
- `post_type_and_collect` returns pending approval without retaining its body. The approval response promises retention and auto-delivery. `enforce_drive` waits eight seconds before returning pending. The approval log for the observed failure records allow after that interval.
- `post_type` stores pending input only after the wait; the handoff can race approval. Held input is keyed only by target pane and overwrites earlier input. Approval drains by target, not original requester.
- Notification candidates require idle state in `bridge.rs`; full message persistence and notification delivery are distinct.
- Original MCP caller and fresh local token resolved to different agent names. MCP subsequently returned -32602 even for status and report_bug, while HTTP health/screen worked. Root cause remains open.
- Windows default keymap has no Alt+Up binding; `term.tsx` intercepts Alt+Left/Right, not Alt+Up. This does not yet establish why Alt+Up fails in the user's pane.

## Work packages and ownership

### Electrical Aardvark — identity, messaging, ACLs

Produce the architecture report first. Define stable sender/recipient keys, authenticated agent-to-pane association, recipient resolution, message permission scopes, and migration behavior for existing mail. Implement the message service/API and authorization once the shared contract is agreed. Labels are presentation, not authority. Explicitly reject anonymous and ambiguous addresses. Neither aliasing nor pane IDs may bypass the recipient ACL.

### Front Ermine — approval and delivery lifecycle

Design and implement operation records that exist before consent can resolve. Key pending actions by request/operation and requester plus destination, never destination alone. Preserve validated payload, attribution, submission intent, and destination type. Approval atomically claims the matching action; denial/cancellation/expiry cannot execute it. Both immediate and delayed approval use the same delivery path. Return truthful states; avoid promising automatic delivery if no operation was retained. Include race and cross-caller tests.

### Grotesque Platypus — input boundaries and keyboard/focus

Define the terminal/agent classification contract and enforce `terminal_run` shell-only behavior. Implement agent `pane_send` integration with the message service rather than duplicating authorization. Replace the notification idle gate with the agreed focus-aware policy. Trace Alt+Up from DOM/xterm through PTY/container to the agent, reproduce it, and fix the verified layer. Update affected tool descriptions and tests.

### Coordinator — integration, persistence, compatibility, validation

Resolve shared contracts before overlapping file edits. Extract cohesive services from main.rs/mcp.rs/bridge.rs where useful; keep HTTP, MCP, and renderer consumers consistent. Validate migration and error reporting, run checks, review each implementation, and collect independent final verdicts. Investigate MCP session/header failure separately from the authorization queue; do not paper it over with retries.

## Shared design constraints

- Separate message content from delivery state and read acknowledgement. Proposed states: awaiting_approval, queued, submitted, failed, denied, expired; read acknowledgement is a separate recipient event. Define precisely what each transport can prove.
- Use collision-resistant operation/message IDs and explicit idempotency keys. Test concurrent sends and retries. Do not claim end-to-end exactly-once execution across a crash without receiver deduplication; preserve an indeterminate state when delivery cannot be established.
- Persist pending messages/approvals when promised durable; on restart reconcile authorization and target identity without replaying input blindly into a replacement shell or agent.
- Existing two-file JSONL format is not automatically replaced: the user deferred the storage-format decision. The refactor must provide reliable read state, locking/serialization, error propagation, and a migration path; reviewers must explain whether the current layout can support the chosen guarantees.
- Decide whether inbox fetch auto-acknowledges or an explicit check/ack operation does. A plain search must not silently mark messages handled. Acknowledge only messages actually returned/handled under the final API contract.
- Generic terminal input must not provide a messaging ACL bypass. Document intentional low-level input capabilities separately and enforce their own permissions.
- Keep ordinary terminal command output collection separate from agent message acceptance and delivery status.
- Avoid concurrent edits to the same sections: publish owned files/regions before implementation. Preserve unrelated existing changes.

## Acceptance matrix

| Area | Required evidence |
|---|---|
| Approval | Fast allow, allow after timeout, deny, cancel, expiry; command retained before prompt; exactly one submission |
| Isolation | Two callers targeting one pane cannot overwrite, approve, drain, or acknowledge each other's operations |
| Retries | Duplicate idempotency key does not duplicate send; failures retain accurate retry/unknown state |
| Identity | Pane and registered-agent addressing resolve to one mailbox; rename/reattach tests; unknown, ambiguous, anonymous, forged recipient rejected |
| ACL | Allowed and denied sends, label alias bypass, revoked grants, self-mail behavior, inbox/search/read ownership |
| Read state | Correct unread counts; ack only recipient's existing message; repeat ack idempotent; state survives restart |
| Storage | Concurrent long messages, ID uniqueness, write failures surfaced, existing-data compatibility |
| Tool boundary | terminal_run executes at idle shell; refuses busy shell, agent/TUI, unknown target without injecting bytes |
| Agent delivery | pane_send reaches agent through shared authorized path; does not execute agent prose at shell prompt |
| Focus | Busy unfocused agent receives intended notification/input; focused human input protected; no focus stealing |
| Keyboard | Alt+Up reproduced and fixed at verified layer; modifiers reach target; relevant existing shortcuts retained |
| Transport | MCP session/header failure reproduced or explicitly bounded; identical authorization semantics via HTTP and MCP |
| Integration | Relevant Rust tests and frontend type/lint/tests pass; live approved send reaches addressed agent once |

## Review and release gate

Each agent writes a verdict with commit/diff reviewed, commands run, results, unresolved issues, and criterion-level pass/fail/not-tested. Review another agent's work, not only your own. The coordinator records disagreements and resolves them with code changes or evidence, then requests re-review. Overall status cannot be "fixed" while a required live test or reviewer verdict is missing. Building a patch is distinct from deploying/restarting the user's running Hyperia instance; prepare a concrete tested result before proposing any disruptive restart.
