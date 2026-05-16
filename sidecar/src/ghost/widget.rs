//! WidgetStore — backs the `tool_mount` SSE event with per-widget data + action queues.
//!
//! When the agent calls the `tool_mount` builtin, the registry stashes the
//! payload here keyed by a server-generated MountId. The renderer's widget
//! JS then:
//!
//!   * fetches data via `GET /api/ghost/widget/:id/data?key=<key>` —
//!     keys outside the mount's `exposes` allowlist are rejected with 403
//!   * requests an action via `POST /api/ghost/widget/:id/action` —
//!     actions outside the mount's `permits` allowlist are rejected with 403
//!
//! Actions are queued (not directly invoked). The agent drains the queue at
//! the top of each loop iteration alongside `pending_injects` and decides
//! whether to honor each one.
//!
//! This is a generalization of the `pending_ui` parking pattern in
//! registry.rs (which holds a single oneshot::Sender per id). WidgetStore
//! holds data + a Vec of actions per id, and never blocks the agent.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Server-generated identifier for a mounted widget. Format: `"m-<hex-ts><counter>"`.
pub type MountId = String;

/// An action queued by a widget for the agent's next turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetAction {
    pub action: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// Per-mount metadata kept for permission checks + audit logging.
#[derive(Debug, Clone)]
pub struct MountMeta {
    pub name: String,
    pub exposes: Vec<String>,
    pub permits: Vec<String>,
    pub srcdoc_hash: String,
    pub created_ts: u64,
}

/// Errors returned by WidgetStore. The HTTP handler maps these to status codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WidgetError {
    /// Mount id unknown or already dismissed.
    NotFound,
    /// Data key requested isn't in the mount's `exposes` allowlist.
    KeyNotExposed,
    /// Action name requested isn't in the mount's `permits` allowlist.
    ActionNotPermitted,
}

impl WidgetError {
    pub fn status_code(&self) -> u16 {
        match self {
            WidgetError::NotFound => 404,
            WidgetError::KeyNotExposed | WidgetError::ActionNotPermitted => 403,
        }
    }
}

impl std::fmt::Display for WidgetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WidgetError::NotFound => write!(f, "widget not found"),
            WidgetError::KeyNotExposed => write!(f, "data key not in exposes allowlist"),
            WidgetError::ActionNotPermitted => write!(f, "action not in permits allowlist"),
        }
    }
}

pub struct WidgetStore {
    data: Mutex<HashMap<MountId, HashMap<String, serde_json::Value>>>,
    actions: Mutex<HashMap<MountId, Vec<WidgetAction>>>,
    meta: Mutex<HashMap<MountId, MountMeta>>,
    counter: AtomicU64,
}

impl Default for WidgetStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WidgetStore {
    pub fn new() -> Self {
        Self {
            data: Mutex::new(HashMap::new()),
            actions: Mutex::new(HashMap::new()),
            meta: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
        }
    }

    /// Mount a new widget. Generates a fresh MountId, stashes data + meta,
    /// returns the id so the caller can include it in the SSE event.
    pub fn mount(
        &self,
        name: String,
        srcdoc: &str,
        data: HashMap<String, serde_json::Value>,
        exposes: Vec<String>,
        permits: Vec<String>,
    ) -> MountId {
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let id: MountId = format!("m-{:x}{:04x}", now_nanos, n & 0xffff);

        let mut h = DefaultHasher::new();
        srcdoc.hash(&mut h);
        let srcdoc_hash = format!("{:016x}", h.finish());

        let meta = MountMeta {
            name,
            exposes,
            permits,
            srcdoc_hash,
            created_ts: now_nanos / 1_000_000_000,
        };

        self.data.lock().unwrap().insert(id.clone(), data);
        self.actions.lock().unwrap().insert(id.clone(), Vec::new());
        self.meta.lock().unwrap().insert(id.clone(), meta);

        id
    }

    /// Read a data key. `NotFound` if id unknown; `KeyNotExposed` if key
    /// outside the mount's allowlist; otherwise returns the stashed value
    /// (or `Value::Null` if the key was in the allowlist but never written).
    pub fn get_data(&self, id: &str, key: &str) -> Result<serde_json::Value, WidgetError> {
        let allowed = {
            let meta = self.meta.lock().unwrap();
            let m = meta.get(id).ok_or(WidgetError::NotFound)?;
            m.exposes.iter().any(|e| e == key)
        };
        if !allowed {
            return Err(WidgetError::KeyNotExposed);
        }
        let data = self.data.lock().unwrap();
        let bucket = data.get(id).ok_or(WidgetError::NotFound)?;
        Ok(bucket.get(key).cloned().unwrap_or(serde_json::Value::Null))
    }

    /// Queue an action for the next agent turn. `NotFound` if id unknown;
    /// `ActionNotPermitted` if the action name isn't in the mount's allowlist.
    pub fn queue_action(&self, id: &str, action: WidgetAction) -> Result<(), WidgetError> {
        let permitted = {
            let meta = self.meta.lock().unwrap();
            let m = meta.get(id).ok_or(WidgetError::NotFound)?;
            m.permits.iter().any(|p| p == &action.action)
        };
        if !permitted {
            return Err(WidgetError::ActionNotPermitted);
        }
        let mut actions = self.actions.lock().unwrap();
        actions.entry(id.to_string()).or_default().push(action);
        Ok(())
    }

    /// Drain all queued actions across all mounts. Returns (mount_id, action)
    /// pairs grouped by mount, FIFO within each mount. Empty queues stay in
    /// place (cheap; bounded by mount count).
    pub fn drain_actions(&self) -> Vec<(MountId, WidgetAction)> {
        let mut actions = self.actions.lock().unwrap();
        let mut out = Vec::new();
        for (id, queue) in actions.iter_mut() {
            for action in queue.drain(..) {
                out.push((id.clone(), action));
            }
        }
        out
    }

    /// Read mount metadata (for audit logging on each tool_mount emission,
    /// and for HTTP handlers that need to know srcdoc_hash on data fetches).
    pub fn meta(&self, id: &str) -> Option<MountMeta> {
        self.meta.lock().unwrap().get(id).cloned()
    }

    /// Drop all state for a widget. Called when the renderer dismisses it
    /// or when the pane closes. Subsequent get_data / queue_action return
    /// NotFound.
    pub fn dismiss(&self, id: &str) {
        self.data.lock().unwrap().remove(id);
        self.actions.lock().unwrap().remove(id);
        self.meta.lock().unwrap().remove(id);
    }

    /// Snapshot of mount count, exposed for debug / `/api/ghost/status`.
    pub fn live_mount_count(&self) -> usize {
        self.meta.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_data(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn mount_returns_unique_ids() {
        let s = WidgetStore::new();
        let a = s.mount("a".into(), "doc", HashMap::new(), vec![], vec![]);
        let b = s.mount("b".into(), "doc", HashMap::new(), vec![], vec![]);
        assert_ne!(a, b, "consecutive mounts must produce distinct ids");
        assert!(a.starts_with("m-"), "id should be prefixed with 'm-'");
    }

    #[test]
    fn get_data_returns_stashed_value() {
        let s = WidgetStore::new();
        let id = s.mount(
            "echo".into(),
            "<!doctype html>...",
            make_data(&[("msg", serde_json::json!("hi"))]),
            vec!["msg".into()],
            vec![],
        );
        let v = s.get_data(&id, "msg").expect("exposed key should resolve");
        assert_eq!(v, serde_json::json!("hi"));
    }

    #[test]
    fn get_data_rejects_key_outside_exposes() {
        let s = WidgetStore::new();
        let id = s.mount(
            "echo".into(),
            "doc",
            make_data(&[("public", serde_json::json!("ok"))]),
            vec!["public".into()],
            vec![],
        );
        let err = s.get_data(&id, "secret").expect_err("non-exposed key should error");
        assert_eq!(err, WidgetError::KeyNotExposed);
        assert_eq!(err.status_code(), 403);
    }

    #[test]
    fn get_data_returns_not_found_for_unknown_id() {
        let s = WidgetStore::new();
        let err = s.get_data("m-fake", "anything").expect_err("unknown id should error");
        assert_eq!(err, WidgetError::NotFound);
        assert_eq!(err.status_code(), 404);
    }

    #[test]
    fn get_data_for_exposed_but_unwritten_key_returns_null() {
        let s = WidgetStore::new();
        let id = s.mount(
            "x".into(),
            "doc",
            HashMap::new(),
            vec!["empty".into()],
            vec![],
        );
        assert_eq!(s.get_data(&id, "empty").unwrap(), serde_json::Value::Null);
    }

    #[test]
    fn queue_and_drain_actions_preserves_fifo() {
        let s = WidgetStore::new();
        let id = s.mount(
            "x".into(),
            "doc",
            HashMap::new(),
            vec![],
            vec!["a".into(), "b".into()],
        );
        s.queue_action(&id, WidgetAction { action: "a".into(), args: serde_json::json!({"i": 1}) }).unwrap();
        s.queue_action(&id, WidgetAction { action: "b".into(), args: serde_json::json!({"i": 2}) }).unwrap();
        s.queue_action(&id, WidgetAction { action: "a".into(), args: serde_json::json!({"i": 3}) }).unwrap();
        let drained = s.drain_actions();
        assert_eq!(drained.len(), 3);
        let names: Vec<&str> = drained.iter().map(|(_, a)| a.action.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "a"], "FIFO order within the mount");
        let drained_again = s.drain_actions();
        assert!(drained_again.is_empty(), "drain should consume the queue");
    }

    #[test]
    fn queue_action_rejects_outside_permits() {
        let s = WidgetStore::new();
        let id = s.mount(
            "x".into(),
            "doc",
            HashMap::new(),
            vec![],
            vec!["save_artifact".into()],
        );
        let err = s
            .queue_action(&id, WidgetAction { action: "rm_rf".into(), args: serde_json::Value::Null })
            .expect_err("non-permitted action should error");
        assert_eq!(err, WidgetError::ActionNotPermitted);
        assert_eq!(err.status_code(), 403);
        // The queue must remain empty after a rejected action.
        assert!(s.drain_actions().is_empty());
    }

    #[test]
    fn queue_action_not_found_for_unknown_id() {
        let s = WidgetStore::new();
        let err = s
            .queue_action("m-ghost", WidgetAction { action: "x".into(), args: serde_json::Value::Null })
            .expect_err("unknown id should error");
        assert_eq!(err, WidgetError::NotFound);
    }

    #[test]
    fn dismiss_removes_state() {
        let s = WidgetStore::new();
        let id = s.mount(
            "x".into(),
            "doc",
            make_data(&[("msg", serde_json::json!("hi"))]),
            vec!["msg".into()],
            vec!["go".into()],
        );
        assert!(s.get_data(&id, "msg").is_ok());
        s.dismiss(&id);
        assert_eq!(s.get_data(&id, "msg").unwrap_err(), WidgetError::NotFound);
        assert_eq!(
            s.queue_action(&id, WidgetAction { action: "go".into(), args: serde_json::Value::Null })
                .unwrap_err(),
            WidgetError::NotFound
        );
    }

    #[test]
    fn meta_records_srcdoc_hash() {
        let s = WidgetStore::new();
        let id_a = s.mount("x".into(), "alpha", HashMap::new(), vec![], vec![]);
        let id_b = s.mount("x".into(), "beta", HashMap::new(), vec![], vec![]);
        let meta_a = s.meta(&id_a).unwrap();
        let meta_b = s.meta(&id_b).unwrap();
        assert_ne!(meta_a.srcdoc_hash, meta_b.srcdoc_hash);
        // Hash should be deterministic for the same input within a single
        // process — re-hash the input and confirm it matches.
        let mut h = DefaultHasher::new();
        "alpha".hash(&mut h);
        assert_eq!(meta_a.srcdoc_hash, format!("{:016x}", h.finish()));
    }

    #[test]
    fn live_mount_count_tracks_dismiss() {
        let s = WidgetStore::new();
        assert_eq!(s.live_mount_count(), 0);
        let id = s.mount("x".into(), "doc", HashMap::new(), vec![], vec![]);
        assert_eq!(s.live_mount_count(), 1);
        let _ = s.mount("y".into(), "doc", HashMap::new(), vec![], vec![]);
        assert_eq!(s.live_mount_count(), 2);
        s.dismiss(&id);
        assert_eq!(s.live_mount_count(), 1);
    }
}
