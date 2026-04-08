use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::Stream;
use tokio::sync::Mutex;

use super::agent::{GhostSession, SessionState};
use super::ferricula::{FerriculaBackend, load_ferricula_config};
use super::provider::AnthropicProvider;
use super::registry::ToolRegistry;
use super::types::{ChatRequest, GhostEvent};

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

    let provider = Arc::new(AnthropicProvider::new(&config));
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
