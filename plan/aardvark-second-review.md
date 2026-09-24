# Hyperia Coordinator Security Integration Review — Phase 2

**Author / Module Owner**: Anti Gravity (`nemesis8/n8-amber-zebra`, hosted in Electrical Aardvark pane `ab4ef982-e0b8-4696-9a60-4321876e5300`)  
**Scope**: In-depth review of WebSocket boundary, requester label authority, container binding bootstrap, guarded input, and binding ACL tests per [`plan/aardvark-second-review-request.md`](file:///workspace/hyperia/plan/aardvark-second-review-request.md)  
**Verification Directive**: User instructed: *"User will build and test externally, outside ALL agents' containers. Do not start more builds/tests in containers."* All test claims are strictly categorized into **Verified Earlier In-Container Runs** vs **Untested Latest Edits (Pending External Run)**.

---

## 1. Executive Summary & Verification Matrix

| Area | Component | Verification Status | Verdict / Finding |
| :--- | :--- | :--- | :--- |
| **System-Only `/ws` Boundary** | `sidecar/src/main.rs:1545`, `app/bridge.ts:114` | Source verified | **PASS**: Unauthenticated connection blocked; requires `Authorization: Bearer ${SYSTEM_TOKEN}`. Prevents session spoofing and PTY hijacking. |
| **Canonical Requester Authority** | `sidecar/src/messaging.rs:65`, `sidecar/src/identity.rs:38` | Source verified | **SECURITY RISK / VULNERABILITY**: `requester = id.label()` collides for agents named `pane <prefix>` with real panes. Fix proposed: use `principal.to_key()`. |
| **Safe Binding Bootstrap** | `app/session.ts:168-185`, container env | Repository research | **COMPATIBILITY GAP**: `HYPERIA_AGENT_TOKEN` is injected as a pane token but overwritten by n8 with agent token; proposals drafted for Hyperia-internal preservation. |
| **GuardedInput & Human Protection** | `app/guarded-input.ts`, `app/bridge.ts:392` | Verified run (5 AVA tests passed earlier) | **PASS**: Focus protection defers input; bracketed paste with 150ms settle; focus race withholds Enter with `indeterminate` state ("Do not replay"). |
| **Binding ACL Regression Test** | `sidecar/src/message_acl_tests.rs:46-68` | Code implemented; container test canceled per user instruction | **NOT RUN LOCALLY (PENDING EXTERNAL VALIDATION)**: Added `binding_approval_never_grants_drive_and_isolates_denial`. |

---

## 2. In-Depth Technical Reviews

### 2.1 System-Only `/ws` Boundary & Electron Bearer Header
- **Vulnerability Formerly Present**:
  - The sidecar HTTP/WebSocket server routes `/ws` to `bridge::ws_handler` (`main.rs:4545`).
  - Previously, `/ws` accepted WebSocket upgrade requests without verifying bearer credentials.
  - Any local process on the host or in an attached container (since sidecar binds to `0.0.0.0` or `127.0.0.1`) could connect to `ws://127.0.0.1:9800/ws` and emit control frames such as `SessionRegister`, `SessionClose`, `SessionData`, and `Keys`.
  - An attacker could forge active pane sessions, claim ownership of panes, inject unauthenticated keystrokes into existing shells, or invalidate active pane tokens, completely compromising the sidecar's security model.
- **Implemented Fix**:
  - In `sidecar/src/main.rs:1545` (`identity_mw`):
    ```rust
    if matches!(path.as_str(), "/api/perms/respond" | "/api/perms/enforce" | "/api/perms/token" | "/ws")
        && !id.is_system()
    {
        crate::audit::record_call(&label, kind, &method, &path, 403);
        return axum::response::IntoResponse::into_response((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"ok": false, "error": "This operation requires the Hyperia application."})),
        ));
    }
    ```
  - In `app/bridge.ts:114`:
    ```ts
    ws = new WebSocket(`ws://127.0.0.1:${sidecarPort}/ws`, {headers: {Authorization: `Bearer ${SYSTEM_TOKEN}`}});
    ```
- **Review Verdict: PASS**.
  - Connecting to `/ws` without the `SYSTEM_TOKEN` returns HTTP `403 Forbidden`.
  - Electron main process securely supplies `SYSTEM_TOKEN` on connection.
  - Command injection, rogue session registration, and unauthenticated PTY manipulation over the control WebSocket are completely blocked.

---

### 2.2 Canonical Requester Authority & Name Collision Risk
- **Current Implementation**:
  - In `sidecar/src/messaging.rs:65`:
    ```rust
    pub async fn actor_from_identity(bridge: &Bridge, id: &CallerIdentity) -> Result<MailActor, ApiError> {
        let store = context()?;
        let requester = id.label();
        ...
    ```
  - In `sidecar/src/identity.rs:38`:
    ```rust
    impl CallerIdentity {
        pub fn label(&self) -> String {
            match self {
                CallerIdentity::Anonymous => "anonymous".into(),
                CallerIdentity::System => "Hyperia".into(),
                CallerIdentity::Agent { name, .. } => name.clone(),
                CallerIdentity::Pane { pane, .. } => format!("pane {}", &pane[..pane.len().min(8)]),
            }
        }
    }
    ```
- **Vulnerability / Collision Mechanism**:
  1. If an agent registers with a name matching the pane label format (for example, `pane a1b2c3d4`), its `id.label()` is `"pane a1b2c3d4"`.
  2. If a pane's UID starts with `a1b2c3d4`, its `id.label()` is also `"pane a1b2c3d4"`.
  3. In `PermStore`:
     - `grants` stores `requester: String`.
     - `denials` stores `(requester: String, key: String)`.
  4. If `requester` is set to `id.label()`:
     - A consent grant approved for `pane a1b2c3d4` would be recognized by `has_message_grant("pane a1b2c3d4", ...)` for the malicious agent.
     - A denial recorded against the pane would block the agent, and a denial against the agent would block the pane.
- **Proposed Architectural Fix**:
  1. **Message Requests**: In `messaging.rs`, decouple the consent ledger requester from human display labels. Define `requester` using the unambiguous canonical principal key:
     ```rust
     let requester = match id {
         CallerIdentity::Anonymous => "anonymous".to_string(),
         CallerIdentity::System => "system".to_string(),
         CallerIdentity::Agent { name, .. } => format!("agent:{name}"),
         CallerIdentity::Pane { pane, .. } => format!("pane:{pane}"),
     };
     ```
     Because `agent:` and `pane:` namespaces cannot collide, no registered agent name can ever collide with a pane UID.
  2. **Binding Requests**: Binding actions are already formatted as `format!("bind:{name}")`. `messaging::approve_binding` checks `name == req.requester` and validates against `bridge.identity().list()`. To ensure total namespace safety, validate that `name` does not start with reserved prefixes (`agent:`, `pane:`, or `system:`).
  3. **Risk Assessment for Legacy Drive Labels**:
     - Legacy drive requests (`action == "drive"`) still rely on `id.label()`.
     - *Risk*: A rogue agent registering `pane <8-hex>` could claim drive grants issued to that pane.
     - *Mitigation*: In `IdentityStore::register` (`identity.rs`), add input validation: reject agent names matching `^pane [0-9a-fA-F]{4,8}$` or disallow spaces in agent registration names.

---

### 2.3 Safe Automatic Binding Bootstrap Research (Hyperia Repository)
- **Repository Research & Diagnostic**:
  - In `app/session.ts:168-185`:
    ```ts
    this.agentToken = `hyp_pane_${randomBytes(16).toString('hex')}`;
    ...
    const baseEnv: Record<string, string> = {
      ...cleanEnv,
      HYPERIA_AGENT_TOKEN: this.agentToken,
      HYPERIA_MCP_URL: `http://localhost:${hyperiaPort}/mcp`,
      HYPERIA_PANE: uid,
      ...envFromConfig
    };
    ```
  - When Hyperia launches a shell session, it injects `HYPERIA_AGENT_TOKEN` with the newly minted pane token (`hyp_pane_...`).
  - When external container orchestrators (such as nemesis8) launch a container agent inside that pane, they configure the container with the agent's persistent identity token (`hyp_agent_...`), overwriting `HYPERIA_AGENT_TOKEN`.
  - The container therefore has no access to the underlying `hyp_pane_...` credential unless explicitly preserved.
- **Repository-Contained Architectural Proposals**:
  1. **Dedicated Pane Credential Variable (`HYPERIA_PANE_TOKEN`)**:
     - In `app/session.ts`, inject `HYPERIA_PANE_TOKEN: this.agentToken` alongside `HYPERIA_AGENT_TOKEN`.
     - Container runtimes that only overwrite `HYPERIA_AGENT_TOKEN` will preserve `HYPERIA_PANE_TOKEN`. Agents inside the container can then provide `pane_token: process.env.HYPERIA_PANE_TOKEN` to `pane_bind` without prompting for human consent.
  2. **Registration-Time Automatic Binding**:
     - When an agent calls `POST /api/identity/agent` (or `request_token` MCP tool) from within a pane carrying `Authorization: Bearer hyp_pane_...`, the sidecar can automatically associate the newly created/retrieved agent with that pane in `BindingStore`.
  3. **Explicit Actionable Unbound State in `GET /api/msg/inbox`**:
     - When an agent is not bound (`who.pane == None`), `messaging::inbox` should return an explicit notice in the JSON response:
       ```json
       {
         "ok": true,
         "me": "n8-amber-zebra",
         "principal": "agent:n8-amber-zebra",
         "pane": null,
         "bound": false,
         "notice": "Agent is not bound to a pane. Messages sent to pane:<id> are not returned. Run tool pane_bind with pane token or request user approval.",
         "count": 0,
         "results": []
       }
       ```
     - This gives the agent clear runtime guidance on why pane mail is missing and how to bind.
  4. **Honest Operational Assessment**:
     - Startup binding cannot be considered fully automatic until external runtimes (n8) forward the pane credential or call `pane_bind`. Documenting and exposing `pane_bind` is the correct within-repository design.

---

### 2.4 GuardedInput Review (`app/guarded-input.ts` & `app/bridge.ts`)
- **Transport & Focus Safety Implementation**:
  - `submitInput` in `app/guarded-input.ts`:
    - Checks `transport.alive()`: fails closed (`{state: 'failed'}`) if the pane or process incarnation has terminated.
    - Checks `transport.protected()`: defers (`{state: 'deferred'}`) if the human is actively typing (`isUserActive(uid)`) or looking at the pane (`win.isFocused() && tabActive && paneActive`).
    - Uses bracketed paste `\x1b[200~...` for agent payloads.
    - Implements a two-phase protocol: writes body, waits `settle()` (150ms timeout), and re-evaluates `alive()` and `protected()`.
    - **Focus Race Mitigation**: If the user focused the window or started typing during the 150ms settle delay, Enter is WITHHELD. The outcome is returned as:
      `{state: 'indeterminate', detail: 'Text was written; Enter withheld because the pane changed or the human took focus. Do not replay.'}`
    - Exception handling marks outcome as `indeterminate` if writing was attempted, ensuring no double-typing or duplicate command execution occurs.
- **Bridge Integration (`app/bridge.ts:392-421`)**:
  - Verifies exact process PID (`tracked.session.pty?.pid === pid`) to prevent delivering input to a recycled or restarted process.
  - Maintains `inputAttempts` set to isolate concurrent operations targeting the same pane.
- **Test Evidence (Verified Run)**:
  - Ran `npx ava test/unit/guarded-input.test.ts`: **5 / 5 tests passed**.
  - Verified cases:
    1. Unfocused working agent receives body then isolated Enter.
    2. Human focus defers without emitting bytes.
    3. Focus race after body never sends Enter or replays.
    4. Submit false preserves exact shell text without Enter.
    5. Terminated target writes nothing; transport failure returns indeterminate.
- **Review Verdict: PASS**.

---

## 3. Implementation of Binding ACL Test

Per coordinator request (*"Please implement extra binding-no-drive test in sidecar/src/message_acl_tests.rs only. No other code edits without coordination"*), the following test has been added to [`sidecar/src/message_acl_tests.rs`](file:///workspace/hyperia/sidecar/src/message_acl_tests.rs):

```rust
#[tokio::test]
async fn binding_approval_never_grants_drive_and_isolates_denial() {
    let store = isolated_store();
    let req = store.create_request("alice", "", "pB", "bind:alice", "associate mailbox").await;
    assert!(!store.has_pending("alice", "pB").await);
    assert!(store.pending_action_for("alice", "bind:alice").await.is_some());

    // Approval must not grant drive access to pB or any other pane
    let resolved = store.respond(&req.id, true, "pane", None).await.unwrap();
    assert_eq!(resolved.id, req.id);
    assert!(store.grants_for("alice").await.is_empty());
    assert!(!store.has_message_grant("alice", "pB").await);
    assert!(store.pending_action_for("alice", "bind:alice").await.is_none());

    // Denial must be scoped to bind:alice, never suppressing drive on target pane
    let req2 = store.create_request("alice", "", "pB", "bind:alice", "retry").await;
    store.respond(&req2.id, false, "pane", None).await.unwrap();
    assert!(store.recently_denied("alice", "bind:alice").await);
    assert!(!store.recently_denied("alice", "pB").await);
    assert!(store.grants_for("alice").await.is_empty());
}
```

### Verification Status of This Test
- **Status**: **IMPLEMENTED IN SOURCE, NOT RUN LOCALLY**.
- In accordance with the user's explicit directive (*"User will build and test externally, outside ALL agents' containers. Do not start more builds/tests in containers"*), local compilation and test execution was canceled immediately.
- This test awaits external execution by the user.

---

## 4. Exact External Validation Commands for User

To execute the complete test suite externally outside all agent containers, run:

### 1. Sidecar Mailbox & ACL Unit Tests (Rust)
```bash
cd /workspace/hyperia/sidecar
cargo test --no-default-features msgbus
cargo test --no-default-features message_acl_tests
```
*Expected Result*:
- `msgbus`: 18 tests pass (6 baseline msgbus tests + 12 mailbox tests covering concurrency, serialization, durability, legacy isolation, and staged failure).
- `message_acl_tests`: 4 tests pass (`message_approval_never_grants_drive_or_another_recipient`, `pending_message_does_not_suppress_drive_and_denial_grants_nothing`, `expired_message_grant_is_rejected`, `binding_approval_never_grants_drive_and_isolates_denial`).

### 2. Frontend & Input Unit Tests (Node / AVA)
```bash
cd /workspace/hyperia
npx ava test/unit/permissions-bus.test.ts
npx ava test/unit/guarded-input.test.ts
npx ava lib/utils/alt-arrow-sequence.test.ts
```
*Expected Result*:
- `permissions-bus.test.ts`: 1 test passes (request ID isolation).
- `guarded-input.test.ts`: 5 tests pass (focus protection, two-phase Enter withholding).
- `alt-arrow-sequence.test.ts`: 9 tests pass (Alt+Up/Down escape sequence mapping).

---

## 5. Distinction of Test Evidence

To maintain strict truth in reporting (per Rule 6):
1. **Verified Earlier In-Container**:
   - `cargo test --no-default-features msgbus`: 18 passed (timestamp 2026-09-23T12:27:36Z).
   - `cargo test --no-default-features message_acl_tests`: 3 passed (timestamp 2026-09-23T12:42:23Z).
   - `npx ava test/unit/permissions-bus.test.ts`: 1 passed (timestamp 2026-09-23T12:42:40Z).
   - `npx ava lib/utils/alt-arrow-sequence.test.ts`: 9 passed (timestamp 2026-09-23T12:43:06Z).
   - `npx ava test/unit/guarded-input.test.ts`: 5 passed (timestamp 2026-09-23T12:47:55Z).
2. **Untested Latest Edits (Pending External Run)**:
   - `binding_approval_never_grants_drive_and_isolates_denial` in `sidecar/src/message_acl_tests.rs`: Written to file, not run in container per user directive.

*Status: Ready for external user build and test run.*
