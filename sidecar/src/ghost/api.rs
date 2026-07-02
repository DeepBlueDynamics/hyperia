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
use super::asset::AssetStore;
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
    pub assets: Arc<AssetStore>,
    pub http_port: u16,
}

impl GhostState {
    pub fn new(http_port: u16, ghost_token: String) -> Self {
        let session = Arc::new(Mutex::new(GhostSession::new(25)));
        let fc_config = load_ferricula_config();
        let ferricula = Arc::new(FerriculaBackend::new(&fc_config));
        let registry = Arc::new(ToolRegistry::new(http_port, ghost_token).with_ferricula(ferricula.clone()));
        let assets = Arc::new(AssetStore::new());
        Self {
            session,
            registry,
            ferricula,
            assets,
            http_port,
        }
    }
}

/// POST /api/ghost/chat — send a message, get SSE stream back.
pub async fn ghost_chat(
    State(state): State<GhostState>,
    Json(req): Json<ChatRequest>,
) -> Sse<Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>> {
    // 1. Check for token setting intercept
    let mut intercept_reply = None;
    if let Some(reply) = super::bootstub::try_set_token(&req.message) {
        intercept_reply = Some(reply);
    } else if let Some(reply) = super::bootstub::try_set_provider_token(&req.message) {
        intercept_reply = Some(reply);
    } else if let Some(reply) = super::bootstub::try_toggle_maximus(&req.message) {
        intercept_reply = Some(reply);
    }

    if let Some(reply) = intercept_reply {
        let s = async_stream::stream! {
            let event = GhostEvent::TextDelta {
                text: reply.text,
            };
            let json = serde_json::to_string(&event).unwrap_or_default();
            yield Ok::<_, Infallible>(Event::default().data(json));
        };
        return Sse::new(Box::pin(s));
    }

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
    let mut active_model = cfg.as_ref().map(|c| c.model.clone()).unwrap_or_default();

    // Read raw config for per-provider token presence (independent of
    // load_config's fallback semantics).
    let raw_cfg = config_raw().unwrap_or(serde_json::Value::Null);
    let providers = &raw_cfg["config"]["providers"];

    // Raw `agent.model` read straight off disk — distinguishes "user has
    // never picked a model" (empty in JSON) from "load_config defaulted to
    // llama3.2 because nothing was set". We auto-pick only when the raw
    // JSON shows no model — respect explicit user choices even if the
    // model isn't installed.
    let raw_agent_model = raw_cfg["config"]["agent"]["model"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let raw_agent_provider = raw_cfg["config"]["agent"]["provider"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let has_token = |name: &str| -> bool {
        // The Hyperia Agent config pane's key (config.agent.keys.<name>) counts.
        if raw_cfg["config"]["agent"]["keys"][name].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false) {
            return true;
        }
        if providers[name]["token"].as_str().map(|s| !s.is_empty()).unwrap_or(false) {
            return true;
        }
        let env_keys = match name {
            "anthropic" => vec!["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"],
            "openai" => vec!["OPENAI_API_KEY", "OPENAI_TOKEN"],
            "gemini" => vec!["GEMINI_API_KEY", "GEMINI_TOKEN"],
            "grok" => vec!["XAI_API_KEY", "GROK_API_KEY"],
            _ => vec![],
        };
        for key in env_keys {
            if raw_cfg["config"]["env"][key].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false) {
                return true;
            }
            if std::env::var(key).map(|s| !s.trim().is_empty()).unwrap_or(false) {
                return true;
            }
        }
        false
    };

    // Ollama probe — try /api/version, then /api/tags to list installed models.
    let ollama_disabled = std::env::var("MAXIMUS_DISABLED")
        .map(|s| s.trim().to_lowercase() == "true" || s.trim() == "1")
        .unwrap_or(false)
        || raw_cfg["config"]["maximus"]["disabled"].as_bool().unwrap_or(false)
        || cfg.as_ref().map(|c| c.maximus_disabled).unwrap_or(false);

    let mut ollama_endpoint = providers["ollama"]["endpoint"]
        .as_str()
        .unwrap_or("http://localhost:11434")
        .trim_end_matches('/')
        .to_string();
    if std::path::Path::new("/.dockerenv").exists() {
        if ollama_endpoint == "http://localhost:11434" || ollama_endpoint == "http://127.0.0.1:11434" {
            ollama_endpoint = "http://host.docker.internal:11434".to_string();
        }
    }
    let ollama_reachable = if ollama_disabled {
        false
    } else {
        client
            .get(format!("{}/api/version", ollama_endpoint))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    };
    let mut ollama_models: Vec<String> = Vec::new();
    if ollama_reachable {
        if let Ok(resp) = client.get(format!("{}/api/tags", ollama_endpoint)).send().await {
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = j["models"].as_array() {
                    for m in arr {
                        if let Some(n) = m["name"].as_str() {
                            ollama_models.push(n.to_string());
                        }
                    }
                }
            }
        }
    }

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

    // Auto-pick model: if the user hasn't explicitly chosen a model AND
    // provider=ollama AND ollama has at least one model installed, write
    // the first installed model to the shared Hyperia config so the agent
    // doesn't fall back to the hardcoded llama3.2 (which often isn't
    // pulled). Respects explicit user choices — only fires when the raw
    // JSON `agent.model` is empty. Picks the first model that isn't a
    // pure embedding/OCR specialist when possible.
    let needs_autopick = raw_agent_model.is_empty()
        && (raw_agent_provider.is_empty() || raw_agent_provider == "ollama")
        && ollama_reachable
        && !ollama_models.is_empty();
    if needs_autopick {
        let pick = pick_default_ollama_model(&ollama_models);
        if let Err(e) = write_agent_model("ollama", &pick) {
            tracing::warn!("auto-pick model failed to write config: {}", e);
        } else {
            tracing::info!("auto-picked ollama model '{}' (no model was configured)", pick);
            active_model = pick.clone();
        }
    }

    Json(serde_json::json!({
        "sidecar": env!("CARGO_PKG_VERSION"),
        "level": level,
        "agent": {
            "provider": if needs_autopick { "ollama".to_string() } else { active_provider },
            "model": active_model,
            "auto_picked": needs_autopick,
        },
        "providers": {
            "anthropic": { "token": has_anthropic },
            "openai":    { "token": has_openai },
            "gemini":    { "token": has_gemini },
            "ollama":    {
                "reachable": ollama_reachable,
                "endpoint": ollama_endpoint,
                "models":   ollama_models,
                "disabled": ollama_disabled,
            }
        },
        "ferricula": {
            "reachable": ferricula_reachable,
            "base_url":  ferricula_base,
        }
    }))
}

fn config_raw() -> Option<serde_json::Value> {
    let path = super::config_path()?;
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Pick a sensible default ollama model from the installed list. Prefers
/// general chat models over embedding/OCR specialists. Stable order: scan
/// the installed list once, return the first non-specialist; fall back to
/// the first installed model if everything looks specialized.
fn pick_default_ollama_model(installed: &[String]) -> String {
    let is_specialist = |name: &str| -> bool {
        let n = name.to_lowercase();
        n.contains("embed")
            || n.contains("nomic-embed")
            || n.contains("mxbai")
            || n.contains("ocr")
            || n.contains("guard")
            || n.contains("rerank")
    };
    installed
        .iter()
        .find(|m| !is_specialist(m))
        .cloned()
        .or_else(|| installed.first().cloned())
        .unwrap_or_default()
}

/// Write `config.agent.{provider, model}` to the shared Hyperia config,
/// preserving all other config keys. Shared by /set-model and the
/// capabilities auto-pick path.
fn write_agent_model(provider: &str, model: &str) -> std::io::Result<()> {
    let path = config_raw_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    let mut json: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({ "config": {} }));
    if !json["config"].is_object() {
        json["config"] = serde_json::json!({});
    }
    if !json["config"]["agent"].is_object() {
        json["config"]["agent"] = serde_json::json!({});
    }
    json["config"]["agent"]["provider"] = serde_json::json!(provider);
    json["config"]["agent"]["model"] = serde_json::json!(model);
    crate::util::write_json_file_atomic(&path, &json)
}

// ─── Set agent provider+model — small targeted writer for the shell picker ─

/// POST /api/ghost/set-model — set `config.agent.provider` and
/// `config.agent.model` in the shared Hyperia config. Used by the shell's
/// model picker. Preserves all other config keys. Body:
///   { "provider": "ollama" | "anthropic" | "openai" | "gemini",
///     "model":    "gemma2:2b" | "claude-sonnet-4-6" | ... }
pub async fn ghost_set_model(
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let provider = body["provider"].as_str().unwrap_or("").trim().to_lowercase();
    let model = body["model"].as_str().unwrap_or("").trim().to_string();
    if provider.is_empty() || model.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "provider and model are required" })),
        ));
    }
    let path = match config_raw_path() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "ok": false, "error": "couldn't resolve $HOME / $USERPROFILE" })),
            ));
        }
    };
    match write_agent_model(&provider, &model) {
        Ok(_) => Ok(Json(serde_json::json!({
            "ok": true,
            "agent": { "provider": provider, "model": model },
        }))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        )),
    }
}

/// POST /api/ghost/wipe-config — reset the shared Hyperia config to {"config": {}}.
pub async fn ghost_wipe_config(
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let path = match config_raw_path() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "ok": false, "error": "couldn't resolve $HOME / $USERPROFILE" })),
            ));
        }
    };
    let empty_cfg = serde_json::json!({ "config": {} });
    match crate::util::write_json_file_atomic(&path, &empty_cfg) {
        Ok(_) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        )),
    }
}

fn config_raw_path() -> Option<std::path::PathBuf> {
    super::config_path()
}

// ─── Assets: paste / drop / upload — appear inline in the shell ──────────

/// POST /api/ghost/asset — raw-bytes upload. Body: file bytes.
/// Headers:
///   content-type: image/png | image/jpeg | application/pdf | text/plain | …
///   x-filename:   original filename if known (else any short label)
/// Returns AssetMeta JSON. 25 MB cap (route-layer DefaultBodyLimit).
pub async fn ghost_asset_upload(
    State(state): State<GhostState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let filename = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            // Synthesize from content-type if the client didn't supply one
            // (clipboard pastes don't carry filenames).
            let ext = content_type
                .split('/')
                .nth(1)
                .unwrap_or("bin")
                .split(';')
                .next()
                .unwrap_or("bin");
            format!("pasted.{}", ext)
        });
    if body.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "empty body" })),
        ));
    }
    match state.assets.store(content_type.clone(), filename.clone(), &body) {
        Ok(meta) => Ok(Json(serde_json::json!({
            "ok": true,
            "id": meta.id,
            "url": format!("/api/ghost/asset/{}", meta.id),
            "content_type": meta.content_type,
            "filename": meta.filename,
            "size": meta.size,
            "created_ts": meta.created_ts,
        }))),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        )),
    }
}

/// GET /api/ghost/asset/:id — serve the asset's raw bytes with its
/// original content-type. 404 if unknown.
pub async fn ghost_asset_get(
    State(state): State<GhostState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, StatusCode> {
    let (path, ct, _filename) = state.assets.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let bytes = std::fs::read(&path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut response = (
        [(axum::http::header::CONTENT_TYPE, ct)],
        bytes,
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "public, max-age=86400".parse().unwrap(),
    );
    Ok(response)
}

/// GET /api/ghost/assets — list all stored assets. Used by the shell on
/// load to restore the asset row state after a refresh.
pub async fn ghost_asset_list(
    State(state): State<GhostState>,
) -> Json<serde_json::Value> {
    let items = state.assets.list();
    let mapped: Vec<serde_json::Value> = items
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "url": format!("/api/ghost/asset/{}", m.id),
                "content_type": m.content_type,
                "filename": m.filename,
                "size": m.size,
                "created_ts": m.created_ts,
            })
        })
        .collect();
    Json(serde_json::json!({ "assets": mapped }))
}

// ─── Bootstub: Level-0 micro-agent for when no model is wired ──────────────

/// POST /api/ghost/bootchat — pre-LLM bootstrap responder. The shell routes
/// here instead of `/chat` when `/capabilities` reports `level: "none"`.
/// Body: `{ "message": "..." }`. Returns `BootReply { text, system,
/// config_changed }`. When `config_changed` is true the shell re-probes
/// capabilities so it can flip levels and start routing to `/chat`.
pub async fn ghost_bootchat(
    Json(body): Json<serde_json::Value>,
) -> Json<super::bootstub::BootReply> {
    let msg = body["message"].as_str().unwrap_or("").to_string();
    Json(super::bootstub::handle(&msg))
}

// ─── Static handler: serve the shell page ──────────────────────────────────

/// GET /shell — the agentic shell page. Loaded as a `webUrl` pane inside
/// Hyperia, or directly in a browser tab during development. The page
/// connects to /api/ghost/chat (SSE), seeds history from /api/ghost/history,
/// and renders show_widget + tool_mount events inline in terminal style.
pub async fn ghost_shell_page() -> impl IntoResponse {
    Html(include_str!("../../static/shell.html"))
}

// ─── Hyperia Agent configuration (epic #131) ────────────────────────────────
// GET /agent/config serves the config page; the API reads/writes
// config.agent.* in the shared Hyperia config (hand-editable by design).
// API keys live in config.agent.keys.<provider> — PLAINTEXT for now, moves to
// the OS keystore with #130.

/// GET /agent/config — the Hyperia Agent configuration page.
pub async fn agent_config_page() -> impl IntoResponse {
    Html(include_str!("../../static/agent-config.html"))
}

fn read_shared_config() -> serde_json::Value {
    config_raw_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({ "config": {} }))
}

/// GET /api/agent/config — current agent config. Keys are reported as
/// booleans (set / not set), never echoed back.
pub async fn get_agent_config() -> Json<serde_json::Value> {
    let json = read_shared_config();
    let agent = &json["config"]["agent"];
    let keys = agent["keys"].as_object();
    let has_key = |p: &str| keys.map(|k| k.get(p).and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)).unwrap_or(false);
    let provider = agent["provider"].as_str().unwrap_or("").to_string();
    let model = agent["model"].as_str().unwrap_or("").to_string();
    // Configured = provider+model chosen, and (local provider OR its key set).
    let local = provider == "ollama" || provider == "sailfish";
    let configured = !provider.is_empty() && !model.is_empty() && (local || has_key(&provider));
    Json(serde_json::json!({
        "ok": true,
        "configured": configured,
        "provider": provider,
        "model": model,
        "keys": {
            "anthropic": has_key("anthropic"),
            "openai": has_key("openai"),
            "grok": has_key("grok"),
            "gemini": has_key("gemini"),
        },
        // Per-service settings (ports etc.) — config.agent.services.<name>.
        "services": agent["services"].clone()
    }))
}

/// POST /api/agent/config — write provider/model and any pasted keys into the
/// shared config. Body: { provider?, model?, keys?: {anthropic?, ...} }.
/// Empty-string key = leave unchanged; "-" = clear. provider="" clears the
/// agent config (unconfigure — Hyperia drops out of the agent list).
pub async fn post_agent_config(
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let path = config_raw_path().ok_or_else(|| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"ok": false, "error": "no home dir"})))
    })?;
    let mut json = read_shared_config();
    if !json["config"].is_object() {
        json["config"] = serde_json::json!({});
    }
    if !json["config"]["agent"].is_object() {
        json["config"]["agent"] = serde_json::json!({});
    }
    if let Some(p) = body["provider"].as_str() {
        if p.is_empty() {
            // Unconfigure: drop provider/model, keep keys (they're credentials).
            json["config"]["agent"]["provider"] = serde_json::json!("");
            json["config"]["agent"]["model"] = serde_json::json!("");
        } else {
            json["config"]["agent"]["provider"] = serde_json::json!(p.to_lowercase());
        }
    }
    if let Some(m) = body["model"].as_str() {
        if !m.is_empty() {
            json["config"]["agent"]["model"] = serde_json::json!(m);
        }
    }
    if let Some(keys) = body["keys"].as_object() {
        if !json["config"]["agent"]["keys"].is_object() {
            json["config"]["agent"]["keys"] = serde_json::json!({});
        }
        for (k, v) in keys {
            if let Some(val) = v.as_str() {
                if val == "-" {
                    json["config"]["agent"]["keys"][k] = serde_json::json!("");
                } else if !val.is_empty() {
                    json["config"]["agent"]["keys"][k] = serde_json::json!(val);
                }
            }
        }
    }
    if let Some(svcs) = body["services"].as_object() {
        if !json["config"]["agent"]["services"].is_object() {
            json["config"]["agent"]["services"] = serde_json::json!({});
        }
        for (name, val) in svcs {
            json["config"]["agent"]["services"][name] = val.clone();
        }
    }
    match crate::util::write_json_file_atomic(&path, &json) {
        Ok(_) => Ok(Json(serde_json::json!({"ok": true}))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"ok": false, "error": e.to_string()})))),
    }
}

/// GET /api/agent/keycheck — probe each frontier provider with the configured
/// key. Status: "none" (no key), "ok" (auth works), "payment" (billing/quota),
/// "bad" (rejected), "error" (unreachable).
pub async fn get_agent_keycheck() -> Json<serde_json::Value> {
    let cfgj = read_shared_config();
    let key_for = |p: &str| -> String {
        let k = cfgj["config"]["agent"]["keys"][p].as_str().unwrap_or("").trim().to_string();
        if !k.is_empty() { return k; }
        let k = cfgj["config"]["providers"][p]["token"].as_str().unwrap_or("").trim().to_string();
        if !k.is_empty() { return k; }
        let envs: &[&str] = match p {
            "anthropic" => &["ANTHROPIC_API_KEY"], "openai" => &["OPENAI_API_KEY"],
            "gemini" => &["GEMINI_API_KEY"], "grok" => &["XAI_API_KEY", "GROK_API_KEY"], _ => &[],
        };
        envs.iter().find_map(|e| std::env::var(e).ok()).map(|s| s.trim().to_string()).unwrap_or_default()
    };
    let client = reqwest::Client::new();
    let probe = |p: &'static str| {
        let key = key_for(p);
        let client = client.clone();
        async move {
            if key.is_empty() { return (p, "none".to_string()); }
            let req = match p {
                "anthropic" => client.get("https://api.anthropic.com/v1/models")
                    .header("x-api-key", &key).header("anthropic-version", "2023-06-01"),
                "openai" => client.get("https://api.openai.com/v1/models").bearer_auth(&key),
                "grok" => client.get("https://api.x.ai/v1/models").bearer_auth(&key),
                _ => client.get(format!("https://generativelanguage.googleapis.com/v1beta/models?key={}", key)),
            };
            match req.timeout(std::time::Duration::from_secs(6)).send().await {
                Ok(r) => {
                    let s = r.status().as_u16();
                    let body = r.text().await.unwrap_or_default().to_lowercase();
                    let st = if s == 200 { "ok" }
                    else if s == 402 || s == 429 || body.contains("quota") || body.contains("billing") || body.contains("credit") { "payment" }
                    else { "bad" };
                    (p, st.to_string())
                }
                Err(_) => (p, "error".to_string()),
            }
        }
    };
    let (a, o, g, x) = tokio::join!(probe("anthropic"), probe("openai"), probe("gemini"), probe("grok"));
    Json(serde_json::json!({"ok": true, "providers": {a.0: a.1, o.0: o.1, g.0: g.1, x.0: x.1}}))
}

/// GET /api/agent/services — detect DBD services on this host: docker
/// containers (shivvr / grub / transcription / sailfish / nemesis8) by
/// name+image match, the nemesis8 binary, and its local MCP endpoint.
pub async fn get_agent_services() -> Json<serde_json::Value> {
    // docker ps (5s guard) — absent/timed-out docker = everything undetected.
    let docker = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new("docker")
            .args(["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"])
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok());
    let rows: Vec<(String, String, String, String)> = docker
        .as_ref()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| {
                    let p: Vec<&str> = l.split('\t').collect();
                    (p.len() >= 4).then(|| (p[0].to_string(), p[1].to_string(), p[2].to_string(), p[3].to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let find = |pats: &[&str]| -> Option<serde_json::Value> {
        rows.iter()
            .find(|(name, image, _, _)| {
                let hay = format!("{} {}", name, image).to_lowercase();
                pats.iter().any(|p| hay.contains(p))
            })
            .map(|(name, image, ports, status)| {
                serde_json::json!({"running": true, "container": name, "image": image, "ports": ports, "status": status})
            })
    };
    let off = serde_json::json!({"running": false});

    // Nemesis8: binary on PATH + local MCP probe (gateway convention :9801/mcp).
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let n8_bin = tokio::process::Command::new(which_cmd)
        .arg("nemesis8")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    let n8_mcp = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        reqwest::Client::new().get("http://localhost:9801/mcp").send(),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .is_some();
    let n8_containers: Vec<String> = rows
        .iter()
        .filter(|(name, image, _, _)| name.starts_with("n8-") || image.to_lowercase().contains("nemesis8"))
        .map(|(name, _, _, _)| name.clone())
        .collect();

    // Ollama runs native (not docker) — probe its HTTP port. Sailfish exposes
    // an OpenAI-compatible endpoint; probe its configured port for "connection
    // up" readiness beyond mere container presence.
    let cfgj = read_shared_config();
    let port_of = |name: &str, def: u16| -> u16 {
        cfgj["config"]["agent"]["services"][name]["port"].as_u64().map(|p| p as u16).unwrap_or(def)
    };
    let http_up = |port: u16, path: &'static str| {
        let client = reqwest::Client::new();
        async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.get(format!("http://localhost:{}{}", port, path)).send(),
            )
            .await
            .ok()
            .and_then(|r| r.ok())
            .is_some()
        }
    };
    let (ollama_up, sailfish_up) = tokio::join!(
        http_up(port_of("ollama", 11434), "/api/version"),
        http_up(port_of("sailfish", 22343), "/v1/models")
    );

    Json(serde_json::json!({
        "ok": true,
        "docker": docker.is_some(),
        "services": {
            "ollama": {"running": ollama_up, "container": if ollama_up { "daemon" } else { "" }},
            "sailfish_api": sailfish_up,
            "shivvr": find(&["shivvr"]).unwrap_or_else(|| off.clone()),
            "grub": find(&["grub"]).unwrap_or_else(|| off.clone()),
            "transcription": find(&["transcri", "whisper"]).unwrap_or_else(|| off.clone()),
            "sailfish": find(&["sailfish", "llama.cpp", "llama-cpp"]).unwrap_or_else(|| off.clone()),
            "nemesis8": {
                "running": n8_bin || !n8_containers.is_empty(),
                "binary": n8_bin,
                "mcp": n8_mcp,
                "containers": n8_containers,
            },
        }
    }))
}

/// Curated Ollama allowlist — Gemma 4 ONLY: the fast local tags (e4b/12b) plus
/// the strong cloud tags. E2B-class excluded (poorly quantized). Hand-extend
/// via config.agent.ollama_allow in the shared config.
const OLLAMA_CURATED: &[&str] = &["gemma4:e4b", "gemma4:12b", "gemma4:cloud", "gemma4:31b-cloud"];

/// GET /api/agent/models — the nemesis8.nuts.services/models catalog, cached
/// for its TTL (1h), with the ollama list filtered to the curated set.
pub async fn get_agent_models() -> Json<serde_json::Value> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<Option<(Instant, serde_json::Value)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, val)) = cache.lock().unwrap().clone() {
        if at.elapsed() < Duration::from_secs(3600) {
            return Json(val);
        }
    }
    let fetched = async {
        let resp = reqwest::Client::new()
            .get("https://nemesis8.nuts.services/models")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        resp.json::<serde_json::Value>().await.ok()
    }
    .await;
    let mut val = match fetched {
        Some(v) => v,
        None => return Json(serde_json::json!({"ok": false, "error": "models catalog unreachable"})),
    };
    // Ollama: the curated list IS the list (not an intersection with the
    // catalog — these tags are pulled locally via `ollama pull`). Extras come
    // from config.agent.ollama_allow.
    let mut allow: Vec<String> = OLLAMA_CURATED.iter().map(|s| s.to_string()).collect();
    if let Some(extra) = read_shared_config()["config"]["agent"]["ollama_allow"].as_array() {
        allow.extend(extra.iter().filter_map(|v| v.as_str().map(String::from)));
    }
    let curated: Vec<serde_json::Value> = allow
        .iter()
        .map(|id| serde_json::json!({"id": id, "label": id}))
        .collect();
    val["providers"]["ollama"]["models"] = serde_json::json!(curated);
    // OpenAI: drop the dated snapshots (…-YYYY-MM-DD) — every one has a plain
    // alias, so the picker only shows the plain names.
    if let Some(models) = val["providers"]["codex"]["models"].as_array() {
        let is_dated = |id: &str| {
            let b = id.as_bytes();
            // …-YYYY-MM-DD snapshots
            let ymd = b.len() > 11
                && b[b.len() - 11] == b'-'
                && b[b.len() - 6] == b'-'
                && b[b.len() - 3] == b'-'
                && id[b.len() - 10..].chars().filter(|c| c.is_ascii_digit()).count() == 8;
            // legacy …-MMDD snapshots (gpt-4-0613, gpt-3.5-turbo-1106)
            let mmdd = b.len() > 5
                && b[b.len() - 5] == b'-'
                && id[b.len() - 4..].chars().all(|c| c.is_ascii_digit());
            ymd || mmdd
        };
        let plain: Vec<serde_json::Value> = models
            .iter()
            .filter(|m| !is_dated(m["id"].as_str().unwrap_or("")))
            .cloned()
            .collect();
        val["providers"]["codex"]["models"] = serde_json::json!(plain);
    }
    val["ok"] = serde_json::json!(true);
    *cache.lock().unwrap() = Some((Instant::now(), val.clone()));
    Json(val)
}
