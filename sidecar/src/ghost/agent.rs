use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use super::ferricula::FerriculaBackend;
use super::provider::AnyProvider;
use super::registry::ToolRegistry;
use super::types::{GhostEvent, PendingToolCall, ProviderEvent, ToolDef};

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
- NEVER call terminal_focus before terminal_keys, terminal_run, or terminal_split — those tools address panes directly and do not need a focus change first. terminal_focus visually shifts the human's active pane; only use it when you intentionally want to direct the human's attention to a pane.
- Use tool_search to discover available tools by keyword.
- Use tool_create to make new tools on the fly when no existing tool fits.
  - Prefer the SCRIPT mode (code + language). Write Python/Node/shell scripts that read JSON args from stdin and write results to stdout. This avoids all quoting issues and gives you real language features.
  - Use shell command templates only for trivial one-liners with no quoting complexity.
  - Scripts are saved to ~/.hyperia/tools/ and are callable immediately after creation.
- If a tool behaves unexpectedly, is broken, or needs fixing, call memory_remember with channel=\"tool-health\" to record it. Future sessions will recall this automatically.

## Memory
You have access to Ferricula memory. Recalled memories appear below when relevant.
Build on what you remember. Don't ask for information you've been told before.

## Building Hyperia
- Always read BUILDING.md before building.
- On macOS the sidecar MUST be built with an explicit --target: `cargo build --release --target aarch64-apple-darwin` (Apple Silicon) or `--target x86_64-apple-darwin` (Intel). A bare `cargo build --release` puts the binary in the wrong path and it will be silently missing from the app.

## Services
- shivvr: https://shivvr.nuts.services

## Web content
- To show a URL to the user, ALWAYS use open_web_pane — never use `open`, `xdg-open`, `start`, or any shell command to open URLs in the system browser. open_web_pane opens an embedded browser tab right inside Hyperia.

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
    /// Cumulative tool calls across all messages this conversation — drives throttle tier.
    tool_call_count: usize,
    /// Recent (name+input, output) pairs for repeat detection — persists across messages.
    recent_calls: Vec<(String, String)>,
    pub stop_requested: Arc<AtomicBool>,
    pub window_closed: Arc<AtomicBool>,
}

impl GhostSession {
    pub fn new(max_turns: usize) -> Self {
        Self {
            messages: Vec::new(),
            turn: 0,
            max_turns,
            state: SessionState::Idle,
            tool_call_count: 0,
            recent_calls: Vec::new(),
            stop_requested: Arc::new(AtomicBool::new(false)),
            window_closed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Relaxed);
    }

    pub fn continue_run(&self) {
        self.stop_requested.store(false, Ordering::Relaxed);
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::Relaxed)
    }

    pub fn notify_window_closed(&self) {
        self.window_closed.store(true, Ordering::Relaxed);
    }

    pub fn window_closed(&self) -> bool {
        self.window_closed.load(Ordering::Relaxed)
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

    pub fn messages(&self) -> &Vec<serde_json::Value> {
        &self.messages
    }

    /// Run the agent loop for a user message. Returns a channel of GhostEvents.
    /// Takes the session mutex so the spawned task can write back the conversation history.
    pub fn run(
        &mut self,
        user_message: String,
        registry: Arc<ToolRegistry>,
        provider: Arc<AnyProvider>,
        session_mutex: Arc<tokio::sync::Mutex<GhostSession>>,
        ferricula: Arc<FerriculaBackend>,
    ) -> mpsc::Receiver<GhostEvent> {
        let (tx, rx) = mpsc::channel(128);

        self.state = SessionState::Running;
        self.turn += 1;
        self.stop_requested.store(false, Ordering::Relaxed);
        self.window_closed.store(false, Ordering::Relaxed);
        let stop_requested = self.stop_requested.clone();
        let window_closed = self.window_closed.clone();

        let user_msg = user_message.clone();
        // Add user message
        self.messages.push(serde_json::json!({
            "role": "user",
            "content": user_message,
        }));

        let messages = self.messages.clone();
        let max_turns = self.max_turns;
        let turn_start = self.turn;
        let initial_tool_call_count = self.tool_call_count;
        let initial_recent_calls = self.recent_calls.clone();

        tokio::spawn(async move {
            let result = run_loop(
                tx.clone(),
                messages,
                registry,
                provider,
                max_turns,
                turn_start,
                &user_msg,
                &ferricula,
                &stop_requested,
                &window_closed,
                initial_tool_call_count,
                initial_recent_calls,
            ).await;
            match result {
                Ok((final_messages, stop_reason, final_tool_call_count, final_recent_calls)) => {
                    // Write the full conversation history and throttle state back to the session
                    let mut session = session_mutex.lock().await;
                    session.set_messages(final_messages);
                    session.set_throttle_state(final_tool_call_count, final_recent_calls);
                    session.set_state(SessionState::Completed(stop_reason));
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

    pub fn set_throttle_state(&mut self, tool_call_count: usize, recent_calls: Vec<(String, String)>) {
        self.tool_call_count = tool_call_count;
        self.recent_calls = recent_calls;
    }

    pub fn reset(&mut self) {
        self.messages.clear();
        self.turn = 0;
        self.state = SessionState::Idle;
        self.tool_call_count = 0;
        self.recent_calls.clear();
        self.stop_requested.store(false, Ordering::Relaxed);
        self.window_closed.store(false, Ordering::Relaxed);
    }
}

async fn run_loop(
    tx: mpsc::Sender<GhostEvent>,
    mut messages: Vec<serde_json::Value>,
    registry: Arc<ToolRegistry>,
    provider: Arc<AnyProvider>,
    max_turns: usize,
    turn_start: usize,
    user_message: &str,
    ferricula: &FerriculaBackend,
    stop_requested: &AtomicBool,
    window_closed: &AtomicBool,
    initial_tool_call_count: usize,
    initial_recent_calls: Vec<(String, String)>,
) -> anyhow::Result<(Vec<serde_json::Value>, String, usize, Vec<(String, String)>)> {
    let tool_defs = registry.tool_defs();

    // Progressive throttle counters — seeded from session so they persist across messages.
    // Reset only when the user explicitly resets the conversation.
    let mut tool_call_count: usize = initial_tool_call_count;
    let mut screen_poll_streak: usize = 0; // consecutive iterations where ONLY terminal_screen was called (resets per message)

    // Track recent tool calls for repeat detection — seeded from session
    let mut recent_calls: Vec<(String, String)> = initial_recent_calls;

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
            // Extract platform for an explicit OS note so the agent uses the right shell commands
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&status) {
                let platform = parsed["platform"].as_str().unwrap_or("unknown");
                let os_note = match platform {
                    "win32" => "## OS: Windows\nYou are on Windows. Use PowerShell or CMD syntax. Do NOT suggest brew, apt, macOS paths, or Unix-only tools unless explicitly using WSL. Available shell profiles are listed in the terminal state below.",
                    "darwin" => "## OS: macOS\nYou are on macOS. Use bash/zsh syntax. Homebrew is common. Do NOT use apt or Windows paths.",
                    "linux" => "## OS: Linux\nYou are on Linux. Use bash syntax, apt/dnf/pacman as appropriate.",
                    _ => "## OS: Unknown platform",
                };
                system.push_str(&format!("\n\n{}", os_note));
            }
            system.push_str(&format!("\n\n## Current terminal state\n```json\n{}\n```", status));
        }
    }

    // Check once whether Maximus context compression is available for this run.
    // Disabled silently if Ollama is not running — no impact on the agent loop.
    let compressor = crate::ghost::compressor::ContextCompressor::from_env();
    compressor.load_patterns_from_ferricula().await;
    let compress = compressor.is_available().await;
    if compress {
        tracing::info!("maximus: context compression active ({})", compressor.model);
    }

    let mut turns = 0;
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;

    loop {
        turns += 1;
        if turns > max_turns {
            let _ = tx
                .send(GhostEvent::Done {
                    stop_reason: "max_turns".into(),
                    turns: turn_start + turns - 1,
                })
                .await;
            return Ok((messages, "max_turns".into(), tool_call_count, recent_calls));
        }

        // Compute throttle tier and filter tools accordingly
        let throttle_tier: u8 = if tool_call_count > 32 { 3 }
            else if tool_call_count > 24 { 2 }
            else if tool_call_count > 16 { 1 }
            else { 0 };

        let effective_tool_defs: Vec<ToolDef> = match throttle_tier {
            1 => tool_defs.iter()
                .filter(|t| t.name != "terminal_screen")
                .cloned()
                .collect(),
            2 => tool_defs.iter()
                .filter(|t| !t.name.starts_with("terminal_"))
                .cloned()
                .collect(),
            3 => tool_defs.iter()
                .filter(|t| t.name == "watercooler" || t.name.starts_with("memory_"))
                .cloned()
                .collect(),
            _ => tool_defs.clone(),
        };

        let mut effective_system = system.clone();
        if throttle_tier == 1 {
            effective_system.push_str(&format!(
                "\n\n## Tool throttle (tier 1 — {} calls made)\n\
                terminal_screen has been removed: you have been making too many tool calls this turn. \
                Stop polling. Use watercooler to check in with the user.",
                tool_call_count
            ));
        } else if throttle_tier == 2 {
            effective_system.push_str(&format!(
                "\n\n## Tool throttle (tier 2 — {} calls made)\n\
                All terminal tools have been removed. You have exceeded your tool budget for this turn. \
                Use watercooler to ask the user for guidance before continuing.",
                tool_call_count
            ));
        } else if throttle_tier == 3 {
            effective_system.push_str(&format!(
                "\n\n## Tool throttle (tier 3 — {} calls made)\n\
                Only memory and watercooler tools are available. \
                You MUST use watercooler to check in with the user before doing anything else.",
                tool_call_count
            ));
        }

        if window_closed.load(Ordering::Relaxed) {
            effective_system.push_str(
                "\n\n## Window closed\nThe Hyperia chat window has been closed by the user.\n\
Stop all current activity immediately. Do not start new tool calls.\n\
Do not produce output — there is no window to display it.\n\
Exit the turn now."
            );
        } else if stop_requested.load(Ordering::Relaxed) {
            effective_system.push_str(
                "\n\n## Stop request\nThe human asked you to stop soon.\n\
This is a request, not a kill signal.\n\
You may either stop now, or do minimal cleanup first if needed to leave the system in a good state.\n\
Allowed cleanup is narrow: save work, finish one in-flight operation, or leave a short note.\n\
Do not start new unrelated work.\n\
After cleanup, reply to the human and end the turn."
            );
        }

        // Compress older messages via local Ollama before sending to the primary model.
        // Recent messages are kept verbatim; `messages` itself is never modified so
        // tool results continue accumulating against the full history.
        let send_messages = if compress {
            compressor.compress_messages(&messages).await
        } else {
            messages.clone()
        };

        // Call the provider
        let mut event_rx = provider
            .stream(&effective_system, &send_messages, &effective_tool_defs, 4096)
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
                ProviderEvent::Usage { input_tokens, output_tokens } => {
                    total_input_tokens += input_tokens;
                    total_output_tokens += output_tokens;
                }
                ProviderEvent::Retrying { attempt, wait_secs } => {
                    let _ = tx.send(GhostEvent::Retrying { attempt, wait_secs }).await;
                }
                ProviderEvent::Error(msg) => {
                    let _ = tx.send(GhostEvent::Error { message: msg }).await;
                    return Ok((messages, "error".into(), tool_call_count, recent_calls));
                }
            }
        }

        // Emit cumulative stats after each model call
        let _ = tx.send(GhostEvent::Stats {
            input_tokens: total_input_tokens,
            output_tokens: total_output_tokens,
            tool_calls: tool_call_count,
            turns,
        }).await;

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

                // Repeat detection: check if we've seen this exact call+output before
                let call_sig = format!("{}:{}", tool.name, input.to_string());
                let is_repeat = recent_calls.iter().any(|(sig, prev_out)| {
                    sig == &call_sig && prev_out == &output
                });
                recent_calls.push((call_sig, output.clone()));
                // Keep only last 10
                if recent_calls.len() > 10 { recent_calls.remove(0); }

                // Auto-save tool health observations
                {
                    let out_lower = output.to_lowercase();
                    let is_error = out_lower.contains("error") || out_lower.contains("failed")
                        || out_lower.contains("blocked") || out_lower.contains("unknown tool");
                    if is_error {
                        let snippet = &output[..output.len().min(300)];
                        ferricula.remember(
                            &format!("Tool '{}' returned an error: {}", tool.name, snippet),
                            "tool-health",
                        ).await;
                    }
                    if is_repeat {
                        ferricula.remember(
                            &format!("Tool '{}' looped — same input produced same output twice. May be broken or stuck. Input: {}",
                                tool.name, &input.to_string()[..input.to_string().len().min(200)]),
                            "tool-health",
                        ).await;
                    }
                }

                let _ = tx
                    .send(GhostEvent::ToolResult {
                        id: tool.id.clone(),
                        name: tool.name.clone(),
                        input: input.clone(),
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

            // Update throttle counters
            let only_screen_this_round = pending_tools.iter().all(|t| t.name == "terminal_screen");
            tool_call_count += pending_tools.len();
            if only_screen_this_round && !pending_tools.is_empty() {
                screen_poll_streak += 1;
            } else {
                screen_poll_streak = 0;
            }

            // Inject screen-polling warning when hammering terminal_screen
            if screen_poll_streak >= 3 {
                if let Some(last) = tool_results.last_mut() {
                    let current = last["content"].as_str().unwrap_or("").to_string();
                    last["content"] = serde_json::Value::String(format!(
                        "{}\n\n[SYSTEM: You have called terminal_screen {} times in a row without \
                        making progress. The output is not changing. STOP polling. \
                        Use watercooler to check in with the user, or wait for an explicit signal \
                        before reading the screen again.]",
                        current, screen_poll_streak
                    ));
                }
            }

            // Forced slow-down when excessively polling the screen
            if screen_poll_streak >= 5 {
                tokio::time::sleep(tokio::time::Duration::from_secs(
                    (screen_poll_streak - 4).min(8) as u64
                )).await;
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
                return Ok((messages, "watercooler".into(), tool_call_count, recent_calls));
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

        let final_stop_reason = if stop_reason.is_empty() {
            if stop_requested.load(Ordering::Relaxed) {
                "stop_requested".into()
            } else {
                "end_turn".into()
            }
        } else {
            stop_reason
        };
        let _ = tx
            .send(GhostEvent::Done {
                stop_reason: final_stop_reason.clone(),
                turns: turn_start + turns - 1,
            })
            .await;
        return Ok((messages, final_stop_reason, tool_call_count, recent_calls));
    }
}
