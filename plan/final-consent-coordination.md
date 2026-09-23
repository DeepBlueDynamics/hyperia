# Final consent coordination
User owns all builds/tests externally. Source edits only.

## 1. Ownership & Roles
- **Ermine**: `sidecar/src/main.rs` approval handler (`post_perm_respond`) stale approval guard. Use landed API below. Tell Platypus any canonical requester assumptions.
- **Aardvark**: `sidecar/src/delivery.rs` query `consent_operations(consent_id, requester) -> Result<Vec<Operation>, DeliveryError>` exact requester, includes terminal/expired records. Added `sidecar/src/delivery_service.rs` public wrapper with same args -> `Result<Vec<Operation>, ApiError>` (root authorized editing ONLY that new wrapper in service). `store()` remains private in `delivery_service`. Added `pub fn now_ms() -> u64` in `delivery.rs`.
- **Platypus**: canonical identity permission cutover, owns `identity.rs` bridge auth main except approval region messaging binding and perms migration as needed. Ermine owns approval handler. Make binding approval compare namespaced requester consistently.
- **Root**: completion/prompt retry outboxes, explicit terminal keys, response codes, idempotent replay. Replay metadata now excludes body/text; exact body/text compared against single stored typed payload. No duplicated content.

---

## 2. Landed Support API (Aardvark)

### In `sidecar/src/delivery.rs`:
```rust
pub async fn consent_operations(
    &self,
    consent_id: &str,
    requester: &str,
) -> Result<Vec<Operation>, DeliveryError>
```
- Performs exact requester matching (`op.consent_id.as_deref() == Some(consent_id) && op.requester == requester`).
- Includes operations across **all** states (active, queued, expired, denied, submitted, failed).
- Returns `Ok(vec![])` if `consent_id` or `requester` is empty, or if no operations match.
- Strict requester isolation: no wildcard matching for `system` or other requesters.

### In `sidecar/src/delivery_service.rs`:
```rust
/// Query all operations linked to a consent prompt under exact requester matching.
/// Includes terminal and expired records to distinguish delivery-linked prompts from explicit access requests.
pub async fn consent_operations(
    consent_id: &str,
    requester: &str,
) -> Result<Vec<Operation>, ApiError> {
    store().await?.consent_operations(consent_id, requester).await.map_err(operation_error)
}
```
*Note: `store()` is private to `delivery_service.rs`. External callers (including `main.rs`) must call `delivery_service::consent_operations(...)`.*

### Timestamp helper in `sidecar/src/delivery.rs`:
```rust
pub fn now_ms() -> u64
```
Returns current system time since unix epoch in milliseconds.

---

## 3. Approval Region Invariants & Integration Recipe (Ermine)

In `post_perm_respond` (`sidecar/src/main.rs:2018+`):

### Invariants:
1. **FAIL-CLOSED ON INSPECTION / STORE ERROR**: If `delivery_service::consent_operations` fails (e.g. store lock or persistence error), the handler **MUST immediately return the error** (`return (status, body.to_string())`). It must **never** log-and-continue or fall through to `perms.respond`, which would grant unauthorized ambient access during storage faults.
2. **Explicit `request_access` Untouched**: If `ops.is_empty()`, the prompt was created via explicit `request_access` or ambient tool prompt (no retained delivery operations). Proceed with normal grant flow.
3. **Stale Delivery Prompts Refused Without Grant**:
   If `!ops.is_empty()` and NO operations are live (`!ops.iter().any(|op| op.state == delivery::DeliveryState::AwaitingApproval && (op.expires_ms == 0 || now < op.expires_ms))`):
   - All retained operations behind this prompt have expired.
   - **Clear UI prompt**: Consume the prompt using `state.bridge.perms().respond(id, false, scope, duration_secs).await;` to remove it from `pending`.
   - **Clear Denial Cooldown**: Call `state.bridge.perms().clear_denial(&req.requester, &req.target_pane).await;` so the agent is not penalized with a denial cooldown for a natural timeout.
   - **Explain Expiry**: Return `(StatusCode::GONE, serde_json::json!({"ok": false, "error": "All retained operations for this permission prompt have expired. Please submit a new request."}).to_string())`.
   - **No Ambient Grant**: Never call `respond(id, true, ...)` or fall through to grant access.
4. **Live Operations Resolved**:
   If live operations exist, call `delivery_service::resolve_approval(&req, true).await`. On error, return `(status, body.to_string())` immediately. On success, set `delivery_operations = operations` and proceed to grant permissions.
5. **Denial Flow**:
   When `allow == false`, call `delivery_service::resolve_approval(&req, false).await`. On error, return `(status, body.to_string())` immediately. On success, proceed to record denial.

### Integration Pattern for `main.rs::post_perm_respond`:
```rust
    // Persist the exact retained operations' decision before consuming the prompt.
    if let Some(req) = state.bridge.perms().pending_request(id).await {
        if req.action == "drive" || req.action.starts_with("message:") {
            if allow {
                // Query linked operations under exact requester matching (Blocker #7)
                match delivery_service::consent_operations(&req.id, &req.requester).await {
                    Ok(ops) if !ops.is_empty() => {
                        let now = delivery::now_ms();
                        let any_live = ops.iter().any(|op| {
                            op.state == delivery::DeliveryState::AwaitingApproval && (op.expires_ms == 0 || now < op.expires_ms)
                        });
                        if !any_live {
                            // Stale delivery prompt: dismiss UI and clear denial cooldown without granting access
                            state.bridge.perms().respond(id, false, scope, duration_secs).await;
                            state.bridge.perms().clear_denial(&req.requester, &req.target_pane).await;
                            return (
                                StatusCode::GONE,
                                serde_json::json!({
                                    "ok": false,
                                    "error": "All retained operations for this permission prompt have expired. Please submit a new request."
                                }).to_string(),
                            );
                        }
                        // Live operations exist: resolve approval
                        match delivery_service::resolve_approval(&req, true).await {
                            Ok(operations) => delivery_operations = operations,
                            Err((status, Json(body))) => return (status, body.to_string()),
                        }
                    }
                    Ok(_) => {
                        // Empty ops: prompt is not delivery-backed (e.g. explicit request_access). Proceed with normal grant.
                    }
                    Err((status, Json(body))) => {
                        // Inspection/store error MUST fail closed immediately; never log-and-continue to grant
                        return (status, body.to_string());
                    }
                }
            } else {
                // Deny flow
                match delivery_service::resolve_approval(&req, false).await {
                    Ok(operations) => delivery_operations = operations,
                    Err((status, Json(body))) => return (status, body.to_string()),
                }
            }
        }
    }
```

---

## 4. Verification & Constraints
- Zero in-container builds or tests executed. User owns all builds and tests externally.
- Independent source verdicts required; none imply runtime/build success.
