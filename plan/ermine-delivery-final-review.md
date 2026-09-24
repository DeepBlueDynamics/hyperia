# Delivery integration final source verdict

Scope: `sidecar/src/delivery_service.rs`, `sidecar/src/main.rs` retained-operation/approval wiring, `sidecar/src/delivery.rs`, and the direct permission/transport call sites needed to evaluate findings 1–9. Source review only. Per user instruction, no build, test, or runtime scenario was run.

## Corrections retained

- `Submitting -> Indeterminate` is required for a focus race where text may have been written but Enter was withheld; such operations must not be replayed.
- `std::fs::rename(temp, existing)` replacement behavior was not a valid blocker.

## Findings 1–9

| # | Source verdict | Evidence |
|---|---|---|
| 1 | Addressed | `delivery_service::retain` uses `PermStore::pending_action_target`; the lookup matches requester, action, and target in one predicate. |
| 2 | Addressed | MCP and Ghost route `terminal_keys` to `/api/terminal/keys`; `main::post_terminal_keys` always calls `delivery_service::raw_keys`, preserving the explicit control-input path rather than inferring intent from printable content. |
| 3 | Addressed | Failed `DeliveryStore::complete` writes enter the process-local `COMPLETIONS` metadata outbox. `tick` retries only `complete(id, state, outcome)` and never repeats transport; `delivery_status` exposes `completion_pending`. |
| 4 | Addressed | Notification failure retains the operation response with its ID and `notification_pending` warning, while `PROMPTS` retries the prompt only while the permission request remains pending. |
| 5 | Addressed | `send_mail`, `submit_input`, and `raw_keys` perform exact requester/key replay before current denial and authorization policy. Conflicting kind, metadata, or content returns conflict. |
| 6 | Addressed | Response mapping returns HTTP 202 for active operations and HTTP 200 for terminal operations across the retained endpoints and compatibility wrapper. |
| 7 | Addressed in `main.rs` | `post_perm_respond` first performs the exact, fallible `consent_operations(consent_id, requester)` inspection, then uses `resolve_approval` as the expiry authority. Inspection or resolution errors return before any grant. An Allow for a delivery-linked prompt with no resolved `Queued` operation consumes the stale permission request without granting, clears the synthetic denial cooldown, records `expired`, emits `PermissionResolved` to clear the UI, and returns 410 with the observed operation rows. An explicit access prompt has no linked rows and keeps its existing grant path. |
| 8 | Addressed — owner verdict READY | `CallerIdentity::principal_key()` is the sole live ledger key (`agent:<name>`, `pane:<uid>`, or `system`) across drive, create, capability, owner, held-create, bind consent, messaging, retained operations, and approval resolution; `label()` remains display-only. `perms.json` schema 2 performs a one-time registry-backed cutover of owners, grants, create grants, and capability grants, drops ambiguous or unregistered requester rows, deduplicates migrated entries, persists schema 2, and does not reinterpret schema-2 rows. Bind approval requires the exact `agent:<name>` requester. `grant_allows` receives the canonical requester by reference. Platypus independently recorded `READY FOR EXTERNAL VALIDATION` in `plan/platypus-implementation-status.md`. |
| 9 | Addressed | `request_metadata` removes `body`/`text`; the typed payload stores content once. `replay_matches` compares the separate stored content plus kind and remaining request metadata, avoiding the 128 KiB duplication regression. |

## Other reviewed findings

- Malformed non-mail payloads are claimed and completed `Failed`; they no longer remain queued forever.
- Unknown operation kinds are claimed and completed `Failed`; they are not interpreted as input payloads.
- The unsupported `acknowledged: false` response claim was removed.
- Approval inspection and resolution execute under `delivery_service::WORKFLOW`; the stale guard fails closed before `PermStore::respond` can create a grant.
- Completion retries persist metadata only. Transport is not replayed after a claimed operation.

## Current verdict

**READY FOR EXTERNAL VALIDATION.** Findings 1–9 are addressed in source. Platypus's independent finding-8 owner verdict and Aardvark's final delivery/root review are also READY FOR EXTERNAL VALIDATION. This review found no new concrete source blocker.

Root's later cleanup and notice changes are covered by Aardvark's source verdict: legacy bridge collection/nudge helpers were removed, `deliver_keys` uses the guarded input path, and pending notices survive focus deferral and definite pre-send disconnect.

No runtime-fixed claim is made. External build/test/runtime validation remains user-owned.
