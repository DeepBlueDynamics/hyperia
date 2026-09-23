# External validation handoff

Integration is ready for the user's external build and validation. Source edits are frozen for handoff. The user owns builds and tests outside every agent container. All three pane agents recorded source-readiness verdicts for their assigned areas; no agent claims the latest tree built, tested or runtime-fixed. Earlier partial results do not validate this tree.

## Build and automated checks

Run from the repository root in the host environment with project dependencies installed:
- `yarn build` (builds webpack and TypeScript project references; plain `tsc --noEmit` may report TS6305 for newly added app modules until references are built).
- `yarn lint`.
- `yarn test:unit`.
- `yarn ava test/unit/alt-arrow-sequence.test.ts` (included in the default unit-test glob).
- From `sidecar`: `cargo test --no-default-features`.
- Build the sidecar with the host's normal production feature set, including TTS dependencies if enabled.

Commands are supplied for the external run; latest integrated changes have not been built or tested by agents.

## Behavior checks using disposable panes and test identities

1. Mail isolation: anonymous send/inbox/check/read rejected; display-name collisions cannot read another identity's mail; a sender cannot mark a recipient's message read.
2. Verified association: pane credential registration binds automatically. Persistent identity with no binding gets an actionable binding-required result. `pane_bind` with wrong proof rejects; with valid proof binds; without proof human approval applies the retained association. Reattach to a new pane requires renewed proof.
3. Approval before and after the former eight-second timeout: submit one operation, allow once, confirm it reaches exactly the addressed target once. The sender must not need to resend.
4. Two requesters and multiple pending operations for one pane: each prompt and decision stays isolated. Denial or expiry sends nothing. Duplicate decision and same idempotency key never duplicate input; changed payload with the same key conflicts.
5. `pane_send`: working unfocused supported agent receives full input; human-focused pane stays queued; moving focus away releases it. Shell, editor, unknown, dead PID, arbitrary argv like `echo codex`, and stale idle integration refuse agent input.
6. `terminal_run`: verified idle shell only. Agent pane and busy shell refuse. `submit=false` sends no Enter, including after delayed approval.
7. Mail notice: one coalesced short notice, never full message body; no idle-silence requirement for unfocused supported agent. Human focus suppresses; storage failure does not pretend delivery succeeded.
8. `msg_inbox` and `msg_search` leave read state unchanged. `msg_check` acknowledges only returned unread messages; `msg_read` is recipient-only and idempotent.
9. Focus race during body/Enter separation: if human takes focus after text, no stray Enter; operation reports indeterminate and never replays silently.
10. Restart: pending/queued operations expire safely; submitting operations become indeterminate; closed/replaced pane cannot receive stale payload.
11. UI approval failure stays visible. Resolving one request does not dismiss another caller's prompt or bell.
12. System-only consent controls and application WebSocket reject non-system callers; token listing never exposes credentials.
13. Alt+Up/Down emit Alt arrow bytes in the affected agent UI; Ctrl+Up/Down and Alt+Left/Right behavior remain intact. Check actual host platform and keyboard.

14. Exact terminal control: printable `y`, LF, CR, escape sequences and `interrupt` through MCP and Ghost preserve the requested bytes, add no Enter, and require drive permission.
15. Storage fault after transport acceptance: completion metadata retries without another PTY write; status exposes the pending known outcome. Restart recovers uncertainty conservatively.
16. Disconnect Electron before submission: retained operation ID is returned with a notification warning; reconnect delivers the approval prompt; Allow releases the same operation once.
17. Expired delivery prompts do not grant future access; explicit access requests and retained operations share the same authenticated principal.
18. Maximum-length Unicode bodies, repeated idempotency keys after denial, and changed bodies under a reused key preserve size/isolation/replay contracts.
19. Fresh and reused MCP sessions load the new tool schema without the observed `-32602` connector failure.

20. Permission migration: preserve pane tokens and unambiguous grants; registered names such as `codex` and `agent:codex` must never inherit one another's legacy grants. Restart twice to confirm schema migration is not applied again.

21. Internal pulses/callbacks use guarded input: focused human pane receives no stray text or Enter; ambiguous foregrounds refuse; no screen-text-based extra Enter is emitted. Pending mail notices survive a long focus delay and a known pre-send disconnection. Closed-pane lock entries disappear only after active writers/waiters finish.

## Agent agreement

After external results arrive, Electrical Aardvark, Front Ermine, Grotesque Platypus, and coordinator each review the final changes and results. Record PASS / FAIL / NOT TESTED per assigned area. Any failure or missing required live check keeps the corresponding claim open.
