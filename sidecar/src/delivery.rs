//! Durable asynchronous operation and delivery store.
//!
//! Owns the lifecycle, retention, idempotency, claiming, and terminal state
//! tracking for operations requiring human consent or asynchronous transport.
//!
//! Guarantees:
//! - Pre-consent retention: operation is persisted durably before approval prompts.
//! - Exact single execution: atomic claim (Queued -> Submitting) prevents duplicate dispatch.
//! - Uncertainty safety: in-flight operations at crash recover to Indeterminate (no blind replay).
//! - Pending restart expiry: all uncompleted operations expire on restart (no replay of ephemeral consent).
//! - Staged persistence: live in-memory state is never mutated before disk sync succeeds.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Maximum serialized payload size (128 KB) to prevent memory exhaustion.
pub const MAX_PAYLOAD_BYTES: usize = 131_072;

/// Maximum number of active pending operations in store.
pub const MAX_PENDING_OPERATIONS: usize = 1000;

/// Default expiration duration: 15 minutes.
pub const DEFAULT_EXPIRY_MS: u64 = 15 * 60 * 1000;

/// Maximum allowable expiration duration: 1 hour.
pub const MAX_EXPIRY_MS: u64 = 60 * 60 * 1000;

/// Maximum length of caller-supplied idempotency key.
pub const MAX_IDEMPOTENCY_KEY_CHARS: usize = 128;

#[derive(Debug)]
pub enum DeliveryError {
    Io(String),
    NotFound(String),
    Forbidden(String),
    Conflict(String),
    Validation(String),
    InvalidState(String),
    CorruptedStore(String),
}

impl std::fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeliveryError::Io(msg) => write!(f, "I/O error: {msg}"),
            DeliveryError::NotFound(msg) => write!(f, "Not found: {msg}"),
            DeliveryError::Forbidden(msg) => write!(f, "Forbidden: {msg}"),
            DeliveryError::Conflict(msg) => write!(f, "Conflict: {msg}"),
            DeliveryError::Validation(msg) => write!(f, "Validation error: {msg}"),
            DeliveryError::InvalidState(msg) => write!(f, "Invalid state transition: {msg}"),
            DeliveryError::CorruptedStore(msg) => write!(f, "Corrupted store: {msg}"),
        }
    }
}

impl std::error::Error for DeliveryError {}

pub type Error = DeliveryError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    AwaitingApproval,
    Queued,
    Submitting,
    Submitted,
    Failed,
    Denied,
    Expired,
    Cancelled,
    Indeterminate,
}

pub type State = DeliveryState;

impl DeliveryState {
    pub fn is_active(&self) -> bool {
        matches!(self, DeliveryState::AwaitingApproval | DeliveryState::Queued | DeliveryState::Submitting)
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            DeliveryState::Submitted
                | DeliveryState::Failed
                | DeliveryState::Denied
                | DeliveryState::Expired
                | DeliveryState::Cancelled
                | DeliveryState::Indeterminate
        )
    }
}


#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NewOperation {
    pub requester: String,
    pub target: String,
    pub kind: String,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub submit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub expires_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Operation {
    pub id: String,
    pub requester: String,
    pub target: String,
    pub kind: String,
    pub payload: serde_json::Value,
    pub submit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub expires_ms: u64,
    pub created_ms: u64,
    pub state: DeliveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<serde_json::Value>,
}

#[derive(Clone)]
pub struct DeliveryStore {
    path: PathBuf,
    operations: Arc<Mutex<HashMap<String, Operation>>>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_op_id(ts_ms: u64) -> Result<String, DeliveryError> {
    let mut rand_bytes = [0u8; 16];
    getrandom::getrandom(&mut rand_bytes)
        .map_err(|e| DeliveryError::Io(format!("CSPRNG entropy failure: {e}")))?;
    let hex_rand: String = rand_bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("op_{ts_ms:x}_{hex_rand}"))
}

fn write_snapshot_atomic(path: &Path, ops: &HashMap<String, Operation>) -> Result<(), DeliveryError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DeliveryError::Io(e.to_string()))?;
    }
    let data = serde_json::to_vec_pretty(ops)
        .map_err(|e| DeliveryError::Io(format!("Serialization error: {e}")))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!(
        "{}.tmp.{}.{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("json"),
        std::process::id(),
        stamp
    ));

    let mut file = std::fs::File::create(&tmp).map_err(|e| DeliveryError::Io(e.to_string()))?;
    file.write_all(&data).map_err(|e| DeliveryError::Io(e.to_string()))?;
    file.flush().map_err(|e| DeliveryError::Io(e.to_string()))?;
    file.sync_data().map_err(|e| DeliveryError::Io(e.to_string()))?;
    drop(file);

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(DeliveryError::Io(format!("Atomic rename failed: {e}")));
    }
    Ok(())
}

impl DeliveryStore {
    /// Open the store snapshot at `path`.
    ///
    /// Recovers state on startup:
    /// - Any operation left in `Submitting` is transitioned to `Indeterminate` (never blind replay).
    /// - ALL operations in `AwaitingApproval` and `Queued` expire on restart (prior process claims
    ///   and ephemeral consent cannot authorize replay; requires fresh submission).
    pub async fn open(path: PathBuf) -> Result<Self, DeliveryError> {
        let mut ops: HashMap<String, Operation> = if path.exists() {
            let data = std::fs::read(&path).map_err(|e| DeliveryError::Io(e.to_string()))?;
            serde_json::from_slice(&data)
                .map_err(|e| DeliveryError::CorruptedStore(format!("Corrupted snapshot at {}: {e}", path.display())))?
        } else {
            HashMap::new()
        };

        let mut dirty = false;

        for op in ops.values_mut() {
            if op.state == DeliveryState::Submitting {
                op.state = DeliveryState::Indeterminate;
                op.outcome = Some(serde_json::json!({
                    "recovered": true,
                    "reason": "Process restarted while operation was submitting to transport; not replayed"
                }));
                dirty = true;
            } else if op.state == DeliveryState::AwaitingApproval || op.state == DeliveryState::Queued {
                op.state = DeliveryState::Expired;
                op.outcome = Some(serde_json::json!({
                    "recovered": true,
                    "reason": "Sidecar restarted; pending operations expire on restart to prevent unauthorized replay"
                }));
                dirty = true;
            }
        }

        if dirty {
            write_snapshot_atomic(&path, &ops)?;
        }

        Ok(Self {
            path,
            operations: Arc::new(Mutex::new(ops)),
        })
    }

    /// Create a new delivery operation.
    ///
    /// Validates bounds, enforces idempotency, and stages persistence to disk.
    /// If `approved` is true, the operation begins in `Queued`; otherwise, `AwaitingApproval`.
    pub async fn create(&self, new: NewOperation, approved: bool) -> Result<Operation, DeliveryError> {
        if new.requester.trim().is_empty() {
            return Err(DeliveryError::Validation("Requester cannot be empty".into()));
        }
        if new.target.trim().is_empty() {
            return Err(DeliveryError::Validation("Target cannot be empty".into()));
        }
        if new.kind.trim().is_empty() {
            return Err(DeliveryError::Validation("Kind cannot be empty".into()));
        }
        if let Some(key) = &new.idempotency_key {
            if key.is_empty() || key.chars().count() > MAX_IDEMPOTENCY_KEY_CHARS {
                return Err(DeliveryError::Validation(format!(
                    "Idempotency key must be 1–{MAX_IDEMPOTENCY_KEY_CHARS} characters"
                )));
            }
        }

        let payload_serialized = serde_json::to_vec(&new.payload)
            .map_err(|e| DeliveryError::Validation(format!("Invalid payload JSON: {e}")))?;
        if payload_serialized.len() > MAX_PAYLOAD_BYTES {
            return Err(DeliveryError::Validation(format!(
                "Payload size ({} bytes) exceeds {MAX_PAYLOAD_BYTES} limit",
                payload_serialized.len()
            )));
        }

        let now = now_ms();
        let expires_ms = if new.expires_ms == 0 {
            now.saturating_add(DEFAULT_EXPIRY_MS)
        } else {
            if new.expires_ms > now.saturating_add(MAX_EXPIRY_MS) {
                return Err(DeliveryError::Validation("Expiry exceeds 1 hour maximum".into()));
            }
            new.expires_ms
        };

        let mut lock = self.operations.lock().await;

        // Idempotency check: match (requester, idempotency_key)
        if let Some(key) = &new.idempotency_key {
            if let Some(existing) = lock.values().find(|op| op.requester == new.requester && op.idempotency_key.as_deref() == Some(key.as_str())) {
                if existing.target == new.target
                    && existing.kind == new.kind
                    && existing.payload == new.payload
                    && existing.submit == new.submit
                {
                    return Ok(existing.clone());
                } else {
                    return Err(DeliveryError::Conflict(
                        "Idempotency key reused with conflicting operation parameters".into(),
                    ));
                }
            }
        }

        // Pending count cap
        let active_count = lock.values().filter(|op| op.state.is_active()).count();
        if active_count >= MAX_PENDING_OPERATIONS {
            return Err(DeliveryError::Conflict(format!(
                "Pending operations count ({active_count}) reached maximum capacity ({MAX_PENDING_OPERATIONS})"
            )));
        }

        let id = generate_op_id(now)?;
        let state = if approved {
            DeliveryState::Queued
        } else {
            DeliveryState::AwaitingApproval
        };

        let op = Operation {
            id: id.clone(),
            requester: new.requester,
            target: new.target,
            kind: new.kind,
            payload: new.payload,
            submit: new.submit,
            idempotency_key: new.idempotency_key,
            expires_ms,
            created_ms: now,
            state,
            consent_id: None,
            outcome: None,
        };

        // Staged persistence: clone, write, then update live memory
        let mut staged = lock.clone();
        staged.insert(id, op.clone());
        write_snapshot_atomic(&self.path, &staged)?;
        *lock = staged;

        Ok(op)
    }

    /// Retrieve an operation by ID. Enforces that only the caller who created
    /// the operation (or "system") may inspect it.
    pub async fn get(&self, id: &str, requester: &str) -> Result<Operation, DeliveryError> {
        let lock = self.operations.lock().await;
        let op = lock.get(id).ok_or_else(|| DeliveryError::NotFound(format!("Operation {id} not found")))?;
        if op.requester != requester && requester != "system" {
            return Err(DeliveryError::Forbidden(
                "Caller does not have authority to view this operation".into(),
            ));
        }
        Ok(op.clone())
    }

    /// Look up an existing operation by exact requester and caller-scoped idempotency key.
    ///
    /// Used for idempotent replay before evaluating current authorization or denial status.
    /// Strictly matches exact requester identity (no wildcard or cross-identity fallback).
    pub async fn find_by_key(
        &self,
        requester: &str,
        key: &str,
    ) -> Result<Option<Operation>, DeliveryError> {
        if requester.trim().is_empty() || key.trim().is_empty() {
            return Ok(None);
        }
        let lock = self.operations.lock().await;
        let found = lock
            .values()
            .find(|op| op.requester == requester && op.idempotency_key.as_deref() == Some(key))
            .cloned();
        Ok(found)
    }

    /// Associate an awaiting operation with an external permission prompt consent ID.
    ///
    /// Invariants:
    /// - Immutable association: cannot rebind an existing different consent_id.
    /// - Cross-target isolation: a consent_id cannot be shared with a different requester or target.
    pub async fn associate(&self, id: &str, requester: &str, consent_id: &str) -> Result<Operation, DeliveryError> {
        if consent_id.trim().is_empty() {
            return Err(DeliveryError::Validation("Consent ID cannot be empty".into()));
        }
        let mut lock = self.operations.lock().await;
        let op = lock.get(id).ok_or_else(|| DeliveryError::NotFound(format!("Operation {id} not found")))?;

        if op.requester != requester && requester != "system" {
            return Err(DeliveryError::Forbidden(
                "Caller does not have authority to associate this operation".into(),
            ));
        }
        if op.state != DeliveryState::AwaitingApproval {
            return Err(DeliveryError::InvalidState(format!(
                "Cannot associate consent on operation in {:?} state; must be AwaitingApproval",
                op.state
            )));
        }

        // Immutable association: reject changing an existing different consent_id
        if let Some(existing_consent) = &op.consent_id {
            if existing_consent != consent_id {
                return Err(DeliveryError::Conflict(
                    "Consent ID is immutable once associated; cannot rebind to different prompt".into(),
                ));
            }
            return Ok(op.clone());
        }

        // Scope check: a consent_id cannot be shared with a different requester or target
        for other in lock.values() {
            if other.id != id && other.consent_id.as_deref() == Some(consent_id) {
                if other.requester != op.requester || other.target != op.target {
                    return Err(DeliveryError::Conflict(format!(
                        "Consent ID '{consent_id}' is already bound to ({}, {}) and cannot be shared with ({}, {})",
                        other.requester, other.target, op.requester, op.target
                    )));
                }
            }
        }

        let mut staged = lock.clone();
        if let Some(target_op) = staged.get_mut(id) {
            target_op.consent_id = Some(consent_id.to_string());
        }
        write_snapshot_atomic(&self.path, &staged)?;
        *lock = staged;

        Ok(lock.get(id).cloned().unwrap())
    }

    /// Resolve operations associated with a consent prompt.
    ///
    /// Must match exact `requester` (no wildcard). Duplicate safe.
    pub async fn resolve(
        &self,
        consent_id: &str,
        requester: &str,
        allow: bool,
    ) -> Result<Vec<Operation>, DeliveryError> {
        let mut lock = self.operations.lock().await;
        let now = now_ms();
        let mut staged = lock.clone();
        let mut resolved = Vec::new();

        for op in staged.values_mut() {
            if op.consent_id.as_deref() == Some(consent_id)
                && op.state == DeliveryState::AwaitingApproval
                && op.requester == requester
            {
                if allow {
                    if op.expires_ms > 0 && now >= op.expires_ms {
                        op.state = DeliveryState::Expired;
                        op.outcome = Some(serde_json::json!({"reason": "Consent approved after expiration"}));
                    } else {
                        op.state = DeliveryState::Queued;
                    }
                } else {
                    op.state = DeliveryState::Denied;
                    op.outcome = Some(serde_json::json!({"denied": true}));
                }
                resolved.push(op.clone());
            }
        }

        if !resolved.is_empty() {
            write_snapshot_atomic(&self.path, &staged)?;
            *lock = staged;
        }

        Ok(resolved)
    }

    /// Return all operations associated with `consent_id` under exact `requester` matching.
    ///
    /// Includes operations in all states (active, queued, expired, denied, submitted, failed).
    /// Used by approval handlers to distinguish delivery-linked prompts with all expired
    /// operations from explicit access requests with no retained operations.
    pub async fn consent_operations(
        &self,
        consent_id: &str,
        requester: &str,
    ) -> Result<Vec<Operation>, DeliveryError> {
        if consent_id.trim().is_empty() || requester.trim().is_empty() {
            return Ok(Vec::new());
        }
        let lock = self.operations.lock().await;
        let ops = lock
            .values()
            .filter(|op| {
                op.consent_id.as_deref() == Some(consent_id) && op.requester == requester
            })
            .cloned()
            .collect();
        Ok(ops)
    }


    /// List all currently queued operations ready for dispatch.
    ///
    /// Automatically marks any expired queued operations as `Expired` before returning.
    /// Sorts deterministically by `(created_ms, id)` ascending (FIFO queue).
    pub async fn queued(&self) -> Result<Vec<Operation>, DeliveryError> {
        let mut lock = self.operations.lock().await;
        let now = now_ms();
        let mut dirty = false;
        let mut staged = lock.clone();

        for op in staged.values_mut() {
            if (op.state == DeliveryState::Queued || op.state == DeliveryState::AwaitingApproval)
                && op.expires_ms > 0
                && now >= op.expires_ms
            {
                op.state = DeliveryState::Expired;
                op.outcome = Some(serde_json::json!({"reason": "Operation expired in queue"}));
                dirty = true;
            }
        }

        if dirty {
            write_snapshot_atomic(&self.path, &staged)?;
            *lock = staged;
        }

        let mut ready: Vec<Operation> = lock
            .values()
            .filter(|op| op.state == DeliveryState::Queued)
            .cloned()
            .collect();
        ready.sort_by(|a, b| (a.created_ms, &a.id).cmp(&(b.created_ms, &b.id)));
        Ok(ready)
    }

    /// Atomically claim a queued operation for dispatch (`Queued -> Submitting`).
    ///
    /// Exactly one claimant wins. If the operation is not queued or has expired,
    /// returns `Ok(None)`.
    pub async fn claim(&self, id: &str) -> Result<Option<Operation>, DeliveryError> {
        let mut lock = self.operations.lock().await;
        let now = now_ms();

        let op = match lock.get(id) {
            Some(op) if op.state == DeliveryState::Queued => op,
            _ => return Ok(None),
        };

        if op.expires_ms > 0 && now >= op.expires_ms {
            let mut staged = lock.clone();
            if let Some(target) = staged.get_mut(id) {
                target.state = DeliveryState::Expired;
                target.outcome = Some(serde_json::json!({"reason": "Expired at claim time"}));
            }
            write_snapshot_atomic(&self.path, &staged)?;
            *lock = staged;
            return Ok(None);
        }

        let mut staged = lock.clone();
        if let Some(target) = staged.get_mut(id) {
            target.state = DeliveryState::Submitting;
        }
        write_snapshot_atomic(&self.path, &staged)?;
        *lock = staged;

        Ok(lock.get(id).cloned())
    }

    /// Complete a submitting operation with its transport outcome.
    ///
    /// Allowed target states:
    /// - `Submitted`: text/enter written to transport.
    /// - `Failed`: transport unrecoverable error.
    /// - `Indeterminate`: transport uncertain / focus race where replay is unsafe.
    /// - `Queued`: ONLY when transport explicitly confirms no bytes were written (`outcome.state == "deferred"`).
    pub async fn complete(
        &self,
        id: &str,
        state: DeliveryState,
        outcome: serde_json::Value,
    ) -> Result<Operation, DeliveryError> {
        let mut lock = self.operations.lock().await;
        let op = lock.get(id).ok_or_else(|| DeliveryError::NotFound(format!("Operation {id} not found")))?;

        if op.state != DeliveryState::Submitting {
            return Err(DeliveryError::InvalidState(format!(
                "Cannot complete operation in {:?} state; must be Submitting",
                op.state
            )));
        }

        match state {
            DeliveryState::Submitted | DeliveryState::Failed | DeliveryState::Indeterminate => {}
            DeliveryState::Queued => {
                let outcome_state = outcome.get("state").and_then(|v| v.as_str());
                if outcome_state != Some("deferred") {
                    return Err(DeliveryError::InvalidState(
                        "Requeuing a submitting operation requires outcome.state == 'deferred' to prove zero bytes were written".into(),
                    ));
                }
            }
            _ => {
                return Err(DeliveryError::InvalidState(format!(
                    "Invalid completion state: {state:?}"
                )));
            }
        }

        let mut staged = lock.clone();
        if let Some(target) = staged.get_mut(id) {
            target.state = state;
            target.outcome = Some(outcome);
        }
        write_snapshot_atomic(&self.path, &staged)?;
        *lock = staged;

        Ok(lock.get(id).cloned().unwrap())
    }

    /// Cancel a pending operation (`AwaitingApproval` or `Queued`).
    ///
    /// Cannot cancel an operation that is actively `Submitting` or already terminal.
    pub async fn cancel(&self, id: &str, requester: &str) -> Result<Operation, DeliveryError> {
        let mut lock = self.operations.lock().await;
        let op = lock.get(id).ok_or_else(|| DeliveryError::NotFound(format!("Operation {id} not found")))?;

        if op.requester != requester && requester != "system" {
            return Err(DeliveryError::Forbidden(
                "Caller does not have authority to cancel this operation".into(),
            ));
        }

        match op.state {
            DeliveryState::AwaitingApproval | DeliveryState::Queued => {}
            DeliveryState::Submitting => {
                return Err(DeliveryError::InvalidState(
                    "Cannot cancel an operation while it is actively submitting to transport".into(),
                ));
            }
            _ => {
                return Err(DeliveryError::InvalidState(format!(
                    "Cannot cancel operation in terminal state {:?}",
                    op.state
                )));
            }
        }

        let mut staged = lock.clone();
        if let Some(target) = staged.get_mut(id) {
            target.state = DeliveryState::Cancelled;
            target.outcome = Some(serde_json::json!({
                "cancelled_by": requester,
                "cancelled_at": now_ms()
            }));
        }
        write_snapshot_atomic(&self.path, &staged)?;
        *lock = staged;

        Ok(lock.get(id).cloned().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = &manifest_dir; // sidecar/target — never the repo-root target/ (Electron packages it)
        let dir = root.join("target").join("test_fixtures").join("delivery").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("delivery.json")
    }

    #[tokio::test]
    async fn test_create_and_get_caller_isolation() {
        let path = test_dir("caller_isolation");
        let store = DeliveryStore::open(path).await.unwrap();

        let op = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "ls\n"}),
            submit: true,
            idempotency_key: Some("key-1".into()),
            expires_ms: 0,
        }, false).await.unwrap();

        assert_eq!(op.state, DeliveryState::AwaitingApproval);
        assert_eq!(op.requester, "alice");

        // Alice can read her own operation
        let fetched = store.get(&op.id, "alice").await.unwrap();
        assert_eq!(fetched.id, op.id);

        // System can read
        let system_fetched = store.get(&op.id, "system").await.unwrap();
        assert_eq!(system_fetched.id, op.id);

        // Eve is forbidden
        let err = store.get(&op.id, "eve").await.unwrap_err();
        assert!(matches!(err, DeliveryError::Forbidden(_)));
    }

    #[tokio::test]
    async fn test_idempotency_duplicate_and_conflict() {
        let path = test_dir("idempotency");
        let store = DeliveryStore::open(path).await.unwrap();

        let first = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "pwd\n"}),
            submit: true,
            idempotency_key: Some("key-dup".into()),
            expires_ms: 0,
        }, false).await.unwrap();

        // Exact replay returns identical operation
        let replay = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "pwd\n"}),
            submit: true,
            idempotency_key: Some("key-dup".into()),
            expires_ms: 0,
        }, false).await.unwrap();

        assert_eq!(first.id, replay.id);

        // Conflicting payload returns Conflict
        let conflict = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "rm -rf\n"}),
            submit: true,
            idempotency_key: Some("key-dup".into()),
            expires_ms: 0,
        }, false).await.unwrap_err();

        assert!(matches!(conflict, DeliveryError::Conflict(_)));
    }

    #[tokio::test]
    async fn test_associate_immutable_and_cross_target_isolation() {
        let path = test_dir("associate_immutability");
        let store = DeliveryStore::open(path).await.unwrap();

        let op1 = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "op1"}),
            submit: true,
            idempotency_key: None,
            expires_ms: 0,
        }, false).await.unwrap();

        let op2 = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-2".into(), // different target!
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "op2"}),
            submit: true,
            idempotency_key: None,
            expires_ms: 0,
        }, false).await.unwrap();

        // Initial association succeeds
        let associated = store.associate(&op1.id, "alice", "perm-100").await.unwrap();
        assert_eq!(associated.consent_id.as_deref(), Some("perm-100"));

        // Idempotent duplicate associate with same consent ID succeeds
        let re_assoc = store.associate(&op1.id, "alice", "perm-100").await.unwrap();
        assert_eq!(re_assoc.consent_id.as_deref(), Some("perm-100"));

        // Rebinding op1 to a different consent ID is rejected as Conflict
        let err_rebind = store.associate(&op1.id, "alice", "perm-200").await.unwrap_err();
        assert!(matches!(err_rebind, DeliveryError::Conflict(_)));

        // Associating same consent ID with different target pane is rejected
        let err_cross_target = store.associate(&op2.id, "alice", "perm-100").await.unwrap_err();
        assert!(matches!(err_cross_target, DeliveryError::Conflict(_)));
    }

    #[tokio::test]
    async fn test_resolve_exact_requester_matching() {
        let path = test_dir("resolve_matching");
        let store = DeliveryStore::open(path).await.unwrap();

        let op = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "test"}),
            submit: true,
            idempotency_key: None,
            expires_ms: 0,
        }, false).await.unwrap();

        store.associate(&op.id, "alice", "perm-abc").await.unwrap();

        // Mismatched requester returns empty (no wildcard)
        let resolved_bob = store.resolve("perm-abc", "bob", true).await.unwrap();
        assert!(resolved_bob.is_empty());

        // Exact requester matches and queues
        let resolved_alice = store.resolve("perm-abc", "alice", true).await.unwrap();
        assert_eq!(resolved_alice.len(), 1);
        assert_eq!(resolved_alice[0].state, DeliveryState::Queued);
    }

    #[tokio::test]
    async fn test_complete_deferred_proof_required_for_requeue() {
        let path = test_dir("complete_deferred");
        let store = DeliveryStore::open(path).await.unwrap();

        let op = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "ls\n"}),
            submit: true,
            idempotency_key: None,
            expires_ms: 0,
        }, true).await.unwrap();

        store.claim(&op.id).await.unwrap();

        // Requeuing without outcome.state == "deferred" is rejected
        let invalid_err = store.complete(
            &op.id,
            DeliveryState::Queued,
            serde_json::json!({"state": "interrupted"}),
        ).await.unwrap_err();
        assert!(matches!(invalid_err, DeliveryError::InvalidState(_)));

        // Requeuing with outcome.state == "deferred" succeeds
        let requeued = store.complete(
            &op.id,
            DeliveryState::Queued,
            serde_json::json!({"state": "deferred", "detail": "human focus"}),
        ).await.unwrap();
        assert_eq!(requeued.state, DeliveryState::Queued);
    }

    #[tokio::test]
    async fn test_open_recovery_expires_all_awaiting_and_queued() {
        let path = test_dir("reopen_expiry");
        let store = DeliveryStore::open(path.clone()).await.unwrap();

        let awaiting = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "awaiting"}),
            submit: true,
            idempotency_key: None,
            expires_ms: now_ms() + 100_000,
        }, false).await.unwrap();

        let queued = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "queued"}),
            submit: true,
            idempotency_key: None,
            expires_ms: now_ms() + 100_000,
        }, true).await.unwrap();

        let submitting = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"text": "submitting"}),
            submit: true,
            idempotency_key: None,
            expires_ms: now_ms() + 100_000,
        }, true).await.unwrap();
        store.claim(&submitting.id).await.unwrap();

        // Drop store and reopen
        drop(store);
        let reopened = DeliveryStore::open(path).await.unwrap();

        // AwaitingApproval must be Expired
        let op_a = reopened.get(&awaiting.id, "alice").await.unwrap();
        assert_eq!(op_a.state, DeliveryState::Expired);

        // Queued must be Expired
        let op_q = reopened.get(&queued.id, "alice").await.unwrap();
        assert_eq!(op_q.state, DeliveryState::Expired);

        // Submitting must be Indeterminate
        let op_s = reopened.get(&submitting.id, "alice").await.unwrap();
        assert_eq!(op_s.state, DeliveryState::Indeterminate);
    }

    #[tokio::test]
    async fn test_deterministic_fifo_ordering() {
        let path = test_dir("fifo_order");
        let store = DeliveryStore::open(path).await.unwrap();

        let op1 = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"n": 1}),
            submit: true,
            idempotency_key: None,
            expires_ms: 0,
        }, true).await.unwrap();

        let op2 = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"n": 2}),
            submit: true,
            idempotency_key: None,
            expires_ms: 0,
        }, true).await.unwrap();

        let queued = store.queued().await.unwrap();
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].id, op1.id);
        assert_eq!(queued[1].id, op2.id);
    }

    #[tokio::test]
    async fn test_find_by_key_exact_requester_only() {
        let path = test_dir("find_by_key");
        let store = DeliveryStore::open(path).await.unwrap();

        let op = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"cmd": "echo 1"}),
            submit: true,
            idempotency_key: Some("replay-key-1".into()),
            expires_ms: 0,
        }, false).await.unwrap();

        // Exact requester and key matches
        let found = store.find_by_key("alice", "replay-key-1").await.unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, op.id);

        // Different key for same requester returns None
        let not_found_key = store.find_by_key("alice", "other-key").await.unwrap();
        assert!(not_found_key.is_none());

        // Different requester for same key returns None (strict requester isolation)
        let not_found_req = store.find_by_key("bob", "replay-key-1").await.unwrap();
        assert!(not_found_req.is_none());

        // System wildcard does NOT match (exact requester lookup only)
        let system_lookup = store.find_by_key("system", "replay-key-1").await.unwrap();
        assert!(system_lookup.is_none());

        // Empty requester or empty key returns None
        assert!(store.find_by_key("", "replay-key-1").await.unwrap().is_none());
        assert!(store.find_by_key("alice", "").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_consent_operations_retention_and_isolation() {
        let path = test_dir("consent_ops_isolation");
        let store = DeliveryStore::open(path).await.unwrap();

        // 1. Non-existent / empty check
        let empty_ops = store.consent_operations("req-none", "alice").await.unwrap();
        assert!(empty_ops.is_empty());
        assert!(store.consent_operations("", "alice").await.unwrap().is_empty());
        assert!(store.consent_operations("req-none", "").await.unwrap().is_empty());

        // 2. Create operation and associate with consent ID
        let op = store.create(NewOperation {
            requester: "alice".into(),
            target: "pane-1".into(),
            kind: "pane_send".into(),
            payload: serde_json::json!({"cmd": "echo 1"}),
            submit: true,
            idempotency_key: None,
            expires_ms: now_ms() + 100_000,
        }, false).await.unwrap();
        store.associate(&op.id, "alice", "consent-1").await.unwrap();

        // Query consent operations for alice
        let c_ops = store.consent_operations("consent-1", "alice").await.unwrap();
        assert_eq!(c_ops.len(), 1);
        assert_eq!(c_ops[0].id, op.id);
        assert_eq!(c_ops[0].state, DeliveryState::AwaitingApproval);

        // Different requester receives empty list (exact requester isolation)
        let other_ops = store.consent_operations("consent-1", "bob").await.unwrap();
        assert!(other_ops.is_empty());

        // System cannot view without exact requester match
        let sys_ops = store.consent_operations("consent-1", "system").await.unwrap();
        assert!(sys_ops.is_empty());

        // 3. Resolve approval with allow = false -> marks Denied
        let resolved = store.resolve("consent-1", "alice", false).await.unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].state, DeliveryState::Denied);

        // 4. Verify consent_operations still includes terminal/denied records
        let terminal_ops = store.consent_operations("consent-1", "alice").await.unwrap();
        assert_eq!(terminal_ops.len(), 1);
        assert_eq!(terminal_ops[0].id, op.id);
        assert_eq!(terminal_ops[0].state, DeliveryState::Denied);
    }
}
