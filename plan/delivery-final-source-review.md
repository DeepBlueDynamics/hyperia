# Final Delivery, Messaging & Root Integration Focused Source Review

**Reviewer**: Anti Gravity (`nemesis8/n8-amber-zebra`, hosted in Electrical Aardvark pane `ab4ef982-e0b8-4696-9a60-4321876e5300`)  
**Scope**: Focused source-level review of latest `delivery_service.rs` revisions (completion/prompt retry outboxes, replay semantics, HTTP status alignment) and root wiring per coordinator directive.  
**Status**: *Source-inspection only. Zero in-container builds or tests were run per user mandate.* Runtime compilation and test execution remain separate and await user external run on the host.

---

## 1. Concrete Evaluation of Latest `delivery_service.rs` Revisions

### A. Completion Retry Outbox (`COMPLETIONS`)
- **Source**: [`sidecar/src/delivery_service.rs#L13`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L13), [`L272-L274`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L272-L274), [`L278-L283`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L278-L283), [`L287-L292`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L287-L292)
- **Mechanism**:
  - `finish()` captures any `store.complete` persistence error into `COMPLETIONS: Mutex<Vec<(String, State, Value)>>`, ensuring that a definitive transport outcome (such as `Submitted` or `Failed`) is not lost if the local metadata write fails.
  - `delivery_service::status()` inspects `COMPLETIONS` and annotates the returned operation with `"completion_pending": { "state": state, "outcome": outcome }`. The caller receives the definitive terminal outcome immediately rather than seeing a stuck `Submitting` state.
  - Background `tick()` takes entries from `COMPLETIONS` and retries `store.complete(&id, state, outcome)`. Failed writes are re-queued.
- **Critical Invariant**:
  - **Zero Transport Replay**: The outbox retries *only* `DeliveryStore::complete` metadata persistence. PTY keystrokes and mailbox appends are never re-dispatched.
  - **Staged Safety**: In `delivery.rs`, in-memory state is only mutated when snapshot write succeeds. Until persisted, `op.state` remains `Submitting`, so retry transitions succeed cleanly once disk I/O recovers.

### B. Prompt Notification Retry Outbox (`PROMPTS`)
- **Source**: [`sidecar/src/delivery_service.rs#L14`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L14), [`L137-L144`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L137-L144), [`L293-L298`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L293-L298)
- **Mechanism**:
  - In `retain()`, if `bridge.notify(prompt)` fails (e.g. Electron UI disconnected), the service no longer returns a 503 error that conceals the already-persisted operation.
  - Instead, the prompt is placed into `PROMPTS: Mutex<Vec<(String, Value)>>`, and the operation is returned with `"notification_pending": true` and HTTP 202 Accepted.
  - Background `tick()` retries `bridge.notify` for any prompt whose permission request is still active in `perms`. Completed or cancelled requests are pruned.
- **Critical Invariant**:
  - Callers receive their durable operation ID even during transient UI disconnects; unkeyed duplicate attempts are avoided.

### C. Idempotent Replay Semantics (`replay` & `find_by_key`)
- **Source**: [`sidecar/src/delivery_service.rs#L82-L92`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L82-L92), [`L154`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L154), [`L182`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L182), [`L232`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L232), [`sidecar/src/delivery.rs#L342-L360`](file:///workspace/hyperia/sidecar/src/delivery.rs#L342-L360)
- **Mechanism**:
  - `replay()` runs under `WORKFLOW` lock at the very start of `send_mail`, `submit_input`, and `raw_keys` **before** any `recently_denied` cooldown evaluation or classification gates.
  - Queries `store.find_by_key(&sender.requester, key)`, enforcing exact caller isolation (no cross-agent key collision).
  - Validates that `op.kind == kind` and `op.payload["request"] == original`. Conflicting parameters return HTTP 409 Conflict.
  - Matching operations return the existing `Operation` record directly.
- **Critical Invariant**:
  - Replaying a previously denied operation returns the existing `Denied` record honestly rather than receiving a false `403 Forbidden` from denial cooldown.

### D. HTTP Status Code Alignment & Response Hygiene
- **Source**: [`sidecar/src/delivery_service.rs#L71-L80`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L71-L80)
- **Mechanism**:
  - `response(op)` evaluates `op.state.is_active()`:
    - Active operations (`AwaitingApproval`, `Queued`, `Submitting`) -> **HTTP 202 Accepted**.
    - Terminal operations (`Submitted`, `Failed`, `Denied`, `Expired`, `Cancelled`, `Indeterminate`) -> **HTTP 200 OK**.
  - Applied consistently across `send_mail`, `pane_send`, `terminal_run`, and `status`.
  - Removed misleading `"acknowledged": false` field from responses (read receipts remain the separate authority).

### E. Target-Exact Pending Consent Association
- **Source**: [`sidecar/src/delivery_service.rs#L115-L118`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L115-L118), [`sidecar/src/perms.rs#L301-L304`](file:///workspace/hyperia/sidecar/src/perms.rs#L301-L304)
- **Mechanism**:
  - `retain()` calls `bridge.perms().pending_action_target(&sender.requester, action, target)`.
  - Strictly matches `r.requester == requester && r.action == action && r.target_pane == target`.
  - Prevents prompt collisions and split consent IDs when a requester issues same-action requests across multiple panes.

### F. Worker Queue Validation & Deadlock Prevention
- **Source**: [`sidecar/src/delivery_service.rs#L301-L313`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L301-L313), [`L332-L335`](file:///workspace/hyperia/sidecar/src/delivery_service.rs#L332-L335)
- **Mechanism**:
  - `tick()` checks `queued.kind` against `"mail" | "pane" | "shell" | "keys"`.
  - Unknown kinds are claimed and failed cleanly (`State::Failed`).
  - Corrupted or unparseable payloads transition to `State::Failed` post-claim, preventing operations from getting stuck in `Queued` forever.

---

## 2. Stream API & Scope Source Review (`sidecar/src/stream.rs`)

### A. `[RESOLVED]` Prior Finding `FINDING-ROOT-01`
- Platypus successfully wired `axum::Extension(caller)` into `tab_handler` and `tab_loop`, added `bridge.authorize_drive(&caller, &uid).await`, and acquired the per-pane input transaction mutex `bridge.lock_input(&uid).await`.

### B. `[NEW FINDING: STREAM-01]` Anonymous Stream Input Unconditionally Blocked Even Under `enforce_off`
- **Location**: [`sidecar/src/stream.rs#L316`](file:///workspace/hyperia/sidecar/src/stream.rs#L316) (in `pane_raw_loop`) and [`sidecar/src/stream.rs#L685`](file:///workspace/hyperia/sidecar/src/stream.rs#L685) (in `tab_loop`).
- **Mechanism**:
  ```rust
  if caller.is_anonymous() || !matches!(bridge.authorize_drive(&caller, &uid).await, crate::perms::AuthDecision::Allow) {
      let _ = send_text(&mut tx, json!({"t":"error","error":"Terminal-control permission required for stream input."}).to_string()).await;
      continue;
  }
  ```
- **Defect Analysis**:
  - When enforcement is disabled (`enforce: false` / `post_perm_enforce` off), `bridge.authorize_drive` explicitly returns `AuthDecision::Allow` (see [`sidecar/src/bridge.rs#L433-L435`](file:///workspace/hyperia/sidecar/src/bridge.rs#L433-L435)).
  - However, because `caller.is_anonymous()` is short-circuited with `||`, an anonymous caller (e.g. browser viewing the 3D terminal monitor without bearer tokens) is **unconditionally rejected with `"Terminal-control permission required for stream input."`**, completely ignoring the master enforcement switch.
  - When enforcement IS enabled (`enforce: true`), `bridge.authorize_drive(&CallerIdentity::Anonymous, &uid).await` already evaluates to `AuthDecision::SoftWall` ([`bridge.rs#L444`](file:///workspace/hyperia/sidecar/src/bridge.rs#L444)). Because `SoftWall != Allow`, `!matches!(..., AuthDecision::Allow)` is ALREADY true for anonymous callers when enforced.
  - The prepended `caller.is_anonymous() ||` is completely redundant under enforcement, and actively breaks `enforce_off`.
- **Recommended Fix**:
  In both `pane_raw_loop` and `tab_loop`, remove `caller.is_anonymous() ||`:
  ```rust
  if !matches!(bridge.authorize_drive(&caller, &uid).await, crate::perms::AuthDecision::Allow) {
  ```
  This restores honest `enforce_off` behavior while maintaining strict authentication when enforcement is turned on.

### C. `[VERIFIED]` Tab Scope Input Restriction
- **Location**: [`sidecar/src/stream.rs#L667-L681`](file:///workspace/hyperia/sidecar/src/stream.rs#L667-L681)
- **Mechanism**:
  - Prior implementation looked up `pid` globally across all sessions, allowing a connection on `/ws/tab/A` to inject input into a pane residing on tab B.
  - Platypus's fix filters `sessions` strictly by `session.root_tab_uid == tab_uid && (u.as_str() == pid || u.starts_with(pid))`.
  - Exact slice match `[one]` guarantees that ambiguous prefixes or non-existent panes fail fast with an informative error: `"Tab input pane id must match exactly one pane."`.
  - Keystrokes are serialized through `bridge.lock_input(&uid)`.
  - Tab-level grants (`scope: "tab"`) correctly allow driving all panes in that tab via `caller_has_grant` matching against `target_tab`.

### D. `[VERIFIED]` Delivery Consent Store Exact Lookup Landing
- All speculative and duplicate helper APIs (`check_consent`, `expire_for_consent`, `is_consent_live`, `operations_for_consent`, and `ConsentStatus`) have been removed from [`sidecar/src/delivery.rs`](file:///workspace/hyperia/sidecar/src/delivery.rs).
- `DeliveryStore::consent_operations(&self, consent_id: &str, requester: &str) -> Result<Vec<Operation>, DeliveryError>` strictly enforces exact requester matching (`op.consent_id.as_deref() == Some(consent_id) && op.requester == requester`) with zero wildcard bypass (no `requester == "system"`).
- `delivery_service::consent_operations` is published as the authorized service wrapper, while `store()` remains private to `delivery_service`. Unit tests lock this exact isolation contract.

---

## 3. Truth in Reporting & Verification Status (Rule 6)

### Verified Historical Test Evidence (Run in Container before Ban)
- `msgbus` (18 unit tests): Passed at `2026-09-23T12:27:36Z`.
- `message_acl_tests` (prior 3 tests): Passed at `2026-09-23T12:42:23Z`.
- `permissions-bus.test.ts` (1 test): Passed at `2026-09-23T12:42:40Z`.
- `alt-arrow-sequence.test.ts` (9 tests): Passed at `2026-09-23T12:43:06Z`.
- `guarded-input.test.ts` (5 tests): Passed at `2026-09-23T12:47:55Z`.

### Untested Recent Code Changes (Source-Inspected Only — Awaiting External Run)
- `sidecar/src/delivery.rs`: `find_by_key` method and `test_find_by_key_exact_requester_only` unit test.
- `sidecar/src/delivery_service.rs`: `COMPLETIONS` / `PROMPTS` outboxes, `replay()` semantics, HTTP 202/200 mapping, and `pending_action_target` integration.
- `sidecar/src/perms.rs`: `pending_action_target` method.
- `sidecar/src/main.rs`: `post_terminal_keys` endpoint (`/api/terminal/keys`) routing.

---

## 4. User External Validation Commands

The full test suite is prepared for execution on the host:

```bash
# 1. Rust Sidecar Build Check & Unit Tests
cd sidecar
cargo check --no-default-features
cargo test --no-default-features msgbus
cargo test --no-default-features message_acl_tests
cargo test --no-default-features delivery

# 2. Node / AVA Test Suites
npx ava test/unit/permissions-bus.test.ts
npx ava test/unit/guarded-input.test.ts
npx ava test/unit/alt-arrow-sequence.test.ts
```

---

## 5. Final Source Review Verdict (Area Handoff)

### Area: Delivery Store & Service Support (`sidecar/src/delivery.rs`, `sidecar/src/delivery_service.rs` wrapper)
**VERDICT: READY FOR EXTERNAL VALIDATION**

### Verified Invariants in Delivery Area:
1. **Durable Storage & Crash Recovery**: `DeliveryStore` persists operations to atomic snapshots with recovery of interrupted `Submitting` operations to `Indeterminate` and expiration of pending records on reopen.
2. **Deterministic FIFO Execution**: Operations queued for execution are ordered strictly by `(created_ms, id)` ascending.
3. **Exact-Requester Replay Lookup**: `find_by_key(&self, requester: &str, key: &str)` enforces exact `requester` matching before denial cooldown or authorization policies evaluate, ensuring honest idempotent replay across all states.
4. **Minimal Landed Consent Query API**:
   - `DeliveryStore::consent_operations(&self, consent_id: &str, requester: &str) -> Result<Vec<Operation>, DeliveryError>` enforces exact `requester` matching across all states with zero wildcard bypass (no `system` wildcard).
   - Removed all speculative/unused helper APIs (`check_consent`, `expire_for_consent`, `is_consent_live`, `operations_for_consent`, and `ConsentStatus`).
   - Public wrapper `delivery_service::consent_operations` is exposed while `store()` remains private to `delivery_service`.
5. **Fail-Closed Stale Guard Integration**: Confirmed Ermine's landing in `main.rs::post_perm_respond` using `delivery_service::consent_operations`. Store errors fail closed immediately. Stale delivery prompts with 0 queued operations consume the prompt, clear denial cooldowns, emit `PermissionResolved` (`decision: "expired"`), and return `410 GONE` without granting ambient access.
6. **Zero Dependencies & Portability**: Pure `std` error implementation (`std::error::Error` + `Display`) without `thiserror`, and portable fixture paths referencing `CARGO_MANIFEST_DIR`.

### Verified Final Root Changes:
1. **`msg_check` Binding Hint Parity**: `messaging::check` returns `binding_hint` and `binding_required` for unbonded agents matching `inbox` behavior.
2. **Guarded `deliver_keys`**: Legacy `deliver_keys` routes strictly through `guarded_input` with classification verification; obsolete `type_and_collect`, `pane_is_tui`, and screen-tail nudge removed.
3. **Notice Lifecycle & Disconnect Retries**: Pending notices do not TTL-expire (`st.pending` retained); definite pre-send disconnects preserve pending state for reconnect retries, while indeterminate outcomes consume the notice to prevent blind replaying.
4. **Orphan Lock Protection**: Pruning of orphaned input mutexes retains any lock with `Arc::strong_count(lock) > 1`, protecting active in-flight transactions.
5. **Schema 2 Identity Migration**: Schema version 2 migration verified in `perms.rs`, upgrading legacy display labels to canonical principal keys.

### Non-Claim Disclaimer (Rule 6):
*Zero in-container builds or tests were run. No claim of runtime execution or compilation success is made. Readiness is source-inspected only and awaits the user's external validation on the host.*


