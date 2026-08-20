//! Per-pane telemetry collection: file ops, network traffic, token counts.
//!
//! Data is kept in memory and queryable at window / tab / pane granularity.
//! The bridge pushes events here; the dashboard and MCP tools read them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

// Liberal-in-what-we-accept: every variant carries lowercase/short aliases so a
// producer sending "in"/"Out"/"rx"/"write" parses instead of 400ing (an exact-
// casing mismatch caused a 7.5k-reject storm from the n8 pusher on 2026-08-20 —
// never again). Serialization stays canonical.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TelemetryEvent {
    #[serde(alias = "fileop", alias = "file_op", alias = "file")]
    FileOp {
        path: String,
        op: FileOp,
        bytes: Option<u64>,
    },
    #[serde(alias = "network", alias = "net")]
    Network {
        direction: NetDirection,
        host: String,
        bytes: u64,
    },
    #[serde(alias = "tokens", alias = "token")]
    Tokens {
        input: u64,
        output: u64,
        cache: u64,
        model: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FileOp {
    #[serde(alias = "create")]
    Create,
    #[serde(alias = "write")]
    Write,
    #[serde(alias = "delete")]
    Delete,
    #[serde(alias = "rename")]
    Rename,
    #[serde(alias = "read")]
    Read,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetDirection {
    #[serde(alias = "In", alias = "in", alias = "inbound", alias = "rx", alias = "Rx", alias = "RX")]
    Inbound,
    #[serde(alias = "Out", alias = "out", alias = "outbound", alias = "tx", alias = "Tx", alias = "TX")]
    Outbound,
}

// ---------------------------------------------------------------------------
// Per-pane accumulator
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct PaneMetrics {
    pub file_creates: u64,
    pub file_writes: u64,
    pub file_deletes: u64,
    pub file_renames: u64,
    pub file_reads: u64,
    pub file_bytes_written: u64,
    pub net_inbound_bytes: u64,
    pub net_outbound_bytes: u64,
    pub net_hosts: Vec<String>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_cache: u64,
    pub events: Vec<TelemetryEvent>,
}

impl PaneMetrics {
    fn record(&mut self, event: TelemetryEvent) {
        match &event {
            TelemetryEvent::FileOp { op, bytes, .. } => {
                match op {
                    FileOp::Create => self.file_creates += 1,
                    FileOp::Write => {
                        self.file_writes += 1;
                        self.file_bytes_written += bytes.unwrap_or(0);
                    }
                    FileOp::Delete => self.file_deletes += 1,
                    FileOp::Rename => self.file_renames += 1,
                    FileOp::Read => self.file_reads += 1,
                }
            }
            TelemetryEvent::Network { direction, host, bytes } => {
                match direction {
                    NetDirection::Inbound => self.net_inbound_bytes += *bytes,
                    NetDirection::Outbound => self.net_outbound_bytes += *bytes,
                }
                if !self.net_hosts.contains(host) {
                    self.net_hosts.push(host.clone());
                }
            }
            TelemetryEvent::Tokens { input, output, cache, .. } => {
                self.tokens_in += input;
                self.tokens_out += output;
                self.tokens_cache += cache;
            }
        }
        // Bounded per-pane history (was unbounded — leak).
        if self.events.len() >= 100 {
            self.events.remove(0);
        }
        self.events.push(event);
    }
}

/// One event with the context the LIVE STREAM needs: when + which pane.
/// (Per-pane `events` vectors lack both, so the window rollup couldn't build
/// an ordered cross-pane feed — the dashboard's stream card sat empty.)
#[derive(Debug, Clone)]
pub struct RecordedEvent {
    pub ts_ms: u64,
    pub pane_uid: String,
    pub event: TelemetryEvent,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct WindowMetrics {
    /// Pane UID → metrics
    pub panes: HashMap<String, PaneMetrics>,
    pub enabled: bool,
    /// Cross-pane recent-events ring (cap 200) feeding the live stream.
    #[serde(skip)]
    pub recent: std::collections::VecDeque<RecordedEvent>,
}

#[derive(Clone)]
pub struct TelemetryStore {
    inner: Arc<Mutex<WindowMetrics>>,
}

impl TelemetryStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WindowMetrics {
                panes: HashMap::new(),
                enabled: true,
                recent: std::collections::VecDeque::new(),
            })),
        }
    }

    /// Record an event for a pane.
    pub fn record(&self, pane_uid: &str, event: TelemetryEvent) {
        let mut store = self.inner.lock().unwrap();
        if !store.enabled {
            return;
        }
        // Feed the cross-pane live-stream ring (with time + pane context).
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if store.recent.len() >= 200 {
            store.recent.pop_front();
        }
        store.recent.push_back(RecordedEvent {
            ts_ms,
            pane_uid: pane_uid.to_string(),
            event: event.clone(),
        });
        store
            .panes
            .entry(pane_uid.to_string())
            .or_default()
            .record(event);
    }

    /// Toggle collection on/off. Returns new state.
    pub fn set_enabled(&self, enabled: bool) -> bool {
        let mut store = self.inner.lock().unwrap();
        store.enabled = enabled;
        enabled
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.lock().unwrap().enabled
    }

    /// Snapshot of a single pane.
    pub fn pane_snapshot(&self, pane_uid: &str) -> Option<PaneMetrics> {
        let store = self.inner.lock().unwrap();
        store.panes.get(pane_uid).cloned()
    }

    /// Aggregate across all panes (window-level).
    pub fn window_snapshot(&self) -> WindowMetrics {
        self.inner.lock().unwrap().clone()
    }

    /// Reset all counters.
    pub fn reset(&self) {
        let mut store = self.inner.lock().unwrap();
        store.panes.clear();
        store.recent.clear();
    }

    /// JSON snapshot at requested level.
    pub fn snapshot_json(&self, level: &str, pane_uid: Option<&str>) -> serde_json::Value {
        let store = self.inner.lock().unwrap();
        match level {
            "pane" => {
                if let Some(uid) = pane_uid {
                    serde_json::to_value(store.panes.get(uid)).unwrap_or(serde_json::json!(null))
                } else {
                    serde_json::to_value(&store.panes).unwrap_or(serde_json::json!({}))
                }
            }
            "window" => {
                // Aggregate across all panes
                let mut agg = PaneMetrics::default();
                for pm in store.panes.values() {
                    agg.file_creates += pm.file_creates;
                    agg.file_writes += pm.file_writes;
                    agg.file_deletes += pm.file_deletes;
                    agg.file_renames += pm.file_renames;
                    agg.file_reads += pm.file_reads;
                    agg.file_bytes_written += pm.file_bytes_written;
                    agg.net_inbound_bytes += pm.net_inbound_bytes;
                    agg.net_outbound_bytes += pm.net_outbound_bytes;
                    agg.tokens_in += pm.tokens_in;
                    agg.tokens_out += pm.tokens_out;
                    agg.tokens_cache += pm.tokens_cache;
                    // Hosts were never merged — window-level net_hosts sat empty.
                    for h in &pm.net_hosts {
                        if !h.is_empty() && !agg.net_hosts.contains(h) {
                            agg.net_hosts.push(h.clone());
                        }
                    }
                }
                let mut out = serde_json::to_value(&agg).unwrap_or(serde_json::json!({}));
                // Live stream: the cross-pane ring, flattened with ts + pane_uid.
                let events: Vec<serde_json::Value> = store
                    .recent
                    .iter()
                    .map(|re| {
                        let mut ev = serde_json::to_value(&re.event).unwrap_or(serde_json::json!({}));
                        if let Some(obj) = ev.as_object_mut() {
                            obj.insert("ts".into(), serde_json::json!(re.ts_ms));
                            obj.insert("pane_uid".into(), serde_json::json!(re.pane_uid));
                        }
                        ev
                    })
                    .collect();
                if let Some(obj) = out.as_object_mut() {
                    obj.insert("events".into(), serde_json::Value::Array(events));
                }
                out
            }
            _ => serde_json::json!({"error": "level must be 'pane' or 'window'"}),
        }
    }
}
