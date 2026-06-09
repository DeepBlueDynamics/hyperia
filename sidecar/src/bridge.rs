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
    /// Friendly, layout-stable pane name (e.g. "Suspicious Marlin 🧄"),
    /// generated per-pane in the renderer and pushed via `SessionName`.
    /// Distinct from `name` (the shell binary path) and `title` (overloaded
    /// with OSC/custom titles). This is the stable human handle for a pane.
    pub shell_name: String,
    pub tab_name: String,
    pub description: String,
    pub rows: u16,
    pub cols: u16,
    pub pid: u32,
    pub root_tab_uid: String,
    pub window_id: u32,
    pub split_label: String,
    pub tab_order: u32,
    pub tab_active: bool,
    pub pane_active: bool,
    pub screen: ScreenBuffer,
    /// BSP bounding box in 0–100 percentage units
    pub bsp_x: f32,
    pub bsp_y: f32,
    pub bsp_w: f32,
    pub bsp_h: f32,
    pub cwd: String,
    pub last_user_activity: Option<std::time::Instant>,
    pub title: String,
}

/// Match a pane's friendly `name` (e.g. "Suspicious Marlin 🧄") against an
/// agent-supplied target. Case-insensitive and tolerant of a missing trailing
/// emoji / whitespace, so "suspicious marlin" resolves the same pane. An empty
/// target never matches (so it can't accidentally hit an unnamed pane).
fn name_matches(name: &str, target: &str) -> bool {
    if target.trim().is_empty() {
        return false;
    }
    let norm =
        |s: &str| s.trim().trim_end_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    norm(name) == norm(target)
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
    /// Last focused Hyperia window id.
    focused_window_id: Mutex<Option<u32>>,
    /// Per-session output subscribers: uid → list of senders waiting for PTY bytes
    output_subs: Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
    /// Lume-backed per-shell log store (BM25 search + pickle-to-disk).
    lume: crate::lume_store::LumeStore,
    /// Cross-pane access consent ledger (pending prompts + active grants).
    perms: crate::perms::PermStore,
    /// Persistent external-agent identities (file-backed, survive restarts).
    identity: crate::identity::IdentityStore,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(BridgeInner {
                cmd_tx: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                seq: AtomicU64::new(1),
                sessions: Mutex::new(HashMap::new()),
                focused_window_id: Mutex::new(None),
                output_subs: Mutex::new(HashMap::new()),
                lume: crate::lume_store::LumeStore::new(),
                perms: crate::perms::PermStore::default(),
                identity: crate::identity::IdentityStore::new(),
            }),
        }
    }

    /// Access the lume store (per-shell log search, sticky search, persistence).
    pub fn lume(&self) -> crate::lume_store::LumeStore {
        self.inner.lume.clone()
    }

    /// Access the cross-pane permission ledger.
    pub fn perms(&self) -> &crate::perms::PermStore {
        &self.inner.perms
    }

    /// Access the persistent agent-identity store.
    pub fn identity(&self) -> &crate::identity::IdentityStore {
        &self.inner.identity
    }

    /// Resolve an `Authorization: Bearer` token to a caller identity. Checks
    /// persistent agent tokens first, then ephemeral pane tokens, else anonymous.
    pub async fn resolve_caller(&self, bearer: Option<&str>) -> crate::identity::CallerIdentity {
        use crate::identity::CallerIdentity;
        let token = match bearer {
            Some(t) if !t.trim().is_empty() => t.trim(),
            _ => return CallerIdentity::Anonymous,
        };
        if self.inner.identity.is_system(token) {
            return CallerIdentity::System;
        }
        if let Some(rec) = self.inner.identity.resolve(token).await {
            return CallerIdentity::Agent { name: rec.name, token: rec.token };
        }
        if let Some(pane) = self.inner.perms.pane_for_token(token).await {
            return CallerIdentity::Pane { pane, token: token.to_string() };
        }
        CallerIdentity::Anonymous
    }

    /// Tab uid (root_tab_uid) a pane belongs to, if registered.
    pub async fn tab_of(&self, pane: &str) -> Option<String> {
        self.inner.sessions.lock().await.get(pane).map(|s| s.root_tab_uid.clone())
    }

    /// Tab-aware grant check: any-scope → every pane; pane-scope → that exact
    /// pane; tab-scope → any pane in the same tab as the grant's anchor pane.
    async fn caller_has_grant(&self, label: &str, target_pane: &str) -> bool {
        let grants = self.inner.perms.grants_for(label).await;
        if grants.is_empty() {
            return false;
        }
        let target_tab = self.tab_of(target_pane).await;
        for (scope, pane) in grants {
            match scope.as_str() {
                "any" => return true,
                "pane" => {
                    if pane == target_pane {
                        return true;
                    }
                }
                "tab" => {
                    if let Some(tt) = &target_tab {
                        if self.tab_of(&pane).await.as_deref() == Some(tt.as_str()) {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
        false
    }

    /// Would `label` be allowed to drive `target_pane` by ownership or a live
    /// grant? Tab-aware — same logic `authorize_drive` uses — so the
    /// `/api/perms/check` endpoint can't diverge from real enforcement.
    pub async fn grant_allows(&self, label: &str, target_pane: &str) -> bool {
        let owned = self.inner.perms.owner_of(target_pane).await.as_deref() == Some(label);
        owned || self.caller_has_grant(label, target_pane).await
    }

    /// Decide whether `id` may drive `target_pane`. When enforcement is off this
    /// is always Allow (attribution-only). When on: a pane can't drive itself
    /// (RefuseHome); anonymous is SoftWalled; an identified caller that owns the
    /// pane or holds a live grant (pane/tab/any) is allowed; a recently-denied
    /// caller is told Denied (no re-prompt); otherwise NeedConsent.
    pub async fn authorize_drive(
        &self,
        id: &crate::identity::CallerIdentity,
        target_pane: &str,
    ) -> crate::perms::AuthDecision {
        use crate::identity::CallerIdentity;
        use crate::perms::AuthDecision;
        if !self.inner.perms.enforced() {
            return AuthDecision::Allow;
        }
        match id {
            CallerIdentity::System => AuthDecision::Allow,
            CallerIdentity::Pane { pane, .. } if pane == target_pane => AuthDecision::RefuseHome,
            CallerIdentity::Anonymous => AuthDecision::SoftWall,
            _ => {
                let label = id.label();
                let owned =
                    self.inner.perms.owner_of(target_pane).await.as_deref() == Some(label.as_str());
                if owned || self.caller_has_grant(&label, target_pane).await {
                    AuthDecision::Allow
                } else if self.inner.perms.recently_denied(&label, target_pane).await {
                    AuthDecision::Denied
                } else {
                    AuthDecision::NeedConsent
                }
            }
        }
    }

    /// Decide whether `id` may CREATE a surface (pane/tab/window/web-pane/sticky).
    /// Create has no pane target, so it's gated on a per-agent create grant, not
    /// a pane/tab/any scope. System bypasses; anonymous is soft-walled; a live
    /// create grant allows (consuming a one-shot); a recent denial reports back.
    /// The denial/grant key is the sentinel pane `__create__`.
    pub async fn authorize_create(
        &self,
        id: &crate::identity::CallerIdentity,
    ) -> crate::perms::AuthDecision {
        use crate::identity::CallerIdentity;
        use crate::perms::AuthDecision;
        if !self.inner.perms.enforced() {
            return AuthDecision::Allow;
        }
        match id {
            CallerIdentity::System => AuthDecision::Allow,
            CallerIdentity::Anonymous => AuthDecision::SoftWall,
            _ => {
                let label = id.label();
                if self.inner.perms.has_create(&label).await {
                    AuthDecision::Allow
                } else if self.inner.perms.recently_denied(&label, crate::perms::CREATE_KEY).await {
                    AuthDecision::Denied
                } else {
                    AuthDecision::NeedConsent
                }
            }
        }
    }

    /// The active pane of the focused window — context for the create toast.
    pub async fn focused_pane(&self) -> Option<String> {
        let focused = *self.inner.focused_window_id.lock().await;
        let sessions = self.inner.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, s)| Some(s.window_id) == focused && s.pane_active)
            .map(|(uid, _)| uid.clone())
    }

    /// Fire-and-forget a JSON message to Electron (no seq, no response wait).
    /// Used for sidecar-initiated pushes the renderer handles out-of-band
    /// (e.g. permission prompts, which reply over HTTP rather than the WS).
    pub async fn notify(&self, msg: serde_json::Value) -> Result<(), String> {
        let guard = self.inner.cmd_tx.lock().await;
        match guard.as_ref() {
            Some(sender) => sender
                .send(msg.to_string())
                .map_err(|_| "Electron disconnected".to_string()),
            None => Err("No Electron client connected".into()),
        }
    }

    /// Whether an Electron client is connected.
    #[allow(dead_code)]
    pub async fn is_connected(&self) -> bool {
        self.inner.cmd_tx.lock().await.is_some()
    }

    /// Get mutable access to sessions for direct updates.
    pub async fn sessions(&self) -> tokio::sync::MutexGuard<'_, HashMap<String, SessionInfo>> {
        self.inner.sessions.lock().await
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

    /// Read the vt100 screen buffer for a session uid.
    /// No round-trip to Electron — reads from the local ScreenBuffer fed by SessionData.
    /// Return (tab_name, pane_label, window_id) for a session uid, or None.
    /// Used by the HTTP handlers to add per-pane context to log lines so
    /// every PTY write/read is attributable to a specific tab and pane.
    pub async fn pane_address_for_log(&self, uid: &str) -> Option<(String, String, u32)> {
        let sessions = self.inner.sessions.lock().await;
        sessions.get(uid).map(|info| {
            let label = if info.split_label.is_empty() {
                // No split label = single-pane tab. Use a short paneId prefix
                // so the line is still parseable even when there's no letter.
                format!("[{}]", &uid[..uid.len().min(8)])
            } else {
                info.split_label.clone()
            };
            (info.tab_name.clone(), label, info.window_id)
        })
    }

    pub async fn get_screen_text_by_uid(&self, uid: &str) -> String {
        let sessions = self.inner.sessions.lock().await;
        if let Some(info) = sessions.get(uid) {
            let dump = info.screen.screen_dump();
            dump.lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            "No screen data".into()
        }
    }

    /// Send keys to a session and collect PTY output until `quiet_ms` of silence.
    /// Returns the raw text that came back, or falls back to a screen snapshot.
    pub async fn type_and_collect(&self, uid: &str, keys: &str, quiet_ms: u64) -> String {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        // Register subscriber before sending keys
        {
            let mut subs = self.inner.output_subs.lock().await;
            subs.entry(uid.to_string()).or_default().push(tx);
        }

        let cmd = serde_json::json!({"type": "Keys", "uid": uid, "keys": keys});
        let _ = self.send_command(cmd).await;

        // Collect output until quiet_ms of silence, cap at 8s total
        let mut collected: Vec<u8> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() { break; }
            match tokio::time::timeout(Duration::from_millis(quiet_ms), rx.recv()).await {
                Ok(Some(chunk)) => collected.extend_from_slice(&chunk),
                Ok(None) => break, // channel closed
                Err(_) => break,   // quiet_ms elapsed with no new data
            }
        }

        // Clean up subscriber
        {
            let mut subs = self.inner.output_subs.lock().await;
            if let Some(txs) = subs.get_mut(uid) {
                txs.retain(|t| !t.is_closed());
            }
        }

        if collected.is_empty() {
            // Nothing came back — return screen snapshot
            self.get_screen_text_by_uid(uid).await
        } else {
            String::from_utf8_lossy(&collected).into_owned()
        }
    }

    /// Set description for a pane by uid.
    pub async fn set_description_by_uid(&self, uid: &str, description: &str) {
        let mut sessions = self.inner.sessions.lock().await;
        if let Some(info) = sessions.get_mut(uid) {
            info.description = description.to_string();
        }
    }

    pub async fn session_count(&self) -> usize {
        self.inner.sessions.lock().await.len()
    }

    pub async fn get_last_tab_activity(&self, target_uid: &str) -> Option<std::time::Duration> {
        let sessions = self.inner.sessions.lock().await;
        let target_root_tab_uid = sessions.get(target_uid).map(|s| s.root_tab_uid.clone())?;
        
        let mut most_recent: Option<std::time::Instant> = None;
        for info in sessions.values() {
            if info.root_tab_uid == target_root_tab_uid {
                if let Some(act) = info.last_user_activity {
                    most_recent = Some(most_recent.map_or(act, |m| m.max(act)));
                }
            }
        }
        
        most_recent.map(|inst| inst.elapsed())
    }

    /// Resolve a window/tab/pane address to its session uid.
    pub async fn resolve_pane_uid(
        &self,
        window: Option<u32>,
        tab: Option<&str>,
        pane: Option<&str>,
    ) -> Option<String> {
        let focused_window_id = *self.inner.focused_window_id.lock().await;
        let sessions = self.inner.sessions.lock().await;

        let mut windows_map: std::collections::BTreeMap<u32, Vec<(&String, &SessionInfo)>> =
            std::collections::BTreeMap::new();
        for (uid, info) in sessions.iter() {
            windows_map.entry(info.window_id).or_default().push((uid, info));
        }

        let (_, win_sessions) = if let Some(window_id) = window {
            windows_map.iter().find(|(id, _)| **id == window_id).map(|(id, s)| (*id, s.clone()))?
        } else {
            if let Some(focused_id) = focused_window_id {
                windows_map
                    .iter()
                    .find(|(id, _)| **id == focused_id)
                    .map(|(id, s)| (*id, s.clone()))
                    .or_else(|| windows_map.iter().next().map(|(id, s)| (*id, s.clone())))?
            } else {
                windows_map.iter().next().map(|(id, s)| (*id, s.clone()))?
            }
        };

        let mut tabs_map: std::collections::BTreeMap<String, Vec<(&String, &SessionInfo)>> =
            std::collections::BTreeMap::new();
        for (uid, info) in win_sessions {
            tabs_map.entry(info.root_tab_uid.clone()).or_default().push((uid, info));
        }

        let mut ordered_tabs: Vec<(String, Vec<(&String, &SessionInfo)>)> = tabs_map.into_iter().collect();
        ordered_tabs.sort_by_key(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_order).unwrap_or(0));

        let (_, tab_sessions) = if let Some(tab_name) = tab {
            ordered_tabs
                .into_iter()
                .find(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_name.as_str() == tab_name).unwrap_or(false))?
        } else {
            ordered_tabs
                .iter()
                .find(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_active).unwrap_or(false))
                .cloned()
                .or_else(|| ordered_tabs.into_iter().next())?
        };

        let mut sorted_panes = tab_sessions;
        sorted_panes.sort_by_key(|(_, info)| {
            if info.split_label.is_empty() {
                '{'
            } else {
                info.split_label.chars().next().unwrap_or('{')
            }
        });

        if let Some(label) = pane {
            sorted_panes
                .into_iter()
                // Resolution order, stable identity first:
                //   1. exact session uid (paneId) — the immutable canonical key
                //   2. paneId PREFIX (>=4 chars). The pane-band "copy" produces
                //      an 8-char prefix (e.g. "dbccc3fe"), so agents paste a
                //      prefix, not the full UUID — accept it.
                //   3. friendly `name` (e.g. "Suspicious Marlin 🧄"), matched
                //      case-insensitively and tolerant of a missing trailing
                //      emoji/whitespace — this is the STABLE human handle and
                //      the one agents should prefer.
                //   4. split_label (a/b/c) LAST — positional and volatile (a
                //      pane's letter changes when siblings open/close), kept
                //      only for back-compat. Prefer name or paneId.
                .find(|(uid, info)| {
                    uid.as_str() == label
                        || (label.len() >= 4 && uid.starts_with(label))
                        || name_matches(&info.shell_name, label)
                        || name_matches(&info.title, label)
                        || info.split_label == label
                })
                .map(|(uid, _)| uid.clone())
        } else {
            sorted_panes
                .iter()
                .find(|(_, info)| info.pane_active)
                .map(|(uid, _)| (*uid).clone())
                .or_else(|| sorted_panes.first().map(|(uid, _)| (*uid).clone()))
        }
    }

    /// Resolve a window/tab address to the first pane's session uid in that tab.
    pub async fn resolve_tab_uid(&self, window: Option<u32>, tab: Option<&str>) -> Option<String> {
        self.resolve_pane_uid(window, tab, None).await
    }

    /// Get status of all registered sessions, grouped by window and tab.
    pub async fn get_status(&self) -> serde_json::Value {
        use sysinfo::{Pid, ProcessesToUpdate, System};
        // Snapshot all processes once; reused for every pane's foreground detection.
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);

        let focused_window_id = *self.inner.focused_window_id.lock().await;
        let sessions = self.inner.sessions.lock().await;

        // Group sessions by window_id
        let mut windows_map: std::collections::BTreeMap<u32, Vec<(&String, &SessionInfo)>> =
            std::collections::BTreeMap::new();
        for (uid, info) in sessions.iter() {
            windows_map.entry(info.window_id).or_default().push((uid, info));
        }

        let mut windows = Vec::new();
        for (win_id, win_sessions) in &windows_map {
            // Group by root_tab_uid within this window
            let mut tabs_map: std::collections::BTreeMap<&str, Vec<(&String, &SessionInfo)>> =
                std::collections::BTreeMap::new();
            for (uid, info) in win_sessions {
                tabs_map.entry(&info.root_tab_uid).or_default().push((uid, info));
            }

            let mut tabs = Vec::new();
            let mut ordered_tabs: Vec<(&str, &Vec<(&String, &SessionInfo)>)> = tabs_map.iter().map(|(k, v)| (*k, v)).collect();
            ordered_tabs.sort_by_key(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_order).unwrap_or(0));

            for (_root_uid, tab_sessions) in ordered_tabs {
                let mut sorted_panes = tab_sessions.clone();
                sorted_panes.sort_by_key(|(_, info)| {
                    if info.split_label.is_empty() {
                        '{'
                    } else {
                        info.split_label.chars().next().unwrap_or('{')
                    }
                });

                let tab_name = sorted_panes.first()
                    .map(|(_, info)| info.tab_name.as_str())
                    .unwrap_or("shell");

                let active = sorted_panes.first().map(|(_, info)| info.tab_active).unwrap_or(false);

                let tab_id = sorted_panes.first()
                    .map(|(_, info)| info.root_tab_uid.as_str())
                    .unwrap_or("");

                let panes: Vec<serde_json::Value> = sorted_panes
                    .iter()
                    .map(|(uid, info)| {
                        // Normalise shell path to just the binary name (e.g. /bin/bash → bash)
                        let shell = std::path::Path::new(&info.name)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(&info.name)
                            .trim_end_matches(".exe")
                            .to_string();
                        // Walk child process tree to find the foreground app.
                        let process = if info.pid > 0 {
                            crate::process::foreground_process_with(&sys, info.pid)
                        } else {
                            String::new()
                        };
                        // `focused` = this pane is where the human's keyboard
                        // actually goes right now: the active pane of the
                        // focused window. `userActiveSecsAgo` = seconds since
                        // the human last typed in this pane (null if never /
                        // not tracked). Together they let an agent see "the
                        // human is in this pane and was just typing" before it
                        // sends keys.
                        let focused = focused_window_id == Some(*win_id) && info.pane_active;
                        let user_active_secs_ago = info
                            .last_user_activity
                            .map(|t| t.elapsed().as_secs());
                        // `name` = the friendly, layout-stable pane name
                        // (e.g. "Suspicious Marlin 🧄"). Fall back to `title`
                        // until the renderer's first `SessionName` arrives, so
                        // a freshly-registered pane is never nameless.
                        let friendly = if info.shell_name.is_empty() {
                            info.title.clone()
                        } else {
                            info.shell_name.clone()
                        };
                        serde_json::json!({
                            "paneId": uid,
                            "name": friendly,
                            "label": info.split_label,
                            "shell": shell,
                            "process": process,
                            "cols": info.cols,
                            "rows": info.rows,
                            "pid": info.pid,
                            "active": info.pane_active,
                            "focused": focused,
                            "userActiveSecsAgo": user_active_secs_ago,
                            "cwd": info.cwd,
                            "title": info.title,
                            // BSP bounding box in 0–100 % — lets tab_image
                            // draw the layout to scale.
                            "bspX": info.bsp_x,
                            "bspY": info.bsp_y,
                            "bspW": info.bsp_w,
                            "bspH": info.bsp_h,
                        })
                    })
                    .collect();

                tabs.push(serde_json::json!({
                    "tabId": tab_id,
                    "name": tab_name,
                    "active": active,
                    "panes": panes,
                }));
            }

            let focused = focused_window_id.map(|id| id == *win_id).unwrap_or_else(|| windows.is_empty());
            windows.push(serde_json::json!({
                "id": win_id,
                "focused": focused,
                "tabs": tabs,
            }));
        }

        serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "windows": windows })
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
                let window_id = msg["windowId"].as_u64().unwrap_or(0) as u32;
                let split_label = msg["splitLabel"].as_str().unwrap_or("").to_string();
                let tab_order = msg["tabOrder"].as_u64().unwrap_or(0) as u32;
                let tab_active = msg["tabActive"].as_bool().unwrap_or(false);
                let pane_active = msg["paneActive"].as_bool().unwrap_or(false);
                let title = msg["title"].as_str().unwrap_or("").to_string();
                let shell_name = msg["shellName"].as_str().unwrap_or("").to_string();
                tracing::info!("Session registered: {uid} ({tab_name}) {cols}x{rows} pid={pid} tab={root_tab_uid} win={window_id}");
                // Register the pane's injected identity token so an in-pane
                // agent's Authorization header resolves to this pane.
                let agent_token = msg["agentToken"].as_str().unwrap_or("");
                if !agent_token.is_empty() {
                    self.inner.perms.set_pane_token(&uid, agent_token).await;
                }
                let mut focused_window_id = self.inner.focused_window_id.lock().await;
                if focused_window_id.is_none() {
                    *focused_window_id = Some(window_id);
                }
                self.inner.sessions.lock().await.insert(
                    uid,
                    SessionInfo {
                        name,
                        shell_name,
                        tab_name,
                        description,
                        rows,
                        cols,
                        pid,
                        root_tab_uid,
                        window_id,
                        split_label,
                        tab_order,
                        tab_active,
                        pane_active,
                        screen: ScreenBuffer::new(rows, cols, 1000),
                        bsp_x: 0.0,
                        bsp_y: 0.0,
                        bsp_w: 100.0,
                        bsp_h: 100.0,
                        cwd: String::new(),
                        last_user_activity: None,
                        title,
                    },
                );
            }

            "SessionTabName" => {
                let uid = msg["uid"].as_str().unwrap_or("").to_string();
                let tab_name = msg["tabName"].as_str().unwrap_or("").to_string();
                let mut sessions = self.inner.sessions.lock().await;
                // Find the root_tab_uid for this session, then update ALL sessions in the tab group
                let root = sessions.get(&uid).map(|s| s.root_tab_uid.clone());
                if let Some(root_uid) = root {
                    for (sid, info) in sessions.iter_mut() {
                        if info.root_tab_uid == root_uid {
                            info.tab_name = tab_name.clone();
                            tracing::info!("Session {sid} tab name: {tab_name}");
                        }
                    }
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

            "SessionCwd" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let cwd = msg["cwd"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.cwd = cwd.clone();
                    tracing::info!("Session {uid} cwd updated: {cwd}");
                }
            }

            "SessionTitle" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let title = msg["title"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.title = title.clone();
                    tracing::info!("Session {uid} title updated: {title}");
                }
            }

            "SessionName" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let name = msg["name"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.shell_name = name.clone();
                    tracing::info!("Session {uid} name updated: {name}");
                }
            }

            "SessionLayout" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let root_tab_uid = msg["rootTabUid"].as_str().unwrap_or("").to_string();
                let split_label = msg["splitLabel"].as_str().unwrap_or("").to_string();
                let tab_order = msg["tabOrder"].as_u64().unwrap_or(0) as u32;
                let tab_active = msg["tabActive"].as_bool().unwrap_or(false);
                let bsp = &msg["bsp"];
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    if !root_tab_uid.is_empty() {
                        info.root_tab_uid = root_tab_uid;
                    }
                    info.split_label = split_label;
                    info.tab_order = tab_order;
                    info.tab_active = tab_active;
                    if bsp.is_object() {
                        info.bsp_x = bsp["x"].as_f64().unwrap_or(0.0) as f32;
                        info.bsp_y = bsp["y"].as_f64().unwrap_or(0.0) as f32;
                        info.bsp_w = bsp["width"].as_f64().unwrap_or(100.0) as f32;
                        info.bsp_h = bsp["height"].as_f64().unwrap_or(100.0) as f32;
                    }
                }
            }

            "SessionActive" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let window_id = msg["windowId"].as_u64().unwrap_or(0) as u32;
                let mut sessions = self.inner.sessions.lock().await;
                for (_sid, info) in sessions.iter_mut() {
                    if info.window_id == window_id {
                        info.pane_active = false;
                    }
                }
                if let Some(info) = sessions.get_mut(uid) {
                    info.pane_active = true;
                }
            }

            "WindowFocus" => {
                let window_id = msg["windowId"].as_u64().unwrap_or(0) as u32;
                *self.inner.focused_window_id.lock().await = Some(window_id);
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
                        drop(sessions);
                        // Append ANSI-stripped text to the lume per-shell log
                        // (the searchable store of record beyond the screen ring).
                        self.inner.lume.append_shell_bytes(uid, &bytes).await;
                        // Forward raw bytes to any waiting output subscribers
                        let mut subs = self.inner.output_subs.lock().await;
                        if let Some(txs) = subs.get_mut(uid) {
                            txs.retain(|tx| tx.send(bytes.clone()).is_ok());
                        }
                    }
                }
            }

            "SessionExit" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                tracing::info!("Session exited: {uid}");
                self.inner.sessions.lock().await.remove(uid);
                // Revoke any cross-pane grants/prompts tied to the closed pane.
                self.inner.perms.cleanup_pane(uid).await;
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

            "UserActivity" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let mut sessions = self.inner.sessions.lock().await;
                if let Some(info) = sessions.get_mut(uid) {
                    info.last_user_activity = Some(std::time::Instant::now());
                    tracing::info!("User activity registered for session {uid}");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn session_info(window_id: u32, root_tab_uid: &str, split_label: &str, tab_active: bool, pane_active: bool) -> SessionInfo {
        SessionInfo {
            name: "shell".into(),
            shell_name: String::new(),
            tab_name: "tab".into(),
            description: String::new(),
            rows: 24,
            cols: 80,
            pid: 1,
            root_tab_uid: root_tab_uid.into(),
            window_id,
            split_label: split_label.into(),
            tab_order: 0,
            tab_active,
            pane_active,
            screen: ScreenBuffer::new(24, 80, 1000),
            bsp_x: 0.0,
            bsp_y: 0.0,
            bsp_w: 100.0,
            bsp_h: 100.0,
            cwd: String::new(),
            last_user_activity: None,
            title: String::new(),
        }
    }

    #[test]
    fn resolve_pane_prefers_focused_window_and_active_pane() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let bridge = Bridge::new();
            {
                let mut sessions = bridge.inner.sessions.lock().await;
                sessions.insert("win0-a".into(), session_info(10, "tab-0", "a", true, false));
                sessions.insert("win0-b".into(), session_info(10, "tab-0", "b", true, true));
                sessions.insert("win1-a".into(), session_info(20, "tab-1", "a", true, true));
            }
            *bridge.inner.focused_window_id.lock().await = Some(10);

            let resolved = bridge.resolve_pane_uid(None, None, None).await;
            assert_eq!(resolved.as_deref(), Some("win0-b"));
        });
    }

    #[test]
    fn status_marks_real_focused_window_and_active_pane() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let bridge = Bridge::new();
            {
                let mut sessions = bridge.inner.sessions.lock().await;
                sessions.insert("win0-a".into(), session_info(10, "tab-0", "a", true, true));
                sessions.insert("win1-a".into(), session_info(20, "tab-1", "a", true, true));
            }
            *bridge.inner.focused_window_id.lock().await = Some(20);

            let status = bridge.get_status().await;
            let windows = status["windows"].as_array().unwrap();
            let focused_window = windows.iter().find(|w| w["focused"].as_bool() == Some(true)).unwrap();
            assert_eq!(focused_window["id"].as_u64(), Some(20));
            let panes = focused_window["tabs"][0]["panes"].as_array().unwrap();
            assert_eq!(panes[0]["active"].as_bool(), Some(true));
        });
    }
}
