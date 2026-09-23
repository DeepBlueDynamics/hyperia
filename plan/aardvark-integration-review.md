# Hyperia Coordinator Security Integration Review

**Reviewer**: Anti Gravity (`nemesis8/n8-amber-zebra`, hosted in Electrical Aardvark pane `ab4ef982-e0b8-4696-9a60-4321876e5300`)  
**Scope**: Independent security, ACL, identity, and compatibility review of coordinator integration per [`plan/aardvark-integration-review-request.md`](file:///workspace/hyperia/plan/aardvark-integration-review-request.md)  
**Modules Reviewed**:
- [`sidecar/src/messaging.rs`](file:///workspace/hyperia/sidecar/src/messaging.rs) (actor/target resolution, binding, pure inbox/search, check/read)
- [`sidecar/src/perms.rs`](file:///workspace/hyperia/sidecar/src/perms.rs) & [`sidecar/src/message_acl_tests.rs`](file:///workspace/hyperia/sidecar/src/message_acl_tests.rs) (message and bind consent grants, pending lookups, cooldown, expiry)
- [`sidecar/src/main.rs`](file:///workspace/hyperia/sidecar/src/main.rs) & [`sidecar/src/identity.rs`](file:///workspace/hyperia/sidecar/src/identity.rs) (System-gated permission endpoints, credential redaction, registration concurrency)
- [`app/index.ts`](file:///workspace/hyperia/app/index.ts) & [`lib/permissions-bus.ts`](file:///workspace/hyperia/lib/permissions-bus.ts) (Electron IPC frame origin validation, request ID isolation in permission bus, frontend modal updates)

**Overall Refactor Status**: **INCOMPLETE / PENDING SYSTEM INTEGRATION**  
*The full refactor CANNOT be declared fixed yet.* Specifically:
1. HTTP route `/api/msg/send` remains bound to legacy `post_msg_send`; Ermine's send queue and async delivery pipeline are still pending integration.
2. Terminal control boundaries and PTY input delivery mechanisms remain under active refinement.
3. Automated binding bootstrap and container re-attachment lifecycles are not yet implemented in production runtime.

---

## 1. Executive Summary & Verification Matrix

| Area | Component | Verification / Test Evidence | Finding | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Actor & Target Resolution** | `messaging.rs:58-143` | `resolve_target`, `actor_from_identity` | Fails closed on ambiguity (409 Conflict); strict `Principal` typing; display labels decoupled from authority. | **PASS** |
| **Binding Endpoint Access Control** | `messaging.rs:284-332` | `messaging::bind` | Caller must be System or agent itself; cannot bind another agent; pane token residency verified. | **PASS** |
| **Binding Human Consent Flow** | `messaging.rs:300-328`, `main.rs:2138` | `messaging::approve_binding`, `PermStore::respond` | Handled via `is_bind`; consumes approval into `BindingStore`; grants NO terminal drive permissions. | **PASS** |
| **Binding Bootstrap & Lifecycle** | Container runtime & sidecar | Code inspection (`main.rs`, `bridge.rs`, container env) | **GAP**: No automatic bootstrap; spawned containers start unbound; stale bindings on reattach. | **COMPATIBILITY GAP** |
| **Pure Queries & Acknowledgement** | `messaging.rs:213-264` | `inbox`, `search`, `read`, `check` | Pure read queries; recipient-only acks; check marks `read: true` with process lock durability. | **PASS** |
| **Send Route & Queue Integration** | `main.rs:4584`, `messaging.rs:184` | `post_msg_send` vs `store_approved` | Route still wired to legacy `post_msg_send`; Ermine queue pipeline pending. | **INCOMPLETE (KNOWN)** |
| **Message Consent Isolation** | `perms.rs:311-354` | `message_acl_tests.rs` (3 tests passed) | `scope == "message"`, recipient-scoped; `grants_for` filters out message grants; cannot drive terminal. | **PASS** |
| **Pending & Denial Separation** | `perms.rs:453-496` | `message_acl_tests.rs` | `has_pending` checks `action == "drive"`; message denials do not block drive, and vice versa. | **PASS** |
| **Perms Endpoint Gatekeeping** | `main.rs:1540-1553` | `identity_mw` | `/api/perms/respond`, `/token`, `/enforce` rejected (403) unless `CallerIdentity::System`. | **PASS** |
| **Agent Token Redaction** | `main.rs:1568` | `get_identity_agents` | Token field removed from listing; returns only `name` and `createdMs`. | **PASS** |
| **Identity Registration Protection** | `identity.rs:148-163` | `register` & `post_identity_agent` | Re-registration rejected unless caller presents valid existing token or is System; lock recheck. | **PASS** |
| **IPC Origin Validation** | `app/index.ts:204-223` | `consentFetch` | Restricts consent IPC to top-level `windowSet` main frames; blocks webview/renderer spoofing. | **PASS** |
| **Permission Bus Request Isolation** | `permissions-bus.ts` | `test/unit/permissions-bus.test.ts` (1 AVA passed) | Keyed by `req.id`; multiple concurrent callers to same pane stay isolated. | **PASS** |

---

## 2. Detailed Findings by Module

### 2.1 `sidecar/src/messaging.rs`
1. **Canonical Identity Resolution (`actor_from_identity`)**:
   - `CallerIdentity::Anonymous` returns `401 Unauthorized`.
   - `CallerIdentity::System` resolves to `Principal::System` with `pane: None`.
   - `CallerIdentity::Agent { name }` resolves to `Principal::Agent(name)`. Pane lookup in `store.bindings.pane_for_agent(name)` is validated against `bridge.sessions().await`. If the bound pane has closed or is inactive, `pane` falls back to `None`.
   - `CallerIdentity::Pane { pane }` verifies the pane exists in active sessions. If mapped to an agent in `store.bindings.agent_for_pane(pane)`, it resolves to `Principal::Agent(agent)`; otherwise, it resolves to `Principal::Pane(pane)`.
   - **Assessment: PASS**. Strongly typed principals prevent identity spoofing. Display labels (`label`) are strictly presentation-only.

2. **Target Ambiguity Handling (`resolve_target`)**:
   - Matches candidate active sessions by window, tab, and pane identifier (full UID, >=4 char prefix, or normalized shell name).
   - If 0 candidates: returns `404 Not Found`.
   - If >1 candidates: returns `409 Conflict` ("Ambiguous pane address; use its full pane ID.").
   - **Assessment: PASS**. Fails closed; eliminates cross-pane delivery races.

3. **Proof-Checked Bind Endpoint & Human Consent Flow**:
   - In `messaging::bind`:
     - Caller identity must be `System` or the target agent itself (`req.agent.as_deref().is_none_or(|s| s == name)`). An agent cannot initiate a binding on behalf of another agent.
     - With valid `pane_token` (verified via `perms.pane_for_token`), immediate residency proof is accepted.
     - Invalid `pane_token` returns `403 Forbidden` ("The pane credential is invalid.").
     - Absent `pane_token`:
       - If already bound, returns 200 with `state: "bound"`.
       - Checks denial cooldown via `perms.recently_denied(&caller.label(), &format!("bind:{name}"))`.
       - Checks `pending_action_for`: if pending for this pane, returns existing request; if pending for a different pane, returns `409 Conflict`.
       - If no pending request: creates `PermRequest` with `action: format!("bind:{name}")`, target pane, and fires `PermissionRequest` notification to Electron bridge. Returns 200 with `state: "awaiting_approval"`.
   - In `PermStore::respond` and `main.rs:2138`:
     - `req.action.starts_with("bind:")` is flagged as `is_bind`.
     - `PermStore::respond` sets `key = req.action.clone()` and skips granting terminal drive permissions (`if is_bind { /* no drive access */ }`).
     - `main.rs` intercepts `allow && req.action.starts_with("bind:")` and executes `messaging::approve_binding(&state.bridge, &req)`.
     - `approve_binding` re-validates that the target pane is active, the requester matches, and calls `context()?.bindings.verify_and_bind` with `ProofOfResidency::System`.
   - **Assessment: PASS**. The binding approval pipeline properly validates proof and applies the stored binding without granting terminal drive permissions.

4. **Binding Bootstrap & Lifecycle Analysis (Operational Gap)**:
   - **Issue 1 (No Automatic Bootstrap)**: When an agent container (e.g. n8 container) is spawned or attached to a pane, neither Hyperia nor the container runtime automatically calls `/api/pane/bind-agent`. The agent container boots with an agent token and a pane token, but in an unbound state in `agent-bindings.json`.
   - **Issue 2 (Pane Message Inaccessibility)**: While unbound (`who.pane == None`), if an agent calls `GET /api/msg/inbox`, `messaging::inbox` passes `caller_pane: None` to `mailbox::inbox`. Consequently, any messages sent to `pane:<pane_id>` will NOT be matched or returned to the agent.
   - **Issue 3 (Re-attachment Invalidation)**: If a pane restarts or session reattaches, the old pane UID becomes inactive. `actor_from_identity` clears `pane` to `None` because the old UID is missing from `bridge.sessions()`. The binding store still holds the old UID until explicitly overwritten.
   - **Recommendation**:
     1. Add automated container bootstrap: container startup or n8 harness should immediately issue `POST /api/pane/bind-agent` presenting its pane token.
     2. Alternatively, when `CallerIdentity::Agent` authenticates with both an agent token and a valid pane header/token, Hyperia can auto-bind or lazily associate the active pane during session attachment.

5. **Pure Inbox/Search vs Checked Operations**:
   - `inbox` and `search` are purely read-only queries with zero mutations.
   - `read` invokes `mailbox::acknowledge_message`, strictly enforcing that only the canonical recipient can acknowledge.
   - `check` invokes `mailbox::check_inbox`, which atomically acquires the store lock, fetches unread mail, acknowledges them, and returns them with `read: true`.
   - **Assessment: PASS**.

6. **Send Route & Queue Integration**:
   - `main.rs:4584` still wires `/api/msg/send` to legacy `post_msg_send`.
   - `messaging::prepare` and `messaging::store_approved` are implemented in `messaging.rs` but not yet wired to the public HTTP endpoint.
   - **Assessment: INCOMPLETE (Known pending item awaiting Ermine queue)**.

---

### 2.2 `sidecar/src/perms.rs` & `message_acl_tests.rs`
1. **Consent Isolation (`message:<recipient>` vs `drive`)**:
   - `PermStore::respond` extracts `message_recipient = req.action.strip_prefix("message:")`.
   - Sets `key = req.action.clone()` (e.g. `"message:agent:bob"`), preventing denial or grant leakage into the target pane's drive key.
   - Overrides `scope` to `"message"`.
   - Stores `pane = message_recipient` in the grant.
   - In `grants_for(requester)`: explicitly filters `g.scope != "message"`. Terminal drive authorization queries `grants_for` and `has_grant`, making it impossible for a message consent grant to authorize terminal writes.
   - In `has_message_grant(requester, recipient)`: strictly checks `g.scope == "message" && g.pane == recipient`.
   - **Test Evidence**: Passed `perms::message_acl_tests::message_approval_never_grants_drive_or_another_recipient`.
   - **Assessment: PASS**.

2. **Pending & Denial Separation**:
   - `has_pending`: checks `r.action == "drive"`. A pending message request never blocks or suppresses a drive request.
   - `pending_action_for`: checks exact `requester` and `action`.
   - Denials are recorded under `(requester, req.action)`. A denied message request records a denial for `"message:<recipient>"`, leaving the pane drive permission unaffected.
   - **Test Evidence**: Passed `perms::message_acl_tests::pending_message_does_not_suppress_drive_and_denial_grants_nothing`.
   - **Assessment: PASS**.

3. **Grant Expiration**:
   - `has_message_grant` filters by `g.live(now)`. Expired grants are discarded and return `false`.
   - **Test Evidence**: Passed `perms::message_acl_tests::expired_message_grant_is_rejected`.
   - **Assessment: PASS**.

4. **Identified Gap in `cleanup_pane`**:
   - In `PermStore::cleanup_pane(uid)`:
     ```rust
     self.grants.lock().await.retain(|g| !((g.scope == "pane" || g.scope == "tab") && g.pane == uid));
     ```
   - When a pane closes, `cleanup_pane` removes pane- and tab-scoped drive grants, but does NOT remove `scope == "message"` grants where `g.pane == uid` or `g.pane == "pane:<uid>"`.
   - *Impact*: While runtime session checks in `messaging.rs` prevent delivering to inactive panes, non-expiring message grants for dead panes linger in `perms.json`.
   - *Recommendation*: Update `cleanup_pane` to also prune `(g.scope == "message" && (g.pane == uid || g.pane == format!("pane:{uid}")))`.

---

### 2.3 `sidecar/src/main.rs` & `sidecar/src/identity.rs`
1. **Sensitive Consent & Credential Routes System-Only**:
   - In `identity_mw` (`main.rs:1540-1553`):
     ```rust
     if matches!(path.as_str(), "/api/perms/respond" | "/api/perms/enforce" | "/api/perms/token")
         && !id.is_system()
     {
         crate::audit::record_call(&label, kind, &method, &path, 403);
         return axum::response::IntoResponse::into_response((
             StatusCode::FORBIDDEN,
             Json(serde_json::json!({"ok": false, "error": "This operation requires the Hyperia application."})),
         ));
     }
     ```
   - An agent or pane caller attempting to hit `/api/perms/respond`, `/api/perms/enforce`, or `/api/perms/token` is rejected with `403 Forbidden`.
   - **Assessment: PASS**.

2. **Agent Token Redaction in Agent Listing**:
   - In `get_identity_agents` (`main.rs:1568`):
     ```rust
     let list: Vec<_> = agents
         .iter()
         .map(|a| serde_json::json!({"name": a.name, "createdMs": a.created_ms}))
         .collect();
     ```
   - Eliminates the previous credential leakage where all agent bearer tokens were broadcast in plaintext to unauthenticated callers.
   - **Assessment: PASS**.

3. **Identity Registration & Credential Retrieval Protection**:
   - In `IdentityStore::register` (`identity.rs:148-163`):
     - If the agent name already exists: returns the existing record only if `may_retrieve` is true; otherwise returns `Err("Identity already exists; present its credential.")`.
     - In `post_identity_agent` (`main.rs:1452-1467`): `may_retrieve` is set to `caller.is_system() || caller.name == name`.
     - Re-checks existence under the `agents.lock()` mutex before insertion, preventing concurrent duplicate mints.
   - **Assessment: PASS**. Prevents rogue agents or anonymous callers from hijacking or retrieving another agent's credential.

---

### 2.4 `app/index.ts` & Frontend Permissions Bus
1. **Electron Main IPC Origin Validation**:
   - In `app/index.ts` (`consentFetch`):
     ```ts
     if (
       !Array.from(windowSet).some((win) => win.webContents === event.sender) ||
       event.senderFrame !== event.sender.mainFrame
     ) {
       throw new Error('Consent requires the Hyperia application window.');
     }
     ```
   - Verifies that the sender webContents belongs to a registered top-level window, and that `senderFrame` is the `mainFrame` (rejecting child frames, iframes, or webview contents).
   - Injects `Authorization: Bearer ${SYSTEM_TOKEN}` server-side in the Node main process, so the renderer never receives or handles the `SYSTEM_TOKEN`.
   - **Assessment: PASS**.

2. **UI Component Migration**:
   - `lib/components/consent-modal.tsx`: Invokes `consent:respond` IPC. Disables redundant duration/scope dropdowns for `bind:` actions. Displays human-readable message target explanations. Captures and renders IPC response errors.
   - `lib/components/agent-toast.tsx`: Invokes `consent:respond` IPC.
   - `lib/components/pane-band.tsx`: Invokes `consent:pane-token` IPC.
   - Zero direct HTTP requests to `/api/perms/*` from frontend UI components.
   - **Assessment: PASS**.

3. **Permissions Bus Request ID Isolation**:
   - `lib/permissions-bus.ts`: Keyed by `req.id` rather than `targetPane`.
   - If two agents concurrently request permission targeting the same pane, both prompts remain isolated. Resolving or expiring one prompt leaves the other active.
   - `hasRequests(paneId)` checks if any active or snoozed request remains before removing pane indicators.
   - **Test Evidence**: Passed `test/unit/permissions-bus.test.ts` (AVA test runner).
   - **Assessment: PASS**.

---

## 3. Concrete Bypass & Vulnerability Analysis

### 3.1 Potential Bypass Assessment

1. **Bypass Vector 1: Forging `CallerIdentity::Pane` or `CallerIdentity::Agent`**:
   - *Hypothesis*: An attacker supplies custom HTTP headers (`X-Pane-Id`, `X-Agent-Name`) to masquerade as another actor.
   - *Verification*: Inspected `bridge::resolve_caller` (`bridge.rs:371-387`). Caller resolution checks strictly the `Authorization: Bearer <token>` value against `identity.is_system`, `identity.resolve`, and `perms.pane_for_token`. No headers other than the bearer token are consulted.
   - *Finding*: **SECURE**. Headers cannot forge identity.

2. **Bypass Vector 2: Privilege Escalation from Message Consent to Terminal Drive**:
   - *Hypothesis*: Approving a message consent prompt silently grants terminal drive access.
   - *Verification*: Inspected `PermStore::respond`. For `action.starts_with("message:")`, `scope` is forced to `"message"`, and `grants_for` explicitly filters `g.scope != "message"`. Drive access checks (`caller_has_grant`) never match message grants.
   - *Finding*: **SECURE**. Verified by `message_approval_never_grants_drive_or_another_recipient`.

3. **Bypass Vector 3: Privilege Escalation from Mailbox Bind Approval to Terminal Drive**:
   - *Hypothesis*: Approving a pane bind consent prompt creates a pane drive grant.
   - *Verification*: Inspected `PermStore::respond` and `main.rs:2138`. `is_bind` is handled as a separate branch, sets `key = req.action.clone()`, creates no drive grant, and triggers `messaging::approve_binding`.
   - *Finding*: **SECURE**. No drive grant created.

4. **Bypass Vector 4: Hijacking Another Agent's Mailbox Binding**:
   - *Hypothesis*: Agent A calls `POST /api/pane/bind-agent` with `{ "pane": "p1", "agent": "AgentB" }`.
   - *Verification*: In `messaging::bind` (`messaging.rs:288-293`):
     ```rust
     CallerIdentity::Agent { name, .. } if req.agent.as_deref().is_none_or(|s| s == name) => name,
     _ => return Err(error(StatusCode::FORBIDDEN, "Only the agent itself or Hyperia can establish this binding.")),
     ```
     Agent A cannot supply any agent name other than `"AgentA"`.
   - *Finding*: **SECURE**. An agent cannot bind another agent's identity.

5. **Bypass Vector 5: Unauthenticated Token Theft via `/api/perms/token` or `/api/identity/agents`**:
   - *Hypothesis*: An unauthenticated or agent caller fetches pane or agent tokens.
   - *Verification*:
     - `/api/perms/token`: Intercepted by `identity_mw` and rejected with 403 Forbidden unless `CallerIdentity::System`.
     - `/api/identity/agents`: Redacted to return only `name` and `createdMs`.
   - *Finding*: **SECURE**. Credential leaks plugged.

---

## 4. Missing Tests & Proposed Test Regressions

The following security test regressions should be added to the test suite as integration tests or added to `message_acl_tests.rs`:

1. **`test_identity_mw_rejects_agent_or_pane_token_on_perms_endpoints`**:
   - Present valid `CallerIdentity::Agent` and `CallerIdentity::Pane` bearer tokens to `/api/perms/token`, `/api/perms/respond`, and `/api/perms/enforce`.
   - Verify that all three return HTTP `403 Forbidden` with `"This operation requires the Hyperia application."`.

2. **`test_bind_endpoint_cannot_bind_different_agent`**:
   - Authenticate as `CallerIdentity::Agent("alice")` with a valid pane token for pane `p1`.
   - Call `/api/pane/bind-agent` requesting `agent: "bob"`.
   - Verify that the endpoint returns `403 Forbidden`.

3. **`test_bind_without_token_creates_pending_and_denial_blocks_retry`**:
   - Authenticate as `CallerIdentity::Agent("alice")` with no pane token.
   - Call `/api/pane/bind-agent` for pane `p1`.
   - Verify that a `PermRequest` is created with `action: "bind:alice"`.
   - Respond with `decision: "deny"`.
   - Verify that a subsequent call returns `403 Forbidden` ("Mailbox binding was denied.").
   - Verify that `has_pending` for `drive` on `p1` returns `false` (no drive prompt interference).

4. **`test_bind_approval_executes_verify_and_bind_without_drive_grant`**:
   - Create pending bind request `perm-1` for `"alice"` on `p1`.
   - Call `respond` with allow.
   - Execute `messaging::approve_binding`.
   - Verify `store.bindings.pane_for_agent("alice") == Some("p1")`.
   - Verify `store.grants_for("alice")` contains ZERO drive grants.

5. **`test_identity_register_concurrency_and_takeover_prevention`**:
   - Register agent `"alice"`.
   - Attempt to call `register` for `"alice"` with `may_retrieve: false`.
   - Verify `Err("Identity already exists; present its credential.")`.

---

## 5. Swarm Coordination & Pending Dependencies

1. **Send Queue & Async Dispatch (Ermine Ownership)**:
   - Wire `/api/msg/send` to Ermine's message queue handler once approved.
   - Verify pre-consent retention: store pending send actions BEFORE prompting the user, eliminating the timeout-loss race condition.
2. **Terminal Boundaries & PTY Injection (Platypus Ownership)**:
   - Finalize Alt+Arrow sequence handling and verify that message/bind approvals never flush held terminal keystrokes.
3. **Automated Binding Lifecycle**:
   - Implement container bootstrap hook so agents running in container panes are automatically bound upon attachment, preventing the "unbound agent cannot read pane messages" gap.

*Report completed and verified against source evidence.*
