#![allow(dead_code, unused_imports, unused_variables)]

mod bridge;
mod chat;
mod dashboard;
mod fsnav;
mod ghost;
mod logs;
mod mcp;
mod process;
mod lume_store;
mod screen;
mod settings;
mod snapshot_image;
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

    /// IP to bind the HTTP listener to. Default 127.0.0.1 (loopback only —
    /// only the local Electron renderer and local MCP clients can reach
    /// the sidecar). Set to 0.0.0.0 to expose to all interfaces (LAN
    /// access from other machines, useful for SSH-less remote MCP). Other
    /// valid forms: a specific IP like 192.168.1.10 for a single
    /// interface. Honors the HYPERIA_BIND environment variable.
    #[arg(long, env = "HYPERIA_BIND", default_value = "127.0.0.1")]
    bind: std::net::IpAddr,

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
    /// When true on /api/type, bypass the human-activity lockout and deliver
    /// keys immediately — used to interrupt a running process (e.g. Ctrl-C)
    /// even while the human is active in the pane. Ignored by other routes.
    interrupt: Option<bool>,
    /// When true on /api/type or /api/type-and-collect, send the request
    /// body verbatim — DO NOT unescape `\r`, `\n`, `\t`, `\x..` etc. This
    /// is required for `terminal_run`, whose payload is a normal shell
    /// command string that may contain Windows paths like `\research` —
    /// the default unescape behavior would turn `\r` into a literal CR
    /// and shred the path. `terminal_keys` keeps raw=false (default) so
    /// `\x03` still maps to Ctrl-C.
    raw: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct NotesQuery {
    q: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FsDirsQuery {
    /// Directory to list. Omit/empty/nonexistent → the user's home directory.
    path: Option<String>,
}

/// List the visible subdirectories of a path (home if absent). Backs the pane
/// directory navigator — the filtering rules (dirs only, no hidden/$system)
/// live in Rust (fsnav), not in the renderer.
async fn get_fs_dirs(Query(q): Query<FsDirsQuery>) -> Json<crate::fsnav::DirListing> {
    Json(crate::fsnav::list_dirs(q.path.as_deref()))
}

#[derive(serde::Deserialize)]
struct TabImageQuery {
    window: Option<u32>,
    tab: Option<String>,
}

#[derive(serde::Deserialize)]
struct SearchQuery {
    q: String,
    /// For shell search: restrict to one session uid. Omit to search all shells.
    uid: Option<String>,
    limit: Option<usize>,
    context_lines: Option<usize>,
}

/// BM25 search across per-shell logs (lume). `uid` restricts to one shell.
async fn get_search_shell(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    let context_lines = q.context_lines.unwrap_or(0);
    let hits = state.bridge.lume().search_shell(q.uid.as_deref(), &q.q, limit, context_lines).await;
    Json(serde_json::json!({ "query": q.q, "hits": hits }))
}

/// BM25 search across sticky notes (lume, reads notes.json fresh).
async fn get_search_sticky(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    let hits = state.bridge.lume().search_stickies(&q.q, limit).await;
    Json(serde_json::json!({ "query": q.q, "hits": hits }))
}

/// Render the requested tab's layout as a B&W PNG. Same data path as the MCP
/// `tab_image` tool, exposed over HTTP so a human can open it in the browser
/// for visual debugging. Returns image/png bytes (no JSON wrapper).
async fn get_tab_image(
    State(state): State<AppState>,
    Query(q): Query<TabImageQuery>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let status = state.bridge.get_status().await;
    let windows = status["windows"].as_array().cloned().unwrap_or_default();
    let win = if let Some(wid) = q.window {
        windows.iter().find(|w| w["id"].as_u64() == Some(wid as u64)).cloned()
    } else {
        windows.iter().find(|w| w["focused"].as_bool() == Some(true)).cloned()
            .or_else(|| windows.first().cloned())
    };
    let Some(win) = win else {
        return (StatusCode::NOT_FOUND, "no matching window").into_response();
    };
    let tabs = win["tabs"].as_array().cloned().unwrap_or_default();
    let tab = if let Some(name) = q.tab.as_deref() {
        tabs.iter().find(|t| t["name"].as_str() == Some(name)).cloned()
    } else {
        tabs.iter().find(|t| t["active"].as_bool() == Some(true)).cloned()
            .or_else(|| tabs.first().cloned())
    };
    let Some(tab) = tab else {
        return (StatusCode::NOT_FOUND, "no matching tab").into_response();
    };
    let tab_name = tab["name"].as_str().unwrap_or("(untitled)").to_string();
    let panes_json = tab["panes"].as_array().cloned().unwrap_or_default();
    struct Owned {
        label: String, kind: String, title: String, subtitle: String,
        x: f32, y: f32, w: f32, h: f32,
    }
    let owned: Vec<Owned> = panes_json.iter().map(|p| Owned {
        label: p["label"].as_str().unwrap_or("").to_string(),
        kind: "shell".to_string(),
        title: p["title"].as_str().filter(|s| !s.is_empty())
            .or_else(|| p["process"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| p["shell"].as_str())
            .unwrap_or("").to_string(),
        subtitle: p["cwd"].as_str().filter(|s| !s.is_empty()).unwrap_or("").to_string(),
        x: p["bspX"].as_f64().unwrap_or(0.0) as f32,
        y: p["bspY"].as_f64().unwrap_or(0.0) as f32,
        w: p["bspW"].as_f64().unwrap_or(0.0) as f32,
        h: p["bspH"].as_f64().unwrap_or(0.0) as f32,
    }).collect();
    let cells: Vec<crate::snapshot_image::PaneCell> = owned.iter().map(|o| {
        crate::snapshot_image::PaneCell {
            label: &o.label, kind: &o.kind, title: &o.title, subtitle: &o.subtitle,
            bsp_x: o.x, bsp_y: o.y, bsp_w: o.w, bsp_h: o.h,
        }
    }).collect();
    let png = crate::snapshot_image::render_tab_png(&tab_name, &cells);
    ([("content-type", "image/png")], png).into_response()
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

// (Removed: load_lockout_config + check_human_activity_lockout.) The
// server used to hard-block agent calls when "human activity" was recent
// in a pane and reply with an error code. That was wrong on two axes:
// (1) the other caller might be another agent, not a human, so the
//     "human priority" framing was bogus;
// (2) blocking with an error trained agents to give up instead of
//     deciding for themselves whether to defer or proceed.
// Recency is still observable: terminal_status exposes per-pane
// userActiveSecsAgo so callers that care can read it and decide.

async fn get_screen(State(state): State<AppState>, Query(addr): Query<PaneAddress>) -> (StatusCode, String) {
    let Some(uid) = state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    else {
        let session_count = state.bridge.session_count().await;
        // Demoted from warn! to debug!: pollers (dashboard widgets, agent
        // probes, stale subscriptions to closed tabs) routinely call
        // get_screen with addresses that no longer exist. At warn! these
        // miss-lookups flooded the tracing pipeline and serialized every
        // real MCP call behind the shared log writer — 858 of 1000
        // recent log entries were a single repeated 404 for a long-closed
        // Mac tab. The 404 status is still returned to the caller; only
        // the log line is downgraded.
        tracing::debug!("get_screen 404: window={:?} tab={:?} pane={:?} (sessions={})",
            addr.window, addr.tab, addr.pane, session_count);
        return (StatusCode::NOT_FOUND, format!(
            "No pane at that address (window={:?} tab={:?} pane={:?}, {} sessions registered). \
The pane field accepts either a split label (for example 'a' or 'b') or a paneId from terminal_status. \
If the pane label is empty, use paneId.",
            addr.window, addr.tab, addr.pane, session_count
        ));
    };
    // No human-activity gate: reading the screen never stomps on input.
    let screen = state.bridge.get_screen_text_by_uid(&uid).await;
    if let Some((tab, pane, win)) = state.bridge.pane_address_for_log(&uid).await {
        tracing::info!(
            "screen win={} tab={:?} pane={} bytes={}",
            win, tab, pane, screen.len()
        );
    }
    (StatusCode::OK, screen)
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
        "model": "gemma2:9b",
        "prompt": prompt,
        "stream": false,
    });

    let client = reqwest::Client::new();
    match client.post(format!("{}/api/generate", ollama_url)).json(&body).send().await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(json) => {
                // Strip everything quote-like, punctuation-like, and whitespace
                // from both ends in one pass. Ollama models routinely emit
                // smart quotes, trailing periods, and stacked quote/punct
                // sequences like `Hard Finch'.` or `"Hard Finch'""` that
                // the old chained trim_matches calls couldn't unwind past
                // an interior period. trim_matches with a closure handles
                // it all in a single scan.
                let description = json["response"]
                    .as_str()
                    .unwrap_or("")
                    .trim_matches(|c: char| {
                        c.is_whitespace()
                            || c == '\'' || c == '"' || c == '`'
                            || c == '\u{2018}' || c == '\u{2019}'   // curly single quotes
                            || c == '\u{201C}' || c == '\u{201D}'   // curly double quotes
                            || c == '.' || c == ',' || c == ':' || c == ';' || c == '!' || c == '?'
                    })
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
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            out.push('\r');
        } else if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\r'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('e') => out.push('\x1b'),
                Some('\\') => out.push('\\'),
                Some('x') => {
                    let mut hex = String::new();
                    if let Some(&h1) = chars.peek() {
                        if h1.is_ascii_hexdigit() {
                            chars.next();
                            hex.push(h1);
                            if let Some(&h2) = chars.peek() {
                                if h2.is_ascii_hexdigit() {
                                    chars.next();
                                    hex.push(h2);
                                }
                            }
                        }
                    }
                    if !hex.is_empty() {
                        if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                            out.push(byte as char);
                        } else {
                            out.push('\\');
                            out.push('x');
                            out.push_str(&hex);
                        }
                    } else {
                        out.push('\\');
                        out.push('x');
                    }
                }
                Some('u') => {
                    let mut hex = String::new();
                    for _ in 0..4 {
                        if let Some(&h) = chars.peek() {
                            if h.is_ascii_hexdigit() {
                                chars.next();
                                hex.push(h);
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    if hex.len() == 4 {
                        if let Ok(val) = u32::from_str_radix(&hex, 16) {
                            if let Some(ch) = std::char::from_u32(val) {
                                out.push(ch);
                            } else {
                                out.push('\\');
                                out.push('u');
                                out.push_str(&hex);
                            }
                        } else {
                            out.push('\\');
                            out.push('u');
                            out.push_str(&hex);
                        }
                    } else {
                        out.push('\\');
                        out.push('u');
                        out.push_str(&hex);
                    }
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    
    // Process control character combinations like ctrl+X, Ctrl+X, C-x, c-X, CTRL+X
    let mut result = out;
    let prefixes = ["ctrl+", "Ctrl+", "CTRL+", "c-", "C-"];
    for prefix in prefixes {
        while let Some(pos) = result.to_lowercase().find(&prefix.to_lowercase()) {
            if pos + prefix.len() < result.len() {
                let ch = result.as_bytes()[pos + prefix.len()];
                let ch_upper = (ch as char).to_ascii_uppercase();
                if ch_upper >= 'A' && ch_upper <= 'Z' {
                    let ctrl_char = ((ch_upper as u8) - b'A' + 1) as char;
                    result = format!(
                        "{}{}{}",
                        &result[..pos],
                        ctrl_char,
                        &result[pos + prefix.len() + 1..]
                    );
                } else if ch as char == '[' {
                    result = format!(
                        "{}{}{}",
                        &result[..pos],
                        '\x1b',
                        &result[pos + prefix.len() + 1..]
                    );
                } else {
                    result = format!(
                        "{}{}",
                        &result[..pos],
                        &result[pos + prefix.len()..]
                    );
                }
            } else {
                break;
            }
        }
    }
    result
}

async fn post_type(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty body".into());
    }
    // raw=true sends the body byte-for-byte. raw=false (default) treats the
    // body as containing escape sequences (\x03 → Ctrl-C etc.). terminal_run
    // uses raw=true so Windows paths like `\research` aren't shredded by the
    // `\r` → CR rule; terminal_keys uses raw=false so \x.. still works.
    let keys = if addr.raw.unwrap_or(false) { body.clone() } else { unescape_keys(&body) };
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
    let interrupt = addr.interrupt.unwrap_or(false);
    // The human-activity gate now lives in the renderer (enqueueOrWrite): when
    // the human is active in this pane it QUEUES the keys and replies with a
    // "queued — resend with interrupt=true" notice instead of silently
    // swallowing them. interrupt=true bypasses the queue and writes now (for
    // Ctrl-C and other take-overs). We forward the flag and let the renderer
    // decide, so the agent always gets an honest result.
    if let Some((tab, pane, win)) = state.bridge.pane_address_for_log(&uid).await {
        tracing::info!(
            "type win={} tab={:?} pane={} bytes={} interrupt={} preview={:?}",
            win, tab, pane, keys.len(), interrupt, &keys[..keys.len().min(120)]
        );
    }
    let cmd = serde_json::json!({"type": "Keys", "uid": uid, "keys": keys, "interrupt": interrupt});
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
    // No activity gate: another caller (human OR agent) being active is not
    // grounds to refuse this call. Agents can see per-pane userActiveSecsAgo
    // via terminal_status and decide for themselves whether to defer/warn.
    let quiet_ms = addr.quiet_ms.unwrap_or(400).clamp(100, 10_000);
    // raw=true: send body verbatim (no \r/\n/\x.. interpretation). Needed
    // for terminal_run so Windows paths with `\research`, `\new`, `\test`
    // aren't shredded by the unescape rule.
    let keys = if addr.raw.unwrap_or(false) { body.clone() } else { unescape_keys(&body) };
    let log_addr = state.bridge.pane_address_for_log(&uid).await;
    if let Some((tab, pane, win)) = &log_addr {
        tracing::info!(
            "type-and-collect ▶ win={} tab={:?} pane={} quiet_ms={} bytes_in={} preview={:?}",
            win, tab, pane, quiet_ms, keys.len(), &keys[..keys.len().min(120)]
        );
    }
    let output = state.bridge.type_and_collect(&uid, &keys, quiet_ms).await;
    if let Some((tab, pane, win)) = &log_addr {
        tracing::info!(
            "type-and-collect ◀ win={} tab={:?} pane={} bytes_out={}",
            win, tab, pane, output.len()
        );
    }
    (StatusCode::OK, output)
}

async fn post_split(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    // No human-activity lockout: a split creates a NEW pane; it doesn't
    // stomp on whatever the human is typing in the active pane. Blocking
    // it just made splits silently fail with 409 while the user was busy.
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let direction = parsed["direction"].as_str().unwrap_or("vertical").to_string();
    let profile = parsed["profile"].as_str().unwrap_or("").to_string();
    let command = parsed["command"].as_str().unwrap_or("").to_string();

    let cmd = serde_json::json!({
        "type": "Split",
        "direction": direction,
        "profile": profile,
        "command": command
    });
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

    // No human-activity lockout: focus is purely visual — it shifts which
    // pane is active, it doesn't send any input to the pane. Blocking it
    // confused agents into thinking they couldn't even orient themselves.
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
    // No activity gate on close either: agents can check userActiveSecsAgo
    // via terminal_status if they care to warn before tearing down a pane.
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

async fn post_layout_save(State(state): State<AppState>) -> (StatusCode, String) {
    let cmd = serde_json::json!({"type": "SaveLayoutState"});
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

async fn post_web_pane_reload(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
) -> (StatusCode, String) {
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => {
            return (StatusCode::NOT_FOUND, "No web pane found at that address".into());
        }
    };
    let cmd = serde_json::json!({"type": "WebPaneReload", "uid": uid});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_web_pane_content(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
) -> (StatusCode, String) {
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => {
            return (StatusCode::NOT_FOUND, "No web pane found at that address".into());
        }
    };
    let cmd = serde_json::json!({"type": "WebPaneContent", "uid": uid});
    let raw = match state.bridge.send_command(cmd).await {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    // The renderer returns {success, url, title, html}. Convert the rendered DOM
    // to clean reader-mode markdown with grub's converter (no external re-fetch).
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    if parsed.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return (StatusCode::OK, raw); // pass through the error shape unchanged
    }
    let url = parsed["url"].as_str().unwrap_or("");
    let title = parsed["title"].as_str().unwrap_or("");
    let html = parsed["html"].as_str().unwrap_or("");
    let markdown = grub_md::to_markdown(html, url);
    let out = serde_json::json!({
        "success": true,
        "url": url,
        "title": title,
        "markdown": markdown,
    });
    (StatusCode::OK, out.to_string())
}

async fn post_web_pane_click(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let text = parsed["text"].as_str().map(|s| s.to_string());
    let selector = parsed["selector"].as_str().map(|s| s.to_string());

    if text.is_none() && selector.is_none() {
        return (StatusCode::BAD_REQUEST, "Either text or selector is required".into());
    }

    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => {
            return (StatusCode::NOT_FOUND, "No web pane found at that address".into());
        }
    };

    let cmd = serde_json::json!({
        "type": "WebPaneClick",
        "uid": uid,
        "text": text,
        "selector": selector
    });
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_web_pane_eval(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let js = parsed["js"].as_str().unwrap_or("").to_string();
    if js.is_empty() {
        return (StatusCode::BAD_REQUEST, "'js' is required".into());
    }
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, "No web pane found at that address".into()),
    };
    let cmd = serde_json::json!({"type": "WebPaneEval", "uid": uid, "js": js});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_web_pane_mouse(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let x = parsed["x"].as_f64().unwrap_or(0.0);
    let y = parsed["y"].as_f64().unwrap_or(0.0);
    let action = parsed["action"].as_str().unwrap_or("move").to_string();
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, "No web pane found at that address".into()),
    };
    let cmd = serde_json::json!({"type": "WebPaneMouse", "uid": uid, "x": x, "y": y, "action": action});
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

async fn post_note_open(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let id = parsed["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }
    let cmd = serde_json::json!({"type": "NoteOpen", "id": id});
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
            let notes = serde_json::from_str::<Vec<serde_json::Value>>(&content).unwrap_or_default();
            let note = resolve_note(&notes, &id);
            match note {
                Some(n) => (StatusCode::OK, serde_json::to_string(&n).unwrap_or_else(|_| "{}".into())),
                None => (StatusCode::NOT_FOUND, format!("Note {} not found", id)),
            }
        }
        Err(_) => (StatusCode::NOT_FOUND, format!("Note {} not found", id)),
    }
}

/// Resolve a note by id, accepting either the full id (`note-<ts>-<suffix>`) or
/// just the short suffix users actually quote (`6r7t`). Exact match wins; failing
/// that, match a note whose id ends with `-<id>` (case-insensitive).
fn resolve_note<'a>(notes: &'a [serde_json::Value], id: &str) -> Option<&'a serde_json::Value> {
    if let Some(n) = notes.iter().find(|n| n["id"].as_str() == Some(id)) {
        return Some(n);
    }
    let id_l = id.to_lowercase();
    let suffix = format!("-{}", id_l);
    notes.iter().find(|n| {
        n["id"]
            .as_str()
            .map(|nid| nid.to_lowercase())
            .map(|nid| nid == id_l || nid.ends_with(&suffix))
            .unwrap_or(false)
    })
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

/// Schedule (or with body {"schedule":null} unschedule) a sticky. The schedule
/// object is forwarded verbatim to Electron, which owns the timer + runners.
async fn post_note_schedule(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: String,
) -> (StatusCode, String) {
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    // Accept either the bare schedule object or {"schedule": {...}}.
    let schedule = if parsed.get("schedule").is_some() {
        parsed["schedule"].clone()
    } else {
        parsed
    };
    let cmd = serde_json::json!({"type": "NoteSchedule", "id": id, "schedule": schedule});
    match state.bridge.send_command(cmd).await {
        Ok(_) => (StatusCode::OK, serde_json::json!({"ok": true}).to_string()),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// Grapheme-safe transactional file edit, backed by the aegis-edit module.
/// Body: { path, edits: [{start_line,start_col,end_line,end_col,text}], preview? }.
/// Reads the file → LOPT Document → applies disjoint edits back-to-front → writes
/// atomically (temp + rename). On any validation error nothing is written.
async fn post_edit_apply(body: String) -> (StatusCode, String) {
    use aegis_edit::{Document, TextEdit};
    let err = |code: StatusCode, msg: String| (code, serde_json::json!({"ok": false, "error": msg}).to_string());

    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("bad JSON: {e}")),
    };
    let path = parsed["path"].as_str().unwrap_or("").to_string();
    if path.is_empty() {
        return err(StatusCode::BAD_REQUEST, "'path' is required".into());
    }
    let preview = parsed["preview"].as_bool().unwrap_or(false);

    let edits_json = parsed["edits"].as_array().cloned().unwrap_or_default();
    if edits_json.is_empty() {
        return err(StatusCode::BAD_REQUEST, "'edits' must be a non-empty array".into());
    }
    let edits: Vec<TextEdit> = edits_json
        .iter()
        .map(|e| TextEdit {
            start_line: e["start_line"].as_u64().unwrap_or(0) as usize,
            start_col: e["start_col"].as_u64().unwrap_or(0) as usize,
            end_line: e["end_line"].as_u64().unwrap_or(0) as usize,
            end_col: e["end_col"].as_u64().unwrap_or(0) as usize,
            text: e["text"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    let applied = edits.len();

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => return err(StatusCode::NOT_FOUND, format!("read {path}: {e}")),
    };

    let mut doc = Document::new(content);
    if let Err(e) = doc.apply_transactional_edits(edits) {
        // Validation failure → file untouched (transactional rollback property).
        return err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string());
    }
    let new_content = doc.render();
    let lines = doc.line_count();
    let bytes = new_content.len();

    if !preview {
        // Atomic write: temp file in the same dir + rename (Rust's fs::rename
        // overwrites the destination on Windows via MoveFileEx REPLACE_EXISTING).
        let p = std::path::Path::new(&path);
        let tmp = p.with_extension(format!("aegistmp{}", std::process::id()));
        if let Err(e) = std::fs::write(&tmp, new_content.as_bytes()) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("write tmp: {e}"));
        }
        if let Err(e) = std::fs::rename(&tmp, p) {
            let _ = std::fs::remove_file(&tmp);
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("rename: {e}"));
        }
    }

    // Bound the echoed preview so a huge file doesn't flood the response.
    let preview_str = if new_content.chars().count() > 4000 {
        new_content.chars().take(4000).collect::<String>() + "\n…[truncated]"
    } else {
        new_content.clone()
    };

    (
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "path": path,
            "lines": lines,
            "bytes": bytes,
            "applied": applied,
            "wrote": !preview,
            "preview": preview_str,
        })
        .to_string(),
    )
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

    // Normal sidecar mode.
    //
    // Two log sinks side-by-side:
    //   1. In-memory ring buffer (1000 lines) — served by /api/logs for the
    //      Settings panel and the sidecar_logs MCP tool. Lost on restart.
    //   2. Daily-rotating file under ~/.hyperia/logs/sidecar.log.YYYY-MM-DD.
    //      Survives restarts so anything that happened mid-session is
    //      recoverable. Keeps ALL log lines, not just the latest 1000.
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let log_dir = home
        .map(|h| std::path::PathBuf::from(h).join(".hyperia").join("logs"))
        .unwrap_or_else(|| std::path::PathBuf::from(".hyperia-logs"));
    let _ = std::fs::create_dir_all(&log_dir);

    let log_buffer = logs::new_log_buffer();
    let file_appender = tracing_appender::rolling::daily(&log_dir, "sidecar.log");
    let (file_writer, _file_guard) = tracing_appender::non_blocking(file_appender);
    // Leak the guard so the non-blocking writer keeps draining for the
    // process lifetime. Dropping it would close the file early.
    Box::leak(Box::new(_file_guard));

    use tracing_subscriber::fmt::writer::MakeWriterExt;
    let writer = logs::LogBufferMakeWriter::new(log_buffer.clone()).and(file_writer);
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()),
        )
        .with_writer(writer)
        .with_ansi(false)
        .init();

    tracing::info!("hyperia-sidecar v{}", env!("CARGO_PKG_VERSION"));
    tracing::info!("API :{}", args.port);
    tracing::info!("log dir: {} (daily rotation)", log_dir.display());

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
    // Grab lume handles before `state` is moved into the router below.
    let lume_for_flush = state.bridge.lume();
    let lume_for_shutdown = state.bridge.lume();

    let app = axum::Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
        .route("/api/mcp/hyperia.py", axum::routing::get(get_mcp_python))
        .route("/ws", axum::routing::get(bridge::ws_handler))
        // Read endpoints
        .route("/api/logs", axum::routing::get(get_logs))
        .route("/api/log", axum::routing::post(post_client_log))
        .route("/api/status", axum::routing::get(get_status))
        .route("/api/screen", axum::routing::get(get_screen))
        .route("/api/fs/dirs", axum::routing::get(get_fs_dirs))
        .route("/api/tab/image", axum::routing::get(get_tab_image))
        .route("/api/search/shell", axum::routing::get(get_search_shell))
        .route("/api/search/sticky", axum::routing::get(get_search_sticky))
        .route("/api/edit/apply", axum::routing::post(post_edit_apply))
        // Write endpoints
        .route("/api/type", axum::routing::post(post_type))
        .route("/api/type-and-collect", axum::routing::post(post_type_and_collect))
        .route("/api/pane/split", axum::routing::post(post_split))
        .route("/api/pane/focus", axum::routing::post(post_focus))
        .route("/api/pane/close", axum::routing::post(post_close))
        .route("/api/pane/new", axum::routing::post(post_new_tab))
        .route("/api/window/new", axum::routing::post(post_new_window))
        .route("/api/layout/save", axum::routing::post(post_layout_save))
        .route("/api/web-pane", axum::routing::post(post_open_web_pane))
        .route("/api/web-pane/reload", axum::routing::post(post_web_pane_reload))
        .route("/api/web-pane/click", axum::routing::post(post_web_pane_click))
        .route("/api/web-pane/content", axum::routing::post(post_web_pane_content))
        .route("/api/web-pane/eval", axum::routing::post(post_web_pane_eval))
        .route("/api/web-pane/mouse", axum::routing::post(post_web_pane_mouse))
        .route("/api/pane/where", axum::routing::get(get_where_pane))
        .route("/api/pane/rename", axum::routing::post(post_rename_tab))
        .route("/api/agent/status", axum::routing::post(post_agent_status))
        .route("/api/ui/key", axum::routing::post(post_ui_key))
        .route("/api/pane/describe", axum::routing::post(post_auto_describe))
        .route("/api/notes", axum::routing::get(get_notes).post(post_note_create))
        .route("/api/notes/highlight", axum::routing::post(post_notes_highlight))
        .route("/api/notes/{id}", axum::routing::get(get_note).delete(delete_note).patch(patch_note))
        .route("/api/notes/{id}/schedule", axum::routing::post(post_note_schedule))
        .route("/api/notes/close", axum::routing::post(post_note_close))
        .route("/api/notes/open", axum::routing::post(post_note_open))
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
        // Widget data + action endpoints back the tool_mount SSE event.
        .route("/api/ghost/widget/{id}/data", axum::routing::get(ghost::api::ghost_widget_data))
        .route("/api/ghost/widget/{id}/action", axum::routing::post(ghost::api::ghost_widget_action))
        // Capabilities probe — boot-level decision for the shell page.
        .route("/api/ghost/capabilities", axum::routing::get(ghost::api::ghost_capabilities))
        // Bootstub — Level-0 micro-agent for the no-model-wired case.
        .route("/api/ghost/bootchat", axum::routing::post(ghost::api::ghost_bootchat))
        // Model picker — writes config.agent.{provider,model} from the shell.
        .route("/api/ghost/set-model", axum::routing::post(ghost::api::ghost_set_model))
        .route("/api/ghost/wipe-config", axum::routing::post(ghost::api::ghost_wipe_config))
        // Assets: paste/drop targets land here, then appear as rows in the shell.
        .route(
            "/api/ghost/asset",
            axum::routing::post(ghost::api::ghost_asset_upload)
                .layer(axum::extract::DefaultBodyLimit::max(25 * 1024 * 1024)),
        )
        .route("/api/ghost/asset/{id}", axum::routing::get(ghost::api::ghost_asset_get))
        .route("/api/ghost/assets", axum::routing::get(ghost::api::ghost_asset_list))
        // Static page: the agentic shell pane's HTML.
        .route("/shell", axum::routing::get(ghost::api::ghost_shell_page))
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

    let addr = std::net::SocketAddr::new(args.bind, args.port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sidecar] Port {} already in use — another sidecar is running. Exiting. ({})", args.port, e);
            std::process::exit(0); // Exit cleanly so auto-restart doesn't loop
        }
    };
    if !args.bind.is_loopback() {
        tracing::warn!(
            "Sidecar bound to {} — reachable from outside this machine. \
            All Hyperia MCP tools (terminal_run, file_read, file_write, etc.) \
            are now accessible to anyone who can reach this address. Use behind \
            a firewall you trust.",
            args.bind
        );
        eprintln!("[sidecar] WARNING: bound to {} (non-loopback) — exposed to network", args.bind);
    }
    tracing::info!(%addr, "Sidecar HTTP listening");
    eprintln!("[sidecar] HTTP ready on :{}", args.port);

    // Periodically pickle the lume per-shell logs to disk. Hyperia shuts the
    // sidecar down with `taskkill /F` (uncatchable), so a shutdown-only hook
    // would lose data — a 45s flush bounds the loss instead. The graceful
    // ctrl_c path below adds a final flush for the soft-shutdown case.
    {
        let lume = lume_for_flush;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(45));
            tick.tick().await; // consume the immediate first tick
            loop {
                tick.tick().await;
                lume.persist().await;
            }
        });
    }

    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        lume_for_shutdown.persist().await;
    });
    if let Err(e) = serve.await {
        eprintln!("[sidecar] axum::serve error: {e}");
        std::process::exit(0); // Exit cleanly — Electron will restart if needed
    }

    Ok(())
}
