use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use super::ferricula::FerriculaBackend;
use super::provider::AnthropicProvider;
use super::registry::ToolRegistry;
use super::types::{GhostEvent, PendingToolCall, ProviderEvent};

const SYSTEM_PROMPT: &str = "\
You are Hyperia, the ghost in the machine — an agent inside the Hyperia terminal emulator.

## State awareness
- You live inside a running terminal emulator. Terminals are ALREADY OPEN with things ALREADY RUNNING.
- NEVER type commands to start yourself, navigate directories, or launch claude. You are already here.
- ALWAYS call terminal_status FIRST to see what panes exist and what's running before doing anything.
- Read the screen of a pane before typing into it. Understand what's there.
- If a pane is running an interactive program (claude, vim, python), don't type shell commands into it.
- Your current state is provided below when available. Use it.

## Rules
- Be concise. Act, don't narrate. Never say what you're about to do — just do it.
- Never repeat a tool call you already made this turn. If you have the result, use it.
- Read tool results before calling more tools. terminal_run already returns the screen.
- For destructive operations, confirm with the user first.

## Tools
- Address panes with window/tab/pane parameters.
- Use tool_search to discover available tools by keyword.
- Use tool_create to make new tools on the fly when no existing tool fits.

## Memory
You have access to Ferricula memory. Recalled memories appear below when relevant.
Build on what you remember. Don't ask for information you've been told before.

## Watercooler
Call the watercooler tool to check in with the human after making real progress. Don't run more than a handful of tool calls without checking in.";

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
    pub stop_flag: Arc<AtomicBool>,
}

impl GhostSession {
    pub fn new(max_turns: usize) -> Self {
        Self {
            messages: Vec::new(),
            turn: 0,
            max_turns,
            state: SessionState::Idle,
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
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
    /// Takes the session mutex so the spawned task can write back the conversation history.
    pub fn run(
        &mut self,
        user_message: String,
        registry: Arc<ToolRegistry>,
        provider: Arc<AnthropicProvider>,
        session_mutex: Arc<tokio::sync::Mutex<GhostSession>>,
        ferricula: Arc<FerriculaBackend>,
    ) -> mpsc::Receiver<GhostEvent> {
        let (tx, rx) = mpsc::channel(128);

        self.state = SessionState::Running;
        self.turn += 1;
        self.stop_flag.store(false, Ordering::Relaxed);
        let stop_flag = self.stop_flag.clone();

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
            let result = run_loop(tx.clone(), messages, registry, provider, max_turns, turn_start, &user_msg, &ferricula, &stop_flag).await;
            match result {
                Ok(final_messages) => {
                    // Write the full conversation history back to the session
                    let mut session = session_mutex.lock().await;
                    session.set_messages(final_messages);
                    session.set_state(SessionState::Completed("end_turn".into()));
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
    ferricula: &FerriculaBackend,
    stop_flag: &AtomicBool,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let tool_defs = registry.tool_defs();

    // Track recent tool calls for repeat detection
    let mut recent_calls: Vec<(String, String)> = Vec::new(); // (name+input, output)

    // Recall memories from Ferricula before the first model call
    let mut system = SYSTEM_PROMPT.to_string();
    let recalled = ferricula.recall(user_message).await;
    if !recalled.is_empty() {
        system.push_str(&recalled);
    }
    // Inject current terminal state so the agent knows what's already running
    let http_port = std::env::var("HYPERIA_PORT").unwrap_or_else(|_| "9800".into());
    let state_client = reqwest::Client::new();
    if let Ok(resp) = state_client.get(format!("http://localhost:{}/api/status", http_port)).send().await {
        if let Ok(status) = resp.text().await {
            system.push_str(&format!("\n\n## Current terminal state\n```json\n{}\n```", status));
        }
    }

    let mut turns = 0;

    loop {
        // Check stop flag
        if stop_flag.load(Ordering::Relaxed) {
            let _ = tx.send(GhostEvent::Done {
                stop_reason: "stopped".into(),
                turns: turn_start + turns,
            }).await;
            break;
        }

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
                // Check stop flag between tool calls
                if stop_flag.load(Ordering::Relaxed) {
                    let _ = tx.send(GhostEvent::Done {
                        stop_reason: "stopped".into(),
                        turns: turn_start + turns,
                    }).await;
                    return Ok(messages);
                }

                let input: serde_json::Value =
                    serde_json::from_str(&tool.json_fragments).unwrap_or(serde_json::json!({}));
                let output = registry.execute(&tool.name, &input).await;

                // Repeat detection: check if we've seen this exact call+output before
                let call_sig = format!("{}:{}", tool.name, input.to_string());
                let is_repeat = recent_calls.iter().any(|(sig, prev_out)| {
                    sig == &call_sig && prev_out == &output
                });
                recent_calls.push((call_sig, output.clone()));
                // Keep only last 10
                if recent_calls.len() > 10 { recent_calls.remove(0); }

                let _ = tx
                    .send(GhostEvent::ToolResult {
                        id: tool.id.clone(),
                        output: output.clone(),
                    })
                    .await;

                let mut result_content = output.clone();
                if is_repeat {
                    result_content = format!(
                        "{}\n\n[SYSTEM: This tool call returned the SAME result as a previous identical call. \
                        You are repeating yourself. Do NOT call this tool again with the same input. \
                        Try a different approach or ask the user for clarification.]",
                        output
                    );
                }

                tool_results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": tool.id,
                    "content": result_content,
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

        // Remember the exchange in Ferricula — both as semantic memory and as chat history
        let summary = format!("User: {}\nAssistant: {}", user_message, &full_text[..full_text.len().min(500)]);
        ferricula.remember(&summary, "ghost").await;
        ferricula.remember_turn("user", user_message).await;
        ferricula.remember_turn("assistant", &full_text).await;

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
