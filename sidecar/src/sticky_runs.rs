//! Sticky runs: the sidecar half of the API/safety contract
//! (plan/sticky-schedules/CONTRACT.md). Electron owns the engine; this module
//! validates runs, decides consent, holds pending approvals and reads history.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Data model (mirrors app/sticky/types.ts StickyRun)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RunWhen {
    /// Run once, immediately.
    Now,
    /// Run once at `at`.
    At,
    /// Recurring, per `every`.
    Every,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum RunEvery {
    /// Every N minutes (>= 1).
    Interval { minutes: u32 },
    /// Every day at "HH:MM", local time.
    Daily { time: String },
    /// On these weekdays (0=Sun..6=Sat) at "HH:MM", local time.
    Weekly { days: Vec<u8>, time: String },
    /// Standard 5-field cron expression, local time.
    Cron { expr: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RunTarget {
    /// Bring the sticky to the front with an OS toast. Nothing executes.
    Notify,
    /// One-shot headless nemesis8 agent.
    Agent,
    /// Send the sticky to an existing open pane (always needs human approval).
    Pane,
}

impl RunTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            RunTarget::Notify => "notify",
            RunTarget::Agent => "agent",
            RunTarget::Pane => "pane",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentImage {
    /// The only image for now; picking one is coming soon.
    #[default]
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentSpec {
    /// nemesis8 provider, e.g. "claude", "codex", "grok".
    pub provider: String,
    /// Optional model override for the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Container image. Only "default" for now.
    #[serde(default)]
    pub image: AgentImage,
    /// Host directory mounted as the agent's workspace. Required.
    pub dir: String,
    /// nemesis8 danger mode (agent runs without asking).
    #[serde(default)]
    pub danger: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PaneSpec {
    /// paneId of an open pane (terminal_status).
    pub uid: String,
    /// Display name; filled from the live pane when omitted.
    #[serde(default)]
    pub name: String,
}

pub const HISTORY_DEFAULT_LIMIT: u32 = 50;
pub const HISTORY_MAX_LIMIT: u32 = 500;

fn default_history_limit() -> u32 {
    HISTORY_DEFAULT_LIMIT
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistorySpec {
    /// Keep past results and feed them to the agent as context.
    pub keep: bool,
    /// Runs kept (1..=500, default 50).
    #[serde(default = "default_history_limit")]
    pub limit: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Approved {
    /// Epoch ms of the human approval.
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StickyRun {
    pub when: RunWhen,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<RunEvery>,
    pub target: RunTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane: Option<PaneSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<HistorySpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<Approved>,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn two_digits(s: &str, max: u32) -> Option<u32> {
    if s.len() != 2 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u32>().ok().filter(|v| *v <= max)
}

/// "HH:MM", 24-hour.
pub fn valid_hhmm(s: &str) -> bool {
    let Some((h, m)) = s.split_once(':') else { return false };
    two_digits(h, 23).is_some() && two_digits(m, 59).is_some()
}

/// ISO 8601 date-time: `YYYY-MM-DDTHH:MM[:SS[.frac]][Z|±HH:MM]` (space allowed for T).
pub fn valid_iso8601(s: &str) -> bool {
    let s = s.trim();
    let Some((date, time)) = s.split_once(['T', 't', ' ']) else { return false };
    let d: Vec<&str> = date.split('-').collect();
    if d.len() != 3 || d[0].len() != 4 || !d[0].bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match (two_digits(d[1], 12), two_digits(d[2], 31)) {
        (Some(mo), Some(day)) if mo >= 1 && day >= 1 => {}
        _ => return false,
    }
    // Split off a zone suffix.
    let (clock, zone) = if let Some(c) = time.strip_suffix(['Z', 'z']) {
        (c, None)
    } else if let Some(i) = time.rfind(['+', '-']) {
        (&time[..i], Some(&time[i + 1..]))
    } else {
        (time, None)
    };
    if let Some(z) = zone {
        if !valid_hhmm(z) {
            return false;
        }
    }
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return false;
    }
    if two_digits(parts[0], 23).is_none() || two_digits(parts[1], 59).is_none() {
        return false;
    }
    if let Some(sec) = parts.get(2) {
        let (whole, frac) = sec.split_once('.').unwrap_or((sec, "0"));
        if two_digits(whole, 60).is_none() || frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    true
}

/// Structural 5-field check. The engine's real parser is the authority.
pub fn valid_cron_shape(expr: &str) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    fields.len() == 5
        && fields
            .iter()
            .all(|f| f.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '*' | ',' | '-' | '/' | '?')))
}

/// Validate a run's shape. Pane existence is checked by the caller (needs live sessions).
pub fn validate(run: &StickyRun) -> Result<(), String> {
    match run.when {
        RunWhen::Now => {
            if run.at.is_some() || run.every.is_some() {
                return Err("when='now' takes no 'at' or 'every'".into());
            }
        }
        RunWhen::At => {
            let at = run.at.as_deref().unwrap_or("").trim();
            if at.is_empty() {
                return Err("when='at' requires 'at' (ISO 8601, e.g. 2026-10-01T08:00)".into());
            }
            if !valid_iso8601(at) {
                return Err(format!("'at' is not an ISO 8601 date-time: {at:?}"));
            }
            if run.every.is_some() {
                return Err("when='at' takes no 'every'".into());
            }
        }
        RunWhen::Every => {
            let Some(every) = &run.every else {
                return Err("when='every' requires 'every' ({kind: interval|daily|weekly|cron, ...})".into());
            };
            if run.at.is_some() {
                return Err("when='every' takes no 'at'".into());
            }
            match every {
                RunEvery::Interval { minutes } => {
                    if !(1..=525_600).contains(minutes) {
                        return Err("every.minutes must be between 1 and 525600".into());
                    }
                }
                RunEvery::Daily { time } => {
                    if !valid_hhmm(time) {
                        return Err(format!("every.time must be \"HH:MM\" (24h), got {time:?}"));
                    }
                }
                RunEvery::Weekly { days, time } => {
                    if days.is_empty() {
                        return Err("every.days must list at least one weekday (0=Sun..6=Sat)".into());
                    }
                    if let Some(d) = days.iter().find(|d| **d > 6) {
                        return Err(format!("every.days has {d}; weekdays are 0=Sun..6=Sat"));
                    }
                    let mut seen = [false; 7];
                    for d in days {
                        if std::mem::replace(&mut seen[*d as usize], true) {
                            return Err(format!("every.days lists {d} twice"));
                        }
                    }
                    if !valid_hhmm(time) {
                        return Err(format!("every.time must be \"HH:MM\" (24h), got {time:?}"));
                    }
                }
                RunEvery::Cron { expr } => {
                    if !valid_cron_shape(expr) {
                        return Err(format!("every.expr must be a 5-field cron expression, got {expr:?}"));
                    }
                }
            }
        }
    }
    match run.target {
        RunTarget::Notify => {
            if run.agent.is_some() || run.pane.is_some() {
                return Err("target='notify' takes no 'agent' or 'pane'".into());
            }
        }
        RunTarget::Agent => {
            let Some(agent) = &run.agent else {
                return Err("target='agent' requires 'agent' {provider, dir, danger?, model?}".into());
            };
            let p = agent.provider.trim();
            if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
                return Err(format!("agent.provider must be a provider name like \"claude\", got {:?}", agent.provider));
            }
            if agent.dir.trim().is_empty() {
                return Err("agent.dir is required: the folder mounted as the agent's workspace".into());
            }
            if run.pane.is_some() {
                return Err("target='agent' takes no 'pane'".into());
            }
        }
        RunTarget::Pane => {
            let Some(pane) = &run.pane else {
                return Err("target='pane' requires 'pane' {uid}".into());
            };
            if pane.uid.trim().is_empty() {
                return Err("pane.uid is required (a paneId from terminal_status)".into());
            }
            if run.agent.is_some() {
                return Err("target='pane' takes no 'agent'".into());
            }
        }
    }
    if let Some(h) = &run.history {
        if !(1..=HISTORY_MAX_LIMIT).contains(&h.limit) {
            return Err(format!("history.limit must be between 1 and {HISTORY_MAX_LIMIT}"));
        }
    }
    Ok(())
}

/// Parse and validate a POST body into a run, with a readable error.
pub fn parse_run(body: &serde_json::Value) -> Result<StickyRun, String> {
    let run: StickyRun = serde_json::from_value(body.clone()).map_err(|e| format!("invalid run: {e}"))?;
    validate(&run)?;
    Ok(run)
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/// PermStore action for a run awaiting human approval.
pub const APPROVAL_ACTION: &str = crate::perms::STICKY_RUN_ACTION;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerKind {
    /// The human, via UI or a System-token caller.
    Human,
    /// Any agent or pane token.
    Agent,
}

/// Pane targets always need approval; agent-created runs always need approval.
pub fn needs_approval(caller: CallerKind, target: RunTarget) -> bool {
    caller == CallerKind::Agent || target == RunTarget::Pane
}

/// The `created_by` principal: "human" for System, else the ledger key.
pub fn created_by_for(principal_key: &str, is_system: bool) -> String {
    if is_system { "human".into() } else { principal_key.to_string() }
}

/// First line of the prompt, bounded for a consent sentence.
pub fn excerpt(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() > max {
        line.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

const DAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Human phrase for When: "now", "at …", "daily at 08:00", "every 2 h".
pub fn describe_when(run: &StickyRun) -> String {
    match run.when {
        RunWhen::Now => "now".into(),
        RunWhen::At => format!("at {}", run.at.as_deref().unwrap_or("?")),
        RunWhen::Every => match &run.every {
            Some(RunEvery::Interval { minutes }) if minutes % 60 == 0 => format!("every {} h", minutes / 60),
            Some(RunEvery::Interval { minutes }) => format!("every {minutes} min"),
            Some(RunEvery::Daily { time }) => format!("daily at {time}"),
            Some(RunEvery::Weekly { days, time }) => {
                let names: Vec<&str> = days.iter().filter_map(|d| DAY_NAMES.get(*d as usize).copied()).collect();
                format!("every {} at {time}", names.join(", "))
            }
            Some(RunEvery::Cron { expr }) => format!("on cron '{expr}'"),
            None => "on a schedule".into(),
        },
    }
}

fn provider_display(p: &str) -> String {
    let mut c = p.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The sentence shown on the approval prompt.
pub fn approval_text(caller: CallerKind, who: &str, note_name: &str, prompt: &str, run: &StickyRun) -> String {
    let when = describe_when(run);
    let ex = excerpt(prompt, 60);
    match run.target {
        RunTarget::Pane => {
            let pane = run.pane.as_ref().map(|p| p.name.as_str()).unwrap_or("?");
            if caller == CallerKind::Human {
                format!("Send sticky '{note_name}' to {pane} {when}?")
            } else {
                format!("{who} wants to send sticky '{note_name}' ('{ex}') to {pane} {when}")
            }
        }
        RunTarget::Agent => {
            let a = run.agent.as_ref();
            let provider = a.map(|a| provider_display(&a.provider)).unwrap_or_default();
            let dir = a.map(|a| a.dir.as_str()).unwrap_or("?");
            let danger = if a.is_some_and(|a| a.danger) { " (danger)" } else { "" };
            format!("{who} wants {provider} to run '{ex}' {when} in {dir}{danger}")
        }
        RunTarget::Notify => format!("{who} wants sticky '{note_name}' to notify you {when}"),
    }
}

// ---------------------------------------------------------------------------
// Pending approvals (note id -> the run awaiting a human)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PendingRun {
    pub perm_id: String,
    pub run: StickyRun,
}

static PENDING: LazyLock<Mutex<HashMap<String, PendingRun>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Park a run for approval; returns a superseded perm id, if any.
pub fn park(note_id: &str, perm_id: &str, run: StickyRun) -> Option<String> {
    let mut m = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    m.insert(note_id.to_string(), PendingRun { perm_id: perm_id.to_string(), run })
        .map(|old| old.perm_id)
}

/// Take the run parked under this perm id (stale ids resolve to None).
pub fn take_by_perm(perm_id: &str) -> Option<(String, StickyRun)> {
    let mut m = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let note = m.iter().find(|(_, p)| p.perm_id == perm_id).map(|(k, _)| k.clone())?;
    m.remove(&note).map(|p| (note, p.run))
}

/// Drop any parked run for a note (clear / re-post); returns its perm id.
pub fn drop_for_note(note_id: &str) -> Option<String> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).remove(note_id).map(|p| p.perm_id)
}

// ---------------------------------------------------------------------------
// Note checks: the lock and the first-touch grant
// ---------------------------------------------------------------------------

fn run_obj(note: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    note.get("run").and_then(|r| r.as_object())
}

/// An armed (set, not paused) run locks the prompt.
pub fn prompt_locked(note: &serde_json::Value) -> bool {
    run_obj(note).is_some_and(|r| r.get("paused").and_then(|p| p.as_bool()) != Some(true))
}

pub const LOCK_MESSAGE: &str = "Pause or unschedule this sticky before editing its prompt";

/// The server-side lock: a changed prompt on an armed run is refused (409)
/// for every caller but System. `result` is never locked.
pub fn check_prompt_edit(note: &serde_json::Value, new_text: Option<&str>, is_system: bool) -> Result<(), &'static str> {
    let Some(t) = new_text else { return Ok(()) };
    if is_system || !prompt_locked(note) || note["text"].as_str().unwrap_or("") == t {
        return Ok(());
    }
    Err(LOCK_MESSAGE)
}

/// A nemesis8 agent may touch this note without a prompt while its approved
/// agent/pane run is in flight. Scoped to one note and one request.
pub fn first_touch_grant(principal_key: &str, note: &serde_json::Value) -> bool {
    if !principal_key.starts_with("agent:nemesis8/") {
        return false;
    }
    let Some(run) = run_obj(note) else { return false };
    let approved = run.get("approved").is_some_and(|a| a.is_object());
    let target_ok = matches!(run.get("target").and_then(|t| t.as_str()), Some("agent" | "pane"));
    let running = note.pointer("/run_state/last_status").and_then(|s| s.as_str()) == Some("running");
    approved && target_ok && running
}

// ---------------------------------------------------------------------------
// Paths and history
// ---------------------------------------------------------------------------

pub fn stickys_dir() -> Option<PathBuf> {
    let home = if cfg!(windows) { std::env::var("USERPROFILE").ok() } else { std::env::var("HOME").ok() }?;
    Some(PathBuf::from(home).join(".hyperia").join("stickys"))
}

pub fn notes_path() -> Option<PathBuf> {
    stickys_dir().map(|d| d.join("notes.json"))
}

pub fn runs_path() -> Option<PathBuf> {
    stickys_dir().map(|d| d.join("runs.jsonl"))
}

/// Read notes.json. Missing file is an empty list; a torn/invalid file is an error.
pub fn load_notes() -> Result<Vec<serde_json::Value>, String> {
    let path = notes_path().ok_or("No home directory")?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("notes.json unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// History records for one note from runs.jsonl text, newest first.
pub fn filter_history(content: &str, note_id: &str, limit: usize) -> Vec<serde_json::Value> {
    let mut rows: Vec<(usize, serde_json::Value)> = content
        .lines()
        .enumerate()
        .filter_map(|(i, l)| serde_json::from_str::<serde_json::Value>(l.trim()).ok().map(|v| (i, v)))
        .filter(|(_, v)| v["note"].as_str() == Some(note_id))
        .collect();
    // Newest `started` first; file order breaks ties (later line = newer).
    rows.sort_by(|(ia, a), (ib, b)| {
        let sa = a["started"].as_u64().unwrap_or(0);
        let sb = b["started"].as_u64().unwrap_or(0);
        sb.cmp(&sa).then(ib.cmp(ia))
    });
    rows.into_iter().take(limit).map(|(_, v)| v).collect()
}

pub fn read_history(note_id: &str, limit: usize) -> Vec<serde_json::Value> {
    let content = runs_path().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    filter_history(&content, note_id, limit)
}

/// Cap on a result written through PATCH.
pub const RESULT_MAX_BYTES: usize = 256 * 1024;

/// Map Electron's reply to (status, body). "ok" and `{ok:true,...}` pass;
/// `{ok:false,error}` is a 400; any other text (e.g. "Unknown command") is a 502.
pub fn parse_engine_reply(r: Result<String, String>) -> Result<serde_json::Value, (u16, serde_json::Value)> {
    let s = match r {
        Ok(s) => s,
        Err(e) => return Err((503, serde_json::json!({"ok": false, "error": e}))),
    };
    let t = s.trim();
    if t == "ok" {
        return Ok(serde_json::json!({"ok": true}));
    }
    match serde_json::from_str::<serde_json::Value>(t) {
        Ok(v) if v.is_object() && v["ok"].as_bool() == Some(false) => Err((400, v)),
        Ok(v) if v.is_object() => Ok(v),
        _ if t.eq_ignore_ascii_case("note not found") => Err((404, serde_json::json!({"ok": false, "error": t}))),
        _ => Err((502, serde_json::json!({"ok": false, "error": t}))),
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(v: serde_json::Value) -> Result<StickyRun, String> {
        parse_run(&v)
    }

    #[test]
    fn valid_runs_parse() {
        assert!(run(json!({"when":"now","target":"notify"})).is_ok());
        assert!(run(json!({"when":"at","at":"2026-10-01T08:00","target":"notify"})).is_ok());
        assert!(run(json!({"when":"at","at":"2026-10-01T08:00:30.5+09:00","target":"notify"})).is_ok());
        assert!(run(json!({"when":"every","every":{"kind":"daily","time":"08:00"},
            "target":"agent","agent":{"provider":"claude","dir":"/work","danger":true},
            "history":{"keep":true,"limit":7}})).is_ok());
        assert!(run(json!({"when":"every","every":{"kind":"weekly","days":[1,3,5],"time":"09:30"},
            "target":"pane","pane":{"uid":"abc"}})).is_ok());
        assert!(run(json!({"when":"every","every":{"kind":"cron","expr":"0 9 * * 1-5"},"target":"notify"})).is_ok());
        let r = run(json!({"when":"every","every":{"kind":"interval","minutes":15},"target":"notify","history":{"keep":false}})).unwrap();
        assert_eq!(r.history.unwrap().limit, HISTORY_DEFAULT_LIMIT);
    }

    #[test]
    fn invalid_runs_are_rejected_with_reasons() {
        let bad = [
            (json!({"when":"soon","target":"notify"}), "unknown variant"),
            (json!({"when":"now","target":"shell"}), "unknown variant"),
            (json!({"when":"at","target":"notify"}), "requires 'at'"),
            (json!({"when":"at","at":"tomorrow","target":"notify"}), "ISO 8601"),
            (json!({"when":"at","at":"2026-13-01T08:00","target":"notify"}), "ISO 8601"),
            (json!({"when":"every","target":"notify"}), "requires 'every'"),
            (json!({"when":"every","every":{"kind":"interval","minutes":0},"target":"notify"}), "minutes"),
            (json!({"when":"every","every":{"kind":"daily","time":"8:00"},"target":"notify"}), "HH:MM"),
            (json!({"when":"every","every":{"kind":"daily","time":"24:00"},"target":"notify"}), "HH:MM"),
            (json!({"when":"every","every":{"kind":"weekly","days":[],"time":"08:00"},"target":"notify"}), "at least one"),
            (json!({"when":"every","every":{"kind":"weekly","days":[7],"time":"08:00"},"target":"notify"}), "0=Sun"),
            (json!({"when":"every","every":{"kind":"weekly","days":[1,1],"time":"08:00"},"target":"notify"}), "twice"),
            (json!({"when":"every","every":{"kind":"cron","expr":"* * *"},"target":"notify"}), "5-field"),
            (json!({"when":"every","every":{"kind":"hourly"},"target":"notify"}), "unknown variant"),
            (json!({"when":"now","target":"agent"}), "requires 'agent'"),
            (json!({"when":"now","target":"agent","agent":{"provider":"claude","dir":"  "}}), "agent.dir"),
            (json!({"when":"now","target":"agent","agent":{"provider":"rm -rf","dir":"/w"}}), "provider"),
            (json!({"when":"now","target":"agent","agent":{"provider":"claude","dir":"/w","image":"evil"}}), "unknown variant"),
            (json!({"when":"now","target":"pane"}), "requires 'pane'"),
            (json!({"when":"now","target":"pane","pane":{"uid":""}}), "pane.uid"),
            (json!({"when":"now","target":"notify","pane":{"uid":"x"}}), "takes no"),
            (json!({"when":"now","target":"notify","history":{"keep":true,"limit":0}}), "history.limit"),
            (json!({"when":"now","target":"notify","history":{"keep":true,"limit":501}}), "history.limit"),
            (json!({"when":"now","target":"notify","runner":"shell"}), "unknown field"),
            (json!({"when":"now","at":"2026-10-01T08:00","target":"notify"}), "takes no"),
        ];
        for (body, want) in bad {
            let err = run(body.clone()).expect_err(&format!("accepted {body}"));
            assert!(err.contains(want), "{body} -> {err:?}, wanted {want:?}");
        }
    }

    #[test]
    fn consent_matrix() {
        use CallerKind as C;
        use RunTarget as T;
        assert!(!needs_approval(C::Human, T::Notify));
        assert!(!needs_approval(C::Human, T::Agent));
        assert!(needs_approval(C::Human, T::Pane));
        assert!(needs_approval(C::Agent, T::Notify));
        assert!(needs_approval(C::Agent, T::Agent));
        assert!(needs_approval(C::Agent, T::Pane));
        assert_eq!(created_by_for("system", true), "human");
        assert_eq!(created_by_for("agent:latin-flea", false), "agent:latin-flea");
        assert_eq!(created_by_for("pane:abc", false), "pane:abc");
    }

    #[test]
    fn approval_sentences_read_naturally() {
        let pane = run(json!({"when":"every","every":{"kind":"daily","time":"08:00"},
            "target":"pane","pane":{"uid":"u","name":"Naval Tern"}})).unwrap();
        assert_eq!(
            approval_text(CallerKind::Human, "Hyperia", "Weather Tokyo", "weather in Tokyo", &pane),
            "Send sticky 'Weather Tokyo' to Naval Tern daily at 08:00?"
        );
        let agent = run(json!({"when":"every","every":{"kind":"daily","time":"08:00"},
            "target":"agent","agent":{"provider":"claude","dir":"~/Code","danger":true}})).unwrap();
        assert_eq!(
            approval_text(CallerKind::Agent, "Latin Flea", "Weather Tokyo", "weather in Tokyo\nmore", &agent),
            "Latin Flea wants Claude to run 'weather in Tokyo' daily at 08:00 in ~/Code (danger)"
        );
        assert!(approval_text(CallerKind::Agent, "Latin Flea", "W", "p", &pane).starts_with("Latin Flea wants to send sticky 'W'"));
    }

    #[test]
    fn lock_applies_only_to_armed_runs() {
        assert!(!prompt_locked(&json!({"id":"n"})));
        assert!(!prompt_locked(&json!({"id":"n","run":null})));
        assert!(prompt_locked(&json!({"id":"n","run":{"when":"now","target":"notify"}})));
        assert!(prompt_locked(&json!({"id":"n","run":{"when":"now","target":"notify","paused":false}})));
        assert!(!prompt_locked(&json!({"id":"n","run":{"when":"now","target":"notify","paused":true}})));
    }

    #[test]
    fn locked_prompt_rejects_edits_but_not_results() {
        let armed = json!({"id":"n","text":"weather in Tokyo","run":{"when":"now","target":"notify"}});
        // A changed prompt from any non-System caller -> 409 message.
        assert_eq!(check_prompt_edit(&armed, Some("rm -rf /"), false), Err(LOCK_MESSAGE));
        // System (the engine/human UI) may edit.
        assert!(check_prompt_edit(&armed, Some("rm -rf /"), true).is_ok());
        // Result-only patches and unchanged text pass.
        assert!(check_prompt_edit(&armed, None, false).is_ok());
        assert!(check_prompt_edit(&armed, Some("weather in Tokyo"), false).is_ok());
        // Human-made notes are locked too (no creator field).
        let paused = json!({"id":"n","text":"a","run":{"when":"now","target":"notify","paused":true}});
        assert!(check_prompt_edit(&paused, Some("b"), false).is_ok());
        assert!(check_prompt_edit(&json!({"id":"n","text":"a"}), Some("b"), false).is_ok());
    }

    #[test]
    fn first_touch_grant_needs_every_condition() {
        let ok = json!({"run":{"target":"agent","approved":{"at":1}},"run_state":{"last_status":"running"}});
        assert!(first_touch_grant("agent:nemesis8/n8-urchin", &ok));
        let pane = json!({"run":{"target":"pane","approved":{"at":1}},"run_state":{"last_status":"running"}});
        assert!(first_touch_grant("agent:nemesis8/x", &pane));
        // wrong caller
        assert!(!first_touch_grant("agent:latin-flea", &ok));
        assert!(!first_touch_grant("pane:nemesis8/x", &ok));
        // not approved
        assert!(!first_touch_grant("agent:nemesis8/x",
            &json!({"run":{"target":"agent"},"run_state":{"last_status":"running"}})));
        // notify target
        assert!(!first_touch_grant("agent:nemesis8/x",
            &json!({"run":{"target":"notify","approved":{"at":1}},"run_state":{"last_status":"running"}})));
        // not in flight
        for st in ["ok", "failed", "awaiting_approval"] {
            assert!(!first_touch_grant("agent:nemesis8/x",
                &json!({"run":{"target":"agent","approved":{"at":1}},"run_state":{"last_status":st}})));
        }
        assert!(!first_touch_grant("agent:nemesis8/x", &json!({"run":{"target":"agent","approved":{"at":1}}})));
    }

    #[test]
    fn history_filters_by_note_newest_first() {
        let content = [
            r#"{"note":"a","run_id":"1","started":100,"status":"ok"}"#,
            r#"{"note":"b","run_id":"2","started":200,"status":"ok"}"#,
            "not json",
            "",
            r#"{"note":"a","run_id":"3","started":300,"status":"failed"}"#,
            r#"{"note":"a","run_id":"4","started":200,"status":"ok"}"#,
        ]
        .join("\n");
        let ids = |v: Vec<serde_json::Value>| v.iter().map(|r| r["run_id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(ids(filter_history(&content, "a", 50)), ["3", "4", "1"]);
        assert_eq!(ids(filter_history(&content, "a", 2)), ["3", "4"]);
        assert_eq!(ids(filter_history(&content, "b", 50)), ["2"]);
        assert!(filter_history(&content, "zzz", 50).is_empty());
    }

    #[test]
    fn engine_replies_map_to_statuses() {
        assert_eq!(parse_engine_reply(Ok("ok".into())).unwrap(), json!({"ok":true}));
        let v = parse_engine_reply(Ok(r#"{"ok":true,"next_run":5,"status":"armed"}"#.into())).unwrap();
        assert_eq!(v["next_run"], 5);
        assert_eq!(parse_engine_reply(Ok(r#"{"ok":false,"error":"bad cron"}"#.into())).unwrap_err().0, 400);
        assert_eq!(parse_engine_reply(Ok("Note not found".into())).unwrap_err().0, 404);
        assert_eq!(parse_engine_reply(Ok("Unknown command: NoteRun".into())).unwrap_err().0, 502);
        assert_eq!(parse_engine_reply(Err("No Electron client connected".into())).unwrap_err().0, 503);
    }

    #[test]
    fn pending_park_take_and_supersede() {
        let r = run(json!({"when":"now","target":"notify"})).unwrap();
        assert_eq!(park("note-t1", "perm-1", r.clone()), None);
        assert_eq!(park("note-t1", "perm-2", r.clone()).as_deref(), Some("perm-1"));
        assert!(take_by_perm("perm-1").is_none(), "superseded id is stale");
        assert_eq!(take_by_perm("perm-2").map(|(n, _)| n).as_deref(), Some("note-t1"));
        park("note-t2", "perm-3", r);
        assert_eq!(drop_for_note("note-t2").as_deref(), Some("perm-3"));
        assert!(take_by_perm("perm-3").is_none());
    }
}
