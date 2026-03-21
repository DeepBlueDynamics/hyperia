mod auracle;
mod bridge;
mod chat;
mod dashboard;
mod deck;
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
#[command(about = "Rust sidecar for Hyperia: Stream Deck, agent engine, MCP, HTTP bridge")]
struct Args {
    /// HTTP API port (Electron connects here)
    #[arg(long, default_value = "9800")]
    port: u16,

    /// Stream Deck HTTP port
    #[arg(long, default_value = "9850")]
    deck_port: u16,

    /// Enable Stream Deck Plus integration
    #[arg(long)]
    deck: bool,

    /// Run as MCP stdio server
    #[arg(long)]
    mcp: bool,

    /// Enable Auracle (voice/mic) integration
    #[arg(long)]
    auracle: bool,
}

#[derive(Clone)]
struct AppState {
    bridge: Bridge,
    log_buffer: logs::LogBuffer,
    telemetry: telemetry::TelemetryStore,
    auracle: Option<auracle::Auracle>,
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
    let keys = unescape_keys(&body);
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
// Voice (Auracle) route handlers
// ---------------------------------------------------------------------------

async fn get_voice_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    if let Some(ref a) = state.auracle {
        Json(serde_json::to_value(a.status().await).unwrap_or_default())
    } else {
        Json(serde_json::json!({"running": false, "error": "Auracle not enabled (use --auracle)"}))
    }
}

async fn post_voice_start(State(state): State<AppState>) -> (StatusCode, String) {
    match &state.auracle {
        Some(a) => match a.start().await {
            Ok(msg) => (StatusCode::OK, msg),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        },
        None => (StatusCode::BAD_REQUEST, "Auracle not enabled".into()),
    }
}

async fn post_voice_stop(State(state): State<AppState>) -> (StatusCode, String) {
    match &state.auracle {
        Some(a) => (StatusCode::OK, a.stop().await),
        None => (StatusCode::BAD_REQUEST, "Auracle not enabled".into()),
    }
}

async fn post_voice_toggle(State(state): State<AppState>) -> (StatusCode, String) {
    match &state.auracle {
        Some(a) => match a.toggle().await {
            Ok(msg) => (StatusCode::OK, msg),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        },
        None => (StatusCode::BAD_REQUEST, "Auracle not enabled".into()),
    }
}

/// Receives forwarded transcripts from Auracle's callback system.
/// The body is plain text like "[Mic] hello world".
async fn post_voice_forward(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty transcript".into());
    }
    match &state.auracle {
        Some(a) => match a.handle_transcript(&body).await {
            Ok(r) => (StatusCode::OK, r),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        },
        None => {
            // Even without --auracle, forward to first pane via bridge
            let uid = state.bridge.pane_uid(0).await;
            match uid {
                Some(u) => {
                    let cmd = serde_json::json!({"type": "Keys", "uid": u, "keys": body});
                    match state.bridge.send_command(cmd).await {
                        Ok(r) => (StatusCode::OK, r),
                        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
                    }
                }
                None => (StatusCode::NOT_FOUND, "No active pane".into()),
            }
        }
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

    // Stream Deck (optional)
    if args.deck {
        match deck::init_deck(args.deck_port).await {
            Ok(dh) => {
                tracing::info!("Stream Deck Plus connected");
                let _ = dh;
            }
            Err(e) => {
                tracing::warn!("Stream Deck not available: {e}");
            }
        }
    }

    let bridge = Bridge::new();
    let telem = telemetry::TelemetryStore::new();
    let dash_state = dashboard::DashboardState::new(telem.clone());

    // Auracle (voice/mic) — optional
    let auracle_handle = if args.auracle {
        Some(auracle::init_auracle(bridge.clone(), args.port, true).await)
    } else {
        // Still create the handle (for toggle via API) but don't auto-start
        Some(auracle::init_auracle(bridge.clone(), args.port, false).await)
    };

    let state = AppState { bridge, log_buffer, telemetry: telem, auracle: auracle_handle };

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
        .route("/api/agent/status", axum::routing::post(post_agent_status))
        // Voice (Auracle) endpoints
        .route("/api/voice/status", axum::routing::get(get_voice_status))
        .route("/api/voice/start", axum::routing::post(post_voice_start))
        .route("/api/voice/stop", axum::routing::post(post_voice_stop))
        .route("/api/voice/toggle", axum::routing::post(post_voice_toggle))
        .route("/api/voice/forward", axum::routing::post(post_voice_forward))
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
    tracing::info!(%addr, "Sidecar HTTP listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
