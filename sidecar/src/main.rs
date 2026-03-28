#![allow(dead_code, unused_imports, unused_variables)]

mod bridge;
mod chat;
mod dashboard;
mod logs;
mod mcp;
mod screen;
mod telemetry;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use clap::Parser;
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

async fn get_logs(State(state): State<AppState>) -> Json<Vec<String>> {
    let lines = state.log_buffer.lock().unwrap();
    Json(lines.iter().cloned().collect())
}

async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.bridge.get_status().await)
}

async fn get_screen(State(state): State<AppState>, Path(pane): Path<usize>) -> String {
    state.bridge.get_screen_text(Some(pane)).await
}

async fn post_auto_describe(
    State(state): State<AppState>,
    Path(pane): Path<usize>,
) -> (StatusCode, String) {
    let screen = state.bridge.get_screen_text(Some(pane)).await;
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
                let description = json["response"].as_str().unwrap_or("").trim().to_string();
                // Update the session description in the bridge
                state.bridge.set_description(pane, &description).await;
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
    Path(pane): Path<usize>,
    body: String,
) -> (StatusCode, String) {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty body".into());
    }
    // Don't unescape here — callers send raw bytes.
    // MCP terminal_keys handles its own unescaping before calling this endpoint.
    let keys = body;
    let uid = match state.bridge.pane_uid(pane).await {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, format!("No pane at index {pane}")),
    };
    let cmd = serde_json::json!({"type": "Keys", "uid": uid, "keys": keys});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
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

    // Focus by pane index — resolve to uid
    if let Some(id) = parsed["id"].as_u64() {
        let uid = match state.bridge.pane_uid(id as usize).await {
            Some(u) => u,
            None => return (StatusCode::NOT_FOUND, format!("No pane at index {id}")),
        };
        let cmd = serde_json::json!({"type": "Focus", "uid": uid});
        match state.bridge.send_command(cmd).await {
            Ok(r) => (StatusCode::OK, r),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        }
    } else {
        (StatusCode::BAD_REQUEST, "Missing 'id' field".into())
    }
}

async fn post_close(State(state): State<AppState>) -> (StatusCode, String) {
    let cmd = serde_json::json!({"type": "Close"});
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

async fn post_rename_tab(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let id = parsed["id"].as_u64().unwrap_or(0);
    let name = parsed["name"].as_str().unwrap_or("").to_string();

    // Update locally in sidecar
    {
        let mut sessions = state.bridge.sessions().await;
        if let Some((_uid, info)) = sessions.iter_mut().nth(id as usize) {
            info.tab_name = name.clone();
        }
    }

    // Tell Electron to update the renderer
    let cmd = serde_json::json!({"type": "Rename", "id": id, "name": name});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
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
    }
    if let Some(pane) = parsed["pane"].as_u64() {
        cmd["pane"] = serde_json::json!(pane);
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

    let bridge = Bridge::new();
    let telem = telemetry::TelemetryStore::new();
    let dash_state = dashboard::DashboardState::new(telem.clone());
    let state = AppState { bridge, log_buffer, telemetry: telem };

    let app = axum::Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
        .route("/ws", axum::routing::get(bridge::ws_handler))
        // Read endpoints
        .route("/api/logs", axum::routing::get(get_logs))
        .route("/api/status", axum::routing::get(get_status))
        .route("/api/screen/{pane}", axum::routing::get(get_screen))
        // Write endpoints
        .route("/api/type/{pane}", axum::routing::post(post_type))
        .route("/api/pane/split", axum::routing::post(post_split))
        .route("/api/pane/focus", axum::routing::post(post_focus))
        .route("/api/pane/close", axum::routing::post(post_close))
        .route("/api/pane/new", axum::routing::post(post_new_tab))
        .route("/api/pane/rename", axum::routing::post(post_rename_tab))
        .route("/api/agent/status", axum::routing::post(post_agent_status))
        .route("/api/pane/describe/{pane}", axum::routing::post(post_auto_describe))
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

    let app = app.merge(dash_routes);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("Port {} already in use — another sidecar is running. Exiting. ({})", args.port, e);
            std::process::exit(0); // Exit cleanly so auto-restart doesn't loop
        }
    };
    tracing::info!(%addr, "Sidecar HTTP listening");
    axum::serve(listener, app).await?;

    Ok(())
}
