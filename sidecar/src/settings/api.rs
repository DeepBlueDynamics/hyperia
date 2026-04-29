use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::Stream;
use tokio::sync::{mpsc, Mutex};

use super::registry::SettingsRegistry;
use super::super::ghost::provider::AnyProvider;
use super::super::ghost::types::{ChatRequest, GhostEvent, PendingToolCall, ProviderEvent, ToolDef};

const SYSTEM_PROMPT: &str = "\
You are the Hyperia settings assistant. Help users configure Hyperia.

## What you can do
- Set the Shivvr embedding endpoint: use set_shivvr_endpoint. Suggest \"shivvr.nuts.services\" as the default.
  Shivvr provides semantic (vector) memory recall. Without it, only BM25 keyword recall is used.
- Read the current config: use read_config.

## Rules
- Be extremely concise: 1-2 sentences per reply.
- After set_shivvr_endpoint is called, confirm what was saved in one sentence.
- You cannot change the API token or model here — direct users to the input fields below.
- You have no terminal access and no internet access.
- Never invent config values. Only set what the user explicitly requests.
- If unsure what the user wants, ask a single clarifying question before using any tool.";

pub struct SettingsSession {
    messages: Vec<serde_json::Value>,
}

impl SettingsSession {
    fn new() -> Self {
        Self { messages: Vec::new() }
    }

    fn reset(&mut self) {
        self.messages.clear();
    }
}

#[derive(Clone)]
pub struct SettingsState {
    pub session: Arc<Mutex<SettingsSession>>,
    pub registry: Arc<SettingsRegistry>,
}

impl SettingsState {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(SettingsSession::new())),
            registry: Arc::new(SettingsRegistry::new()),
        }
    }
}

/// POST /api/settings/chat — settings agent with limited tool set.
pub async fn settings_chat(
    State(state): State<SettingsState>,
    Json(req): Json<ChatRequest>,
) -> Sse<Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>> {
    let config = match super::super::ghost::load_config() {
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

    let (messages, tool_defs) = {
        let mut session = session_mutex.lock().await;
        session.messages.push(serde_json::json!({
            "role": "user",
            "content": req.message,
        }));
        (session.messages.clone(), registry.tool_defs())
    };

    let (tx, mut rx_inner) = mpsc::channel::<GhostEvent>(128);

    tokio::spawn(async move {
        let result = settings_run_loop(
            tx.clone(),
            messages,
            &registry,
            provider,
            &tool_defs,
            10,
        ).await;

        match result {
            Ok(final_messages) => {
                let mut session = session_mutex.lock().await;
                session.messages = final_messages;
            }
            Err(e) => {
                let _ = tx.send(GhostEvent::Error { message: e.to_string() }).await;
            }
        }
    });

    let s = async_stream::stream! {
        while let Some(event) = rx_inner.recv().await {
            let json = serde_json::to_string(&event).unwrap_or_default();
            yield Ok::<_, Infallible>(Event::default().data(json));
        }
    };

    Sse::new(Box::pin(s))
}

/// POST /api/settings/reset — clear conversation.
pub async fn settings_reset(State(state): State<SettingsState>) -> &'static str {
    let mut session = state.session.lock().await;
    session.reset();
    "ok"
}

async fn settings_run_loop(
    tx: mpsc::Sender<GhostEvent>,
    mut messages: Vec<serde_json::Value>,
    registry: &SettingsRegistry,
    provider: Arc<AnyProvider>,
    tool_defs: &[ToolDef],
    max_turns: usize,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut turns = 0;
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;

    loop {
        turns += 1;
        if turns > max_turns {
            let _ = tx.send(GhostEvent::Done {
                stop_reason: "max_turns".into(),
                turns,
            }).await;
            return Ok(messages);
        }

        let mut event_rx = provider
            .stream(SYSTEM_PROMPT, &messages, tool_defs, 2048)
            .await?;

        let mut text_parts: Vec<String> = Vec::new();
        let mut pending_tools: Vec<PendingToolCall> = Vec::new();
        let mut current_tool_index: Option<usize> = None;
        let mut stop_reason = String::new();

        while let Some(event) = event_rx.recv().await {
            match event {
                ProviderEvent::TextDelta(text) => {
                    text_parts.push(text.clone());
                    let _ = tx.send(GhostEvent::TextDelta { text }).await;
                }
                ProviderEvent::ToolCallStart { id, name } => {
                    let idx = pending_tools.len();
                    pending_tools.push(PendingToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        json_fragments: String::new(),
                    });
                    current_tool_index = Some(idx);
                    let _ = tx.send(GhostEvent::ToolStart { name, id }).await;
                }
                ProviderEvent::ToolCallDelta { json_fragment, .. } => {
                    if let Some(idx) = current_tool_index {
                        if let Some(tool) = pending_tools.get_mut(idx) {
                            tool.json_fragments.push_str(&json_fragment);
                        }
                    }
                }
                ProviderEvent::ToolCallEnd { .. } => {
                    current_tool_index = None;
                }
                ProviderEvent::Usage { input_tokens, output_tokens } => {
                    total_input_tokens += input_tokens;
                    total_output_tokens += output_tokens;
                }
                ProviderEvent::MessageStop { stop_reason: sr } => {
                    stop_reason = sr;
                }
                ProviderEvent::Retrying { attempt, wait_secs } => {
                    let _ = tx.send(GhostEvent::Retrying { attempt, wait_secs }).await;
                }
                ProviderEvent::Error(msg) => {
                    let _ = tx.send(GhostEvent::Error { message: msg }).await;
                    return Ok(messages);
                }
            }
        }

        // Build assistant message for conversation history
        let mut content_blocks: Vec<serde_json::Value> = Vec::new();
        if !text_parts.is_empty() {
            content_blocks.push(serde_json::json!({
                "type": "text",
                "text": text_parts.join(""),
            }));
        }
        for tool in &pending_tools {
            content_blocks.push(serde_json::json!({
                "type": "tool_use",
                "id": tool.id,
                "name": tool.name,
                "input": serde_json::from_str::<serde_json::Value>(&tool.json_fragments)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
            }));
        }
        messages.push(serde_json::json!({
            "role": "assistant",
            "content": content_blocks,
        }));

        if stop_reason != "tool_use" || pending_tools.is_empty() {
            let _ = tx.send(GhostEvent::Stats {
                input_tokens: total_input_tokens,
                output_tokens: total_output_tokens,
                tool_calls: 0,
                turns,
            }).await;
            let _ = tx.send(GhostEvent::Done { stop_reason, turns }).await;
            return Ok(messages);
        }

        // Execute tools
        let mut tool_results: Vec<serde_json::Value> = Vec::new();
        for tool in &pending_tools {
            let input: serde_json::Value = serde_json::from_str(&tool.json_fragments)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

            let output = registry.execute(&tool.name, &input).await;

            let _ = tx.send(GhostEvent::ToolResult {
                id: tool.id.clone(),
                name: tool.name.clone(),
                input: input.clone(),
                output: output.clone(),
            }).await;

            tool_results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tool.id,
                "content": output,
            }));
        }

        messages.push(serde_json::json!({
            "role": "user",
            "content": tool_results,
        }));
    }
}
