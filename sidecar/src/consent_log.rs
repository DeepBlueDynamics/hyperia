//! First-class consent ledger (#135).
//!
//! Every consent interaction is recorded as one JSONL line: who asked (label +
//! friendly display name + identity kind), for what capability/action, on
//! which target, and — when the human decides — the decision. This is the
//! queryable answer to "why did I get this toast" / "did agent X ever ask",
//! which previously meant grepping flooded raw logs.
//!
//! File: `~/.hyperia/logs/consent.jsonl` (append-only; consent volume is tiny,
//! so no rotation — a busy month is a few KB).

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

fn log_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    std::path::PathBuf::from(home).join(".hyperia").join("logs").join("consent.jsonl")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Append one consent event. `entry` should carry the event-specific fields;
/// `ts` is stamped here.
pub fn record(mut entry: serde_json::Value) {
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("ts".into(), serde_json::json!(now_ms()));
    }
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let mut line = entry.to_string();
        line.push('\n');
        let _ = f.write_all(line.as_bytes());
    }
}

/// A consent request was raised (a prompt/toast is now in front of the human).
#[allow(clippy::too_many_arguments)]
pub fn record_request(
    id: &str,
    requester: &str,
    requester_name: &str,
    kind: &str,
    action: &str,
    target: &str,
    purpose: &str,
) {
    record(serde_json::json!({
        "event": "requested",
        "id": id,
        "requester": requester,
        "requesterName": requester_name,
        "kind": kind,
        "action": action,
        "target": target,
        "purpose": purpose,
    }));
}

/// The human decided (or the request was resolved programmatically).
pub fn record_decision(id: &str, decision: &str, scope: &str, requester: &str, action: &str, target: &str) {
    record(serde_json::json!({
        "event": "decision",
        "id": id,
        "decision": decision,
        "scope": scope,
        "requester": requester,
        "action": action,
        "target": target,
    }));
}

/// Search the ledger, newest-first. `q` is a case-insensitive substring match
/// against the whole serialized line (requester, action, target, id — all of
/// it), so `q=sticky:access` or `q=Severe Booby` both work.
pub fn search(q: Option<&str>, limit: usize) -> Vec<serde_json::Value> {
    let Ok(content) = std::fs::read_to_string(log_path()) else {
        return Vec::new();
    };
    let q_lc = q.map(|s| s.to_lowercase());
    let mut out = Vec::new();
    for line in content.lines().rev() {
        if out.len() >= limit {
            break;
        }
        if let Some(q) = &q_lc {
            if !line.to_lowercase().contains(q.as_str()) {
                continue;
            }
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            out.push(v);
        }
    }
    out
}
