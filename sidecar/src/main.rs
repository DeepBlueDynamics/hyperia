#![allow(dead_code, unused_imports, unused_variables)]

mod bridge;
mod chat;
mod dashboard;
mod ghost;
mod logs;
mod mcp;
mod process;
mod screen;
mod settings;
mod telemetry;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use clap::Parser;
use serde::Deserialize;
use tracing_subscriber::EnvFilter;

use bridge::Bridge;

#[derive(Parser, Debug)]
#[command(name = "hyperia-sidecar")]
#[command(about = "Rust sidecar for Hyperia: agent engine, MCP, HTTP bridge")]
struct Args {
    /// HTTP API port (Electron connects here)
    #[arg(long, default_value = "9800")]
    port: u16,

    /// Run as MCP stdio server
    #[arg(long)]
    mcp: bool,
}

#[derive(Clone)]
struct AppState {
    bridge: Bridge,
    log_buffer: logs::LogBuffer,
    telemetry: telemetry::TelemetryStore,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct PaneAddress {
    window: Option<u32>,
    tab: Option<String>,
    pane: Option<String>,
    quiet_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct NotesQuery {
    q: Option<String>,
}

/// Serve the Hyperia Python MCP tool file. Nemesis8 fetches this at container startup.
async fn get_mcp_python() -> impl axum::response::IntoResponse {
    const SRC: &str = include_str!("../assets/hyperia-mcp.py");
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        SRC,
    )
}

async fn get_logs(State(state): State<AppState>) -> Json<Vec<String>> {
    let lines = state.log_buffer.lock().unwrap();
    Json(lines.iter().cloned().collect())
}

#[derive(serde::Deserialize)]
struct ClientLogRequest {
    level: Option<String>,
    message: String,
}

async fn post_client_log(
    State(state): State<AppState>,
    Json(req): Json<ClientLogRequest>,
) -> &'static str {
    let msg = format!("[ghost-client] {}", req.message);
    match req.level.as_deref().unwrap_or("info") {
        "error" => tracing::error!("{}", msg),
        "warn"  => tracing::warn!("{}", msg),
        _       => tracing::info!("{}", msg),
    }
    "ok"
}

async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.bridge.get_status().await)
}

async fn get_screen(State(state): State<AppState>, Query(addr): Query<PaneAddress>) -> (StatusCode, String) {
    let Some(uid) = state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    else {
        let session_count = state.bridge.session_count().await;
        tracing::warn!("get_screen 404: window={:?} tab={:?} pane={:?} (sessions={})",
            addr.window, addr.tab, addr.pane, session_count);
        return (StatusCode::NOT_FOUND, format!(
            "No pane at that address (window={:?} tab={:?} pane={:?}, {} sessions registered). \
The pane field accepts either a split label (for example 'a' or 'b') or a paneId from terminal_status. \
If the pane label is empty, use paneId.",
            addr.window, addr.tab, addr.pane, session_count
        ));
    };
    (StatusCode::OK, state.bridge.get_screen_text_by_uid(&uid).await)
}

async fn post_auto_describe(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
) -> (StatusCode, String) {
    let Some(uid) = state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    else {
        return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into());
    };

    let screen = state.bridge.get_screen_text_by_uid(&uid).await;
    if screen.trim().is_empty() {
        return (StatusCode::OK, "empty".into());
    }

    // Hit local ollama to describe what's happening in this terminal
    let ollama_url = std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".into());
    let prompt = format!(
        "In 10 words or fewer, describe what this terminal is doing:\n\n{}",
        &screen[..screen.len().min(2000)]
    );
    let body = serde_json::json!({
        "model": "llama3.2",
        "prompt": prompt,
        "stream": false,
    });

    let client = reqwest::Client::new();
    match client.post(format!("{}/api/generate", ollama_url)).json(&body).send().await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(json) => {
                let description = json["response"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('\'')
                    .trim_matches('`')
                    .trim()
                    .to_string();
                // Update the session description in the bridge
                state.bridge.set_description_by_uid(&uid, &description).await;
                (StatusCode::OK, description)
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Parse: {e}")),
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Ollama: {e}")),
    }
}

/// Unescape backslash sequences so MCP tools can send Enter, Tab, Esc, etc.
fn unescape_keys(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\r'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('e') => out.push('\x1b'),
                Some('\\') => out.push('\\'),
                Some('x') => {
                    // \x1b style hex escape
                    let hi = chars.next().unwrap_or('0');
                    let lo = chars.next().unwrap_or('0');
                    let hex: String = [hi, lo].iter().collect();
                    if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                        out.push(byte as char);
                    }
                }
                Some(other) => { out.push('\\'); out.push(other); }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

async fn post_type(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty body".into());
    }
    let keys = body;
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => {
            let session_count = state.bridge.session_count().await;
            tracing::warn!("post_type 404: window={:?} tab={:?} pane={:?} (sessions={})",
                addr.window, addr.tab, addr.pane, session_count);
            return (StatusCode::NOT_FOUND, format!(
                "No pane at that address (window={:?} tab={:?} pane={:?}, {} sessions registered). \
The pane field accepts either a split label (for example 'a' or 'b') or a paneId from terminal_status. \
If the pane label is empty, use paneId.",
                addr.window, addr.tab, addr.pane, session_count
            ));
        }
    };
    let cmd = serde_json::json!({"type": "Keys", "uid": uid, "keys": keys});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_type_and_collect(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty body".into());
    }
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => {
            return (
                StatusCode::NOT_FOUND,
                "No pane at that address. The pane field accepts either a split label or a paneId from terminal_status. If the pane label is empty, use paneId.".into(),
            );
        }
    };
    let quiet_ms = addr.quiet_ms.unwrap_or(400).clamp(100, 10_000);
    let output = state.bridge.type_and_collect(&uid, &body, quiet_ms).await;
    (StatusCode::OK, output)
}

async fn post_split(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let direction = if body.is_empty() {
        "vertical".to_string()
    } else {
        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["direction"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "vertical".into())
    };
    let cmd = serde_json::json!({"type": "Split", "direction": direction});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_focus(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();

    if let Some(uid) = parsed["sessionUid"].as_str() {
        let cmd = serde_json::json!({"type": "Focus", "uid": uid});
        match state.bridge.send_command(cmd).await {
            Ok(r) => (StatusCode::OK, r),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        }
    } else if parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string() {
        let uid = match state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                parsed["pane"].as_str(),
            )
            .await
        {
            Some(u) => u,
            None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
        };
        let cmd = serde_json::json!({"type": "Focus", "uid": uid});
        match state.bridge.send_command(cmd).await {
            Ok(r) => (StatusCode::OK, r),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        }
    } else {
        (StatusCode::BAD_REQUEST, "Missing sessionUid or window/tab/pane".into())
    }
}

async fn post_close(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    let uid = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["uid"].as_str().map(|s| s.to_string()));
    let mut cmd = serde_json::json!({"type": "Close"});
    if let Some(uid) = uid {
        cmd["uid"] = serde_json::Value::String(uid);
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_new_tab(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let profile = parsed["profile"].as_str().unwrap_or("").to_string();
    let command = parsed["command"].as_str().unwrap_or("").to_string();
    let cmd = serde_json::json!({"type": "NewTab", "profile": profile, "command": command});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_where_pane(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, String) {
    let a = params.get("a").map(|s| s.as_str()).unwrap_or("");
    let b = params.get("b").map(|s| s.as_str()).unwrap_or("");
    if a.is_empty() || b.is_empty() {
        return (StatusCode::BAD_REQUEST, "Provide ?a=label&b=label".into());
    }
    let sessions = state.bridge.sessions().await;
    // Resolve by uid first, then fall back to split_label
    let find = |key: &str| -> Option<(String, _)> {
        if let Some(s) = sessions.get(key) {
            return Some((key.to_string(), s.clone()));
        }
        sessions.iter()
            .find(|(_, s)| s.split_label == key)
            .map(|(uid, s)| (uid.clone(), s.clone()))
    };
    let (uid_a, sa) = match find(a) {
        Some(v) => v,
        None => return (StatusCode::NOT_FOUND, format!("Pane '{}' not found", a)),
    };
    let (uid_b, sb) = match find(b) {
        Some(v) => v,
        None => return (StatusCode::NOT_FOUND, format!("Pane '{}' not found", b)),
    };
    let (a, b) = (uid_a.as_str(), uid_b.as_str());
    let (sa, sb) = (&sa, &sb);

    let mut parts: Vec<&str> = Vec::new();

    // Vertical position
    if sb.bsp_y >= sa.bsp_y + sa.bsp_h - 1.0 {
        parts.push("below");
    } else if sb.bsp_y + sb.bsp_h <= sa.bsp_y + 1.0 {
        parts.push("above");
    }

    // Horizontal position
    if sb.bsp_x >= sa.bsp_x + sa.bsp_w - 1.0 {
        parts.push("to the right of");
    } else if sb.bsp_x + sb.bsp_w <= sa.bsp_x + 1.0 {
        parts.push("to the left of");
    }

    let label_a = if sa.split_label.is_empty() { a } else { sa.split_label.as_str() };
    let label_b = if sb.split_label.is_empty() { b } else { sb.split_label.as_str() };

    let relation = if parts.is_empty() {
        format!("pane {} overlaps or is the same position as pane {}", label_b, label_a)
    } else {
        format!("pane {} is {} pane {}", label_b, parts.join(" and "), label_a)
    };

    (StatusCode::OK, serde_json::json!({
        "relation": relation,
        "a": {"uid": a, "label": label_a, "x": sa.bsp_x, "y": sa.bsp_y, "width": sa.bsp_w, "height": sa.bsp_h},
        "b": {"uid": b, "label": label_b, "x": sb.bsp_x, "y": sb.bsp_y, "width": sb.bsp_w, "height": sb.bsp_h}
    }).to_string())
}

async fn post_new_window(State(state): State<AppState>) -> (StatusCode, String) {
    let cmd = serde_json::json!({"type": "NewWindow"});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_open_web_pane(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let url = match parsed["url"].as_str() {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return (StatusCode::BAD_REQUEST, "url is required".into()),
    };
    let cmd = serde_json::json!({"type": "OpenWebPane", "url": url});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_rename_tab(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let name = parsed["name"].as_str().unwrap_or("").to_string();
    let session_uid = match state
        .bridge
        .resolve_tab_uid(
            parsed["window"].as_u64().map(|v| v as u32),
            parsed["tab"].as_str(),
        )
        .await
    {
        Some(uid) => uid,
        None => return (StatusCode::NOT_FOUND, "No tab at that window/tab address".into()),
    };

    // Update locally in sidecar
    {
        let mut sessions = state.bridge.sessions().await;
        let root = sessions.get(&session_uid).map(|info| info.root_tab_uid.clone());
        if let Some(root_uid) = root {
            for (_uid, info) in sessions.iter_mut() {
                if info.root_tab_uid == root_uid {
                    info.tab_name = name.clone();
                }
            }
        }
    }

    // Tell Electron to update the renderer
    let cmd = serde_json::json!({"type": "Rename", "uid": session_uid, "name": name});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_ui_key(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let key_code = match parsed["keyCode"].as_str() {
        Some(k) => k.to_string(),
        None => return (StatusCode::BAD_REQUEST, "Missing keyCode".into()),
    };
    let modifiers = parsed["modifiers"].clone();
    let window_id = parsed["windowId"].as_u64().map(|v| v as u32);
    let mut cmd = serde_json::json!({
        "type": "UIKey",
        "keyCode": key_code,
        "modifiers": modifiers,
    });
    if let Some(wid) = window_id {
        cmd["windowId"] = serde_json::json!(wid);
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_notes(Query(query): Query<NotesQuery>) -> (StatusCode, String) {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };
    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let query = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty());
            if let Some(query) = query {
                let query = query.to_lowercase();
                let filtered = serde_json::from_str::<Vec<serde_json::Value>>(&content)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|note| {
                        note["text"]
                            .as_str()
                            .map(|text| text.to_lowercase().contains(&query))
                            .unwrap_or(false)
                    })
                    .collect::<Vec<_>>();
                (
                    StatusCode::OK,
                    serde_json::to_string(&filtered).unwrap_or_else(|_| "[]".into()),
                )
            } else {
                (StatusCode::OK, content)
            }
        }
        Err(_) => (StatusCode::OK, "[]".into()),
    }
}

async fn post_note_create(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let cmd = serde_json::json!({
        "type": "NoteCreate",
        "text": parsed["text"],
        "color": parsed["color"],
        "filePath": parsed["file_path"],
    });
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_note_close(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let id = parsed["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }
    let cmd = serde_json::json!({"type": "NoteClose", "id": id});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_note(Path(id): Path<String>) -> (StatusCode, String) {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };
    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let note = serde_json::from_str::<Vec<serde_json::Value>>(&content)
                .unwrap_or_default()
                .into_iter()
                .find(|n| n["id"].as_str() == Some(&id));
            match note {
                Some(n) => (StatusCode::OK, serde_json::to_string(&n).unwrap_or_else(|_| "{}".into())),
                None => (StatusCode::NOT_FOUND, format!("Note {} not found", id)),
            }
        }
        Err(_) => (StatusCode::NOT_FOUND, format!("Note {} not found", id)),
    }
}

async fn patch_note(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: String,
) -> (StatusCode, String) {
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }
    let payload: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()),
    };
    let text = match payload["text"].as_str() {
        Some(t) => t.to_string(),
        None => return (StatusCode::BAD_REQUEST, "Missing 'text' field".into()),
    };

    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };

    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");

    let mut notes = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<Vec<serde_json::Value>>(&content).unwrap_or_default(),
        Err(_) => return (StatusCode::NOT_FOUND, String::new()),
    };

    let found = notes.iter_mut().find(|n| n["id"].as_str() == Some(id.as_str()));
    let Some(note) = found else {
        return (StatusCode::NOT_FOUND, String::new());
    };
    note["text"] = serde_json::Value::String(text.clone());

    let serialized = match serde_json::to_string_pretty(&notes) {
        Ok(content) => content,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Err(e) = std::fs::write(&path, serialized) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    let cmd = serde_json::json!({"type": "NoteUpdate", "id": id, "text": text});
    match state.bridge.send_command(cmd).await {
        Ok(_) => (StatusCode::OK, serde_json::json!({"ok": true}).to_string()),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn delete_note(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> (StatusCode, String) {
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }

    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };

    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");

    let notes = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<Vec<serde_json::Value>>(&content).unwrap_or_default(),
        Err(_) => return (StatusCode::NOT_FOUND, String::new()),
    };
    let original_len = notes.len();

    let filtered: Vec<serde_json::Value> = notes
        .into_iter()
        .filter(|note| note["id"].as_str() != Some(id.as_str()))
        .collect();

    if filtered.len() == original_len {
        return (StatusCode::NOT_FOUND, String::new());
    }

    let serialized = match serde_json::to_string_pretty(&filtered) {
        Ok(content) => content,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Err(e) = std::fs::write(&path, serialized) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    let cmd = serde_json::json!({"type": "NoteDelete", "id": id});
    match state.bridge.send_command(cmd).await {
        Ok(_) => (
            StatusCode::OK,
            serde_json::json!({"ok": true}).to_string(),
        ),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// In-memory cache for highlight results: content_hash → rules JSON
static HIGHLIGHT_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, String>>> =
    std::sync::OnceLock::new();

fn highlight_cache() -> &'static std::sync::Mutex<std::collections::HashMap<u64, String>> {
    HIGHLIGHT_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn content_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[derive(Deserialize)]
struct HighlightRequest {
    content: String,
    hint: Option<String>,
}

async fn post_notes_highlight(
    Json(body): Json<HighlightRequest>,
) -> (StatusCode, String) {
    let content = body.content.chars().take(4000).collect::<String>();
    let key = content_hash(&content);

    // Cache hit
    if let Ok(cache) = highlight_cache().lock() {
        if let Some(cached) = cache.get(&key) {
            return (StatusCode::OK, cached.clone());
        }
    }

    let cfg = match ghost::load_config() {
        Some(c) => c,
        None => return (StatusCode::SERVICE_UNAVAILABLE, r#"{"error":"no api key configured"}"#.into()),
    };

    let hint = body.hint.unwrap_or_default();
    let user_msg = if hint.is_empty() {
        format!("Highlight this content:\n\n{}", content)
    } else {
        format!("Hint: {}\n\nHighlight this content:\n\n{}", hint, content)
    };

    // Resolve model ID (same logic as provider.rs)
    let model = match cfg.model.as_str() {
        "anthropic" => "claude-haiku-4-5-20251001".to_string(),
        other => other.to_string(),
    };

    let req_body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "system": "You are a syntax highlighter. Analyze the given content and return a JSON object with a single key \"rules\" containing an array of highlight rules. Each rule has: \"pattern\" (regex string), \"flags\" (optional, default \"g\"), \"className\" (an hljs CSS class like hljs-keyword, hljs-string, hljs-comment, hljs-number, hljs-title, hljs-built_in, hljs-literal), and optionally \"color\" (hex color override). Identify keywords, literals, identifiers, operators, and domain-specific terms. Return ONLY valid JSON, no explanation, no markdown.",
        "messages": [{"role": "user", "content": user_msg}]
    });

    let client = reqwest::Client::new();
    let resp = match client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&req_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!(r#"{{"error":"{}"}}"#, e)),
    };

    let resp_json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!(r#"{{"error":"{}"}}"#, e)),
    };

    // Extract text from response
    let text = resp_json["content"][0]["text"].as_str().unwrap_or("{}");

    // Parse and validate — must have a "rules" array
    let parsed: serde_json::Value = serde_json::from_str(text).unwrap_or(serde_json::json!({"rules": []}));
    let result = if parsed["rules"].is_array() {
        parsed
    } else {
        serde_json::json!({"rules": []})
    };

    let out = result.to_string();

    // Store in cache
    if let Ok(mut cache) = highlight_cache().lock() {
        cache.insert(key, out.clone());
    }

    (StatusCode::OK, out)
}

async fn post_agent_status(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let mut cmd = serde_json::json!({
        "type": "AgentStatus",
        "connected": parsed["connected"],
        "working": parsed["working"],
        "label": parsed["label"],
        "humanPercent": parsed["humanPercent"],
    });
    if let Some(uid) = parsed["sessionUid"].as_str() {
        cmd["sessionUid"] = serde_json::json!(uid);
    } else if parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string() {
        match state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                parsed["pane"].as_str(),
            )
            .await
        {
            Some(uid) => cmd["sessionUid"] = serde_json::json!(uid),
            None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
        }
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Log panics to stderr so they appear in the Electron console
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[sidecar-panic] {info}");
    }));

    let args = Args::parse();

    // MCP mode: stdio proxy
    if args.mcp {
        tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()),
            )
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
        tracing::info!("MCP server (stdio) starting");
        return mcp::run_mcp_stdio(args.port).await;
    }

    // Normal sidecar mode
    let log_buffer = logs::new_log_buffer();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()),
        )
        .with_writer(logs::LogBufferMakeWriter::new(log_buffer.clone()))
        .with_ansi(false)
        .init();

    tracing::info!("hyperia-sidecar v{}", env!("CARGO_PKG_VERSION"));
    tracing::info!("API :{}", args.port);

    // Ferricula no longer embedded. The ghost agent talks to ferricula over
    // HTTP via FerriculaBackend (FERRICULA_URL env var or
    // ~/.hyperia/hyperia.json). Run ferricula separately — Docker locally
    // (`docker compose up ferricula`) or remote in the cloud.
    let ferricula_url = std::env::var("FERRICULA_URL")
        .unwrap_or_else(|_| "http://localhost:8765".to_string());
    tracing::info!("Ferricula client: {} (run ferricula separately, e.g. via docker compose)", ferricula_url);

    let bridge = Bridge::new();
    let telem = telemetry::TelemetryStore::new();
    let dash_state = dashboard::DashboardState::new(telem.clone());
    let state = AppState { bridge, log_buffer, telemetry: telem };

    let app = axum::Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
        .route("/api/mcp/hyperia.py", axum::routing::get(get_mcp_python))
        .route("/ws", axum::routing::get(bridge::ws_handler))
        // Read endpoints
        .route("/api/logs", axum::routing::get(get_logs))
        .route("/api/log", axum::routing::post(post_client_log))
        .route("/api/status", axum::routing::get(get_status))
        .route("/api/screen", axum::routing::get(get_screen))
        // Write endpoints
        .route("/api/type", axum::routing::post(post_type))
        .route("/api/type-and-collect", axum::routing::post(post_type_and_collect))
        .route("/api/pane/split", axum::routing::post(post_split))
        .route("/api/pane/focus", axum::routing::post(post_focus))
        .route("/api/pane/close", axum::routing::post(post_close))
        .route("/api/pane/new", axum::routing::post(post_new_tab))
        .route("/api/window/new", axum::routing::post(post_new_window))
        .route("/api/web-pane", axum::routing::post(post_open_web_pane))
        .route("/api/pane/where", axum::routing::get(get_where_pane))
        .route("/api/pane/rename", axum::routing::post(post_rename_tab))
        .route("/api/agent/status", axum::routing::post(post_agent_status))
        .route("/api/ui/key", axum::routing::post(post_ui_key))
        .route("/api/pane/describe", axum::routing::post(post_auto_describe))
        .route("/api/notes", axum::routing::get(get_notes).post(post_note_create))
        .route("/api/notes/highlight", axum::routing::post(post_notes_highlight))
        .route("/api/notes/{id}", axum::routing::get(get_note).delete(delete_note).patch(patch_note))
        .route("/api/notes/close", axum::routing::post(post_note_close))
        .with_state(state);

    // Dashboard routes with their own state
    let dash_routes = axum::Router::new()
        .route("/dashboard", axum::routing::get(dashboard::get_dashboard))
        .route("/api/telemetry/snapshot", axum::routing::get(dashboard::get_telemetry_snapshot))
        .route("/api/telemetry/toggle", axum::routing::post(dashboard::post_telemetry_toggle))
        .route("/api/telemetry/reset", axum::routing::post(dashboard::post_telemetry_reset))
        .route("/api/telemetry/event", axum::routing::post(dashboard::post_telemetry_event))
        .route("/api/dashboard/widgets", axum::routing::get(dashboard::get_widgets).post(dashboard::post_widgets))
        .with_state(dash_state);

    // Ghost agent routes — always mounted, config lazy-loaded per request
    let ghost_state = ghost::GhostState::new(args.port);
    let shared_registry = ghost_state.registry.clone();
    let ghost_routes = axum::Router::new()
        .route("/api/ghost/chat", axum::routing::post(ghost::api::ghost_chat))
        .route("/api/ghost/status", axum::routing::get(ghost::api::ghost_status))
        .route("/api/ghost/history", axum::routing::get(ghost::api::ghost_history))
        .route("/api/ghost/memory", axum::routing::get(ghost::api::ghost_memory))
        .route("/api/ghost/session", axum::routing::get(ghost::api::ghost_session_dump))
        .route("/api/ghost/stop", axum::routing::post(ghost::api::ghost_stop))
        .route("/api/ghost/ui-response", axum::routing::post(ghost::api::ghost_ui_response))
        .route("/api/ghost/inject", axum::routing::post(ghost::api::ghost_inject))
        .route("/api/ghost/continue", axum::routing::post(ghost::api::ghost_continue))
        .route("/api/ghost/reset", axum::routing::post(ghost::api::ghost_reset))
        .route("/api/ghost/window-closed", axum::routing::post(ghost::api::ghost_window_closed))
        .with_state(ghost_state);

    // Settings agent routes — separate session, SHARED tool registry so
    // the configuration agent has full access to doctor / show_* / settings_set /
    // model_catalog / docker_run / etc. Widgets opened from either panel
    // resolve through the same pending_ui map via /api/ghost/ui-response.
    let settings_state = settings::SettingsState::with_registry(shared_registry);
    let settings_routes = axum::Router::new()
        .route("/api/settings/chat", axum::routing::post(settings::api::settings_chat))
        .route("/api/settings/reset", axum::routing::post(settings::api::settings_reset))
        .with_state(settings_state);

    let app = app
        .merge(dash_routes)
        .merge(ghost_routes)
        .merge(settings_routes)
        .nest_service("/mcp", mcp::streamable_http_service(args.port));

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sidecar] Port {} already in use — another sidecar is running. Exiting. ({})", args.port, e);
            std::process::exit(0); // Exit cleanly so auto-restart doesn't loop
        }
    };
    tracing::info!(%addr, "Sidecar HTTP listening");
    eprintln!("[sidecar] HTTP ready on :{}", args.port);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[sidecar] axum::serve error: {e}");
        std::process::exit(0); // Exit cleanly — Electron will restart if needed
    }

    Ok(())
}
