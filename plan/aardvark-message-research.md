# Hyperia Messaging & Delivery Refactor: Architecture, ACL & Contract Specification

**Author / Role**: Anti Gravity Researcher (`nemesis8/n8-amber-zebra`, hosted in Electrical Aardvark pane `ab4ef982-e0b8-4696-9a60-4321876e5300`)  
**Domain Ownership**: Architecture, Access Control Layer (ACL), Identity Model, and Secure API Contracts  
**Collaborators**:
- **Front Ermine** (`674d195b-e34c-4530-a9bf-7cc33290e88e`): Approval queues, continuation, FIFO action holding  
- **Grotesque Platypus** (`de9de912-bf12-4f47-a1c1-d1d88282cb24`): Tool boundaries, focus protection, Alt+Up / focus shortcuts, delivery mechanics  
- **Coordinator / Disastrous Ocelot** (`cb024892-8ad5-484e-a941-e92d7e8ee758`): Shared plan integration, boundary validation, test execution, consensus sign-off  
**Status**: Specification Complete — Research & Contracts Defined. No source code modifications yet (awaiting tripartite swarm consensus).

---

## 1. Executive Summary

Following swarm scope alignment, this specification defines the architectural, access control, and API contracts for the full Hyperia messaging and action delivery refactor.

### Core Problems Solved
1. **Approval Timeout Discarding Actions**: In [`sidecar/src/main.rs:1090`](file:///workspace/hyperia/sidecar/src/main.rs#L1090), `post_type_and_collect` discards command payloads when human consent takes longer than 8 seconds. We define a strict continuation contract requiring atomic payload holding on HTTP 202 Accepted.
2. **Identity & Addressing Partition**: Hyperia separates persistent Agent tokens (`hyp_agent_...`) from ephemeral Pane tokens (`hyp_...`), causing container agents to have `me_pane = ""` ([`sidecar/src/main.rs:2557`](file:///workspace/hyperia/sidecar/src/main.rs#L2557)). Messages addressed to a pane UID cannot be read by the agent executing in that pane, and messages addressed to an agent name never arm notifications. We define a unified Principal model with explicit Pane-Agent binding.
3. **Message Bus Access Control (ACL) Gaps**: Current messaging endpoints allow unauthenticated (anonymous) writes, unauthenticated inbox reads, unverified read receipts, and lack cross-principal authorization gates. We define an enforced ACL model with strict authentication and recipient-only read validation.
4. **Notification Starvation vs. Focus Protection**: Idle-gated notifications require 10 seconds of complete PTY silence ([`sidecar/src/bridge.rs:977`](file:///workspace/hyperia/sidecar/src/bridge.rs#L977)), starving active agents. We specify a decoupled delivery model that respects human focus without stalling background agents.

---

## 2. Verified Root Causes & Citations

### 2.1 Approval Timeout Discard in `post_type_and_collect`
- **Location**: [`sidecar/src/main.rs:1065-1131`](file:///workspace/hyperia/sidecar/src/main.rs#L1065-L1131)
- **Mechanism**:
  - `terminal_run` (`submit=true`) invokes `/api/type-and-collect` ([`sidecar/src/mcp.rs:1229-1244`](file:///workspace/hyperia/sidecar/src/mcp.rs#L1229-L1244)).
  - Line 1090 calls `enforce_drive(&state, &headers, &uid).await`.
  - `enforce_drive_with_purpose` ([`sidecar/src/main.rs:1649-1663`](file:///workspace/hyperia/sidecar/src/main.rs#L1649-L1663)) waits up to $16 \times 500\text{ ms} = 8.0\text{ s}$ for user consent.
  - On timeout, `enforce_drive` returns `Err(pending_202())` (HTTP 202 Accepted).
  - In `post_type` ([`sidecar/src/main.rs:1013-1025`](file:///workspace/hyperia/sidecar/src/main.rs#L1013-L1025)), HTTP 202 triggers `state.bridge.hold_action(&uid, &requester, &keys).await`.
  - In `post_type_and_collect`, `keys` is not computed until line 1100, and **`hold_action` is never called**.
  - When the user approves at 14.08s (verified in `consent_log`: request ts `1790164709265`, allow ts `1790164723349`), `post_perm_respond` ([`sidecar/src/main.rs:2122`](file:///workspace/hyperia/sidecar/src/main.rs#L2122)) calls `state.bridge.take_action(&req.target_pane)`. It receives `None`, and the command payload is permanently lost.

### 2.2 Identity & Addressing Partition
- **Location**: [`sidecar/src/identity.rs:20-29`](file:///workspace/hyperia/sidecar/src/identity.rs#L20-L29), [`sidecar/src/main.rs:2549-2560`](file:///workspace/hyperia/sidecar/src/main.rs#L2549-L2560), [`sidecar/src/msgbus.rs:109-115`](file:///workspace/hyperia/sidecar/src/msgbus.rs#L109-L115)
- **Mechanism**:
  - `CallerIdentity::Agent` sets `me_pane = ""` in `caller_parts`.
  - Messages addressed to a pane set `to_pane = <uid>` and `to_label = <pane_title>`.
  - In `msgbus::to_me`:
    ```rust
    m["to"].as_str() == Some(me_label) || (!me_pane.is_empty() && m["toPane"].as_str() == Some(me_pane))
    ```
    An agent with an agent token has `me_pane == ""` and `me_label == "<agent_name>"`. Both checks evaluate to `false`. The agent cannot read messages sent to its host pane.
  - Messages sent by `to_label` set `to_pane = ""`. `post_msg_send` ([`sidecar/src/main.rs:2620`](file:///workspace/hyperia/sidecar/src/main.rs#L2620)) skips `arm_msg_notify` whenever `to_pane` is empty.
  - `msgbus::record_read` ([`sidecar/src/msgbus.rs:88`](file:///workspace/hyperia/sidecar/src/msgbus.rs#L88)) stores only `reader: reader_label`. An agent reading under its agent name leaves the pane's unread counter in `bridge.rs:1143` unsatisfied, causing repeated notifications.

### 2.3 Messaging ACL Gaps
- **Location**: [`sidecar/src/main.rs:2577-2675`](file:///workspace/hyperia/sidecar/src/main.rs#L2577-L2675)
- **Mechanism**:
  - `post_msg_send` does not authenticate or gate callers. Anonymous callers are accepted as `("anonymous", "anonymous", "")`.
  - `get_msg_inbox` and `get_msg_search` do not reject anonymous requests with HTTP 401.
  - `post_msg_read` accepts any ID string without checking whether the message exists or whether the caller is the intended recipient.

---

## 3. Architecture Specification: Unified Identity & Addressing

### 3.1 Principal Domain Model
We replace the disjoint caller representations with a unified `Principal` structure inside `sidecar/src/identity.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrincipalKind {
    System,
    Agent,
    Pane,
    Anonymous,
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub kind: PrincipalKind,
    pub id: String,              // Stable unique identifier (e.g. "hyp_agent_...", pane UID, or "system")
    pub label: String,           // Human-readable identifier (e.g. "nemesis8/n8-amber-zebra", "Electrical Aardvark")
    pub host_pane: Option<String>,// Bound host pane UID if this principal runs inside a Hyperia terminal
}
```

### 3.2 Pane-Agent Binding Protocol
To bridge the container agent and the hosting terminal pane:
1. **Binding Source of Truth**:
   - `PermStore` tracks active bindings: `agent_panes: Mutex<HashMap<String, String>>` (mapping `agent_name` $\leftrightarrow$ `pane_uid`).
2. **Binding Channels**:
   - **Explicit Claim**: An agent calls `POST /api/pane/bind-agent` with `{ "pane": "<pane_uid>" }` accompanied by its bearer token.
   - **Header Injection**: Container agents passing `X-Hyperia-Pane: <pane_uid>` in HTTP/MCP headers have their binding resolved automatically if the caller owns the pane or if the pane's foreground process is an agent (`is_agent_pane`).
   - **Re-attach Reconciliation**: When an agent container restarts, reading `/opt/nemesis8/.n8/panes/$NEMESIS8_AGENT_ID` provides the authoritative pane UID to bind on the first call.
3. **Resolution in `resolve_caller`**:
   - When an agent token resolves to `CallerIdentity::Agent { name, token }`, the bridge checks `PermStore` for a bound `pane_uid`.
   - `caller_parts` returns:
     ```rust
     (name.clone(), "agent".into(), bound_pane_uid.unwrap_or_default())
     ```
   - Consequently, `me_pane` is populated with the actual live pane UID!

### 3.3 Symmetric Message Addressing & Storage Model
Every message in `messages.jsonl` shall carry explicit canonical fields:
```json
{
  "id": "msg_18e1a2b3c4d",
  "ts": 1790165000000,
  "fromLabel": "nemesis8/hyperia",
  "fromKind": "agent",
  "fromPane": "cb024892-8ad5-484e-a941-e92d7e8ee758",
  "toPane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "toLabel": "Electrical Aardvark 🍬",
  "toAgent": "nemesis8/n8-amber-zebra",
  "subject": "Research plan",
  "body": "..."
}
```

#### Canonical Matching Rule (`to_me`)
In `msgbus::to_me(m, me_agent, me_label, me_pane)`:
```rust
pub fn to_me(m: &serde_json::Value, me_agent: &str, me_label: &str, me_pane: &str) -> bool {
    // 1. Matched by explicit agent name
    if !me_agent.is_empty() && m["toAgent"].as_str() == Some(me_agent) {
        return true;
    }
    // 2. Matched by display label
    if !me_label.is_empty() && m["to"].as_str() == Some(me_label) {
        return true;
    }
    // 3. Matched by target pane UID
    if !me_pane.is_empty() && m["toPane"].as_str() == Some(me_pane) {
        return true;
    }
    false
}
```

#### Dual-Keyed Read Receipts
In `message-reads.jsonl`:
```json
{
  "msgId": "msg_18e1a2b3c4d",
  "readerLabel": "nemesis8/n8-amber-zebra",
  "readerPane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "ts": 1790165050000
}
```
A message is recognized as read by a caller if any receipt matches either `readerLabel == me_label` OR `readerPane == me_pane`. This guarantees that an agent reading mail via its agent token immediately clears the unread flag in the bridge's pane monitor.

---

## 4. Formal Access Control Matrix (ACL Model)

| Endpoint | Permitted Callers | Preconditions / Checks | Behavior on Denial |
| :--- | :--- | :--- | :--- |
| `POST /api/msg/send` | Identified `Agent`, `Pane`, `System` | Non-anonymous; `body` $\le 16\text{ KB}$; valid `to_pane` or non-empty `to_label`/`to_agent`. | `401 Unauthorized` if anonymous; `400 Bad Request` if invalid. |
| `GET /api/msg/inbox` | Identified `Agent`, `Pane`, `System` | Non-anonymous. Returns exclusively messages where `to_me` evaluates to `true`. | `401 Unauthorized` if anonymous. |
| `GET /api/msg/search` | Identified `Agent`, `Pane`, `System` | Non-anonymous. Returns exclusively messages where `to_me` or `from_me` is `true`. | `401 Unauthorized` if anonymous. |
| `POST /api/msg/read` | Identified `Agent`, `Pane`, `System` | Non-anonymous; `id` must exist; caller must satisfy `to_me(msg)`. | `401` if anonymous; `404` if not found; `403 Forbidden` if caller not recipient. |
| `POST /api/pane/bind-agent` | Identified `Agent` | Non-anonymous; target `pane` must exist; caller must own or reside in pane. | `401` if anonymous; `404` if pane missing; `403` if unauthorized. |

---

## 5. Secure API Contracts

### 5.1 `POST /api/msg/send`
* **Purpose**: Dispatch a durable, searchable message to an agent and/or terminal pane.
* **Authentication**: Required (`Authorization: Bearer <token>`).
* **Headers**:
  - `Authorization`: `Bearer <token>` (Required)
  - `X-Hyperia-Pane`: `<pane_uid>` (Optional caller pane hint)

#### Request Schema
```json
{
  "type": "object",
  "properties": {
    "window": { "type": ["integer", "null"], "description": "Target window ID" },
    "tab": { "type": ["string", "null"], "description": "Target tab ID or title prefix" },
    "pane": { "type": ["string", "null"], "description": "Target pane UUID or label" },
    "to_agent": { "type": ["string", "null"], "description": "Explicit persistent agent codename" },
    "to_label": { "type": ["string", "null"], "description": "Display name or free-form recipient label" },
    "subject": { "type": "string", "default": "" },
    "body": { "type": "string", "minLength": 1, "maxLength": 16384 }
  },
  "required": ["body"]
}
```

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "id": "msg_18e1a2b3c4d",
  "to": "Electrical Aardvark 🍬",
  "to_pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "to_agent": "nemesis8/n8-amber-zebra",
  "notified": true
}
```

#### Error Codes
- `400 Bad Request`: Empty body, body exceeds 16KB, or neither pane nor recipient label provided.
  ```json
  { "ok": false, "error": "body is required and must not exceed 16384 characters", "code": "HYP_ERR_INVALID_BODY" }
  ```
- `401 Unauthorized`: Anonymous caller.
  ```json
  { "ok": false, "error": "Messaging requires an authenticated identity", "code": "HYP_ERR_UNAUTHORIZED" }
  ```
- `404 Not Found`: Addressed pane could not be resolved from active sessions.
  ```json
  { "ok": false, "error": "No pane at that address", "code": "HYP_ERR_PANE_NOT_FOUND" }
  ```

---

### 5.2 `GET /api/msg/inbox`
* **Purpose**: List messages addressed to the authenticated caller, newest first.
* **Authentication**: Required (`Authorization: Bearer <token>`).
* **Query Parameters**:
  - `unread_only`: boolean (default `false`)
  - `limit`: integer (default `100`, max `2000`)

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "count": 1,
  "principal": {
    "label": "nemesis8/n8-amber-zebra",
    "kind": "agent",
    "pane": "ab4ef982-e0b8-4696-9a60-4321876e5300"
  },
  "results": [
    {
      "id": "msg_18e1a2b3c4d",
      "ts": 1790165000000,
      "from": "nemesis8/hyperia",
      "fromKind": "agent",
      "fromPane": "cb024892-8ad5-484e-a941-e92d7e8ee758",
      "to": "Electrical Aardvark 🍬",
      "toPane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
      "toAgent": "nemesis8/n8-amber-zebra",
      "subject": "Research plan",
      "body": "Please review...",
      "read": false
    }
  ]
}
```

#### Error Codes
- `401 Unauthorized`: Missing or invalid token.

---

### 5.3 `POST /api/msg/read`
* **Purpose**: Acknowledge and mark a message as read.
* **Authentication**: Required (`Authorization: Bearer <token>`).
* **Request Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "id": { "type": "string", "minLength": 1 }
    },
    "required": ["id"]
  }
  ```

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "id": "msg_18e1a2b3c4d",
  "reader": "nemesis8/n8-amber-zebra",
  "reader_pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "ts": 1790165050000
}
```

#### Error Codes
- `400 Bad Request`: `id` is empty.
- `401 Unauthorized`: Anonymous caller.
- `403 Forbidden`: Caller is not a recipient of message `id`.
  ```json
  { "ok": false, "error": "You are not an authorized recipient of this message", "code": "HYP_ERR_FORBIDDEN" }
  ```
- `404 Not Found`: Message `id` does not exist in `messages.jsonl`.
  ```json
  { "ok": false, "error": "Message msg_xyz not found", "code": "HYP_ERR_MSG_NOT_FOUND" }
  ```

---

### 5.4 `POST /api/pane/bind-agent`
* **Purpose**: Bind an authenticated agent identity to its current hosting terminal pane.
* **Authentication**: Required (`Authorization: Bearer <token>`).

#### Request Schema
```json
{
  "type": "object",
  "properties": {
    "pane": { "type": "string", "minLength": 1, "description": "Pane UUID to bind" }
  },
  "required": ["pane"]
}
```

#### Response (HTTP 200 OK)
```json
{
  "ok": true,
  "agent": "nemesis8/n8-amber-zebra",
  "pane": "ab4ef982-e0b8-4696-9a60-4321876e5300",
  "pane_label": "Electrical Aardvark 🍬"
}
```

---

## 6. Subsystem Handoff Contracts

### 6.1 Approval Queues & Continuation Contract (Handoff to Front Ermine)
* **Lead Reviewer**: Front Ermine (`674d195b-e34c-4530-a9bf-7cc33290e88e`)
* **Core Invariant**: **No command payload may be dropped across the consent timeout boundary.**
* **Contract Specification**:
  1. In `post_type_and_collect` ([`sidecar/src/main.rs:1065`](file:///workspace/hyperia/sidecar/src/main.rs#L1065)):
     - The command string `keys` must be prepared *prior* to calling `enforce_drive`.
     - When `enforce_drive` returns `Err(resp)` where `resp.0 == StatusCode::ACCEPTED`:
       ```rust
       let requester = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await.label();
       state.bridge.hold_action(&uid, &requester, &keys).await;
       ```
  2. Front Ermine to review queue mechanics:
     - Replace single-entry `held_actions` with a per-pane FIFO queue (`VecDeque<HeldAction>`) so rapid sequential tool calls under pending consent do not overwrite each other.
     - Ensure `post_perm_respond` drains the queue in submission order upon `allow`.
     - Ensure user `deny` explicitly drains and purges held actions with an audit log.

### 6.2 Tool Boundaries, Focus & Alt+Up Contract (Handoff to Grotesque Platypus)
* **Lead Reviewer**: Grotesque Platypus (`de9de912-bf12-4f47-a1c1-d1d88282cb24`)
* **Core Invariant**: **Autonomous agent notifications must never steal the human's active keyboard focus or corrupt active TUI/stdin buffers.**
* **Contract Specification**:
  1. **Focus Protection Boundary**:
     - If `user_active_recently(pane)` is true, or if `pane` is currently the human's focused pane (`focused_window_id == Some(win) && pane_active`), **never inject keystrokes**.
  2. **Decoupling Idle Silence from Notification**:
     - Remove the requirement that an agent pane must be silent for 10 seconds (`IDLE_STALE_SECS`).
     - Grotesque Platypus to review safe delivery mechanisms:
       - Determine whether notifications to background agent panes should use out-of-band message bus delivery (avoiding PTY typing entirely), or
       - Verify safe prompt detection (non-streaming, waiting on prompt) before invoking `deliver_keys`.
  3. **Alt+Up / Focus Shortcuts**:
     - Reaffirm that `terminal_focus` is strictly an attention-directing UI tool, never a prerequisite for addressing panes with `terminal_run`, `terminal_keys`, or `msg_send`.

---

## 7. Tripartite Verification & Evidence Protocol

Before any production changes are merged, all three worker agents must independently execute and verify the following test suite, submitting structured evidence to the coordinator:

```
[Swarm Verification Suite]
  ├── Test 1: Consent Timeout Continuation (Front Ermine & Anti Gravity)
  │     ├── Submit terminal_run to unpermitted pane
  │     ├── Await 8.0s timeout -> verify HTTP 202 returned
  │     ├── Approve consent in Hyperia UI at t = 14s
  │     └── Verify held command executes in target pane (terminal_screen holds output)
  │
  ├── Test 2: Cross-Namespace Messaging (Anti Gravity & Grotesque Platypus)
  │     ├── Agent A messages Pane B using pane UID
  │     ├── Agent B connects using agent token (hyp_agent_...)
  │     └── Verify Agent B's msg_inbox receives message (count == 1)
  │
  ├── Test 3: Read Receipt Reconciliation (Anti Gravity)
  │     ├── Agent B calls msg_read(msg_id)
  │     ├── Verify receipt written with both readerLabel and readerPane
  │     └── Verify Bridge idle monitor recalculates unread == 0 (no duplicate notices)
  │
  ├── Test 4: Access Control & Soft-Wall Enforcement (Anti Gravity)
  │     ├── Anonymous POST /api/msg/send -> verify 401 Unauthorized
  │     ├── Non-recipient POST /api/msg/read -> verify 403 Forbidden
  │     └── Non-existent ID POST /api/msg/read -> verify 404 Not Found
  │
  └── Test 5: Focus Non-Steal Verification (Grotesque Platypus)
        ├── Human types in Window 1 Pane A
        ├── Background notification dispatches to Window 1 Pane B
        └── Verify Human active cursor and typing stream in Pane A is undisturbed
```

---

## 8. Swarm Consensus Checkpoints

- [x] **Anti Gravity (Electrical Aardvark)**: Architecture, ACL, identity model, and API contracts defined and verified.
- [ ] **Front Ermine**: Review approval queues, FIFO continuation, and timeout lifecycle.
- [ ] **Grotesque Platypus**: Review tool boundaries, focus protection, and Alt+Up interaction.
- [ ] **Disastrous Ocelot (Coordinator)**: Review integrated plan and authorize execution.

*No source code has been edited. Implementation will commence only upon tripartite swarm sign-off.*
