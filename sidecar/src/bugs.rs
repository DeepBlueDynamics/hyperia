//! Agent-filed bug reports (#141).
//!
//! When a Hyperia tool — or the app itself — fails in a way the calling agent
//! believes is a Hyperia defect (not its own mistake), it calls the `report_bug`
//! MCP tool, which appends one JSONL line here: who reported it, a one-line
//! title, free-form details, the failing tool + exact error, reproduction
//! context, and the sidecar version. The human (or Claude Code) triages these
//! into GitHub issues — turning a silently-swallowed "it just failed" into a
//! durable, fixable report.
//!
//! File: `~/.hyperia/logs/bugs.jsonl` (append-only; low volume, no rotation).

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

fn log_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    std::path::PathBuf::from(home).join(".hyperia").join("logs").join("bugs.jsonl")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Append one bug report and return its generated id (`bug_<hex-ts>`).
#[allow(clippy::too_many_arguments)]
pub fn record(
    reporter: &str,
    reporter_kind: &str,
    title: &str,
    details: &str,
    tool: &str,
    error: &str,
    context: &str,
    version: &str,
) -> String {
    let ts = now_ms();
    let id = format!("bug_{ts:x}");
    let entry = serde_json::json!({
        "id": id,
        "ts": ts,
        "reporter": reporter,
        "reporterKind": reporter_kind,
        "title": title,
        "details": details,
        "tool": tool,
        "error": error,
        "context": context,
        "version": version,
        "status": "open",
    });
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let mut line = entry.to_string();
        line.push('\n');
        let _ = f.write_all(line.as_bytes());
    }
    id
}

/// Search the bug log, newest-first. `q` is a case-insensitive substring match
/// against the whole serialized line (title, error, tool, reporter — all of it).
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
