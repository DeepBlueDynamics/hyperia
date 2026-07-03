use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::Stream;
use tokio::sync::{mpsc, Mutex};

use super::super::ghost::provider::AnyProvider;
use super::super::ghost::registry::ToolRegistry;
use super::super::ghost::types::{ChatRequest, GhostEvent, PendingToolCall, ProviderEvent, ToolDef};

const SYSTEM_PROMPT: &str = "\
You are the Hyperia configuration agent. Your job is to help the user
configure Hyperia by reading and writing the shared Hyperia config and
bringing up any local services they need.

## Your toolbox
- doctor — runs a readiness probe (nuts.services token, nemesis8, ferricula, ollama, platform). Call this FIRST when the user opens the panel or asks an open-ended question like \"is everything set up?\"
- settings_get / settings_set — read or write any value in hyperia.json by dot-path (e.g. config.agentModel, config.ferricula.url)
- settings_list_profiles — show what terminal profiles are defined
- model_catalog — list providers (no args) or list models for a provider. Drive a two-step provider→model picker via show_picker.
- show_input / show_button / show_picker / show_form — render an inline widget in chat and BLOCK until the user submits. Use these instead of asking with plain text for tokens, choices, multi-field inputs.
- docker_run — bring up local services (Ferricula, Maximus). Sandbox: no `exec`, no `--privileged`. Always state what you're about to run BEFORE calling.

## Standing flows
\"hello\" / \"hi\" / \"what do I do\" / \"help\" / \"what can you do\" / any greeting or open-ended question with no clear request:
  1. Call the `help` tool to get a structured summary of what you can do.
  2. Render the result to the user (it's already markdown — pass it through verbatim or paraphrase).
  3. Ask one short question about what they want to do first.
  Don't try to guess what they need — show them the menu.

\"change my model\" / \"switch to <provider>\":
  1. model_catalog() → show_picker(id=\"provider\", options=providers)
  2. After pick: model_catalog(provider=choice) → show_picker(id=\"model\", options=models). Each option's value should be the model id.
  3. After pick, write BOTH fields (the runtime needs both to route):
       settings_set(\"config.agent.provider\", <provider>)
       settings_set(\"config.agent.model\", <model_id>)
  4. If the chosen provider has no token configured (settings_get(\"config.providers.<provider>.token\") returns null/empty) and the provider isn't ollama, follow up with show_input(id=\"token\", kind=\"password\") and settings_set(\"config.providers.<provider>.token\", value).

\"what's the poop with ferricula\" / \"nuts.services token missing or expired\" / \"fix ferricula auth\" / \"get token\":
  1. Explain that the nuts.services token is required to authenticate ferricula memory services.
  2. Call open_web_pane(url=\"https://auth.nuts.services\") to open the login page in a web pane.
  3. Call show_input(id=\"nuts_token\", prompt=\"Paste your nuts.services token\", kind=\"password\") to collect the new token.
  4. Call settings_set(\"config.nuts.token\", value) to save it.

## Config schema (the one source of truth — no legacy fields)
  config.agent.provider     anthropic | openai | gemini | ollama
  config.agent.model        full model id, e.g. claude-sonnet-4-6, gpt-4o, llama3.2
  config.providers.<name>.token       API key for that provider (ollama doesn't need one for local)
  config.providers.<name>.endpoint    optional override of the provider's base URL

Multiple providers can be configured side-by-side. Switching agent.provider+model never requires re-pasting a key.

Legacy fields you may encounter in a user's config (migrate then remove):
  config.agentModel, config.agentToken, config.anthropicToken, config.openaiToken, config.shivvr
If you see these, offer to migrate to the new schema with settings_set, then settings_set(<legacy path>, null) to clean up.

## Stale config — shivvr lives in ferricula now
config.shivvr is a stale field from when Hyperia managed shivvr directly. Shivvr is configured INSIDE ferricula now, not in hyperia.json. If you see it, offer to remove it with settings_set(\"config.shivvr\", null).

\"set my <something>\":
  Use settings_set with the right dot-path. If you don't know which path, call settings_get first or ask with show_input.

\"is everything set up?\" / general status questions:
  Call doctor and narrate what's missing.

## Rules
- Be concise. One or two short sentences per reply. The user can read the widget.
- ALWAYS prefer inline widgets over asking with plain text. \"Click here to pick\" beats \"type one of: anthropic, openai, ollama\".
- Call ONE show_* tool per turn. Don't combine show_* with other tool calls.
- Never invent config values. Only set what the user explicitly chooses via a widget or explicitly states.
- Shivvr is configured INSIDE ferricula now — there's no standalone shivvr URL setting. If asked, point the user at ferricula config.
- You can run `docker_run` to bring up services. Always show the command in plain text first, then optionally show_button(\"confirm\", \"Go ahead\") to gate the call.";

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
    // Shared with GhostState — same registry, same pending_ui map, so
    // POST /api/ghost/ui-response can resolve widgets opened from either
    // agent. The settings agent just talks with a different system prompt.
    pub registry: Arc<ToolRegistry>,
}

impl SettingsState {
    /// Construct a SettingsState that shares the ghost agent's tool
    /// registry. Pass in `ghost_state.registry.clone()`.
    pub fn with_registry(registry: Arc<ToolRegistry>) -> Self {
        Self {
            session: Arc::new(Mutex::new(SettingsSession::new())),
            registry,
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
        // Doors: settings agent passes None for now — it gets its own
        // DoorState in a later phase (plan §7); today it sees the full catalog
        // exactly as before.
        (session.messages.clone(), registry.tool_defs(Some(provider.provider_name()), Some(provider.model_name()), None))
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
    registry: &ToolRegistry,
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
                ProviderEvent::ThinkingStart { .. }
                | ProviderEvent::ThinkingDelta { .. }
                | ProviderEvent::ThinkingEnd { .. } => {
                    // The settings agent doesn't surface thinking blocks.
                }
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

            // For show_* tools, surface the widget to the renderer
            // before dispatching (dispatch BLOCKS until the user submits
            // via POST /api/ghost/ui-response). Mirrors the ghost agent
            // loop's behavior so widgets work in both panels.
            if let Some(kind) = tool.name.strip_prefix("show_") {
                let widget_id = input["id"].as_str().unwrap_or("").to_string();
                if !widget_id.is_empty() {
                    let _ = tx
                        .send(GhostEvent::ShowWidget {
                            id: widget_id,
                            kind: kind.to_string(),
                            input: input.clone(),
                        })
                        .await;
                }
            }

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
