# Hyperia Messaging & Delivery Refactor: Contract Review & Secure API Specification

**Author / Role**: Anti Gravity Researcher (`nemesis8/n8-amber-zebra`, hosted in Electrical Aardvark pane `ab4ef982-e0b8-4696-9a60-4321876e5300`)  
**Domain Ownership**: Identity, Addressing, Messaging Access Control (ACL), and Secure API Contracts  
**Collaborators**:
- **Front Ermine** (`674d195b-e34c-4530-a9bf-7cc33290e88e`): Approval & delivery lifecycle, pre-consent retention, request-scoped operations  
- **Grotesque Platypus** (`de9de912-bf12-4f47-a1c1-d1d88282cb24`): Input boundaries, shell-only `terminal_run`, focus protection, Alt+Up  
- **Coordinator / Disastrous Ocelot** (`cb024892-8ad5-484e-a941-e92d7e8ee758`): Integration, persistence, acceptance matrix, consensus gate  
**Status**: Research & Contract Review Complete. No source code edits (strictly adhering to "no implementation until shared plan").

---

## 1. Factual Corrections and Retractions

In accordance with rule 6 ("Own what you claim and what you did") and feedback from `nemesis8/hyperia`:

1. **Agent Identity Drift Retracted**:
   * *Earlier claim*: I claimed that `nemesis8/n8-olive-robin` and `nemesis8/n8-amber-zebra` were evidence of identity drift of the same agent across container re-attachment.
   * *Correction*: That claim is false per `nemesis8/hyperia`. `olive-robin` and `amber-zebra` are two distinct external agent instances operating in the swarm. The request timestamp `1790164709265` in `consent_log` belonged to `olive-robin`, whereas `amber-zebra` is this current Anti Gravity instance.
2. **Credential Redaction Mandate**:
   * *Earlier action*: A raw token string was printed during live state inspection.
   * *Correction*: Plaintext credentials (`hyp_...` / `hyp_agent_...`) must never be recorded in plan files, transcripts, or logs. All token references herein are redacted as `[REDACTED_TOKEN]`.
3. **Arbitrary Client Headers Rejected as Authority**:
   * *Earlier proposal*: I proposed trusting client-supplied headers such as `X-Hyperia-Pane` to bind agents to panes.
   * *Correction*: That proposal is unsafe. Client-supplied headers can be spoofed by any HTTP or MCP caller. Pane-to-agent binding must be anchored in verified server-side state (such as dual-credential proof of residency or authoritative orchestrator registration via `CallerIdentity::System`).
4. **`post_type` Race Condition Acknowledged**:
   * *Earlier proposal*: I proposed mirroring `post_type`'s pattern in `post_type_and_collect` by storing `keys` on HTTP 202.
   * *Correction*: As documented in [`plan/messaging-delivery-refactor.md:20`](file:///workspace/hyperia/plan/messaging-delivery-refactor.md#L20), `post_type` contains a verified design flaw: it stores pending input *after* the wait, racing early approvals, and keys held actions solely by target pane rather than requester and operation ID. Storing after the wait must not be replicated. Pending operations must be retained **before** consent evaluation begins.
5. **Repeated Spam Claim Retracted**:
   * *Earlier claim*: I claimed that unread count discrepancies caused perpetual notification spam.
   * *Correction*: That claim is unproven. Per [`sidecar/src/bridge.rs:1148`](file:///workspace/hyperia/sidecar/src/bridge.rs#L1148), `st.pending = false` is explicitly set upon firing to consume the batch. The bridge does not continuously fire without a new inbound message arming `arm_msg_notify`.

---

## 2. Review Against `plan/messaging-delivery-refactor.md`

We align our identity and API architecture directly with the outcomes, constraints, and work package boundaries defined in [`plan/messaging-delivery-refactor.md`](file:///workspace/hyperia/plan/messaging-delivery-refactor.md):

* **Outcome 1 & Front Ermine Boundary**: Operations requiring consent must be retained atomically *prior* to consent evaluation, keyed by `(operation_id, requester, destination)`. When approved, they execute exactly once.
* **Outcome 2 & Grotesque Platypus Boundary**: `terminal_run` must strictly require an interactive shell at an idle prompt; busy shells and TUIs must be rejected cleanly. Agent communication must route via explicit messaging (`pane_send` / `msg_send`), not shell keystroke injection.
* **Outcome 3 & 4 (Our Domain)**: Agent messaging must authenticate the sender, enforce recipient-bound ACLs, isolate inboxes, and provide collision-resistant message IDs and idempotency keys.
* **Outcome 5 (Grotesque Platypus Boundary)**: Background agents must receive mail/notifications without stealing human focus or corrupting active TUI buffers.
* **Constraint on Storage**: Retain the append-only JSONL layout (`messages.jsonl`, `message-reads.jsonl`) as requested by the user, enhancing schema fields and adding explicit serialization/locking and error propagation.

---

## 3. Secure Principal Binding Architecture

### 3.1 The Security Dilemma
In Hyperia, containerized agents hold **persistent agent tokens** (`hyp_agent_...`), while terminal panes have **ephemeral pane tokens** (`hyp_...`).
If an agent only presents an agent token:
- How does the sidecar know which pane the agent is running in?
- An unverified header (like `X-Hyperia-Pane`) allows any rogue agent to claim ownership of another agent's pane or the human user's pane.

### 3.2 Secure Binding Channels
We specify two authoritative mechanisms for establishing agent-to-pane association:

#### Mechanism A: Dual-Credential Proof of Residency (In-Pane Agent Binding)
1. At pane creation, the Electron process or host daemon injects the pane's ephemeral token (`hyp_...`) into the PTY environment as `HYPERIA_PANE_TOKEN`.
2. The agent container runtime reads both:
   - Its persistent agent token from its token file.
   - The pane's ephemeral token from the PTY environment or `/opt/nemesis8/.n8/panes/`.
3. To establish binding, the agent invokes `POST /api/pane/bind-agent`:
   ```json
   {
     "pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
     "pane_token": "[REDACTED_PANE_TOKEN]"
   }
   ```
   accompanied by `Authorization: Bearer [REDACTED_AGENT_TOKEN]`.
4. **Verification Rule**: The sidecar verifies via [`perms::PermStore::pane_for_token`](file:///workspace/hyperia/sidecar/src/perms.rs#L525) that `pane_token` matches the active token for `pane`.
   - Because only the process running inside that physical pane possesses the ephemeral pane token, presenting both constitutes cryptographic/possession-based proof of residency.
   - An agent in pane $Q$ cannot bind to pane $P$ because it cannot produce pane $P$'s secret ephemeral token.

#### Mechanism B: Authoritative Orchestrator Binding (`CallerIdentity::System`)
1. When Hyperia or the host orchestrator spawns an agent container, it calls `POST /api/pane/bind-agent` directly using `HYPERIA_SYSTEM_TOKEN` ([`sidecar/src/identity.rs:68-70`](file:///workspace/hyperia/sidecar/src/identity.rs#L68-L70)).
2. `CallerIdentity::System` is unconditionally trusted. The sidecar records the mapping `agent_name <-> pane_uid` directly into `PermStore`.

### 3.3 Principal Resolution in Runtime
When a request arrives:
1. `resolve_caller` ([`sidecar/src/bridge.rs:363`](file:///workspace/hyperia/sidecar/src/bridge.rs#L363)) resolves the bearer token:
   - `System` $\to$ `Principal::System`
   - `Agent { name, token }` $\to$ Looks up verified binding in `PermStore`. If bound to pane $P$, yields `Principal::Agent { name, host_pane: Some(P) }`.
   - `Pane { pane, token }` $\to$ Yields `Principal::Pane { pane, label: pane_display_name }`.
   - Otherwise $\to$ `Principal::Anonymous`.
2. In `caller_parts` ([`sidecar/src/main.rs:2549`](file:///workspace/hyperia/sidecar/src/main.rs#L2549)):
   ```rust
   Principal::Agent { name, host_pane } => (
       name.clone(),
       "agent".into(),
       host_pane.unwrap_or_default(),
   )
   ```
   Now `me_pane` accurately reflects the authenticated host pane without relying on spoofable headers.

---

## 4. Message Bus Access Control (ACL) Model

### 4.1 Canonical Message Envelope
Every message in `messages.jsonl` shall carry explicit canonical addressing fields:
```json
{
  "id": "msg_18e1a2b3c4d_a7f9b2",
  "idempotencyKey": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "ts": 1790165000000,
  "fromPrincipal": "nemesis8/hyperia",
  "fromKind": "agent",
  "fromPane": "cb024892-8ad5-484e-a941-e92d7e8ee758",
  "toPane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "toLabel": "Electrical Aardvark 🍬",
  "toAgent": "nemesis8/n8-amber-zebra",
  "subject": "Refactor plan",
  "body": "...",
  "deliveryState": "queued"
}
```

### 4.2 Canonical Recipient Matching (`to_me`)
In [`sidecar/src/msgbus.rs`](file:///workspace/hyperia/sidecar/src/msgbus.rs):
```rust
pub fn to_me(m: &serde_json::Value, caller_agent: &str, caller_label: &str, caller_pane: &str) -> bool {
    // 1. Direct match on explicit agent codename
    if !caller_agent.is_empty() && m["toAgent"].as_str() == Some(caller_agent) {
        return true;
    }
    // 2. Direct match on destination pane UID
    if !caller_pane.is_empty() && m["toPane"].as_str() == Some(caller_pane) {
        return true;
    }
    // 3. Fallback match on display label ONLY if toAgent and toPane are unset
    if m["toAgent"].as_str().is_none() && m["toPane"].as_str().is_none() {
        if !caller_label.is_empty() && m["to"].as_str() == Some(caller_label) {
            return true;
        }
    }
    false
}
```
*Note*: Display label matching is strictly restricted to legacy unaddressed messages to prevent collision or aliasing attacks.

### 4.3 Dual-Keyed Read Receipts
In `message-reads.jsonl`:
```json
{
  "msgId": "msg_18e1a2b3c4d_a7f9b2",
  "readerPrincipal": "nemesis8/n8-amber-zebra",
  "readerPane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "readerLabel": "Electrical Aardvark 🍬",
  "ts": 1790165050000
}
```
A message is marked read if a receipt exists where:
`receipt["readerPrincipal"] == caller_principal || receipt["readerPane"] == caller_pane`.
This ensures that reading a message via an agent token immediately updates the read state for the hosting pane.

---

## 5. Secure API Proposals & Contracts

### 5.1 `POST /api/msg/send`
* **Authentication**: Required (`Authorization: Bearer <token>`). Anonymous callers receive `401 Unauthorized`.
* **Idempotency**: Clients may supply `X-Idempotency-Key: <UUID>` or `idempotency_key` in the JSON body. Submitting the same key with matching payload returns the previously assigned `message_id` without creating a duplicate record.
* **Payload Size**: Capped at $16\text{ KB}$ (`MAX_BODY_CHARS = 16384`).
* **Addressing**:
  - `to_pane`: Must be a valid active pane UID or resolve via `resolve_pane_uid` (`404 Not Found` if specified but invalid).
  - `to_agent`: Must be a registered agent name in `IdentityStore` (`404 Not Found` if specified but unknown).
  - At least one valid target (`to_pane` or `to_agent`) must be provided.

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "id": "msg_18e1a2b3c4d_a7f9b2",
  "idempotency_key": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "to_pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "to_agent": "nemesis8/n8-amber-zebra",
  "delivery_state": "queued",
  "notified": true
}
```

---

### 5.2 `GET /api/msg/inbox`
* **Authentication**: Required (`Authorization: Bearer <token>`). Anonymous callers receive `401 Unauthorized`.
* **Mailbox Isolation**: Callers can only retrieve messages where `to_me` is true for their verified principal.
* **Parameters**:
  - `unread_only`: boolean (default `false`)
  - `limit`: integer (default `100`, max `2000`)
* **Side-Effect**: Pure read query; **does not acknowledge or mark messages read**.

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "count": 1,
  "caller": {
    "principal": "nemesis8/n8-amber-zebra",
    "kind": "agent",
    "host_pane": "ab4ef982-e0b8-4696-9a60-4321876e5300"
  },
  "results": [
    {
      "id": "msg_18e1a2b3c4d_a7f9b2",
      "ts": 1790165000000,
      "from": "nemesis8/hyperia",
      "fromKind": "agent",
      "fromPane": "cb024892-8ad5-484e-a941-e92d7e8ee758",
      "toPane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
      "toAgent": "nemesis8/n8-amber-zebra",
      "subject": "Refactor plan",
      "body": "...",
      "read": false
    }
  ]
}
```

---

### 5.3 `POST /api/msg/ack` (and `POST /api/msg/read` backwards-compatibility)
* **Authentication**: Required. Anonymous callers receive `401 Unauthorized`.
* **Preconditions**:
  - The message `id` must exist in `messages.jsonl` (`404 Not Found`).
  - The caller must be an authorized recipient satisfying `to_me(msg)` (`403 Forbidden`).
* **Idempotency**: Submitting an ack for an already-acknowledged message succeeds with the existing read timestamp.

#### Request Schema
```json
{
  "id": "msg_18e1a2b3c4d_a7f9b2"
}
```

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "id": "msg_18e1a2b3c4d_a7f9b2",
  "reader": "nemesis8/n8-amber-zebra",
  "reader_pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "ts": 1790165050000
}
```

---

### 5.4 `GET /api/msg/search`
* **Authentication**: Required. Anonymous callers receive `401 Unauthorized`.
* **Scope**: Restricts results strictly to messages where `from_me` or `to_me` is satisfied for the caller.
* **Side-Effect**: Pure read query; never modifies read or delivery state.

---

### 5.5 `POST /api/pane/bind-agent`
* **Authentication**: Required (`Authorization: Bearer <token>`).
* **Purpose**: Authoritatively associates an agent identity with a terminal pane using proof-of-residency or system token.

#### Request Schema
```json
{
  "pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "pane_token": "[REDACTED_PANE_TOKEN]"
}
```
*Note*: `pane_token` is required for agent callers, but omitted for `CallerIdentity::System`.

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "agent": "nemesis8/n8-amber-zebra",
  "pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "pane_label": "Electrical Aardvark 🍬"
}
```

#### Error Codes
- `401 Unauthorized`: Missing or invalid credentials.
- `403 Forbidden`: `pane_token` does not match the active token for `pane`.
- `404 Not Found`: Pane UID does not exist in active sessions.

---

## 6. Pre-Consent Retention Contract (Handoff to Front Ermine)

Front Ermine owns the approval and delivery lifecycle. We specify the exact handoff invariants:

1. **Pre-Consent Retention (`OperationRecord`)**:
   - `post_type_and_collect` must create and register an `OperationRecord` **before** calling `enforce_drive`.
   - The operation must be keyed by `(operation_id, requester_principal_id, target_pane_uid)`.
   - The record captures:
     - `operation_id`: Unique operation UUID.
     - `requester`: Authenticated principal string.
     - `destination`: Target pane UID.
     - `payload`: Exact validated command text.
     - `options`: `quiet_ms`, `raw`, `submit`.
     - `created_at`: Instant of submission.
2. **Elimination of Post-Wait Storage Race**:
   - `enforce_drive` must not perform delayed storage after its 8-second wait.
   - If `enforce_drive` returns `202 ACCEPTED`, the operation is already safely held.
   - If approval arrives while `enforce_drive` is waiting (inline fast approval), the inline waiter atomically claims and executes the pre-stored `OperationRecord`.
   - If approval arrives after timeout via `post_perm_respond`, `post_perm_respond` atomically claims the pre-stored `OperationRecord` by `operation_id` and executes it.
3. **Queue Isolation**:
   - Replace single-entry `held_actions` with a structured registry supporting multiple operations from distinct requesters without clobbering.

---

## 7. Input Boundaries & Focus Protection Contract (Handoff to Grotesque Platypus)

Grotesque Platypus owns tool boundaries and keyboard/focus mechanics. We specify the input invariants:

1. **Shell-Only `terminal_run`**:
   - `terminal_run` must inspect the target pane's foreground process.
   - If the target is running a TUI (e.g. `claude`, `codex`, `aider`, `n8`) or an active shell command, it must refuse execution cleanly with an actionable error. It must never inject keystrokes into a non-idle shell.
2. **Explicit Messaging via `pane_send` / `msg_send`**:
   - Prose communication directed to an agent must route via `pane_send` / `msg_send`.
   - It must never execute prose at an open shell prompt.
3. **Focus Protection Invariant**:
   - Hyperia must never steal human focus or type over active human typing.
   - If `user_active_recently(pane)` is true, or if `pane` is currently the focused active pane of the foreground window, no automated keystrokes may be injected.
   - Background agents working in unfocused panes can receive notifications without being stalled on a 10-second idle silence timer.

---

## 8. Storage Format Compatibility & Error Propagation

1. **JSONL Layout Maintained**:
   - We retain `messages.jsonl` and `message-reads.jsonl`.
   - New fields (`toAgent`, `fromPrincipal`, `idempotencyKey`, `readerPane`) are optional/nullable on read, ensuring 100% backward compatibility with existing message logs.
2. **Collision-Resistant IDs**:
   - Replace millisecond IDs (`msg_<hex-ts>`) with `msg_<hex-ts>_<random-8hex>` (using cryptographic randomness from `crate::util::random_token`).
3. **Explicit Error Handling**:
   - Replace silent write error suppression (`let _ = f.write_all(...)`) in [`sidecar/src/msgbus.rs:49`](file:///workspace/hyperia/sidecar/src/msgbus.rs#L49) with `Result<(), std::io::Error>` propagation. A disk write failure must return HTTP 500 rather than falsely reporting successful message delivery.

---

## 9. Acceptance Criteria & Independent Verification Matrix

| Test Case | Description | Verification Method | Expected Evidence |
| :--- | :--- | :--- | :--- |
| **AC-1: Approval Continuation** | `terminal_run` submitted; approval arrives at $t=14\text{ s}$ ($> 8\text{ s}$). | Live execution with Front Ermine. | Command executes exactly once; output present in target screen dump; no payload lost. |
| **AC-2: Pre-Consent Retention** | Multiple callers target same pane with pending consent. | Concurrent test with Front Ermine. | Operations queued by `(op_id, requester)`; no clobbering; approvals claim correct operation. |
| **AC-3: In-Pane Agent Binding** | Agent authenticates via dual-credential handshake. | Live test via `POST /api/pane/bind-agent`. | Agent token bound to host pane; `caller_parts` returns correct `me_pane`. |
| **AC-4: Pane & Agent Addressing** | Send addressed to pane UID; send addressed to agent name. | Live test via `POST /api/msg/send`. | Agent's `GET /api/msg/inbox` fetches both; unread counts match. |
| **AC-5: Read Receipt Reconciliation** | Recipient calls `POST /api/msg/ack`. | Live test via `POST /api/msg/ack`. | Read receipt matches `readerPrincipal` and `readerPane`; pane unread counter drops to 0. |
| **AC-6: ACL & Auth Enforcement** | Anonymous send, inbox, and read requests. | Automated curl / HTTP tests. | All return `401 Unauthorized`; non-recipient read returns `403 Forbidden`. |
| **AC-7: Shell-Only `terminal_run`** | `terminal_run` aimed at TUI agent (n8/claude) or busy command. | Live test with Grotesque Platypus. | Refused cleanly without typing bytes or corrupting stdin. |
| **AC-8: Focus Non-Stealing** | Mail arrives for background pane while human is typing in active pane. | Live test with Grotesque Platypus. | Active human cursor and typing stream undisturbed; no focus shift. |

---

## 10. Summary of Consensus Checkpoints

- [x] **Electrical Aardvark (Anti Gravity)**: Contract review complete. Corrections recorded, secure binding model specified, ACL and API contracts published.
- [ ] **Front Ermine**: Review approval queues, pre-consent retention, and FIFO continuation.
- [ ] **Grotesque Platypus**: Review input boundaries, shell classification, focus protection, and Alt+Up.
- [ ] **Disastrous Ocelot (Coordinator)**: Review shared contracts across work packages and authorize implementation.

*No source code has been modified. Research and contract review phase concluded.*
