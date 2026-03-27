use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::screen::ScreenBuffer;
use crate::AppState;

// ---------------------------------------------------------------------------
// Session info tracked per Electron PTY session
// ---------------------------------------------------------------------------

pub struct SessionInfo {
    pub name: String,
    pub tab_name: String,
    pub description: String,
    pub rows: u16,
    pub cols: u16,
    pub pid: u32,
    pub root_tab_uid: String,
    pub screen: ScreenBuffer,
}

// ---------------------------------------------------------------------------
// Bridge: shared state between WebSocket handler, chat.rs, and mcp.rs
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Bridge {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    /// Channel to send JSON messages downstream to Electron
    cmd_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// Pending request→response: seq → oneshot sender
    pending: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    /// Monotonic sequence counter
    seq: AtomicU64,
    /// Registered PTY sessions (uid → info)
    sessions: Mutex<HashMap<String, SessionInfo>>,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(BridgeInner {
                cmd_tx: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                seq: AtomicU64::new(1),
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Whether an Electron client is connected.
    #[allow(dead_code)]
    pub async fn is_connected(&self) -> bool {
        self.inner.cmd_tx.lock().await.is_some()
    }

    /// Send a command to Electron and wait for the ToolResult response.
    /// Automatically assigns a sequence number. Times out after 10s.
    pub async fn send_command(&self, mut msg: serde_json::Value) -> Result<String, String> {
        let seq = self.inner.seq.fetch_add(1, Ordering::Relaxed);
        msg["seq"] = serde_json::json!(seq);

        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(seq, tx);

        // Send downstream
        {
            let guard = self.inner.cmd_tx.lock().await;
            match guard.as_ref() {
                Some(sender) => {
                    if sender.send(msg.to_string()).is_err() {
                        self.inner.pending.lock().await.remove(&seq);
                        return Err("Electron disconnected".into());
                    }
                }
                None => {
                    self.inner.pending.lock().await.remove(&seq);
                    return Err("No Electron client connected".into());
                }
            }
        }

        // Await response with timeout
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err("Response channel dropped".into()),
            Err(_) => {
                self.inner.pending.lock().await.remove(&seq);
                Err("Timeout waiting for Electron response".into())
            }
        }
    }

    /// Read the vt100 screen buffer for a pane (by index or focused=0).
    /// No round-trip to Electron — reads from the local ScreenBuffer fed by SessionData.
    pub async fn get_screen_text(&self, pane: Option<usize>) -> String {
        let sessions = self.inner.sessions.lock().await;
        let idx = pane.unwrap_or(0);
        let keys: Vec<&String> = sessions.keys().collect();
        if let Some(uid) = keys.get(idx) {
            if let Some(info) = sessions.get(*uid) {
                let dump = info.screen.screen_dump();
                dump.lines
                    .iter()
                    .map(|l| l.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                "No screen data".into()
            }
        } else {
            "No pane at that index".into()
        }
    }

    /// Set description for a pane by index.
    pub async fn set_description(&self, pane: usize, description: &str) {
        let mut sessions = self.inner.sessions.lock().await;
        if let Some((_uid, info)) = sessions.iter_mut().nth(pane) {
            info.description = description.to_string();
        }
    }

    /// Resolve a pane index to its session uid.
    pub async fn pane_uid(&self, pane: usize) -> Option<String> {
        let sessions = self.inner.sessions.lock().await;
        sessions.keys().nth(pane).cloned()
    }

    /// Compute the split label (a, b, c...) for a session within its tab group.
    fn split_label(sessions: &HashMap<String, SessionInfo>, uid: &str) -> String {
        let info = match sessions.get(uid) {
            Some(i) => i,
            None => return String::new(),
        };
        let root = &info.root_tab_uid;
        let mut siblings: Vec<&String> = sessions
            .iter()
            .filter(|(_, i)| i.root_tab_uid == *root)
            .map(|(u, _)| u)
            .collect();
        if siblings.len() <= 1 {
            return String::new(); // no splits
        }
        siblings.sort(); // deterministic order
        let idx = siblings.iter().position(|u| *u == uid).unwrap_or(0);
        String::from((b'a' + idx as u8) as char)
    }

    /// Get status of all registered sessions.
    pub async fn get_status(&self) -> serde_json::Value {
        let sessions = self.inner.sessions.lock().await;
        let panes: Vec<serde_json::Value> = sessions
            .iter()
            .enumerate()
            .map(|(idx, (uid, info))| {
                let label = Self::split_label(&sessions, uid);
                serde_json::json!({
                    "id": idx,
                    "uid": uid,
                    "name": info.name,
                    "tabName": info.tab_name,
                    "splitLabel": label,
                    "description": info.description,
                    "rows": info.rows,
                    "cols": info.cols,
                    "pid": info.pid,
                })
            })
            .collect();
        serde_json::json!({ "panes": panes })
    }

    /// Handle an incoming message from Electron.
    async fn handle_message(&self, text: &str) {
        let msg: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("Bad message from Electron: {e}");
                return;
            }
        };

        let msg_type = msg["type"].as_str().unwrap_or("");

        match msg_type {
            "SessionRegister" => {
                let uid = msg["uid"].as_str().unwrap_or("").to_string();
                let name = msg["name"].as_str().unwrap_or("shell").to_string();
                let tab_name = msg["tabName"].as_str().unwrap_or(&name).to_string();
                let description = msg["description"].as_str().unwrap_or("").to_string();
                let rows = msg["rows"].as_u64().unwrap_or(24) as u16;
                let cols = msg["cols"].as_u64().unwrap_or(80) as u16;
                let pid = msg["pid"].as_u64().unwrap_or(0) as u32;
                let root_tab_uid = msg["rootTabUid"].as_str().unwrap_or(&uid).to_string();
                tracing::info!("Session registered: {uid} ({tab_name}) {cols}x{rows} pid={pid} tab={root_tab_uid}");
                self.inner.sessions.lock().await.insert(
                    uid,
                    SessionInfo {
                        name,
                        tab_name,
                        description,
                        rows,
                        cols,
                        pid,
                        root_tab_uid,
                        screen: ScreenBuffer::new(rows, cols, 1000),
                    },
                );
            }

            "SessionTabName" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let tab_name = msg["tabName"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.tab_name = tab_name.clone();
                    tracing::info!("Session {uid} tab name: {tab_name}");
                }
            }

            "SessionDescribe" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let description = msg["description"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.description = description.clone();
                    tracing::info!("Session {uid} described: {description}");
                }
            }

            "SessionData" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                if let Some(data_b64) = msg["data"].as_str() {
                    if let Ok(bytes) = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        data_b64,
                    ) {
                        let mut sessions = self.inner.sessions.lock().await;
                        if let Some(info) = sessions.get_mut(uid) {
                            info.screen.process(&bytes);
                        }
                    }
                }
            }

            "SessionExit" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                tracing::info!("Session exited: {uid}");
                self.inner.sessions.lock().await.remove(uid);
            }

            "Resize" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let rows = msg["rows"].as_u64().unwrap_or(24) as u16;
                let cols = msg["cols"].as_u64().unwrap_or(80) as u16;
                let mut sessions = self.inner.sessions.lock().await;
                if let Some(info) = sessions.get_mut(uid) {
                    info.rows = rows;
                    info.cols = cols;
                    info.screen.resize(rows, cols);
                }
            }

            "ToolResult" => {
                let seq = msg["seq"].as_u64().unwrap_or(0);
                let result = msg["result"].as_str().unwrap_or("").to_string();
                let mut pending = self.inner.pending.lock().await;
                if let Some(tx) = pending.remove(&seq) {
                    let _ = tx.send(result);
                }
            }

            "Heartbeat" => {
                // Reconcile: remove any sessions the bridge no longer tracks
                if let Some(uids) = msg["sessionUids"].as_array() {
                    let bridge_uids: std::collections::HashSet<String> = uids
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                    let mut sessions = self.inner.sessions.lock().await;
                    let stale: Vec<String> = sessions
                        .keys()
                        .filter(|uid| !bridge_uids.contains(*uid))
                        .cloned()
                        .collect();
                    for uid in &stale {
                        tracing::info!("Heartbeat reconcile: removing stale session {uid}");
                        sessions.remove(uid);
                    }
                }
            }

            _ => {
                tracing::warn!("Unknown message type from Electron: {msg_type}");
            }
        }
    }

    /// Called when a WebSocket client disconnects.
    async fn on_disconnect(&self) {
        *self.inner.cmd_tx.lock().await = None;
        // Fail all pending requests
        let mut pending = self.inner.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send("Electron disconnected".into());
        }
        // Clear sessions
        self.inner.sessions.lock().await.clear();
        tracing::info!("Electron disconnected — sessions cleared");
    }
}

// ---------------------------------------------------------------------------
// Axum WebSocket handler
// ---------------------------------------------------------------------------

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    tracing::info!("Electron WebSocket upgrade request");
    let bridge = state.bridge;
    ws.on_upgrade(move |socket| handle_socket(socket, bridge))
}

async fn handle_socket(socket: WebSocket, bridge: Bridge) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Clear stale sessions from any previous connection that didn't disconnect cleanly
    {
        let mut sessions = bridge.inner.sessions.lock().await;
        if !sessions.is_empty() {
            tracing::info!("Clearing {} stale sessions from previous connection", sessions.len());
            sessions.clear();
        }
    }

    // Create the command channel for this connection
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<String>();
    *bridge.inner.cmd_tx.lock().await = Some(cmd_tx);

    tracing::info!("Electron WebSocket connected");

    // Writer task: forwards queued commands to the WebSocket
    let writer = tokio::spawn(async move {
        while let Some(msg) = cmd_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Reader loop: process incoming messages from Electron
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                bridge.handle_message(&text).await;
            }
            Message::Binary(data) => {
                if let Ok(text) = String::from_utf8(data.to_vec()) {
                    bridge.handle_message(&text).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup
    writer.abort();
    bridge.on_disconnect().await;
}
