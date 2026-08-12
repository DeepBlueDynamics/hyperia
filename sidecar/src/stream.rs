//! Event Stream API — WebSocket fan-out of terminal state to external apps.
//!
//! Two modes (full contract: `plan/specs/EVENT_STREAM_API.md`):
//!   - `/ws/wall`       — every pane at once (overview / 3D monitor wall).
//!   - `/ws/pane/{id}`  — one pane, full fidelity (walk-up deep view).
//!
//! This is the FOUNDATION (spec build-order task 1): the [`StreamHub`] fan-out
//! types + connectable handlers that send `hello` and a live snapshot. The live
//! delta / raw-byte bodies (tasks 2–6: ingest hooks, grid diffs, raw-ring replay)
//! are layered on per the spec — deliberately kept OUT of the already-large
//! `bridge.rs`.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast;

use crate::bridge::Bridge;

/// Wire protocol version advertised in `hello`. Bump on breaking changes.
const PROTO_VERSION: u32 = 1;
const HEARTBEAT: Duration = Duration::from_secs(15);

/// One terminal event, fanned out to every connected stream client. Published by
/// the bridge ingest path and consumed by the per-connection tasks below.
#[allow(dead_code)] // publishers/consumers wired per EVENT_STREAM_API.md build order
#[derive(Clone, Debug)]
pub enum StreamEvent {
    PaneRegistered { uid: String },
    PaneData { uid: String, bytes: Vec<u8> },
    PaneResized { uid: String, cols: u16, rows: u16 },
    PaneRemoved { uid: String },
    PaneState { uid: String, state: String, app: Option<String>, cwd: String },
    TopologyChanged,
}

/// Broadcast fan-out. One per sidecar (held on the bridge); each stream
/// connection `subscribe()`s. A slow client lags its own receiver without
/// stalling ingest or other clients.
#[allow(dead_code)] // held on Bridge + published-to per EVENT_STREAM_API.md
#[derive(Clone)]
pub struct StreamHub {
    tx: broadcast::Sender<StreamEvent>,
}

#[allow(dead_code)]
impl StreamHub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(1024);
        Self { tx }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<StreamEvent> {
        self.tx.subscribe()
    }
    /// Non-blocking publish; ignores the "no receivers" case.
    pub fn publish(&self, ev: StreamEvent) {
        let _ = self.tx.send(ev);
    }
}

impl Default for StreamHub {
    fn default() -> Self {
        Self::new()
    }
}

// --- helpers ---------------------------------------------------------------

fn hello(mode: &str) -> String {
    serde_json::json!({
        "t": "hello",
        "v": PROTO_VERSION,
        "mode": mode,
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "heartbeatMs": HEARTBEAT.as_millis() as u64,
    })
    .to_string()
}

async fn send_text(tx: &mut futures::stream::SplitSink<WebSocket, Message>, s: String) -> bool {
    tx.send(Message::Text(s.into())).await.is_ok()
}

/// Flat snapshot of every pane. The wall handler ships this on connect; dev
/// agents replace it with the full `topology` tree (reuse terminal_status's
/// builder) + live deltas per the spec.
async fn panes_snapshot(bridge: &Bridge) -> Vec<serde_json::Value> {
    let sessions = bridge.sessions().await;
    sessions
        .iter()
        .map(|(uid, s)| {
            let title = if s.title.is_empty() { s.shell_name.clone() } else { s.title.clone() };
            serde_json::json!({
                "paneId": uid,
                "title": title,
                "shellName": s.shell_name,
                "cols": s.cols,
                "rows": s.rows,
                "windowId": s.window_id,
                "tabId": s.root_tab_uid,
                "tabName": s.tab_name,
                "active": s.pane_active,
                "tabActive": s.tab_active,
                "state": s.shell_state,
                "cwd": s.cwd,
            })
        })
        .collect()
}

// --- wall mode: /ws/wall ---------------------------------------------------

pub async fn wall_handler(ws: WebSocketUpgrade, State(state): State<crate::AppState>) -> impl IntoResponse {
    let bridge = state.bridge;
    ws.on_upgrade(move |socket| wall_loop(socket, bridge))
}

async fn wall_loop(socket: WebSocket, bridge: Bridge) {
    let (mut tx, mut rx) = socket.split();
    if !send_text(&mut tx, hello("wall")).await {
        return;
    }
    let panes = panes_snapshot(&bridge).await;
    let snapshot = serde_json::json!({"t": "panes", "v": PROTO_VERSION, "panes": panes}).to_string();
    if !send_text(&mut tx, snapshot).await {
        return;
    }
    // Keepalive until the client closes. Live deltas (subscribe to StreamHub +
    // ScreenBuffer::diff() coalescing) are wired here per the spec.
    let mut ticker = tokio::time::interval(HEARTBEAT);
    ticker.tick().await; // consume the immediate first tick
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if !send_text(&mut tx, r#"{"t":"ping"}"#.to_string()).await { break; }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}

// --- focused mode: /ws/pane/{id} -------------------------------------------

pub async fn pane_handler(
    ws: WebSocketUpgrade,
    Path(pane): Path<String>,
    State(state): State<crate::AppState>,
) -> impl IntoResponse {
    let bridge = state.bridge;
    ws.on_upgrade(move |socket| pane_loop(socket, bridge, pane))
}

async fn pane_loop(socket: WebSocket, bridge: Bridge, pane: String) {
    let (mut tx, mut rx) = socket.split();
    if !send_text(&mut tx, hello("focused")).await {
        return;
    }
    // Resolve the pane prefix → uid + meta (no await while the lock is held).
    let resolved = {
        let sessions = bridge.sessions().await;
        sessions
            .iter()
            .find(|(uid, _)| uid.as_str() == pane || uid.starts_with(&pane))
            .map(|(uid, s)| {
                let title = if s.title.is_empty() { s.shell_name.clone() } else { s.title.clone() };
                (
                    uid.clone(),
                    serde_json::json!({
                        "t": "meta", "paneId": uid, "title": title,
                        "cols": s.cols, "rows": s.rows, "state": s.shell_state, "cwd": s.cwd,
                    })
                    .to_string(),
                )
            })
    };
    let uid = match resolved {
        Some((uid, meta)) => {
            if !send_text(&mut tx, meta).await {
                return;
            }
            uid
        }
        None => {
            let err = serde_json::json!({"t":"error","code":"no-such-pane","message":pane}).to_string();
            let _ = send_text(&mut tx, err).await;
            return;
        }
    };
    // Scaffold: current screen-text snapshot. Dev agents replace with raw-ring
    // replay (binary) + live raw PTY bytes per the spec.
    let screen = bridge.get_screen_text_by_uid(&uid).await;
    let snap = serde_json::json!({"t":"screen-snapshot","paneId":uid,"text":screen}).to_string();
    let _ = send_text(&mut tx, snap).await;
    let mut ticker = tokio::time::interval(HEARTBEAT);
    ticker.tick().await;
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if !send_text(&mut tx, r#"{"t":"ping"}"#.to_string()).await { break; }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}
