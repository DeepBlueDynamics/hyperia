use std::collections::HashMap;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse};
use axum::Json;
use futures::Stream;
use tokio::sync::Mutex;

use super::agent::{GhostSession, SessionState};
use super::ferricula::{FerriculaBackend, load_ferricula_config};
use super::provider::AnyProvider;
use super::registry::ToolRegistry;
use super::types::{ChatRequest, GhostEvent};
use super::widget::{WidgetAction, WidgetError};

/// Shared state for the Ghost agent, stored in the axum app state.
/// Config is lazy-loaded per request so no restart is needed after setting a token.
#[derive(Clone)]
pub struct GhostState {
    pub session: Arc<Mutex<GhostSession>>,
    pub registry: Arc<ToolRegistry>,
    pub ferricula: Arc<FerriculaBackend>,
    pub http_port: u16,
}

impl GhostState {
    pub fn new(http_port: u16) -> Self {
        let session = Arc::new(Mutex::new(GhostSession::new(25)));
        let fc_config = load_ferricula_config();
        let ferricula = Arc::new(FerriculaBackend::new(&fc_config));
        let registry = Arc::new(ToolRegistry::new(http_port).with_ferricula(ferricula.clone()));
        Self {
            session,
            registry,
            ferricula,
            http_port,
        }
    }
}

/// POST /api/ghost/chat — send a message, get SSE stream back.
pub async fn ghost_chat(
    State(state): State<GhostState>,
    Json(req): Json<ChatRequest>,
) -> Sse<Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>> {
    // Lazy-load config each request — no restart needed after setting token
    let config = match super::load_config() {
        Some(c) => c,
        None => {
            let s = async_stream::stream! {
                let event = GhostEvent::Error {
                    message: "No agent token configured. Set your API token in Settings (Ctrl+,).".into(),
                };
                let json = serde_json::to_string(&event).unwrap_or_default();
                yield Ok::<_, Infallible>(Event::default().data(json));
            };
            return Sse::new(Box::pin(s));
        }
    };

    let provider = Arc::new(AnyProvider::from_config(&config));
    let registry = state.registry.clone();
    let session_mutex = state.session.clone();
    let ferricula = state.ferricula.clone();

    let rx = {
        let mut session = state.session.lock().await;
        session.run(req.message, registry, provider, session_mutex.clone(), ferricula)
    };

    let s = async_stream::stream! {
        let mut rx = rx;
        while let Some(event) = rx.recv().await {
            let json = serde_json::to_string(&event).unwrap_or_default();
            yield Ok::<_, Infallible>(Event::default().data(json));
        }
    };

    Sse::new(Box::pin(s))
}

/// GET /api/ghost/status — current agent state.
pub async fn ghost_status(State(state): State<GhostState>) -> Json<serde_json::Value> {
    let has_token = super::load_config().is_some();
    let session = state.session.lock().await;
    let state_str = match session.state() {
        SessionState::Idle => "idle",
        SessionState::Running => "running",
        SessionState::Completed(_) => "completed",
        SessionState::Error(_) => "error",
    };
    Json(serde_json::json!({
        "state": state_str,
        "turn": session.turn(),
        "messages": session.message_count(),
        "stop_requested": session.stop_requested(),
        "has_token": has_token,
    }))
}

/// GET /api/ghost/history — return chat messages from Ferricula for restoring the UI.
pub async fn ghost_history(State(state): State<GhostState>) -> Json<serde_json::Value> {
    let turns = state.ferricula.history(50).await;
    let messages: Vec<serde_json::Value> = turns
        .into_iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();
    Json(serde_json::json!({ "messages": messages }))
}

/// GET /api/ghost/memory — inspect Ferricula memory state.
pub async fn ghost_memory(State(state): State<GhostState>) -> Json<serde_json::Value> {
    let info = state.ferricula.config_json();
    let history = state.ferricula.history(20).await;
    let recent: Vec<serde_json::Value> = history
        .into_iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();

    Json(serde_json::json!({
        "config": info,
        "recent_history": recent,
    }))
}

/// POST /api/ghost/inject — queue a user message while the agent is
/// running. The agent drains the queue between API calls and splices the
/// messages into its next user turn so they're read without a hard
/// interrupt. Body: { message: string }.
pub async fn ghost_inject(
    State(state): State<GhostState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let msg = body["message"].as_str().unwrap_or("").trim().to_string();
    if msg.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "message is required"
        }));
    }
    let session = state.session.lock().await;
    session.inject_user_message(msg);
    Json(serde_json::json!({ "ok": true }))
}

/// POST /api/ghost/ui-response — renderer reports a user response to a
/// pending show_* widget. Body: { id, value? } or { id, dismissed: true }.
pub async fn ghost_ui_response(
    State(state): State<GhostState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = body["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "id is required"
        }));
    }
    let response = if body["dismissed"].as_bool().unwrap_or(false) {
        super::registry::UiResponse::Dismissed
    } else {
        // Accept any JSON for value (string, number, array, object).
        super::registry::UiResponse::Value(body["value"].clone())
    };
    let resolved = state.registry.resolve_ui_response(&id, response).await;
    Json(serde_json::json!({ "ok": resolved, "id": id }))
}

/// POST /api/ghost/stop — request that the running agent wrap up and stop.
pub async fn ghost_stop(State(state): State<GhostState>) -> &'static str {
    let session = state.session.lock().await;
    session.request_stop();
    "stop requested"
}

/// POST /api/ghost/continue — clear a pending stop request.
pub async fn ghost_continue(State(state): State<GhostState>) -> &'static str {
    let session = state.session.lock().await;
    session.continue_run();
    "continuing"
}

/// POST /api/ghost/reset — clear conversation.
pub async fn ghost_reset(State(state): State<GhostState>) -> &'static str {
    let mut session = state.session.lock().await;
    session.reset();
    "ok"
}

/// POST /api/ghost/window-closed — notify agent that the chat window was closed.
pub async fn ghost_window_closed(State(state): State<GhostState>) -> &'static str {
    let session = state.session.lock().await;
    session.notify_window_closed();
    "ok"
}

/// GET /api/ghost/session — full current session messages for analysis/reporting.
pub async fn ghost_session_dump(State(state): State<GhostState>) -> Json<serde_json::Value> {
    let session = state.session.lock().await;
    let messages = session.messages();
    Json(serde_json::json!({
        "turn": session.turn(),
        "message_count": session.message_count(),
        "messages": messages,
    }))
}

// ─── Widget data + action endpoints (backs the tool_mount SSE event) ───────

fn widget_error_response(err: WidgetError) -> (StatusCode, Json<serde_json::Value>) {
    let status = StatusCode::from_u16(err.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(serde_json::json!({ "ok": false, "error": err.to_string() })))
}

/// GET /api/ghost/widget/:id/data?key=<name> — read a data value that the
/// agent stashed for this mount. 403 if the key isn't in the mount's
/// `exposes` allowlist; 404 if the widget doesn't exist or was dismissed.
pub async fn ghost_widget_data(
    State(state): State<GhostState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let key = params.get("key").map(|s| s.as_str()).unwrap_or("").trim();
    if key.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "?key= is required" })),
        ));
    }
    let store = state.registry.widget_store();
    match store.get_data(&id, key) {
        Ok(value) => Ok(Json(serde_json::json!({ "ok": true, "value": value }))),
        Err(e) => Err(widget_error_response(e)),
    }
}

/// POST /api/ghost/widget/:id/action — widget requests an agent action.
/// Body: `{ "action": "<name>", "args": <any-json> }`. The action is queued
/// (not invoked); the agent reads the queue at the top of its next loop
/// iteration and decides whether to honor it. 403 if `action` not in the
/// mount's `permits` allowlist; 404 if the widget is gone.
pub async fn ghost_widget_action(
    State(state): State<GhostState>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, Json<serde_json::Value>)> {
    let action_name = body["action"].as_str().unwrap_or("").trim().to_string();
    if action_name.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "'action' is required" })),
        ));
    }
    let args = body.get("args").cloned().unwrap_or(serde_json::Value::Null);
    let store = state.registry.widget_store();
    match store.queue_action(&id, WidgetAction { action: action_name, args }) {
        Ok(()) => Ok((StatusCode::ACCEPTED, Json(serde_json::json!({ "ok": true })))),
        Err(e) => Err(widget_error_response(e)),
    }
}

// ─── Capabilities probe (boot-level for the shell page) ────────────────────

/// GET /api/ghost/capabilities — what the sidecar can do right now. Probed
/// fresh per call (cheap: a config read + two short HTTP HEAD/GET to
/// ollama + ferricula). The shell page uses this to pick boot level:
///   none      — no token, no ollama, no ferricula → bootstub micro-agent
///   local     — ollama only
///   frontier  — token only
///   hybrid    — both
pub async fn ghost_capabilities(State(state): State<GhostState>) -> Json<serde_json::Value> {
    use std::time::Duration;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Provider tokens — read straight off the config file (no model needed).
    let cfg = super::super::ghost::load_config();
    let active_provider = cfg.as_ref().map(|c| c.provider.clone()).unwrap_or_default();
    let active_model = cfg.as_ref().map(|c| c.model.clone()).unwrap_or_default();

    // Read raw config for per-provider token presence (independent of
    // load_config's fallback semantics).
    let raw_cfg = config_raw().unwrap_or(serde_json::Value::Null);
    let providers = &raw_cfg["config"]["providers"];
    let has_token = |name: &str| -> bool {
        providers[name]["token"].as_str().map(|s| !s.is_empty()).unwrap_or(false)
    };

    // Ollama probe — try /api/version.
    let ollama_endpoint = providers["ollama"]["endpoint"]
        .as_str()
        .unwrap_or("http://localhost:11434")
        .trim_end_matches('/')
        .to_string();
    let ollama_reachable = client
        .get(format!("{}/api/version", ollama_endpoint))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    // Ferricula probe — config.json() returns base_url. We just check reachable.
    let ferricula_info = state.ferricula.config_json();
    let ferricula_base = ferricula_info["base_url"].as_str().unwrap_or("").to_string();
    let ferricula_reachable = if ferricula_base.is_empty() {
        false
    } else {
        client
            .get(format!("{}/status", ferricula_base.trim_end_matches('/')))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    };

    let has_anthropic = has_token("anthropic");
    let has_openai = has_token("openai");
    let has_gemini = has_token("gemini");
    let has_frontier = has_anthropic || has_openai || has_gemini;

    let level = match (has_frontier, ollama_reachable) {
        (true, true) => "hybrid",
        (true, false) => "frontier",
        (false, true) => "local",
        (false, false) => "none",
    };

    Json(serde_json::json!({
        "sidecar": env!("CARGO_PKG_VERSION"),
        "level": level,
        "agent": {
            "provider": active_provider,
            "model": active_model,
        },
        "providers": {
            "anthropic": { "token": has_anthropic },
            "openai":    { "token": has_openai },
            "gemini":    { "token": has_gemini },
            "ollama":    {
                "reachable": ollama_reachable,
                "endpoint": ollama_endpoint,
            }
        },
        "ferricula": {
            "reachable": ferricula_reachable,
            "base_url":  ferricula_base,
        }
    }))
}

fn config_raw() -> Option<serde_json::Value> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()?
    } else {
        std::env::var("HOME").ok()?
    };
    let path = std::path::PathBuf::from(home).join(".hyperia").join("hyperia.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

// ─── Static handler: serve the shell page ──────────────────────────────────

/// GET /shell — the agentic shell page. Loaded as a `webUrl` pane inside
/// Hyperia, or directly in a browser tab during development. The page
/// connects to /api/ghost/chat (SSE), seeds history from /api/ghost/history,
/// and renders show_widget + tool_mount events inline in terminal style.
pub async fn ghost_shell_page() -> impl IntoResponse {
    Html(include_str!("../../static/shell.html"))
}

