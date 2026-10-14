//! Telemetry from agents running directly on the host (not inside n8):
//! Claude Code's OpenTelemetry, a folder watcher on agent panes, and their
//! network (exact through the counting proxy, else approximate from process I/O).
//!
//! Each event is recorded in the local TelemetryStore (proto_viz Live reads
//! that) and forwarded to the n8 gateway, the server of record, through
//! `POST /telemetry/ingest` (forward.rs). Panes running n8 containers are
//! skipped: n8's own monitor already reports those.

pub mod forward;
pub mod watcher;
pub mod otlp;
pub mod netio;
pub mod proxy;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Window in which the watcher skips a path OTel already reported. Claude
/// exports logs every 5s, so the watcher also holds changes (watcher::OTEL_HOLD).
const DEDUP_WINDOW: Duration = Duration::from_secs(15);

static OTEL_RECENT: Mutex<Option<HashMap<(String, String), Instant>>> = Mutex::new(None);

/// Record that OTel just reported a file event for `pane` + `path`.
pub(crate) fn note_otel_file(pane: &str, path: &str) {
    let mut g = OTEL_RECENT.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if m.len() > 1000 {
        m.retain(|_, t| t.elapsed() < DEDUP_WINDOW);
    }
    m.insert((pane.to_string(), norm(path)), Instant::now());
}

/// Windows paths compare case-insensitively, either slash.
fn norm(path: &str) -> String {
    if cfg!(windows) { path.replace('/', "\\").to_lowercase() } else { path.to_string() }
}

/// Has OTel recently reported a file event for `pane` + `path`?
pub(crate) fn otel_recent(pane: &str, path: &str) -> bool {
    let g = OTEL_RECENT.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref()
        .and_then(|m| m.get(&(pane.to_string(), norm(path))))
        .is_some_and(|t| t.elapsed() < DEDUP_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn otel_dedup_within_window() {
        note_otel_file("test-pane-dedup-a", "/w/file-dedup-a.rs");
        assert!(otel_recent("test-pane-dedup-a", "/w/file-dedup-a.rs"));
        assert!(!otel_recent("test-pane-dedup-a", "/w/other-dedup-a.rs"));
        assert!(!otel_recent("other-pane-dedup-a", "/w/file-dedup-a.rs"));
        if cfg!(windows) {
            note_otel_file("test-pane-dedup-b", "C:/Work/Src/Main.rs");
            assert!(otel_recent("test-pane-dedup-b", r"c:\work\src\main.rs"), "case and slashes don't matter");
        }
    }
}
