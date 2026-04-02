use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::Stream;
use tokio::sync::Mutex;

use super::agent::{GhostSession, SessionState};
use super::provider::AnthropicProvider;
use super::registry::ToolRegistry;
use super::types::{ChatRequest, GhostEvent};

/// Shared state for the Ghost agent, stored in the axum app state.
/// Config is lazy-loaded per request so no restart is needed after setting a token.
#[derive(Clone)]
pub struct GhostState {
    pub session: Arc<Mutex<GhostSession>>,
    pub registry: Arc<ToolRegistry>,
    pub http_port: u16,
}

impl GhostState {
    pub fn new(http_port: u16) -> Self {
        let registry = Arc::new(ToolRegistry::new(http_port));
        let session = Arc::new(Mutex::new(GhostSession::new(25)));
        Self {
            session,
            registry,
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

    let rx = {
        let mut session = state.session.lock().await;
        session.run(req.message, registry, provider)
    };

    let s = async_stream::stream! {
        let mut rx = rx;
        while let Some(event) = rx.recv().await {
            let json = serde_json::to_string(&event).unwrap_or_default();
            yield Ok::<_, Infallible>(Event::default().data(json));

            match &event {
                GhostEvent::Done { stop_reason, .. } => {
                    let mut session = state.session.lock().await;
                    session.set_state(SessionState::Completed(stop_reason.clone()));
                }
                GhostEvent::Error { message } => {
                    let mut session = state.session.lock().await;
                    session.set_state(SessionState::Error(message.clone()));
                }
                _ => {}
            }
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
        "has_token": has_token,
    }))
}

/// POST /api/ghost/reset — clear conversation.
pub async fn ghost_reset(State(state): State<GhostState>) -> &'static str {
    let mut session = state.session.lock().await;
    session.reset();
    "ok"
}
