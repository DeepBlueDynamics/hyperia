//! Telemetry from agents running directly on the host (not inside n8):
//! Claude Code's OpenTelemetry and a folder watcher on agent panes.
//!
//! Each event is recorded in the local TelemetryStore (proto_viz Live reads
//! that) and forwarded to the n8 gateway, the server of record, through
//! `POST /telemetry/ingest` (forward.rs). Panes running n8 containers are
//! skipped: n8's own monitor already reports those.

pub mod forward;
