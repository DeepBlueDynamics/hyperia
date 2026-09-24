//! Pane classification for shell commands vs direct agent input.
//!
//! `terminal_run` may proceed only for [`PaneClass::ShellPrompt`].
//! `pane_send` may deliver bytes only for a supported agent token.
//! Shell, unknown, and any other foreground are refusals — an unfocused
//! pane is not permission to type into whatever process is there.
//!
//! Empty foreground output is not a prompt. A missing or dead pid is never
//! a shell and never an agent. Screen text is not an input. Alt-screen is
//! honored only when the caller already knows it (`Some`); `None` means the
//! renderer has not reported it yet.

use sysinfo::{ProcessesToUpdate, System};

/// Executable tokens that may receive direct `pane_send` input.
/// Matched on the launcher executable only (process image name, or argv0
/// when that name is missing). Later argv tokens are arguments: `echo codex`
/// is `echo`. Never a substring (`pip` is not `pi`, `codex-cli` is not `codex`).
const AGENT_TOKENS: &[&str] = &[
    "agy",
    "aider",
    "antigravity",
    "claude",
    "claude-code",
    "codex",
    "gemini",
    "gemini-cli",
    "grok",
    "n8",
    "nemesis8",
    "ollama",
    "opencode",
];

const SHELL_TOKENS: &[&str] = &[
    "bash", "cmd", "dash", "fish", "nu", "powershell", "pwsh", "sh", "zsh",
];

/// What the process walk and shell integration actually showed.
/// Callers fill this. This module does not read the terminal screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassEvidence {
    pub pid: u32,
    /// Shell pid was found in the process table. Distinct from "no children".
    pub process_alive: bool,
    /// Shell binary path or filename (`SessionInfo.name`).
    pub shell_binary: String,
    /// Deepest foreground child. Empty when the shell has no child.
    pub foreground_name: String,
    pub foreground_cmdline: String,
    pub shell_has_integration: bool,
    /// Integration state string (`idle`, `running`, `busy`). Ignored when
    /// integration is absent.
    pub shell_state: String,
    pub shell_app_name: String,
    pub shell_app_cmdline: String,
    /// `None` until the renderer reports the xterm buffer type.
    /// `Some(true)` is an alt-screen and blocks [`PaneClass::ShellPrompt`].
    pub alt_screen: Option<bool>,
    /// Some ancestor has more than one child. Foreground name/cmdline are then
    /// empty; do not treat an arbitrary child as the launcher.
    pub process_ambiguous: bool,
}

impl ClassEvidence {
    pub fn dead() -> Self {
        Self {
            pid: 0,
            process_alive: false,
            shell_binary: String::new(),
            foreground_name: String::new(),
            foreground_cmdline: String::new(),
            shell_has_integration: false,
            shell_state: String::new(),
            shell_app_name: String::new(),
            shell_app_cmdline: String::new(),
            alt_screen: None,
            process_ambiguous: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaneClass {
    /// Live known shell, integration says idle, no foreign child, no agent.
    ShellPrompt,
    /// Known shell with something else in front, or integration says not idle.
    ShellBusy { foreground: String },
    /// Supported agent transport. `token` is one of [`AGENT_TOKENS`].
    Agent { token: String },
    /// A foreground we will not drive and will not treat as an agent.
    OtherForeground { name: String },
    /// Missing pid, dead process, or not enough authoritative evidence.
    Unknown { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    pub class: PaneClass,
    /// One line, safe to put in an API refusal.
    pub summary: String,
}

impl Classification {
    pub fn agent_token(&self) -> Option<&str> {
        match &self.class {
            PaneClass::Agent { token } => Some(token.as_str()),
            _ => None,
        }
    }

    pub fn terminal_run_allowed(&self) -> bool {
        matches!(self.class, PaneClass::ShellPrompt)
    }

    /// Direct pane input is allowed only for a supported agent token.
    pub fn accepts_direct_input(&self) -> bool {
        self.agent_token().is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FocusFacts {
    /// This pane is the active pane of the focused Hyperia window.
    pub pane_is_keyboard_focus: bool,
    /// Hyperia is the OS-foreground application.
    pub hyperia_foreground: bool,
    /// Human typed in this pane inside the activity lockout.
    pub actively_typed: bool,
}

impl FocusFacts {
    /// The human's keyboard is in this pane right now. Independent of the
    /// typing timer: looking at the pane is enough.
    pub fn human_focus_protected(&self) -> bool {
        self.pane_is_keyboard_focus && self.hyperia_foreground
    }
}

/// What the shared queue should do with a `pane_send` body.
/// This is eligibility, not a submitted or read state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputDisposition {
    /// Supported agent, not focus-protected, not mid-typing.
    /// `explicit_submit` is always true: the queue submits as its own step.
    /// Fresh PTY output does not block this (no idle-silence wait).
    Deliver { token: String, explicit_submit: bool },
    /// Supported agent, but the human is in the pane or was just typing.
    /// Hold on the shared queue. Do not write now.
    Defer { token: String, reason: String },
    /// Shell, unknown, or any non-agent foreground. Do not enqueue input.
    Refuse { reason: String },
}

/// What `msg_send` may do *in addition to* storing mail.
/// The notice is not the message body and is not a read receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoticeDisposition {
    /// A supported agent may be told without waiting for output silence.
    Arm { idle_silence_required: bool },
    /// Agent, but the human owns the pane right now.
    Suppress { reason: String },
    /// Not an agent transport. Do not type a notice here.
    Skip { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryCandidate {
    pub classification: Classification,
    pub focus_protected: bool,
    pub actively_typed: bool,
    pub pane_send: InputDisposition,
    pub notice: NoticeDisposition,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessObs {
    pub alive: bool,
    pub foreground_name: String,
    pub foreground_cmdline: String,
    /// More than one child at some level. Name and cmdline are empty.
    pub ambiguous: bool,
}

/// Live process table. Empty foreground + `alive: true` means the shell has
/// no child. `alive: false` means the pid is missing. `ambiguous` means more
/// than one child existed, so no child was selected.
struct ProcNode {
    pid: u32,
    parent: Option<u32>,
    name: String,
    cmdline: String,
}

enum ForegroundWalk {
    NoChild,
    One(u32),
    Ambiguous,
}

pub fn observe_process(shell_pid: u32) -> ProcessObs {
    if shell_pid == 0 {
        return process_obs_dead();
    }
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    observe_process_with(&sys, shell_pid)
}

pub fn observe_process_with(sys: &System, shell_pid: u32) -> ProcessObs {
    let nodes: Vec<ProcNode> = sys
        .processes()
        .iter()
        .map(|(pid, info)| ProcNode {
            pid: pid.as_u32(),
            parent: info.parent().map(|parent| parent.as_u32()),
            name: info.name().to_string_lossy().into_owned(),
            cmdline: cmdline_of(info),
        })
        .collect();
    observe_nodes(shell_pid, &nodes)
}

fn process_obs_dead() -> ProcessObs {
    ProcessObs {
        alive: false,
        foreground_name: String::new(),
        foreground_cmdline: String::new(),
        ambiguous: false,
    }
}

fn observe_nodes(root: u32, nodes: &[ProcNode]) -> ProcessObs {
    if root == 0 || !nodes.iter().any(|node| node.pid == root) {
        return process_obs_dead();
    }
    match walk_foreground(root, nodes) {
        ForegroundWalk::NoChild => ProcessObs {
            alive: true,
            foreground_name: String::new(),
            foreground_cmdline: String::new(),
            ambiguous: false,
        },
        ForegroundWalk::One(pid) => {
            let node = nodes.iter().find(|node| node.pid == pid);
            ProcessObs {
                alive: true,
                foreground_name: node.map(|node| basename_token(&node.name)).unwrap_or_default(),
                foreground_cmdline: node.map(|node| node.cmdline.clone()).unwrap_or_default(),
                ambiguous: false,
            }
        }
        ForegroundWalk::Ambiguous => ProcessObs {
            alive: true,
            foreground_name: String::new(),
            foreground_cmdline: String::new(),
            ambiguous: true,
        },
    }
}

fn walk_foreground(pid: u32, nodes: &[ProcNode]) -> ForegroundWalk {
    let mut children: Vec<u32> = nodes
        .iter()
        .filter(|node| node.parent == Some(pid))
        .map(|node| node.pid)
        .collect();
    children.sort_unstable();
    match children.len() {
        0 => ForegroundWalk::NoChild,
        1 => match walk_foreground(children[0], nodes) {
            ForegroundWalk::NoChild => ForegroundWalk::One(children[0]),
            other => other,
        },
        _ => ForegroundWalk::Ambiguous,
    }
}

fn cmdline_of(proc: &sysinfo::Process) -> String {
    proc.cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn basename_token(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let base = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    let lower = base.to_lowercase();
    lower.strip_suffix(".exe").or_else(|| lower.strip_suffix(".cmd")).or_else(|| lower.strip_suffix(".ps1")).or_else(|| lower.strip_suffix(".bat")).unwrap_or(&lower).to_string()
}

fn agent_token(token: &str) -> Option<&'static str> {
    AGENT_TOKENS.iter().copied().find(|agent| *agent == token)
}

fn is_shell_token(token: &str) -> bool {
    SHELL_TOKENS.iter().any(|shell| *shell == token)
}

/// The program that was executed, not an argument it was given.
/// Process image name wins. Argv0 is used only when that name is empty.
fn launcher_executable(name: &str, cmdline: &str) -> String {
    let from_name = basename_token(name);
    if !from_name.is_empty() {
        return from_name;
    }
    cmdline.split_whitespace().next().map(basename_token).unwrap_or_default()
}

const CONTAINER_RUNTIMES: &[&str] = &["docker", "podman", "containerd"];

/// Live launcher first. An idle integration record with no child is a
/// finished command. A container runtime that is still the foreground is
/// not: the walk only keeps the deepest process, so pwsh -> n8 -> docker
/// is reported as docker, and a prompt redraw marks the shell idle while
/// that child is alive.
fn find_agent(evidence: &ClassEvidence) -> Option<&'static str> {
    let live = launcher_executable(&evidence.foreground_name, &evidence.foreground_cmdline);
    if let Some(token) = agent_token(&live) {
        return Some(token);
    }
    let recorded = launcher_executable(&evidence.shell_app_name, &evidence.shell_app_cmdline);
    let recorded_token = agent_token(&recorded);
    if CONTAINER_RUNTIMES.iter().any(|runtime| *runtime == live)
        && matches!(recorded_token, Some("n8" | "nemesis8"))
    {
        return recorded_token;
    }
    if !evidence.shell_has_integration || integration_idle(evidence) {
        return None;
    }
    let Some(token) = recorded_token else {
        return None;
    };
    if matches!(token, "n8" | "nemesis8")
        && (live.is_empty() || CONTAINER_RUNTIMES.iter().any(|runtime| *runtime == live))
    {
        return Some(token);
    }
    // No child visible yet: the running integration record is the launcher.
    // A different live executable (`echo codex`, `vim`) is not that agent.
    if live.is_empty() {
        return Some(token);
    }
    None
}

/// App name/cmdline left behind after the command exited are not a live app.
fn recorded_app_is_live(evidence: &ClassEvidence) -> bool {
    evidence.shell_has_integration && !integration_idle(evidence)
}

fn integration_idle(evidence: &ClassEvidence) -> bool {
    evidence.shell_has_integration && evidence.shell_state.eq_ignore_ascii_case("idle")
}

fn foreign_foreground(evidence: &ClassEvidence) -> Option<String> {
    let name = launcher_executable(&evidence.foreground_name, &evidence.foreground_cmdline);
    if name.is_empty() {
        return None;
    }
    let shell = basename_token(&evidence.shell_binary);
    if !shell.is_empty() && name == shell {
        return None;
    }
    Some(name)
}

/// Active integration whose app name and argv0 name the same launcher.
/// Idle records and name/argv0 disagreements are not authoritative.
fn validated_active_launcher(evidence: &ClassEvidence) -> Option<String> {
    if !evidence.shell_has_integration {
        return None;
    }
    let state = evidence.shell_state.trim();
    if !state.eq_ignore_ascii_case("running") && !state.eq_ignore_ascii_case("busy") {
        return None;
    }
    let from_name = basename_token(&evidence.shell_app_name);
    let from_argv0 = evidence
        .shell_app_cmdline
        .split_whitespace()
        .next()
        .map(basename_token)
        .unwrap_or_default();
    match (from_name.is_empty(), from_argv0.is_empty()) {
        (true, true) => None,
        (false, true) => Some(from_name),
        (true, false) => Some(from_argv0),
        (false, false) if from_name == from_argv0 => Some(from_name),
        _ => None,
    }
}

fn classify_ambiguous(evidence: &ClassEvidence) -> Classification {
    let Some(launcher) = validated_active_launcher(evidence) else {
        return Classification {
            class: PaneClass::Unknown {
                reason: "process tree has multiple children and shell integration is not an active validated app".into(),
            },
            summary: "unknown: ambiguous process tree; refusing to pick a child as the agent or the shell prompt".into(),
        };
    };
    if let Some(token) = agent_token(&launcher) {
        return Classification {
            class: PaneClass::Agent { token: token.to_string() },
            summary: format!("agent {token}: active shell integration matches the launcher; process tree is ambiguous"),
        };
    }
    let shell = basename_token(&evidence.shell_binary);
    if is_shell_token(&shell) {
        return Classification {
            class: PaneClass::ShellBusy { foreground: launcher.clone() },
            summary: format!("shell busy: ambiguous process tree; integration launcher is {launcher}, not an agent"),
        };
    }
    Classification {
        class: PaneClass::OtherForeground { name: launcher.clone() },
        summary: format!("other foreground: ambiguous process tree; integration launcher is {launcher}"),
    }
}

pub fn classify(evidence: &ClassEvidence) -> Classification {
    if evidence.pid == 0 || !evidence.process_alive {
        return Classification {
            class: PaneClass::Unknown {
                reason: "shell pid is missing or not alive".into(),
            },
            summary: "unknown: shell pid is missing or not alive; not a prompt and not an agent"
                .into(),
        };
    }

    if evidence.process_ambiguous {
        return classify_ambiguous(evidence);
    }

    if let Some(token) = find_agent(evidence) {
        return Classification {
            class: PaneClass::Agent { token: token.to_string() },
            summary: format!("agent {token}: supported direct-input transport"),
        };
    }

    if evidence.alt_screen == Some(true) {
        return Classification {
            class: PaneClass::OtherForeground {
                name: "alt-screen".into(),
            },
            summary: "other foreground: alt-screen, not a shell prompt and not a supported agent"
                .into(),
        };
    }

    let shell = basename_token(&evidence.shell_binary);
    let known_shell = is_shell_token(&shell);

    if let Some(foreground) = foreign_foreground(evidence) {
        if known_shell {
            return Classification {
                class: PaneClass::ShellBusy {
                    foreground: foreground.clone(),
                },
                summary: format!(
                    "shell busy: {shell} has foreground {foreground}; not a supported agent"
                ),
            };
        }
        return Classification {
            class: PaneClass::OtherForeground { name: foreground.clone() },
            summary: format!("other foreground: {foreground}; not a supported agent"),
        };
    }

    if !known_shell {
        return Classification {
            class: PaneClass::Unknown {
                reason: format!("binary '{shell}' is not a known shell or supported agent"),
            },
            summary: format!(
                "unknown: '{shell}' is not a known shell or supported agent; refusing input"
            ),
        };
    }

    // Integration absent, or idle with only a stale app record, or a running
    // record that names no executable. An empty child list is not a prompt
    // by itself.
    let no_app = !recorded_app_is_live(evidence)
        || launcher_executable(&evidence.shell_app_name, &evidence.shell_app_cmdline).is_empty();
    if integration_idle(evidence) && no_app {
        return Classification {
            class: PaneClass::ShellPrompt,
            summary: format!("shell prompt: {shell} integration idle, no foreground"),
        };
    }

    if evidence.shell_has_integration {
        let foreground = if evidence.shell_state.trim().is_empty() {
            "running".to_string()
        } else {
            evidence.shell_state.clone()
        };
        return Classification {
            class: PaneClass::ShellBusy { foreground },
            summary: format!(
                "shell busy: {shell} integration state '{}'",
                evidence.shell_state
            ),
        };
    }

    Classification {
        class: PaneClass::Unknown {
            reason: "shell integration is absent and an empty process list is not a prompt".into(),
        },
        summary: "unknown: integration is absent; empty foreground is not a shell prompt".into(),
    }
}

pub fn decide(classification: Classification, focus: FocusFacts) -> DeliveryCandidate {
    let focus_protected = focus.human_focus_protected();
    let actively_typed = focus.actively_typed;
    let (pane_send, notice) = match classification.agent_token() {
        Some(token) => {
            let token = token.to_string();
            if focus_protected || actively_typed {
                let reason = match (focus_protected, actively_typed) {
                    (true, true) => "human keyboard focus and recent typing; queue the input",
                    (true, false) => "human keyboard focus; queue the input",
                    (false, true) => "human is typing in this pane; queue the input",
                    (false, false) => unreachable!(),
                };
                (
                    InputDisposition::Defer {
                        token: token.clone(),
                        reason: reason.into(),
                    },
                    NoticeDisposition::Suppress { reason: reason.into() },
                )
            } else {
                (
                    InputDisposition::Deliver {
                        token,
                        explicit_submit: true,
                    },
                    NoticeDisposition::Arm {
                        idle_silence_required: false,
                    },
                )
            }
        }
        None => {
            let reason = classification.summary.clone();
            (
                InputDisposition::Refuse { reason: reason.clone() },
                NoticeDisposition::Skip { reason },
            )
        }
    };
    DeliveryCandidate {
        classification,
        focus_protected,
        actively_typed,
        pane_send,
        notice,
    }
}

fn idle_shell(shell: &str) -> ClassEvidence {
    ClassEvidence {
        pid: 4242,
        process_alive: true,
        shell_binary: shell.into(),
        foreground_name: String::new(),
        foreground_cmdline: String::new(),
        shell_has_integration: true,
        shell_state: "idle".into(),
        shell_app_name: String::new(),
        shell_app_cmdline: String::new(),
        alt_screen: None,
        process_ambiguous: false,
    }
}

fn focus(protected: bool, typed: bool) -> FocusFacts {
    FocusFacts {
        pane_is_keyboard_focus: protected,
        hyperia_foreground: true,
        actively_typed: typed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_prompt_requires_live_integrated_idle_shell() {
        let class = classify(&idle_shell("bash"));
        assert!(class.terminal_run_allowed());
        assert!(!class.accepts_direct_input());
        assert!(matches!(class.class, PaneClass::ShellPrompt));
    }

    #[test]
    fn empty_foreground_without_integration_is_unknown() {
        let mut evidence = idle_shell("pwsh");
        evidence.shell_has_integration = false;
        let class = classify(&evidence);
        assert!(!class.terminal_run_allowed());
        assert!(matches!(class.class, PaneClass::Unknown { .. }));
        assert!(class.summary.contains("empty foreground"));
    }

    #[test]
    fn dead_pid_is_unknown_even_when_integration_says_codex() {
        let mut evidence = ClassEvidence::dead();
        evidence.shell_has_integration = true;
        evidence.shell_state = "running".into();
        evidence.shell_app_name = "codex".into();
        let class = classify(&evidence);
        assert!(matches!(class.class, PaneClass::Unknown { .. }));
        assert!(!class.accepts_direct_input());
        let decision = decide(class, focus(false, false));
        assert!(matches!(decision.pane_send, InputDisposition::Refuse { .. }));
        assert!(matches!(decision.notice, NoticeDisposition::Skip { .. }));
    }

    #[test]
    fn codex_foreground_accepts_input_without_idle_silence() {
        let mut evidence = idle_shell("bash");
        evidence.shell_has_integration = false;
        evidence.foreground_name = "codex".into();
        let class = classify(&evidence);
        assert_eq!(class.agent_token(), Some("codex"));
        let decision = decide(class, focus(false, false));
        assert!(
            matches!(
                decision.pane_send,
                InputDisposition::Deliver { ref token, explicit_submit: true } if token == "codex"
            ),
            "working unfocused agent delivers: {:?}",
            decision.pane_send
        );
        assert_eq!(
            decision.notice,
            NoticeDisposition::Arm { idle_silence_required: false }
        );
    }

    #[test]
    fn focused_agent_defers_even_when_the_typing_timer_is_clear() {
        let mut evidence = idle_shell("zsh");
        evidence.shell_app_name = "claude".into();
        evidence.shell_state = "running".into();
        let decision = decide(classify(&evidence), focus(true, false));
        assert!(decision.focus_protected);
        assert!(!decision.actively_typed);
        assert!(
            matches!(decision.pane_send, InputDisposition::Defer { ref reason, .. } if reason.contains("keyboard focus")),
            "{:?}",
            decision.pane_send
        );
        assert!(matches!(decision.notice, NoticeDisposition::Suppress { .. }));
    }

    #[test]
    fn recent_typing_defers_an_unfocused_agent() {
        let mut evidence = idle_shell("bash");
        evidence.foreground_name = "opencode".into();
        let decision = decide(classify(&evidence), focus(false, true));
        assert!(!decision.focus_protected);
        assert!(matches!(decision.pane_send, InputDisposition::Defer { .. }));
        assert!(matches!(decision.notice, NoticeDisposition::Suppress { .. }));
    }

    #[test]
    fn background_hyperia_does_not_count_as_foreground_focus() {
        let mut evidence = idle_shell("bash");
        evidence.foreground_name = "grok".into();
        let facts = FocusFacts {
            pane_is_keyboard_focus: true,
            hyperia_foreground: false,
            actively_typed: false,
        };
        let decision = decide(classify(&evidence), facts);
        assert!(!decision.focus_protected);
        assert!(matches!(decision.pane_send, InputDisposition::Deliver { .. }));
    }

    #[test]
    fn shell_and_unknown_never_receive_agent_input() {
        let prompt = decide(classify(&idle_shell("fish")), focus(false, false));
        assert!(matches!(prompt.pane_send, InputDisposition::Refuse { .. }));
        assert!(matches!(prompt.notice, NoticeDisposition::Skip { .. }));

        let mut vim = idle_shell("bash");
        vim.foreground_name = "vim".into();
        vim.shell_state = "running".into();
        let busy = decide(classify(&vim), focus(false, false));
        assert!(matches!(busy.classification.class, PaneClass::ShellBusy { .. }));
        assert!(matches!(busy.pane_send, InputDisposition::Refuse { .. }));

        let mut node = idle_shell("bash");
        node.foreground_name = "node".into();
        node.foreground_cmdline = "node server.js".into();
        let other = classify(&node);
        assert!(matches!(other.class, PaneClass::ShellBusy { .. }), "{:?}", other.class);
        assert!(other.agent_token().is_none());

        let mut pip = idle_shell("bash");
        pip.foreground_name = "pip".into();
        assert!(classify(&pip).agent_token().is_none());
    }

    #[test]
    fn n8_integration_with_docker_foreground_is_the_n8_transport() {
        let mut evidence = idle_shell("bash");
        evidence.shell_state = "running".into();
        evidence.shell_app_name = "n8".into();
        evidence.foreground_name = "docker".into();
        evidence.foreground_cmdline = "docker run --rm hyperia-n8".into();
        let class = classify(&evidence);
        assert_eq!(class.agent_token(), Some("n8"));
    }

    #[test]
    fn docker_without_n8_integration_is_not_an_agent() {
        let mut evidence = idle_shell("bash");
        evidence.foreground_name = "docker".into();
        evidence.foreground_cmdline = "docker run n8-image".into();
        evidence.shell_has_integration = false;
        assert!(classify(&evidence).agent_token().is_none());
    }

    #[test]
    fn launcher_is_argv0_or_image_name_not_a_later_argument() {
        let mut echo_codex = idle_shell("bash");
        echo_codex.foreground_name = "echo".into();
        echo_codex.foreground_cmdline = "echo codex".into();
        echo_codex.shell_state = "running".into();
        assert!(classify(&echo_codex).agent_token().is_none());

        let mut echo_path = idle_shell("bash");
        echo_path.foreground_name = String::new();
        echo_path.foreground_cmdline = "echo /usr/bin/codex --help".into();
        echo_path.shell_has_integration = false;
        assert!(classify(&echo_path).agent_token().is_none());

        let mut node_script = idle_shell("bash");
        node_script.foreground_name = "node".into();
        node_script.foreground_cmdline = "node /usr/bin/codex".into();
        assert!(classify(&node_script).agent_token().is_none(), "node is the launcher");

        let mut sh_c = idle_shell("bash");
        sh_c.foreground_name = "bash".into();
        sh_c.foreground_cmdline = "bash -c codex".into();
        assert!(classify(&sh_c).agent_token().is_none());

        let mut docker_arg = idle_shell("bash");
        docker_arg.foreground_name = "docker".into();
        docker_arg.foreground_cmdline = "docker run n8".into();
        docker_arg.shell_has_integration = false;
        assert!(classify(&docker_arg).agent_token().is_none());

        let mut near = idle_shell("bash");
        near.foreground_name = "codex-cli".into();
        assert!(classify(&near).agent_token().is_none());

        let mut real = idle_shell("bash");
        real.foreground_name = String::new();
        real.foreground_cmdline = "/usr/local/bin/codex chat".into();
        real.shell_has_integration = false;
        assert_eq!(classify(&real).agent_token(), Some("codex"));
    }

    #[test]
    fn idle_integration_app_is_stale_and_is_not_an_agent() {
        let mut stale = idle_shell("zsh");
        stale.shell_app_name = "codex".into();
        stale.shell_app_cmdline = "codex".into();
        stale.shell_state = "idle".into();
        let class = classify(&stale);
        assert!(class.agent_token().is_none());
        assert!(class.terminal_run_allowed(), "idle shell with a leftover app record is a prompt: {class:?}");

        let mut finished_n8 = idle_shell("bash");
        finished_n8.shell_app_name = "n8".into();
        finished_n8.shell_app_cmdline = "n8".into();
        assert!(classify(&finished_n8).agent_token().is_none());
        assert!(classify(&finished_n8).terminal_run_allowed());

        let mut live_docker = idle_shell("bash");
        live_docker.shell_state = "idle".into();
        live_docker.shell_app_name = "n8".into();
        live_docker.foreground_name = "docker".into();
        live_docker.foreground_cmdline = "docker run --rm hyperia-n8".into();
        assert_eq!(classify(&live_docker).agent_token(), Some("n8"));

        let mut n8_cmd = idle_shell("pwsh");
        n8_cmd.shell_app_name = "n8.cmd".into();
        n8_cmd.foreground_name = "docker.exe".into();
        n8_cmd.foreground_cmdline = "docker.exe run --rm hyperia-n8".into();
        assert_eq!(classify(&n8_cmd).agent_token(), Some("n8"));

        let mut live_child = idle_shell("zsh");
        live_child.shell_state = "idle".into();
        live_child.shell_app_name = "vim".into();
        live_child.foreground_name = "codex".into();
        assert_eq!(classify(&live_child).agent_token(), Some("codex"));
    }

    #[test]
    fn alt_screen_blocks_shell_prompt_but_not_a_named_agent() {
        let mut shell = idle_shell("zsh");
        shell.alt_screen = Some(true);
        assert!(matches!(classify(&shell).class, PaneClass::OtherForeground { .. }));

        let mut agent = idle_shell("zsh");
        agent.alt_screen = Some(true);
        agent.foreground_name = "codex".into();
        assert_eq!(classify(&agent).agent_token(), Some("codex"));
    }

    #[test]
    fn integration_running_without_a_child_is_shell_busy() {
        let mut evidence = idle_shell("bash");
        evidence.shell_state = "running".into();
        assert!(matches!(classify(&evidence).class, PaneClass::ShellBusy { .. }));
    }

    fn proc_node(pid: u32, parent: Option<u32>, name: &str, cmdline: &str) -> ProcNode {
        ProcNode {
            pid,
            parent,
            name: name.into(),
            cmdline: cmdline.into(),
        }
    }

    #[test]
    fn multiple_children_are_not_read_as_codex() {
        let nodes = vec![
            proc_node(1, None, "bash", ""),
            proc_node(2, Some(1), "echo", "echo codex"),
            proc_node(3, Some(1), "codex", "codex"),
        ];
        let obs = observe_nodes(1, &nodes);
        assert!(obs.alive);
        assert!(obs.ambiguous);
        assert!(obs.foreground_name.is_empty());
        assert_ne!(obs.foreground_name, "codex");
    }

    #[test]
    fn a_single_child_chain_is_that_leaf() {
        let nodes = vec![
            proc_node(1, None, "bash", ""),
            proc_node(2, Some(1), "codex", "/usr/bin/codex"),
        ];
        let obs = observe_nodes(1, &nodes);
        assert!(!obs.ambiguous);
        assert_eq!(obs.foreground_name, "codex");
    }

    #[test]
    fn several_grandchildren_make_the_tree_ambiguous() {
        let nodes = vec![
            proc_node(1, None, "bash", ""),
            proc_node(2, Some(1), "codex", "codex"),
            proc_node(3, Some(2), "echo", "echo"),
            proc_node(4, Some(2), "rg", "rg"),
        ];
        let obs = observe_nodes(1, &nodes);
        assert!(obs.ambiguous);
        assert!(obs.foreground_name.is_empty());
    }

    #[test]
    fn ambiguous_tree_without_validated_integration_is_unknown() {
        let mut evidence = idle_shell("bash");
        evidence.process_ambiguous = true;
        evidence.shell_has_integration = false;
        evidence.foreground_name = "codex".into();
        let class = classify(&evidence);
        assert!(matches!(class.class, PaneClass::Unknown { .. }), "{:?}", class);
        assert!(class.agent_token().is_none());
        assert!(!class.terminal_run_allowed());
        let decision = decide(class, focus(false, false));
        assert!(matches!(decision.pane_send, InputDisposition::Refuse { .. }));
    }

    #[test]
    fn ambiguous_idle_integration_is_unknown_not_a_prompt_or_agent() {
        let mut evidence = idle_shell("bash");
        evidence.process_ambiguous = true;
        evidence.shell_state = "idle".into();
        evidence.shell_app_name = "codex".into();
        evidence.shell_app_cmdline = "codex".into();
        let class = classify(&evidence);
        assert!(matches!(class.class, PaneClass::Unknown { .. }), "{:?}", class);
        assert!(class.agent_token().is_none());
        assert!(!class.terminal_run_allowed());
    }

    #[test]
    fn ambiguous_tree_uses_validated_running_integration() {
        let mut codex = idle_shell("bash");
        codex.process_ambiguous = true;
        codex.shell_state = "running".into();
        codex.shell_app_name = "codex".into();
        codex.shell_app_cmdline = "/usr/local/bin/codex chat".into();
        assert_eq!(classify(&codex).agent_token(), Some("codex"));

        let mut disagree = idle_shell("bash");
        disagree.process_ambiguous = true;
        disagree.shell_state = "running".into();
        disagree.shell_app_name = "codex".into();
        disagree.shell_app_cmdline = "echo codex".into();
        let disagreed = classify(&disagree);
        assert!(disagreed.agent_token().is_none());
        assert!(matches!(disagreed.class, PaneClass::Unknown { .. }));

        let mut echo = idle_shell("bash");
        echo.process_ambiguous = true;
        echo.shell_state = "busy".into();
        echo.shell_app_name = "echo".into();
        echo.shell_app_cmdline = "echo codex".into();
        let echoed = classify(&echo);
        assert!(echoed.agent_token().is_none());
        assert!(matches!(echoed.class, PaneClass::ShellBusy { .. }));
    }
}
