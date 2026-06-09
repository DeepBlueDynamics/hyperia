//! Audit log — one JSONL line per gated/identified call.
//!
//! Every agent action that reaches the gated API is recorded with who did it,
//! what, against which target, and the decision (carried by the HTTP status).
//! Files roll daily and auto-prune, so you get an after-the-fact record without
//! unbounded growth. Built on `tracing-appender`'s rolling file appender (the
//! same machinery the sidecar log uses) so there are no new deps.
//!
//! File: `~/.hyperia/logs/audit.<YYYY-MM-DD>.jsonl`, kept ~14 days.

use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing_appender::non_blocking::NonBlocking;

static AUDIT: OnceLock<NonBlocking> = OnceLock::new();

/// How many daily files to keep before the oldest is pruned.
const KEEP_DAYS: usize = 14;

/// Initialise the audit writer. Call once at startup with the logs dir.
pub fn init(log_dir: &Path) {
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("audit")
        .filename_suffix("jsonl")
        .max_log_files(KEEP_DAYS)
        .build(log_dir);
    match appender {
        Ok(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            // Keep the worker draining for the process lifetime.
            Box::leak(Box::new(guard));
            let _ = AUDIT.set(writer);
        }
        Err(e) => {
            tracing::warn!("audit log init failed: {e}");
        }
    }
}

/// Append one audit entry (a JSON object) as a line.
pub fn record(entry: serde_json::Value) {
    if let Some(w) = AUDIT.get() {
        let mut w = w.clone(); // NonBlocking is cheap to clone (channel sender)
        let mut line = entry.to_string();
        line.push('\n');
        let _ = w.write_all(line.as_bytes());
    }
}

/// Record a gated API call: who, what action (method + path), and the decision
/// (HTTP status: 200 allow · 202 consent-pending · 401 soft-wall · 403 denied).
pub fn record_call(identity: &str, kind: &str, method: &str, path: &str, status: u16) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    record(serde_json::json!({
        "ts": ts,
        "identity": identity,
        "kind": kind,
        "method": method,
        "path": path,
        "status": status,
    }));
}
