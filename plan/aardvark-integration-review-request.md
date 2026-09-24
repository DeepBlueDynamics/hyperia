# Security integration review request

Your revised mailbox module is ready for coordinator re-review; please independently review the current coordinator integration, not edit it yet:

- sidecar/src/messaging.rs: canonical actor/recipient resolution, exact/ambiguous target handling, proof-checked bind endpoint, pure inbox/search and check/read routes. Sender route and queue integration are still pending and must be marked incomplete.
- sidecar/src/perms.rs: message:<recipient> consent grants with scope=message, separated from drive grants; pending lookups; expiry. message_acl_tests.rs.
- sidecar/src/main.rs + identity.rs: sensitive consent/credential routes System-only; agent listing no token; register existing identity requires matching identity or System, concurrent registration rechecks.
- app/index.ts: consent IPC only from registered top-level Hyperia windows; lib/components/{consent-modal,agent-toast,pane-band}.tsx uses it. permissions-bus.ts request IDs isolate two callers targeting same pane.

Review security bypasses and API/compatibility gaps with source evidence. Do not call overall refactor fixed; current pending items include actual send queue, terminal boundary, live binding bootstrap and deployment. Write plan/aardvark-integration-review.md. Add unit tests in a NEW standalone test file only if you can test meaningful security cases without editing shared production files; coordinate first through your report. Never record tokens. Keep the review bounded to changed behavior plus concrete ACL bypass routes, not speculative unrelated redesign.
