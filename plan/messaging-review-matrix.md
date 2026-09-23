# Messaging refactor review matrix

Source review is distinct from runtime validation. User owns all builds/tests outside agent containers. Latest integrated tree has not been built or tested.

| Area | Owner / reviewer | Current evidence |
| --- | --- | --- |
| Mail principals, binding, receipts, durable operation store | Electrical Aardvark / Anti Gravity | READY FOR EXTERNAL VALIDATION in plan/delivery-final-source-review.md; runtime not tested. |
| Approval retention, expiry, idempotency, outcome reporting | Front Ermine + coordinator | Ermine marks owned findings 1–7 and 9 READY FOR EXTERNAL VALIDATION; Platypus separately marks finding 8 ready. Runtime not tested. |
| Shell vs agent classification, Alt arrows, stream authorization, writer serialization | Grotesque Platypus + coordinator | Platypus source readiness recorded. Coordinator additionally rejects anonymous stream writers, restricts tab targets, removes legacy nudge/collection paths, and routes internal pulses through guarded input. Aardvark independently reviewed final cleanup. Live checks pending. |
| Canonical permission requester and persisted grant cutover | Grotesque Platypus | READY FOR EXTERNAL VALIDATION in plan/platypus-implementation-status.md. Schema-2 migration invalidates ambiguous legacy grants. Runtime not tested. |
| MCP/Ghost tools and integration | Coordinator | Explicit terminal/keys route; pane_send and shell-only terminal_run; retained operation status. Fresh/reused connector sessions require external validation. |
| Full build, unit suites, live approval/focus/Alt+Up | User | NOT RUN on latest tree. Checklist: plan/external-messaging-validation.md. |

Assigned source blockers are addressed; coordinator marks integration ready for external validation and freezes source edits. Final runtime-fixed agreement awaits the user's external results. Earlier partial tests do not validate this tree.
