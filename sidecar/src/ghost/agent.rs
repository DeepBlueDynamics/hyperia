use std::sync::Arc;

use tokio::sync::mpsc;

use super::ferricula::FerriculaClient;
use super::provider::AnthropicProvider;
use super::registry::ToolRegistry;
use super::types::{GhostEvent, PendingToolCall, ProviderEvent};

const SYSTEM_PROMPT: &str = "\
You are Hyperia, the ghost in the machine — an agent inside the Hyperia terminal emulator.

## Rules
- Be concise. Act, don't narrate. Never say what you're about to do — just do it.
- Never repeat a tool call you already made this turn. If you have the result, use it.
- Read tool results before calling more tools. Don't call terminal_screen after terminal_run — terminal_run already returns the screen.
- One message, multiple tool calls if needed. Don't split into separate turns what can be done in one.
- For destructive operations, confirm with the user first.

## Tools
- Call terminal_status to see the pane layout (windows/tabs/panes).
- Address panes with window/tab/pane parameters.
- Use tool_search to discover available tools by keyword.
- Use tool_create to make new tools on the fly when no existing tool fits.

## Memory
You have access to Ferricula memory. Recalled memories appear below when relevant.
Build on what you remember. Don't ask for information you've been told before.

## Watercooler
Call the watercooler tool to check in with the human. Do this after you've made real progress — share what you did and what you're thinking next. The human gets a chance to redirect or confirm. Don't run more than a handful of tool calls without checking in.";

#[derive(Debug, Clone)]
pub enum SessionState {
    Idle,
    Running,
    Completed(String),
    Error(String),
}

pub struct GhostSession {
    messages: Vec<serde_json::Value>,
    turn: usize,
    max_turns: usize,
    state: SessionState,
}

impl GhostSession {
    pub fn new(max_turns: usize) -> Self {
        Self {
            messages: Vec::new(),
            turn: 0,
            max_turns,
            state: SessionState::Idle,
        }
    }

    pub fn state(&self) -> &SessionState {
        &self.state
    }

    pub fn turn(&self) -> usize {
        self.turn
    }

    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    /// Run the agent loop for a user message. Returns a channel of GhostEvents.
    pub fn run(
        &mut self,
        user_message: String,
        registry: Arc<ToolRegistry>,
        provider: Arc<AnthropicProvider>,
    ) -> mpsc::Receiver<GhostEvent> {
        let (tx, rx) = mpsc::channel(128);

        self.state = SessionState::Running;
        self.turn += 1;

        let user_msg = user_message.clone();
        // Add user message
        self.messages.push(serde_json::json!({
            "role": "user",
            "content": user_message,
        }));

        let messages = self.messages.clone();
        let max_turns = self.max_turns;
        let turn_start = self.turn;

        tokio::spawn(async move {
            let result = run_loop(tx.clone(), messages, registry, provider, max_turns, turn_start, &user_msg).await;
            match result {
                Ok(final_messages) => {
                    // We can't easily update self from a spawned task, so the
                    // final messages are sent as a Done event with the turn count.
                    // The caller updates session state from the API handler.
                    let _ = final_messages; // consumed in the loop
                }
                Err(e) => {
                    let _ = tx
                        .send(GhostEvent::Error {
                            message: e.to_string(),
                        })
                        .await;
                }
            }
        });

        rx
    }

    /// Update messages after the agent loop completes.
    pub fn set_messages(&mut self, messages: Vec<serde_json::Value>) {
        self.messages = messages;
    }

    pub fn set_state(&mut self, state: SessionState) {
        self.state = state;
    }

    pub fn reset(&mut self) {
        self.messages.clear();
        self.turn = 0;
        self.state = SessionState::Idle;
    }
}

async fn run_loop(
    tx: mpsc::Sender<GhostEvent>,
    mut messages: Vec<serde_json::Value>,
    registry: Arc<ToolRegistry>,
    provider: Arc<AnthropicProvider>,
    max_turns: usize,
    turn_start: usize,
    user_message: &str,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let tool_defs = registry.tool_defs();

    // Recall memories from Ferricula before the first model call
    let ferricula = FerriculaClient::new();
    let mut system = SYSTEM_PROMPT.to_string();
    if let Some(ref fc) = ferricula {
        let recalled = fc.recall(user_message).await;
        if !recalled.is_empty() {
            system.push_str(&recalled);
        }
    }
    let mut turns = 0;

    loop {
        turns += 1;
        if turns > max_turns {
            let _ = tx
                .send(GhostEvent::Done {
                    stop_reason: "max_turns".into(),
                    turns: turn_start + turns - 1,
                })
                .await;
            break;
        }

        // Call the provider
        let mut event_rx = provider
            .stream(&system, &messages, &tool_defs, 4096)
            .await?;

        // Accumulate assistant content and tool calls
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
                    let _ = tx
                        .send(GhostEvent::ToolStart {
                            name,
                            id,
                        })
                        .await;
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
                ProviderEvent::MessageStop { stop_reason: sr } => {
                    stop_reason = sr;
                }
                ProviderEvent::Usage { .. } => {}
                ProviderEvent::Error(msg) => {
                    let _ = tx.send(GhostEvent::Error { message: msg }).await;
                    return Ok(messages);
                }
            }
        }

        if stop_reason == "tool_use" && !pending_tools.is_empty() {
            // Build assistant content blocks
            let mut content_blocks: Vec<serde_json::Value> = Vec::new();
            let full_text: String = text_parts.drain(..).collect();
            if !full_text.is_empty() {
                content_blocks.push(serde_json::json!({
                    "type": "text",
                    "text": full_text,
                }));
            }
            for tool in &pending_tools {
                let input: serde_json::Value =
                    serde_json::from_str(&tool.json_fragments).unwrap_or(serde_json::json!({}));
                content_blocks.push(serde_json::json!({
                    "type": "tool_use",
                    "id": tool.id,
                    "name": tool.name,
                    "input": input,
                }));
            }

            messages.push(serde_json::json!({
                "role": "assistant",
                "content": content_blocks,
            }));

            // Execute each tool and build tool result blocks
            let mut tool_results: Vec<serde_json::Value> = Vec::new();
            for tool in &pending_tools {
                let input: serde_json::Value =
                    serde_json::from_str(&tool.json_fragments).unwrap_or(serde_json::json!({}));
                let output = registry.execute(&tool.name, &input).await;

                let _ = tx
                    .send(GhostEvent::ToolResult {
                        id: tool.id.clone(),
                        output: output.clone(),
                    })
                    .await;

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

            // Check if agent called watercooler — yield to human
            if pending_tools.iter().any(|t| t.name == "watercooler") {
                // Find the watercooler tool's message
                let wc_msg = pending_tools.iter()
                    .find(|t| t.name == "watercooler")
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t.json_fragments).ok())
                    .and_then(|v| v["message"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "Checking in".into());

                let _ = tx
                    .send(GhostEvent::Watercooler {
                        summary: wc_msg,
                        tool_calls: turns,
                    })
                    .await;

                let _ = tx
                    .send(GhostEvent::Done {
                        stop_reason: "watercooler".into(),
                        turns: turn_start + turns - 1,
                    })
                    .await;
                break;
            }

            // Continue the loop
            continue;
        }

        // Not a tool_use stop — we're done
        let full_text: String = text_parts.into_iter().collect();
        if !full_text.is_empty() {
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": full_text,
            }));
        }

        // Remember the exchange in Ferricula
        if let Some(ref fc) = ferricula {
            let summary = format!("User: {}\nAssistant: {}", user_message, &full_text[..full_text.len().min(500)]);
            fc.remember(&summary, "ghost").await;
        }

        let _ = tx
            .send(GhostEvent::Done {
                stop_reason: if stop_reason.is_empty() {
                    "end_turn".into()
                } else {
                    stop_reason
                },
                turns: turn_start + turns - 1,
            })
            .await;
        break;
    }

    Ok(messages)
}
