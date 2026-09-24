# Message bus ACL research

Status: preliminary source review; requested swarm scan is pending pane access. No implementation changes or tests run.

## Verified current behavior

- `sidecar/src/main.rs:2577` accepts a pane address or a free-form recipient label, then records the message immediately. No authorization gate is called by this handler. `identity_mw` at line 1494 resolves identity and audits; it does not authorize messaging.
- `sidecar/src/main.rs:2627` lists the caller's inbox, newest first, optionally unread only. Fetching does not mark messages read.
- `sidecar/src/main.rs:2645` records a read receipt for any nonempty message ID without verifying recipient ownership or message existence.
- `sidecar/src/msgbus.rs` stores bodies in `messages.jsonl` and read receipts in `message-reads.jsonl`. Inbox ownership matches display label OR pane ID. Read receipts are keyed by display label. Storage failures are silently ignored; message IDs use millisecond timestamps.
- `sidecar/src/bridge.rs:1108` coalesces notifications, waits for an idle agent pane and cooldown, recomputes unread count, then submits a short notice through `deliver_keys`. Label-only messages do not arm pane notification. Full bodies are fetched separately.
- `sidecar/src/perms.rs` already provides cross-pane grants, denial cooldown, capability grants, and persistence. Messaging needs explicit integration; tool visibility is not access control.

## Approval and tool transport failure

User reports immediately approving the first held terminal_run, but delivery was not confirmed. Follow-up terminal_screen and terminal_status calls stalled. On explicit user-requested retry, terminal_run returned MCP -32602 Invalid request parameters with an empty detail string for both UUID and name addressing. report_bug failed with the same error. A direct HTTP GET /health returned `ok`. Investigate approval continuation, request timeout, and MCP session lifecycle; do not equate pending with delivered. Direct HTTP retry returned 202 pending. The consent log confirms the original request was approved: requester `nemesis8/n8-olive-robin`, request timestamp 1790164709265, allow timestamp 1790164723349 (about 14 seconds later). The current token file resolves to `nemesis8/hyperia`, so the HTTP retry created a different request. Direct `/api/screen` confirms Electrical Aardvark runs Anti Gravity and remained at an empty prompt. Source defect: `post_type_and_collect` at main.rs:1090 returns `enforce_drive`'s 202 without storing the body. `enforce_drive` waits 16 x 500ms; `post_perm_respond` at main.rs:2122 only flushes a previously stored action. Thus approval after that wait cannot deliver this discarded command despite the response promising it is held. Also trace caller identity drift between MCP headers and the current token file.

## Questions to resolve before implementation

1. Which authenticated stable principal owns a mailbox, and how does it map to its current pane after reattachment?
2. What explicit send permission should be enforced for pane and named-agent destinations? Ensure label addressing cannot bypass it.
3. How should inbox/search/read reject anonymous callers and enforce recipient ownership?
4. Replace the notification idle requirement with the requested focus-aware behavior after tracing renderer delivery and active-user protection. Verify safe submission while an agent is working and an unfocused pane is receiving input.
5. Reproduce missing mail across pane-addressed send and actual MCP caller identity; do not assume the display-label mismatch is the sole cause.
6. Decide whether checking mail acknowledges returned messages automatically or retains explicit acknowledgement. Storage format redesign is deferred per the user.

## Swarm work allocation after initial scan

- Electrical Aardvark: initial architecture map and ACL/security integration research, then endpoint authorization implementation.
- Front Ermine: pane/agent identity and inbox/read ownership, with addressing regression cases.
- Grotesque Platypus: notification focus/busy behavior and delivery regression cases.
- Coordinator: review boundaries, integrate changes, run checks, and explain resulting behavior.

The user mentioned Anti Gravity for the first scan; terminal_status currently lists only Electrical Aardvark, Front Ermine, Grotesque Platypus, and the coordinator. Clarification is pending. The initial direct-pane research request to Electrical Aardvark was held by Hyperia for user approval; delivery is not yet verified. The other work allocations above are planned, not delivered assignments.
