use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use super::ferricula::FerriculaBackend;
use super::provider::AnyProvider;
use super::registry::ToolRegistry;
use super::types::{GhostEvent, PendingToolCall, ProviderEvent, ToolDef};

const SYSTEM_PROMPT: &str = "\
You are Hyperia, the ghost in the machine — an agent inside the Hyperia terminal emulator.

## Conversation memory
Everything the user tells you in this conversation is yours to use. Facts about them, things they have, names, preferences, prior actions, anything — treat it as ground truth within this conversation. Do NOT refuse to acknowledge what the user told you on the grounds of \"not having access to personal information\" — if they told you in the conversation, you do have access. If they said they have a blue parrot, then they have a blue parrot. If they told you their name, use it. If they said \"you are Hyperia,\" act as Hyperia. The conversation history above is your short-term memory; read it and use it.

## Honesty about tools
The tool list above is the COMPLETE set of tools you have. Do not invent tool names — `google:search`, `web_search`, generic shell access, image generation, etc. don't exist unless they're in the list. If the user asks for something you can't do:
- check `tool_search` for what exists by keyword
- use `web_fetch` if you can compose a specific URL
- offer to build a new tool with `tool_create`
- or tell the user plainly that the capability isn't wired

Never call a tool name that wasn't in your tool definitions for this turn.

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
- STRUCTURED WORKFLOWS:
  - Web Content: open_web_pane -> terminal_status -> Parse tabId -> web_pane_content.
  - Terminal Execution: terminal_status -> Parse active paneId -> terminal_run -> terminal_screen.
- TARGET PARAMETERS:
  - Terminal tools (terminal_screen, terminal_run) target a 'pane' (highly prefer the stable paneId UUID or its 4+ char prefix; alphabetical split labels like \"a\", \"b\" are DEPRECATED and shift when layout changes).
  - Web tools (web_pane_content, web_pane_eval) target a 'tab' (e.g. tabId UUID or tab name).
  - For simple tasks in the current view, omit target parameters (window, tab, pane) to default to the currently focused window, tab, or pane.
- PAGE LOAD ASYNCHRONY: When open_web_pane returns, wait briefly or check if the page content contains loading states before summarizing.

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
- Ferricula is the memory backend — runs in Docker locally (`docker compose up ferricula`) or pointed at a remote URL via FERRICULA_URL.
- Shivvr (embeddings) is configured INSIDE ferricula, not separately. Don't ask the user to set a standalone shivvr URL — point them at the ferricula config instead if recall quality is poor.

## Web content
- To show a URL to the user, ALWAYS use open_web_pane — never use `open`, `xdg-open`, `start`, or any shell command to open URLs in the system browser. open_web_pane opens an embedded browser tab right inside Hyperia.

## Watercooler
Call the watercooler tool to check in with the human after making real progress. Don't run more than a handful of tool calls without checking in.

## Inline UI widgets (show_input / show_button / show_picker)
When you need user input — a token, a path, a yes/no, a choice among options — prefer rendering an inline widget over asking with plain text. The widgets are show_input (single line), show_button (one-tap action), and show_picker (single-select from a list). They BLOCK your tool call until the user submits, and the tool result tells you what they entered or whether they dismissed.

Rules:
- Call exactly ONE show_* tool per turn. Do not combine show_* with other tool calls in the same turn — the others will wait while the user reads.
- Pick a stable, descriptive id (e.g. \"nuts_token\", \"model_choice\", \"confirm_docker_run\"). The id surfaces in the tool result.
- For tokens or secrets, use show_input with kind=\"password\".
- If the user dismisses (tool result has dismissed: true), don't re-prompt for the same thing in the same turn — pick a different angle or end the turn.

## Configuration
When the user asks about settings, configuration, missing services, or onboarding, call doctor first to get a readiness report. Then use show_button / show_input / show_picker to walk the user through what's missing. Use settings_set to apply choices to the shared Hyperia config.
If the nuts_token is missing or unauthenticated, explain that the token is required to authenticate ferricula memory services, call open_web_pane(url=\"https://auth.nuts.services\") to open the login page in a web pane, and use show_input(id=\"nuts_token\", prompt=\"Paste your nuts.services token\", kind=\"password\") and settings_set(\"config.nuts.token\", value) to save it.

## Bringing up services with docker_run
The docker_run tool is your one terminal exception — it exists so you can start local services like Ferricula or Maximus when doctor reports them missing or unreachable. Shivvr lives inside ferricula and doesn't get its own container. Rules:
- ALWAYS tell the user what you're about to run BEFORE calling docker_run. Show them the docker command in plain text in your reply (\"I'll run: docker compose -f hyperia/docker-compose.yml up -d ferricula\"). Then optionally use show_button(\"confirm_docker\", \"Go ahead\") to confirm before firing.
- Only call docker_run for service bring-up, status checks, or log inspection. Don't use it as a general terminal.
- Common patterns: `docker ps` to see what's running, `docker logs <name> --tail 50` to debug a service, `docker run -d --name X -p HOST:CONTAINER image` to start one detached.
- After bringing up a service, re-run doctor to confirm it's reachable.
- If docker_run returns success=false or a non-zero exit_code, read the stderr field and explain the failure to the user — don't just retry.

## Changing the model
When the user says \"change my model\", \"switch to OpenAI\", \"use Claude\", or anything similar, follow this exact flow:
  1. Call model_catalog() (no args). You get back a list of providers — anthropic, openai, gemini, ollama. Call show_picker with id=\"provider\" and one option per provider (use the `label` field as the picker label, `provider` as the value).
  2. After the user picks a provider, call model_catalog(provider=\"<choice>\"). You get back the models for that provider. Call show_picker with id=\"model\" and one option per model (use `name` + a description line from `note` and `context`, and `id` as the value).
  3. After the user picks a model, write both config settings:
       settings_set with path=\"config.agent.provider\" and value=<provider>
       settings_set with path=\"config.agent.model\" and value=<model_id>
  4. If the chosen provider has no token configured (settings_get(\"config.providers.<provider>.token\") returns null/empty) and the provider isn't ollama, follow up with show_input(id=\"token\", kind=\"password\") to collect it, then settings_set(\"config.providers.<provider>.token\", <value>).
Do not invent models. Only present what model_catalog returns.";

/// The exact "## Honesty about tools" paragraph inside [`SYSTEM_PROMPT`]. In
/// doors mode it is string-replaced with [`DOORS_CONTRACT`] (plan §4.3.5).
/// MUST stay byte-for-byte identical to the block in SYSTEM_PROMPT or the
/// replace silently no-ops.
const HONESTY_ABOUT_TOOLS: &str = "\
## Honesty about tools
The tool list above is the COMPLETE set of tools you have. Do not invent tool names — `google:search`, `web_search`, generic shell access, image generation, etc. don't exist unless they're in the list. If the user asks for something you can't do:
- check `tool_search` for what exists by keyword
- use `web_fetch` if you can compose a specific URL
- offer to build a new tool with `tool_create`
- or tell the user plainly that the capability isn't wired

Never call a tool name that wasn't in your tool definitions for this turn.";

/// Doors-mode replacement for [`HONESTY_ABOUT_TOOLS`]. Explains that the live
/// tool list is a small core plus opened doors, and how to reveal more.
const DOORS_CONTRACT: &str = "\
## Tools behind doors
Your tool list is NOT the whole catalog — it is a small always-on core plus any doors you have opened. A door is a named category of tools. Two meta-tools drive it:
- open_tools(door=\"NAME\") makes that door's tools callable on your NEXT turn. Its description lists every door and what each contains.
- close_tools(door=\"NAME\") puts a door away to free room (there is a live-tool cap; opening a door may evict the least-recently-used one).
- tool_search(query) searches the FULL catalog (open or closed) and tells you which door each tool is behind.

Rules:
- If a capability seems missing, DON'T assume it doesn't exist — search first, then open the right door.
- You may call a tool that is behind a closed door directly; the door auto-opens and the call runs. Prefer open_tools when you know you'll need a whole category.
- Never invent tool names that are not in the catalog (tool_search will confirm what's real).";

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
    /// Progressive-disclosure door state (open doors + cap), persisted across
    /// messages exactly like `tool_call_count`/`recent_calls`. `enabled` is
    /// (re)derived per run from `HYPERIA_TOOL_DOORS`; the open-door list rides
    /// through so a door opened on one message stays open on the next.
    door_state: crate::doors::DoorState,
    pub stop_requested: Arc<AtomicBool>,
    pub window_closed: Arc<AtomicBool>,
    /// Messages the user typed while the agent was running. Drained by the
    /// agent loop between Anthropic calls and spliced into the conversation
    /// so the agent sees them on its next turn without a hard interrupt.
    pub pending_injects: Arc<std::sync::Mutex<Vec<String>>>,
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
            door_state: crate::doors::DoorState::new(crate::doors::Surface::Ghost),
            stop_requested: Arc::new(AtomicBool::new(false)),
            window_closed: Arc::new(AtomicBool::new(false)),
            pending_injects: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Queue a user message to be picked up by the running agent loop on
    /// its next iteration. Safe to call while the agent is mid-turn.
    pub fn inject_user_message(&self, msg: String) {
        if let Ok(mut v) = self.pending_injects.lock() {
            v.push(msg);
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
        door_config: crate::doors::DoorConfig,
        context_tokens: usize,
    ) -> mpsc::Receiver<GhostEvent> {
        let (tx, rx) = mpsc::channel(128);

        self.state = SessionState::Running;
        self.turn += 1;
        self.stop_requested.store(false, Ordering::Relaxed);
        self.window_closed.store(false, Ordering::Relaxed);
        let stop_requested = self.stop_requested.clone();
        let window_closed = self.window_closed.clone();
        let pending_injects = self.pending_injects.clone();

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
        let initial_door_state = self.door_state.clone();

        tokio::spawn(async move {
            let result = run_loop(
                tx.clone(),
                messages,
                registry,
                provider,
                max_turns,
                turn_start,
                &user_msg,
                ferricula,
                &stop_requested,
                &window_closed,
                pending_injects,
                initial_tool_call_count,
                initial_recent_calls,
                initial_door_state,
                door_config,
                context_tokens,
            ).await;
            match result {
                Ok((final_messages, stop_reason, final_tool_call_count, final_recent_calls, final_door_state)) => {
                    // Write the full conversation history and throttle state back to the session
                    let mut session = session_mutex.lock().await;
                    session.set_messages(final_messages);
                    session.set_throttle_state(final_tool_call_count, final_recent_calls);
                    session.set_door_state(final_door_state);
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

    /// Persist the open-door set back to the session after a run (mirrors
    /// `set_throttle_state`).
    pub fn set_door_state(&mut self, door_state: crate::doors::DoorState) {
        self.door_state = door_state;
    }

    pub fn reset(&mut self) {
        self.messages.clear();
        self.turn = 0;
        self.state = SessionState::Idle;
        self.tool_call_count = 0;
        self.recent_calls.clear();
        self.door_state = crate::doors::DoorState::new(crate::doors::Surface::Ghost);
        self.stop_requested.store(false, Ordering::Relaxed);
        self.window_closed.store(false, Ordering::Relaxed);
    }
}

/// Ring buffer of per-turn ghost telemetry, exposed at GET /api/ghost/debug.
/// Lets a dev/agent troubleshoot the run loop (which model, token counts,
/// decode speed, context budget, tools) without a human relaying the shell.
static GHOST_DEBUG: std::sync::OnceLock<std::sync::Mutex<Vec<serde_json::Value>>> =
    std::sync::OnceLock::new();

pub fn push_ghost_debug(entry: serde_json::Value) {
    let buf = GHOST_DEBUG.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    if let Ok(mut v) = buf.lock() {
        v.push(entry);
        let len = v.len();
        if len > 60 {
            v.drain(0..len - 60);
        }
    }
}

pub fn ghost_debug_snapshot() -> Vec<serde_json::Value> {
    GHOST_DEBUG
        .get()
        .and_then(|m| m.lock().ok().map(|v| v.clone()))
        .unwrap_or_default()
}

async fn run_loop(
    tx: mpsc::Sender<GhostEvent>,
    mut messages: Vec<serde_json::Value>,
    registry: Arc<ToolRegistry>,
    provider: Arc<AnyProvider>,
    max_turns: usize,
    turn_start: usize,
    user_message: &str,
    ferricula: Arc<FerriculaBackend>,
    stop_requested: &AtomicBool,
    window_closed: &AtomicBool,
    pending_injects: Arc<std::sync::Mutex<Vec<String>>>,
    initial_tool_call_count: usize,
    initial_recent_calls: Vec<(String, String)>,
    initial_door_state: crate::doors::DoorState,
    door_config: crate::doors::DoorConfig,
    context_tokens: usize,
) -> anyhow::Result<(Vec<serde_json::Value>, String, usize, Vec<(String, String)>, crate::doors::DoorState)> {
    // Doors mode + cap are resolved once at config load (config.agent.tool_doors
    // "auto"/"on"/"off" + provider + env override) and passed in via
    // `door_config`. The open-door set persists across messages via the session;
    // `enabled`/`cap` are re-applied here every run so a config change takes
    // effect on the next message without a restart.
    let doors_enabled = door_config.enabled;
    let mut door_state = initial_door_state;
    door_state.set_enabled(doors_enabled);
    door_state.set_cap(door_config.cap);

    // Progressive throttle counters — seeded from session so they persist across messages.
    // Reset only when the user explicitly resets the conversation.
    let mut tool_call_count: usize = initial_tool_call_count;
    let mut screen_poll_streak: usize = 0; // consecutive iterations where ONLY terminal_screen was called (resets per message)
    let mut view_open_count: usize = 0; // panes/tabs/windows created this message — runaway-open guard (resets per message)

    // Track recent tool calls for repeat detection — seeded from session
    let mut recent_calls: Vec<(String, String)> = initial_recent_calls;

    // Recall memories from Ferricula before the first model call
    let mut system = SYSTEM_PROMPT.to_string();
    // Doors mode: swap the "complete tool list" honesty paragraph for the
    // doors contract (plan §4.3.5) — in doors mode the tool list is a small
    // core plus opened doors, not the whole catalog.
    if doors_enabled {
        system = system.replace(HONESTY_ABOUT_TOOLS, DOORS_CONTRACT);
    }
    let recalled = ferricula.recall(user_message).await;
    if !recalled.is_empty() {
        system.push_str(&recalled);
    }
    // Inject current terminal state so the agent knows what's already running.
    // In doors mode on a small/local model the full /api/status JSON is a big
    // fixed cost against an 8k window — trim it to a compact one-line-per-pane
    // summary (window/tab/pane counts + focused pane) instead (plan §4.3.3).
    let slim_state = doors_enabled && door_config.small;
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

                if slim_state {
                    system.push_str(&format!(
                        "\n\n## Current terminal state (summary)\n{}\n\
                         Call terminal_status for full pane/tab detail when you need it.",
                        compact_terminal_state(&parsed)
                    ));
                } else {
                    system.push_str(&format!("\n\n## Current terminal state\n```json\n{}\n```", status));
                }
            } else if !slim_state {
                // Unparseable but we still ship the raw text in full mode.
                system.push_str(&format!("\n\n## Current terminal state\n```json\n{}\n```", status));
            }
        }
    }

    // Check once whether Maximus context compression is available for this run.
    // Disabled silently if Ollama is not running — no impact on the agent loop.
    let compressor = crate::ghost::compressor::ContextCompressor::from_env()
        .with_ferricula(ferricula.clone());
    compressor.load_patterns_from_ferricula().await;
    let compress = compressor.is_available().await;
    if compress {
        tracing::info!("maximus: context compression active ({})", compressor.get_model());
    }

    let mut turns = 0;
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut prev_in: u64 = 0;
    let mut prev_out: u64 = 0;

    loop {
        turns += 1;
        let turn_start_at = std::time::Instant::now();
        if turns > max_turns {
            let _ = tx
                .send(GhostEvent::Done {
                    stop_reason: "max_turns".into(),
                    turns: turn_start + turns - 1,
                })
                .await;
            return Ok((messages, "max_turns".into(), tool_call_count, recent_calls, door_state));
        }

        // Assemble the base tool list for THIS iteration. In doors mode this is
        // core + open doors' schemas (which change as the model opens/closes
        // doors mid-turn); with doors off it is the full catalog. Throttle-tier
        // filtering below then applies ON TOP as a stricter emergency brake.
        let tool_defs = registry.tool_defs(
            Some(provider.provider_name()),
            Some(provider.model_name()),
            Some(&door_state),
        );

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

        // Serialized tool-schema byte size — used both by the Phase 0
        // instrumentation below and as compressor overhead (system + tools) for
        // the token-budget guard.
        let tool_schema_bytes = serde_json::to_vec(&effective_tool_defs)
            .map(|v| v.len())
            .unwrap_or(0);

        // Effective context window. Explicit config (config.agent.context_tokens)
        // wins; otherwise assume the known small-model window (8k) for local/small
        // providers (Sailfish/Ollama) so the budget guard actually engages — the
        // config leaves this 0, which used to disable trimming entirely and let an
        // 8k model 400 with "exceeds context size". Cloud models have huge windows
        // and manage themselves, so they stay unbounded (0 = no trim).
        let effective_ctx = if context_tokens > 0 {
            context_tokens
        } else if door_config.small {
            8192
        } else {
            0
        };
        // Reserve headroom for the model's own output. On a small 8k window, the
        // old fixed 4096 was half the budget — scale it down so the prompt has room.
        let out_reserve: u32 = if effective_ctx > 0 && effective_ctx <= 16384 { 1024 } else { 4096 };
        let prompt_budget = effective_ctx.saturating_sub(out_reserve as usize);

        // Compress older messages via local Ollama before sending to the primary model.
        // Recent messages are kept verbatim; `messages` itself is never modified so
        // tool results continue accumulating against the full history. When a context
        // budget is known, trim so system + tools + history fits; if the LLM
        // compressor is down, still hard-trim mechanically (never send full history
        // into a bounded window).
        let overhead_chars = effective_system.len() + tool_schema_bytes;
        let send_messages = if compress {
            compressor
                .compress_messages_budgeted(&messages, prompt_budget, overhead_chars)
                .await
        } else if prompt_budget > 0 {
            crate::ghost::compressor::hard_trim_to_budget(&messages, prompt_budget, overhead_chars)
        } else {
            messages.clone()
        };

        // Phase 0 instrumentation (no behavior change): measure the live tool
        // surface shipped to the provider this iteration — count + serialized
        // schema byte size. This is the baseline the doors work shrinks.
        tracing::info!(
            target: "doors",
            turn = turns,
            throttle_tier,
            tool_count = effective_tool_defs.len(),
            schema_bytes = tool_schema_bytes,
            "ghost tool surface (per-iteration)"
        );

        // Call the provider
        let mut event_rx = provider
            .stream(&effective_system, &send_messages, &effective_tool_defs, out_reserve)
            .await?;

        // Accumulate assistant content and tool calls
        let mut text_parts: Vec<String> = Vec::new();
        let mut pending_tools: Vec<PendingToolCall> = Vec::new();
        let mut current_tool_index: Option<usize> = None;
        let mut stop_reason = String::new();

        while let Some(event) = event_rx.recv().await {
            match event {
                ProviderEvent::ThinkingStart { id } => {
                    text_parts.push("[Thinking: ".to_string());
                    let _ = tx.send(GhostEvent::ThinkingStart { id }).await;
                }
                ProviderEvent::ThinkingDelta { id, text } => {
                    text_parts.push(text.clone());
                    let _ = tx.send(GhostEvent::ThinkingDelta { id, text }).await;
                }
                ProviderEvent::ThinkingEnd { id } => {
                    text_parts.push("]\n\n".to_string());
                    let _ = tx.send(GhostEvent::ThinkingEnd { id }).await;
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
                    // Note: GhostEvent::ToolStart is intentionally NOT emitted
                    // here. Verbose models can keep generating text + declaring
                    // more tool calls for a long time after the first
                    // declaration — emitting tool_start during streaming made
                    // the pulse run for the rest of the model's turn rather
                    // than for actual execution. tool_start is emitted further
                    // down, right before registry.execute(), so pulse
                    // duration tracks real tool execution time.
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
                    return Ok((messages, "error".into(), tool_call_count, recent_calls, door_state));
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

        // Per-turn debug telemetry (ring buffer at /api/ghost/debug) so a dev or
        // agent can see WHICH model handled the turn, token counts, decode speed,
        // context budget, and tools — without a human relaying the transcript.
        {
            let dt_in = total_input_tokens.saturating_sub(prev_in);
            let dt_out = total_output_tokens.saturating_sub(prev_out);
            prev_in = total_input_tokens;
            prev_out = total_output_tokens;
            let ms = turn_start_at.elapsed().as_millis() as u64;
            let tps = if ms > 0 { (dt_out as f64) / (ms as f64 / 1000.0) } else { 0.0 };
            let tools: Vec<&str> = pending_tools.iter().map(|t| t.name.as_str()).collect();
            push_ghost_debug(serde_json::json!({
                "turn": turns,
                "provider": provider.provider_name(),
                "model": provider.model_name(),
                "sent_messages": send_messages.len(),
                "compressed": compress,
                "effective_ctx": effective_ctx,
                "prompt_budget": prompt_budget,
                "out_reserve": out_reserve,
                "in_tokens_total": total_input_tokens,
                "out_tokens_total": total_output_tokens,
                "in_tokens_turn": dt_in,
                "out_tokens_turn": dt_out,
                "duration_ms": ms,
                "tps": (tps * 10.0).round() / 10.0,
                "tools": tools,
                "stop_reason": stop_reason,
                "view_opens": view_open_count,
            }));
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

                // Emit tool_start right before execution so the pulse in the
                // shell tracks real dispatch time, not the rest of the model's
                // streaming turn.
                let _ = tx
                    .send(GhostEvent::ToolStart {
                        name: tool.name.clone(),
                        id: tool.id.clone(),
                    })
                    .await;

                // Doors meta-tools (only when doors mode is active). A bare door
                // name (e.g. calling "web") is accepted as an alias for
                // open_tools(door="web") — cheap and 4B-friendly (plan §7).
                let output;
                let door_alias: Option<&'static str> = if door_state.enabled() {
                    crate::doors::door_by_name(&tool.name)
                        .filter(|d| !d.ghost_tools.is_empty())
                        .map(|d| d.name)
                } else {
                    None
                };

                if door_state.enabled() && (tool.name == "open_tools" || door_alias.is_some()) {
                    // Gather-on-entry: mutate loop-local DoorState, synthesize the
                    // "available next turn" text (plan §4.3.2). Schemas land in the
                    // next request's tools array, not in the transcript.
                    output = open_door_result(&registry, &mut door_state, door_alias, &input);
                } else if door_state.enabled() && tool.name == "close_tools" {
                    output = close_door_result(&mut door_state, &input);
                } else if tool.name == "tool_mount" {
                    // tool_mount: non-blocking dynamic-widget mount. Stash the
                    // payload server-side keyed by a generated mount_id, emit
                    // the SSE event so the renderer can render it inline, and
                    // synthesize a confirmation string for the agent's history.
                    // Skip registry.execute() entirely — there's no blocking
                    // dispatch to run.
                    let widget_name = input["name"].as_str().unwrap_or("widget").to_string();
                    let srcdoc = input["srcdoc"].as_str().unwrap_or("").to_string();
                    if srcdoc.is_empty() {
                        output = "Error: tool_mount requires a non-empty 'srcdoc'.".to_string();
                    } else {
                        let data: std::collections::HashMap<String, serde_json::Value> = input["data"]
                            .as_object()
                            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                            .unwrap_or_default();
                        let exposes: Vec<String> = input["exposes"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let permits: Vec<String> = input["permits"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let height = input["height"].as_u64().unwrap_or(320) as u32;

                        let store = registry.widget_store();
                        let srcdoc_bytes = srcdoc.len();
                        let mount_id = store.mount(
                            widget_name.clone(),
                            &srcdoc,
                            data,
                            exposes.clone(),
                            permits.clone(),
                        );

                        if let Some(meta) = store.meta(&mount_id) {
                            tracing::info!(
                                target: "widget_mount",
                                mount_id = %mount_id,
                                name = %meta.name,
                                srcdoc_hash = %meta.srcdoc_hash,
                                srcdoc_bytes = srcdoc_bytes,
                                exposes = ?meta.exposes,
                                permits = ?meta.permits,
                                "tool_mount emitted"
                            );
                        }

                        let _ = tx
                            .send(GhostEvent::ToolMount {
                                id: mount_id.clone(),
                                name: widget_name,
                                srcdoc,
                                exposes,
                                permits,
                                height,
                            })
                            .await;

                        output = format!(
                            "mounted widget {0} (display-only; agent continues immediately). \
                             Widget fetches data via GET /api/ghost/widget/{0}/data?key=<key> and \
                             may queue actions via POST /api/ghost/widget/{0}/action — you'll \
                             see queued actions in your next turn as a [Meanwhile a widget \
                             requested:] marker.",
                            mount_id
                        );
                    }
                } else {
                    // Closed-door call guard (plan §4.3.3): the model called a
                    // real catalog tool that is behind a closed door (saw the
                    // name in tool_search / compressed history / an earlier
                    // turn). Auto-open the door, run the tool, and annotate the
                    // result. This is safe by construction — doors are a menu,
                    // not a permission boundary (consent/identity live at the
                    // HTTP API). Truly unknown names fall through to the normal
                    // "Unknown tool: X" from registry.execute.
                    let mut auto_opened: Option<String> = None;
                    if door_state.enabled() {
                        if let Some(dn) = door_state.door_of(&tool.name) {
                            if !door_state.is_door_open(dn) {
                                door_state.open_door(dn);
                                auto_opened = Some(dn.to_string());
                            }
                        }
                    }

                    // For show_* tools, surface the widget to the renderer
                    // *before* dispatching (because dispatch blocks until the
                    // user submits via POST /api/ghost/ui-response). The
                    // widget id comes from input.id (the agent sets it).
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

                    // Runaway-pane guard: a small model on a fuzzy task can open
                    // panes/tabs forever — each open is a fresh side effect, so
                    // the repeat guard (which keys on identical output) never
                    // trips. Hard-cap view-creating tools per user message; past
                    // the cap, refuse the side effect and tell it to stop.
                    // Focus-never-steal makes runaway opens especially disruptive.
                    const VIEW_CREATORS: [&str; 4] =
                        ["open_web_pane", "terminal_new_tab", "terminal_new_window", "terminal_split"];
                    const VIEW_CREATE_CAP: usize = 4;
                    let is_view_creator = VIEW_CREATORS.contains(&tool.name.as_str());

                    // tool_search is door-aware in doors mode (adds open/closed
                    // hints); otherwise it flows through execute() unchanged.
                    let raw_output = if is_view_creator && view_open_count >= VIEW_CREATE_CAP {
                        tracing::warn!(target: "doors", tool = %tool.name, count = view_open_count, "runaway view-creation blocked");
                        format!(
                            "[BLOCKED: refusing to run {} — you've already opened {} panes/tabs/windows \
                             for this request. Opening more disrupts the human's view. STOP creating panes. \
                             Use the ones already open (terminal_status lists them), finish the task, or ask \
                             the user what they want.]",
                            tool.name, view_open_count
                        )
                    } else if door_state.enabled() && tool.name == "tool_search" {
                        registry.handle_tool_search(&input, Some(&door_state))
                    } else {
                        if is_view_creator {
                            view_open_count += 1;
                        }
                        registry.execute(&tool.name, &input).await
                    };

                    output = match auto_opened {
                        Some(dn) => format!("[door '{}' auto-opened by this call]\n{}", dn, raw_output),
                        None => raw_output,
                    };
                }

                // Any executed tool touches its door → moves it to MRU so it
                // survives the next cap eviction longest (no-op for core tools
                // and closed doors).
                if door_state.enabled() {
                    door_state.touch(&tool.name);
                }

                // Repeat detection. Two ways a call counts as a loop:
                //  (a) same call+output as a previous one (deterministic re-fire), OR
                //  (b) same tool+input issued 3+ times recently even when the
                //      OUTPUT differs each time — e.g. terminal_split with no
                //      args spawns a NEW pane every call, so its output never
                //      repeats and (a) alone would let a small model split
                //      forever. Counting the signature catches that.
                let call_sig = format!("{}:{}", tool.name, input.to_string());
                let same_sig_count = recent_calls.iter().filter(|(sig, _)| sig == &call_sig).count();
                let is_repeat = same_sig_count >= 2
                    || recent_calls.iter().any(|(sig, prev_out)| sig == &call_sig && prev_out == &output);
                recent_calls.push((call_sig, output.clone()));
                // Keep only last 10
                if recent_calls.len() > 10 { recent_calls.remove(0); }

                // Auto-save tool health observations
                {
                    let out_lower = output.to_lowercase();
                    let is_error = out_lower.contains("error") || out_lower.contains("failed")
                        || out_lower.contains("blocked") || out_lower.contains("unknown tool");
                    if is_error {
                        let snippet = crate::util::safe_prefix(&output, 300);
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

            // Soft preemption: drain any messages the user typed while the
            // agent was working and append them as a text block in the same
            // user message that carries the tool_results. The agent's next
            // call sees both — tool outputs and the user's latest direction.
            let injected: Vec<String> = {
                let mut v = pending_injects.lock().unwrap();
                std::mem::take(&mut *v)
            };
            if !injected.is_empty() {
                let joined = injected
                    .iter()
                    .map(|m| format!("- {}", m))
                    .collect::<Vec<_>>()
                    .join("\n");
                tool_results.push(serde_json::json!({
                    "type": "text",
                    "text": format!(
                        "[Meanwhile the user said — read this before continuing]\n{}",
                        joined
                    ),
                }));
            }

            // Widget action drain: any actions queued by mounted widgets via
            // POST /api/ghost/widget/:id/action since the last turn. The
            // agent reads them in its next turn and decides whether to
            // honor each. Permission enforcement (permits allowlist) already
            // happened at queue time in the HTTP handler.
            let widget_actions = registry.widget_store().drain_actions();
            if !widget_actions.is_empty() {
                let lines: Vec<String> = widget_actions
                    .iter()
                    .map(|(mount_id, a)| {
                        format!("- widget {} requested action '{}' args={}", mount_id, a.action, a.args)
                    })
                    .collect();
                tool_results.push(serde_json::json!({
                    "type": "text",
                    "text": format!(
                        "[Meanwhile a widget requested — review and honor or decline]\n{}",
                        lines.join("\n")
                    ),
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
                return Ok((messages, "watercooler".into(), tool_call_count, recent_calls, door_state));
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
        let summary = format!("User: {}\nAssistant: {}", user_message, crate::util::safe_prefix(&full_text, 500));
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
        return Ok((messages, final_stop_reason, tool_call_count, recent_calls, door_state));
    }
}

/// Compact one-liner summary of `/api/status` for the slim doors-mode prompt
/// (plan §4.3.3): total window/tab/pane counts plus the single focused pane.
/// Keeps a small/local model oriented without paying for the full nested JSON.
fn compact_terminal_state(status: &serde_json::Value) -> String {
    let windows = status["windows"].as_array().cloned().unwrap_or_default();
    let win_count = windows.len();
    let mut tab_count = 0usize;
    let mut pane_count = 0usize;
    let mut focused: Option<String> = None;

    for win in &windows {
        let win_id = win["id"].as_u64().unwrap_or(0);
        let win_focused = win["focused"].as_bool().unwrap_or(false);
        for tab in win["tabs"].as_array().into_iter().flatten() {
            tab_count += 1;
            let tab_name = tab["name"].as_str().unwrap_or("shell");
            let tab_active = tab["active"].as_bool().unwrap_or(false);
            for pane in tab["panes"].as_array().into_iter().flatten() {
                pane_count += 1;
                let pane_active = pane["active"].as_bool().unwrap_or(false);
                if focused.is_none() && win_focused && tab_active && pane_active {
                    let label = pane["label"].as_str().unwrap_or("");
                    let shell = pane["shell"].as_str().unwrap_or("");
                    let proc = pane["process"].as_str().unwrap_or("");
                    let cwd = pane["cwd"].as_str().unwrap_or("");
                    let proc_info = if proc.is_empty() {
                        shell.to_string()
                    } else {
                        format!("{} ({})", shell, proc)
                    };
                    focused = Some(format!(
                        "window {} › tab '{}' › pane {}: {} in `{}`",
                        win_id,
                        tab_name,
                        if label.is_empty() { "-" } else { label },
                        proc_info,
                        cwd
                    ));
                }
            }
        }
    }

    let counts = format!(
        "{} window(s), {} tab(s), {} pane(s).",
        win_count, tab_count, pane_count
    );
    match focused {
        Some(f) => format!("{} Focused: {}", counts, f),
        None => format!("{} No focused pane reported.", counts),
    }
}

/// Open a door and synthesize the gather-on-entry result text (plan §4.3.2):
/// the door name, a one-line-per-tool listing of what it exposes NEXT turn, the
/// current open-door set, the live-tool budget, and any LRU-evicted doors.
/// Handles both `open_tools(door=…)` and the bare-door-name alias.
fn open_door_result(
    registry: &ToolRegistry,
    door_state: &mut crate::doors::DoorState,
    alias: Option<&str>,
    input: &serde_json::Value,
) -> String {
    use crate::doors::{door_by_name, doors_for, Surface};

    let door: String = match alias {
        Some(d) => d.to_string(),
        None => input["door"].as_str().unwrap_or("").trim().to_string(),
    };
    tracing::info!(target: "doors", door = %door, alias = ?alias, raw_input = %input, "open_tools requested");

    // Validate against the ghost surface.
    let valid = door_by_name(&door).map_or(false, |d| !d.ghost_tools.is_empty());
    if !valid {
        let names: Vec<&str> = doors_for(Surface::Ghost).map(|d| d.name).collect();
        tracing::warn!(target: "doors", door = %door, available = %names.join(", "), "open_tools failed: unknown door");
        return format!(
            "Unknown door '{}'. Available doors: {}",
            door,
            names.join(", ")
        );
    }

    let evicted = door_state.open_door(&door);
    let door_def = door_by_name(&door).unwrap();
    tracing::info!(
        target: "doors",
        door = %door,
        opened_tools = door_def.ghost_tools.len(),
        live = door_state.live_tool_count(),
        cap = door_state.cap(),
        evicted = %evicted.join(","),
        "open_tools ok"
    );

    // One-line-per-tool listing pulled from the full catalog descriptions.
    let catalog = registry.tool_defs(None, None, None);
    let lines: Vec<String> = door_def
        .ghost_tools
        .iter()
        .map(|&t| {
            let desc = catalog
                .iter()
                .find(|c| c.name == t)
                .map(|c| c.description.as_str())
                .unwrap_or("");
            let first = desc.lines().next().unwrap_or("").trim();
            format!("- {}: {}", t, first)
        })
        .collect();

    let open_list = door_state.open_doors().join(", ");
    let mut out = format!(
        "Door '{}' opened. Available on your NEXT turn ({} tools):\n{}\n\n\
         [doors open: {}] [live tools next turn: {}/{}]",
        door,
        door_def.ghost_tools.len(),
        lines.join("\n"),
        open_list,
        door_state.live_tool_count(),
        door_state.cap()
    );
    if !evicted.is_empty() {
        out.push_str(&format!(
            "\n[evicted: {} — reopen with open_tools if needed]",
            evicted.join(", ")
        ));
    }
    out
}

/// Close a door and report the resulting live-tool budget (plan §4.3.2).
fn close_door_result(
    door_state: &mut crate::doors::DoorState,
    input: &serde_json::Value,
) -> String {
    let door = input["door"].as_str().unwrap_or("").trim().to_string();
    if door.is_empty() {
        return "close_tools requires a 'door' name.".to_string();
    }
    let was_open = door_state.is_door_open(&door);
    door_state.close_door(&door);
    let open_list = door_state.open_doors().join(", ");
    let open_disp = if open_list.is_empty() {
        "none".to_string()
    } else {
        open_list
    };
    let prefix = if was_open {
        format!("Door '{}' closed.", door)
    } else {
        format!("Door '{}' was not open.", door)
    };
    format!(
        "{} [doors open: {}] [live tools next turn: {}/{}]",
        prefix,
        open_disp,
        door_state.live_tool_count(),
        door_state.cap()
    )
}
