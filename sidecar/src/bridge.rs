use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::screen::ScreenBuffer;
use crate::AppState;

// ---------------------------------------------------------------------------
// Session info tracked per Electron PTY session
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ShellAppInfo {
    pub name: String,
    pub path: String,
    pub cmdline: String,
    pub pid: u32,
}

pub struct SessionInfo {
    pub name: String,
    /// Friendly, layout-stable pane name (e.g. "Suspicious Marlin 🧄"),
    /// generated per-pane in the renderer and pushed via `SessionName`.
    /// Distinct from `name` (the shell binary path) and `title` (overloaded
    /// with OSC/custom titles). This is the stable human handle for a pane.
    pub shell_name: String,
    pub tab_name: String,
    pub description: String,
    pub rows: u16,
    pub cols: u16,
    pub pid: u32,
    pub root_tab_uid: String,
    pub window_id: u32,
    pub split_label: String,
    pub tab_order: u32,
    pub tab_active: bool,
    pub pane_active: bool,
    pub screen: ScreenBuffer,
    /// BSP bounding box in 0–100 percentage units
    pub bsp_x: f32,
    pub bsp_y: f32,
    pub bsp_w: f32,
    pub bsp_h: f32,
    pub cwd: String,
    pub last_user_activity: Option<std::time::Instant>,
    pub title: String,
    pub shell_state: String,
    pub shell_app: Option<ShellAppInfo>,
    pub shell_last_exit: Option<i32>,
    pub shell_has_integration: bool,
}

/// Match a pane's friendly `name` (e.g. "Suspicious Marlin 🧄") against an
/// agent-supplied target. Case-insensitive and tolerant of a missing trailing
/// emoji / whitespace, so "suspicious marlin" resolves the same pane. An empty
/// target never matches (so it can't accidentally hit an unnamed pane).
fn name_matches(name: &str, target: &str) -> bool {
    if target.trim().is_empty() {
        return false;
    }
    let norm =
        |s: &str| s.trim().trim_end_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    norm(name) == norm(target)
}

// ---------------------------------------------------------------------------
// Bridge: shared state between WebSocket handler, chat.rs, and mcp.rs
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Bridge {
    inner: Arc<BridgeInner>,
}

/// An agent's keystroke payload held while the human decides on a consent
/// prompt. Flushed to the target pane on approval, dropped on denial.
#[derive(Clone)]
struct HeldAction {
    #[allow(dead_code)]
    requester: String,
    keys: String,
}

/// A capped, edge-triggered self-poke an agent armed for its OWN pane: when the
/// pane next goes running->idle, deliver `keys` to it. Can't run away — it fires
/// once per running->idle edge, at most `max_fires` times, and expires (<=1h).
#[derive(Clone)]
struct IdleCallback {
    #[allow(dead_code)]
    id: String,
    pane: String,
    keys: String,
    expires_at: std::time::Instant,
    max_fires: u32,
    fires: u32,
    running_seen: bool,
    #[allow(dead_code)]
    creator: String,
}

/// Wall-clock seconds since the unix epoch (for persisted pulse timing).
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// serde default for `Pulse.submit` (older persisted pulses had no field → submit).
fn default_true() -> bool {
    true
}

/// A recurring prompt the sidecar re-injects into a pane on an interval — the
/// pane "pulse" watchdog. idle_only fires only when the pane looks idle/stalled;
/// otherwise it fires every interval (skipping human/dialog/working). Capped to
/// a max lifetime (<=1h) and optional max_fires. Persisted to disk and addressed
/// by window+tab so it survives pane/agent restarts and a Hyperia restart.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Pulse {
    id: String,
    window: u32,
    tab: String,
    target_label: String,
    /// Last resolved pane uid — re-bound each tick from window+tab. Not authoritative
    /// (a restart gives a new uid); recomputed, so default empty when loaded.
    #[serde(default)]
    pane: String,
    keys: String,
    interval_secs: u64,
    idle_only: bool,
    /// Whether to press Enter after typing (submit). false = type only, for review.
    #[serde(default = "default_true")]
    submit: bool,
    created_at_unix: u64,
    expires_at_unix: u64,
    max_fires: Option<u32>,
    fires: u32,
    paused: bool,
    last_fire_unix: u64,
    creator: String,
}

/// Where pulses persist (~/.hyperia/pulse/configs.json).
fn pulse_store_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("pulse")
        .join("configs.json")
}

/// Load persisted pulses, dropping any already past their lifetime (never resurrect
/// an expired pulse). The cached uid is cleared — re-resolved on the first tick.
fn load_pulses() -> Vec<Pulse> {
    let txt = match std::fs::read_to_string(pulse_store_path()) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut v: Vec<Pulse> = serde_json::from_str(&txt).unwrap_or_default();
    let now = now_unix();
    v.retain(|p| now < p.expires_at_unix);
    for p in v.iter_mut() {
        p.pane = String::new();
    }
    v
}

struct BridgeInner {
    /// Channel to send JSON messages downstream to Electron
    cmd_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// Pending request→response: seq → oneshot sender
    pending: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    /// Monotonic sequence counter
    seq: AtomicU64,
    /// Registered PTY sessions (uid → info)
    sessions: Mutex<HashMap<String, SessionInfo>>,
    /// Last focused Hyperia window id.
    focused_window_id: Mutex<Option<u32>>,
    /// Whether a Hyperia window is the OS-foreground app (false → the human is in
    /// another app, e.g. Chrome). Set from the renderer's AppFocus messages.
    app_foreground: Mutex<bool>,
    /// Keystrokes an agent tried to send to a pane it doesn't own yet, held while
    /// the human decides. Flushed on approval, dropped on denial. Key = target uid.
    held_actions: Mutex<HashMap<String, HeldAction>>,
    /// Capped, edge-triggered self idle-callbacks: when a pane goes running->idle,
    /// deliver the stored keys to it. Watched + fired by the idle-monitor task.
    idle_callbacks: Mutex<Vec<IdleCallback>>,
    /// Self-reported liveness: pane uid -> busy-until instant. A fresh entry means
    /// the agent (or its in-container monitor, e.g. nemesis8) says it's working —
    /// this OVERRIDES the screen heuristic and suppresses pokes. Lapses on TTL.
    liveness: Mutex<HashMap<String, std::time::Instant>>,
    /// Recurring pane pulses (the watchdog): re-inject a prompt on an interval,
    /// idle-gated or fixed. Watched + fired by the idle-monitor task.
    pulses: Mutex<Vec<Pulse>>,
    /// Per-session output subscribers: uid → list of senders waiting for PTY bytes
    output_subs: Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
    /// Lume-backed per-shell log store (BM25 search + pickle-to-disk).
    lume: crate::lume_store::LumeStore,
    /// Cross-pane access consent ledger (pending prompts + active grants).
    perms: crate::perms::PermStore,
    /// Persistent external-agent identities (file-backed, survive restarts).
    identity: crate::identity::IdentityStore,
    /// OS pixel bounds per window id (from the renderer): {width,height,x,y}.
    /// Lets terminal_status report real window size + resize relative to it.
    window_bounds: Mutex<HashMap<u32, serde_json::Value>>,
    /// Agent TOKENS that bypass consent (Hyperia's OWN built-in agent — the
    /// ghost). Trust is by token, never by name (names are spoofable). The
    /// user configured this agent deliberately; prompting them to approve its
    /// every pane action is asking permission for the thing they just asked
    /// it to do. Populated at startup with the freshly-minted ghost token.
    trusted_agent_tokens: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(BridgeInner {
                cmd_tx: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                seq: AtomicU64::new(1),
                sessions: Mutex::new(HashMap::new()),
                focused_window_id: Mutex::new(None),
                app_foreground: Mutex::new(true),
                held_actions: Mutex::new(HashMap::new()),
                idle_callbacks: Mutex::new(Vec::new()),
                liveness: Mutex::new(HashMap::new()),
                pulses: Mutex::new(load_pulses()),
                output_subs: Mutex::new(HashMap::new()),
                lume: crate::lume_store::LumeStore::new(),
                perms: crate::perms::PermStore::default(),
                identity: crate::identity::IdentityStore::new(),
                window_bounds: Mutex::new(HashMap::new()),
                trusted_agent_tokens: std::sync::Mutex::new(std::collections::HashSet::new()),
            }),
        }
    }

    /// Mark an agent TOKEN as consent-exempt (Hyperia's own built-in agent).
    pub fn trust_agent_token(&self, token: &str) {
        if token.is_empty() {
            return;
        }
        if let Ok(mut set) = self.inner.trusted_agent_tokens.lock() {
            set.insert(token.to_string());
        }
    }

    /// Is this caller a consent-exempt trusted agent (by token, never by name)?
    fn is_trusted_agent(&self, id: &crate::identity::CallerIdentity) -> bool {
        if let crate::identity::CallerIdentity::Agent { token, .. } = id {
            return self
                .inner
                .trusted_agent_tokens
                .lock()
                .map(|s| s.contains(token))
                .unwrap_or(false);
        }
        false
    }

    /// Access the lume store (per-shell log search, sticky search, persistence).
    pub fn lume(&self) -> crate::lume_store::LumeStore {
        self.inner.lume.clone()
    }

    /// Access the cross-pane permission ledger.
    pub fn perms(&self) -> &crate::perms::PermStore {
        &self.inner.perms
    }

    /// Access the persistent agent-identity store.
    pub fn identity(&self) -> &crate::identity::IdentityStore {
        &self.inner.identity
    }

    /// Resolve an `Authorization: Bearer` token to a caller identity. Checks
    /// persistent agent tokens first, then ephemeral pane tokens, else anonymous.
    pub async fn resolve_caller(&self, bearer: Option<&str>) -> crate::identity::CallerIdentity {
        use crate::identity::CallerIdentity;
        let token = match bearer {
            Some(t) if !t.trim().is_empty() => t.trim(),
            _ => return CallerIdentity::Anonymous,
        };
        if self.inner.identity.is_system(token) {
            return CallerIdentity::System;
        }
        if let Some(rec) = self.inner.identity.resolve(token).await {
            return CallerIdentity::Agent { name: rec.name, token: rec.token };
        }
        if let Some(pane) = self.inner.perms.pane_for_token(token).await {
            return CallerIdentity::Pane { pane, token: token.to_string() };
        }
        CallerIdentity::Anonymous
    }

    /// Tab uid (root_tab_uid) a pane belongs to, if registered.
    pub async fn tab_of(&self, pane: &str) -> Option<String> {
        self.inner.sessions.lock().await.get(pane).map(|s| s.root_tab_uid.clone())
    }

    /// Tab-aware grant check: any-scope → every pane; pane-scope → that exact
    /// pane; tab-scope → any pane in the same tab as the grant's anchor pane.
    async fn caller_has_grant(&self, label: &str, target_pane: &str) -> bool {
        let grants = self.inner.perms.grants_for(label).await;
        if grants.is_empty() {
            return false;
        }
        let target_tab = self.tab_of(target_pane).await;
        for (scope, pane) in grants {
            match scope.as_str() {
                "any" => return true,
                "pane" => {
                    if pane == target_pane {
                        return true;
                    }
                }
                "tab" => {
                    if let Some(tt) = &target_tab {
                        if self.tab_of(&pane).await.as_deref() == Some(tt.as_str()) {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
        false
    }

    /// Would `label` be allowed to drive `target_pane` by ownership or a live
    /// grant? Tab-aware — same logic `authorize_drive` uses — so the
    /// `/api/perms/check` endpoint can't diverge from real enforcement.
    pub async fn grant_allows(&self, label: &str, target_pane: &str) -> bool {
        let owned = self.inner.perms.owner_of(target_pane).await.as_deref() == Some(label);
        owned || self.caller_has_grant(label, target_pane).await
    }

    /// Decide whether `id` may drive `target_pane`. When enforcement is off this
    /// is always Allow (attribution-only). When on: a pane can't drive itself
    /// (RefuseHome); anonymous is SoftWalled; an identified caller that owns the
    /// pane or holds a live grant (pane/tab/any) is allowed; a recently-denied
    /// caller is told Denied (no re-prompt); otherwise NeedConsent.
    pub async fn authorize_drive(
        &self,
        id: &crate::identity::CallerIdentity,
        target_pane: &str,
    ) -> crate::perms::AuthDecision {
        use crate::identity::CallerIdentity;
        use crate::perms::AuthDecision;
        if !self.inner.perms.enforced() {
            return AuthDecision::Allow;
        }
        // Hyperia's own agent (trusted token) drives panes without consent —
        // the user configured it; its actions ARE the user's ask.
        if self.is_trusted_agent(id) {
            return AuthDecision::Allow;
        }
        match id {
            CallerIdentity::System => AuthDecision::Allow,
            CallerIdentity::Pane { pane, .. } if pane == target_pane => AuthDecision::RefuseHome,
            CallerIdentity::Anonymous => AuthDecision::SoftWall,
            _ => {
                let label = id.label();
                let owned =
                    self.inner.perms.owner_of(target_pane).await.as_deref() == Some(label.as_str());
                if owned || self.caller_has_grant(&label, target_pane).await {
                    AuthDecision::Allow
                } else if self.inner.perms.recently_denied(&label, target_pane).await {
                    AuthDecision::Denied
                } else {
                    AuthDecision::NeedConsent
                }
            }
        }
    }

    /// Decide whether `id` may CREATE a surface (pane/tab/window/web-pane/sticky).
    /// Create has no pane target, so it's gated on a per-agent create grant, not
    /// a pane/tab/any scope. System bypasses; anonymous is soft-walled; a live
    /// create grant allows (consuming a one-shot); a recent denial reports back.
    /// The denial/grant key is the sentinel pane `__create__`.
    pub async fn authorize_create(
        &self,
        id: &crate::identity::CallerIdentity,
    ) -> crate::perms::AuthDecision {
        use crate::identity::CallerIdentity;
        use crate::perms::AuthDecision;
        if !self.inner.perms.enforced() {
            return AuthDecision::Allow;
        }
        if self.is_trusted_agent(id) {
            return AuthDecision::Allow;
        }
        match id {
            CallerIdentity::System => AuthDecision::Allow,
            CallerIdentity::Anonymous => AuthDecision::SoftWall,
            _ => {
                let label = id.label();
                if self.inner.perms.has_create(&label).await {
                    AuthDecision::Allow
                } else if self.inner.perms.recently_denied(&label, crate::perms::CREATE_KEY).await {
                    AuthDecision::Denied
                } else {
                    AuthDecision::NeedConsent
                }
            }
        }
    }

    /// Decide whether `id` may use a named capability (files / settings /
    /// web_eval / manage / ...). Mirrors authorize_create: system bypasses,
    /// anonymous is soft-walled, a held capability allows, a recent denial
    /// reports back, otherwise NeedConsent.
    pub async fn authorize_capability(
        &self,
        id: &crate::identity::CallerIdentity,
        cap: &str,
    ) -> crate::perms::AuthDecision {
        use crate::identity::CallerIdentity;
        use crate::perms::AuthDecision;
        if !self.inner.perms.enforced() {
            return AuthDecision::Allow;
        }
        if self.is_trusted_agent(id) {
            return AuthDecision::Allow;
        }
        match id {
            CallerIdentity::System => AuthDecision::Allow,
            CallerIdentity::Anonymous => AuthDecision::SoftWall,
            _ => {
                let label = id.label();
                if self.inner.perms.has_cap(&label, cap).await {
                    AuthDecision::Allow
                } else if self.inner.perms.recently_denied(&label, &format!("cap:{cap}")).await {
                    AuthDecision::Denied
                } else {
                    AuthDecision::NeedConsent
                }
            }
        }
    }

    /// The active pane of the focused window — context for the create toast.
    pub async fn focused_pane(&self) -> Option<String> {
        let focused = *self.inner.focused_window_id.lock().await;
        let sessions = self.inner.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, s)| Some(s.window_id) == focused && s.pane_active)
            .map(|(uid, _)| uid.clone())
    }

    /// Record whether a Hyperia window is the OS-foreground app (false → the
    /// human is in another application).
    pub async fn set_app_foreground(&self, foreground: bool) {
        *self.inner.app_foreground.lock().await = foreground;
    }

    /// Where the human's keyboard is right now — the active pane of the focused
    /// window, how long since they touched it, and whether Hyperia is the
    /// foreground app. Lets a focus caller see if forcing would steal the view.
    pub async fn human_focus_report(&self) -> serde_json::Value {
        let focused_win = *self.inner.focused_window_id.lock().await;
        let app_foreground = *self.inner.app_foreground.lock().await;
        let sessions = self.inner.sessions.lock().await;
        let here = sessions
            .iter()
            .find(|(_, s)| Some(s.window_id) == focused_win && s.pane_active);
        match here {
            Some((uid, s)) => serde_json::json!({
                "hyperia_foreground": app_foreground,
                "window": s.window_id,
                "tab": s.tab_name,
                "pane": s.shell_name,
                "paneId": uid,
                "secs_since_active": s.last_user_activity.map(|t| t.elapsed().as_secs()),
            }),
            None => serde_json::json!({
                "hyperia_foreground": app_foreground,
                "note": "no active pane resolved for the focused window",
            }),
        }
    }

    /// Hold an agent's keystrokes for a pane it doesn't own yet, pending the
    /// human's consent decision. Overwrites any prior held action for the pane.
    pub async fn hold_action(&self, target_uid: &str, requester: &str, keys: &str) {
        self.inner.held_actions.lock().await.insert(
            target_uid.to_string(),
            HeldAction { requester: requester.to_string(), keys: keys.to_string() },
        );
    }

    /// Take (remove + return) any keystrokes held for a pane — called when the
    /// human resolves the consent prompt. Returns the held keys, if any.
    pub async fn take_action(&self, target_uid: &str) -> Option<String> {
        self.inner
            .held_actions
            .lock()
            .await
            .remove(target_uid)
            .map(|h| h.keys)
    }

    /// Arm a one-shot (capped) idle callback for a pane — the caller's OWN pane.
    /// Replaces any existing callback for that pane (one per pane). Lifetime is
    /// hard-capped at 1h and fires at 5. Returns the callback id.
    pub async fn register_idle_callback(
        &self,
        pane: &str,
        keys: &str,
        max_lifetime_secs: u64,
        max_fires: u32,
        creator: &str,
    ) -> String {
        let life = max_lifetime_secs.clamp(1, 3600);
        let fires_cap = max_fires.clamp(1, 5);
        let id = format!(
            "cb_{}",
            self.inner.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let cb = IdleCallback {
            id: id.clone(),
            pane: pane.to_string(),
            keys: keys.to_string(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(life),
            max_fires: fires_cap,
            fires: 0,
            // The caller is active right now (it just made this call), so arm as
            // if we've already seen 'running' — the NEXT idle fires.
            running_seen: true,
            creator: creator.to_string(),
        };
        let mut cbs = self.inner.idle_callbacks.lock().await;
        cbs.retain(|c| c.pane != pane);
        cbs.push(cb);
        id
    }

    /// Record a self-reported liveness pulse. busy=true marks the pane busy until
    /// now+ttl (overrides the screen heuristic); busy=false clears it (let the
    /// screen decide, so a pending callback can fire). TTL clamped to a sane window.
    pub async fn set_liveness(&self, pane: &str, busy: bool, ttl_secs: u64) {
        let mut lv = self.inner.liveness.lock().await;
        if busy {
            let ttl = ttl_secs.clamp(1, 120);
            lv.insert(
                pane.to_string(),
                std::time::Instant::now() + std::time::Duration::from_secs(ttl),
            );
        } else {
            lv.remove(pane);
        }
    }

    /// Whether the pane has a non-expired self-reported busy pulse.
    async fn pane_self_busy(&self, pane: &str) -> bool {
        let lv = self.inner.liveness.lock().await;
        lv.get(pane).map(|t| *t > std::time::Instant::now()).unwrap_or(false)
    }

    /// Register a recurring pulse on a pane. Clamps interval (>=20s) and lifetime
    /// (<=1h). One pulse per (window,tab) — dedupe. Returns the id.
    #[allow(clippy::too_many_arguments)]
    pub async fn register_pulse(
        &self,
        window: u32,
        tab: &str,
        pane: &str,
        target_label: &str,
        keys: &str,
        interval_secs: u64,
        idle_only: bool,
        submit: bool,
        max_lifetime_secs: u64,
        max_fires: Option<u32>,
        creator: &str,
    ) -> String {
        let interval = interval_secs.max(20);
        let life = max_lifetime_secs.clamp(1, 3600);
        let now = now_unix();
        let id = format!(
            "pulse_{}",
            self.inner.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let p = Pulse {
            id: id.clone(),
            window,
            tab: tab.to_string(),
            target_label: target_label.to_string(),
            // Target the SPECIFIC pane it was set on (re-resolved to the tab's
            // active pane only if this one's session later dies — see the monitor).
            pane: pane.to_string(),
            keys: keys.to_string(),
            interval_secs: interval,
            idle_only,
            submit,
            created_at_unix: now,
            expires_at_unix: now + life,
            max_fires,
            fires: 0,
            paused: false,
            last_fire_unix: now, // wait one interval before the first fire
            creator: creator.to_string(),
        };
        {
            let mut pulses = self.inner.pulses.lock().await;
            pulses.retain(|x| !(x.window == window && x.tab == tab));
            pulses.push(p);
        }
        self.persist_pulses().await;
        id
    }

    /// Clear pulses by id or by (current) target pane uid. Returns how many removed.
    pub async fn clear_pulse(&self, id_or_pane: &str) -> usize {
        let n = {
            let mut pulses = self.inner.pulses.lock().await;
            let before = pulses.len();
            pulses.retain(|p| p.id != id_or_pane && p.pane != id_or_pane);
            before - pulses.len()
        };
        if n > 0 {
            self.persist_pulses().await;
        }
        n
    }

    /// Pause/resume a pulse by id. Returns true if found.
    pub async fn pause_pulse(&self, id: &str, paused: bool) -> bool {
        let found = {
            let mut pulses = self.inner.pulses.lock().await;
            if let Some(p) = pulses.iter_mut().find(|p| p.id == id) {
                p.paused = paused;
                true
            } else {
                false
            }
        };
        if found {
            self.persist_pulses().await;
        }
        found
    }

    /// Persist all pulses to disk (best-effort).
    async fn persist_pulses(&self) {
        let json = {
            let pulses = self.inner.pulses.lock().await;
            serde_json::to_string_pretty(&*pulses).unwrap_or_else(|_| "[]".to_string())
        };
        let path = pulse_store_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, json);
    }

    /// Snapshot of active pulses for the status endpoint.
    pub async fn pulse_status(&self) -> serde_json::Value {
        let now = now_unix();
        let pulses = self.inner.pulses.lock().await;
        let list: Vec<serde_json::Value> = pulses
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "pane": p.pane,
                    "target": p.target_label,
                    "window": p.window,
                    "tab": p.tab,
                    "interval_secs": p.interval_secs,
                    "idle_only": p.idle_only,
                    "paused": p.paused,
                    "fires": p.fires,
                    "max_fires": p.max_fires,
                    "secs_until_expiry": p.expires_at_unix.saturating_sub(now),
                    "secs_since_fire": now.saturating_sub(p.last_fire_unix),
                    "creator": p.creator,
                })
            })
            .collect();
        serde_json::json!({ "pulses": list })
    }

    /// Whether the human touched this pane within the last 15s (don't poke over them).
    async fn user_active_recently(&self, uid: &str) -> bool {
        let sessions = self.inner.sessions.lock().await;
        sessions
            .get(uid)
            .and_then(|s| s.last_user_activity)
            .map(|t| t.elapsed().as_secs() < 15)
            .unwrap_or(false)
    }

    /// True if the pane is running an agent / Ink TUI (prose input), so a "From:"
    /// attribution header is appropriate. False for a plain shell (a prefix would
    /// corrupt a command). Keys off the foreground app name (shell_app), which is
    /// None for a bare shell.
    pub async fn is_agent_pane(&self, uid: &str) -> bool {
        const AGENTS: &[&str] = &[
            "claude", "codex", "aider", "gemini", "ollama", "node", "n8",
            "nemesis8", "antigravity", "opencode", "grok", "sakana", "pi",
        ];
        let sessions = self.inner.sessions.lock().await;
        let name = sessions
            .get(uid)
            .and_then(|s| s.shell_app.as_ref())
            .map(|a| a.name.to_lowercase())
            .unwrap_or_default();
        !name.is_empty() && AGENTS.iter().any(|a| name.contains(a))
    }

    /// The friendly display name (shell_name) of a pane, for attribution headers.
    pub async fn pane_display_name(&self, uid: &str) -> Option<String> {
        let sessions = self.inner.sessions.lock().await;
        sessions
            .get(uid)
            .map(|s| s.shell_name.clone())
            .filter(|n| !n.is_empty())
    }

    /// The (window_id, tab_name) a pane lives in — for restart-stable pulse
    /// addressing (a pulse re-binds to the tab's current active pane each tick).
    pub async fn pane_window_tab(&self, uid: &str) -> Option<(u32, String)> {
        let sessions = self.inner.sessions.lock().await;
        sessions.get(uid).map(|s| (s.window_id, s.tab_name.clone()))
    }

    /// Whether a live session exists for this uid.
    async fn has_session(&self, uid: &str) -> bool {
        self.inner.sessions.lock().await.contains_key(uid)
    }

    /// One idle-monitor tick: classify each watched pane and fire any callback
    /// whose pane just went running->idle. Edge-triggered, capped, expiring.
    pub async fn idle_monitor_tick(&self) {
        // Re-bind each active pulse to its tab's CURRENT active pane: an agent
        // restart gives a new uid, but the tab is stable. This keeps pulses alive
        // across pane/agent restarts and a Hyperia restart (window+tab persisted).
        let pulse_targets: Vec<(String, u32, String, String)> = {
            let pulses = self.inner.pulses.lock().await;
            pulses
                .iter()
                .filter(|p| !p.paused)
                .map(|p| (p.id.clone(), p.window, p.tab.clone(), p.target_label.clone()))
                .collect()
        };
        for (id, window, tab, target_label) in &pulse_targets {
            // Keep the SPECIFIC pane the pulse was set on while its session is
            // alive (so a split's pulse hits the right pane, not the tab's active
            // one). Only re-bind to the tab's active pane when the cached pane is
            // empty or its session has died (agent/Hyperia restart).
            let cached = {
                let pulses = self.inner.pulses.lock().await;
                pulses.iter().find(|p| &p.id == id).map(|p| p.pane.clone()).unwrap_or_default()
            };
            if !cached.is_empty() && self.has_session(&cached).await {
                continue;
            }
            if let Some(uid) = self
                .resolve_pane_uid(Some(*window), Some(tab.as_str()), Some(target_label.as_str()))
                .await
            {
                let mut pulses = self.inner.pulses.lock().await;
                if let Some(p) = pulses.iter_mut().find(|p| &p.id == id) {
                    p.pane = uid;
                }
            }
        }

        // Snapshot watched panes (don't hold the callbacks lock across awaits).
        let panes: Vec<String> = {
            let cbs = self.inner.idle_callbacks.lock().await;
            let pulses = self.inner.pulses.lock().await;
            let mut v: Vec<String> = cbs.iter().map(|c| c.pane.clone()).collect();
            v.extend(pulses.iter().filter(|p| !p.paused).map(|p| p.pane.clone()));
            v.sort();
            v.dedup();
            v
        };
        if panes.is_empty() {
            return;
        }

        // Classify each pane. 'human' if the human was active there recently —
        // never poke over them; treat dialog/empty/unknown as "not safely idle".
        let mut kinds: HashMap<String, String> = HashMap::new();
        for pane in &panes {
            let kind = if self.pane_self_busy(pane).await {
                // Agent (or its in-container monitor) says it's working — overrides
                // the screen heuristic (covers "thinking"/streaming that looks idle).
                "running".to_string()
            } else if self.user_active_recently(pane).await {
                "human".to_string()
            } else {
                let text = self.get_screen_text_by_uid(pane).await;
                crate::mcp::classify_screen_kind(&text)
            };
            kinds.insert(pane.clone(), kind);
        }

        let now = std::time::Instant::now();
        // (pane, keys, Some(creator) => pulse [attribute] / None => callback [self], submit?)
        let mut to_fire: Vec<(String, String, Option<String>, bool)> = Vec::new();

        // Idle callbacks — edge-triggered (running->idle), one fire per edge.
        {
            let mut cbs = self.inner.idle_callbacks.lock().await;
            for c in cbs.iter_mut() {
                match kinds.get(&c.pane).map(|s| s.as_str()).unwrap_or("unknown") {
                    "running" => c.running_seen = true,
                    "idle" => {
                        if c.running_seen {
                            to_fire.push((c.pane.clone(), c.keys.clone(), None, true));
                            c.fires += 1;
                            c.running_seen = false;
                        }
                    }
                    _ => {}
                }
            }
            cbs.retain(|c| now < c.expires_at && c.fires < c.max_fires);
        }

        // Pulses — interval-gated. idle_only fires only when idle; otherwise fires
        // when not human/dialog/running. Never fires while the human is active.
        let now_u = now_unix();
        let mut pulses_changed = false;
        {
            let mut pulses = self.inner.pulses.lock().await;
            let before = pulses.len();
            for p in pulses.iter_mut() {
                if p.paused || p.pane.is_empty() {
                    continue;
                }
                if now_u.saturating_sub(p.last_fire_unix) < p.interval_secs {
                    continue;
                }
                let kind = kinds.get(&p.pane).map(|s| s.as_str()).unwrap_or("unknown");
                let ok = if p.idle_only {
                    kind == "idle"
                } else {
                    kind != "human" && kind != "dialog" && kind != "running"
                };
                if ok {
                    to_fire.push((p.pane.clone(), p.keys.clone(), Some(p.creator.clone()), p.submit));
                    p.last_fire_unix = now_u;
                    p.fires += 1;
                    pulses_changed = true;
                }
            }
            pulses.retain(|p| {
                now_u < p.expires_at_unix && p.max_fires.map(|m| p.fires < m).unwrap_or(true)
            });
            if pulses.len() != before {
                pulses_changed = true;
            }
        }
        if pulses_changed {
            self.persist_pulses().await;
        }

        // Fire outside the locks. interrupt=false (never steals focus; renderer
        // queues if the human is active). Bracketed-paste + a separate Enter so a
        // long prompt isn't garbled. Pulses get a "From: <creator>:" header into
        // agent panes; self-callbacks don't (you're poking yourself).
        for (pane, keys, from_creator, submit) in to_fire {
            let is_agent = self.is_agent_pane(&pane).await;
            let shell_pid = {
                let sessions = self.inner.sessions.lock().await;
                sessions.get(&pane).map(|s| s.pid).unwrap_or(0)
            };
            let is_ink_tui = if shell_pid > 0 {
                let proc_name = crate::process::foreground_process(shell_pid);
                let n = proc_name.to_lowercase();
                ["node", "claude", "claude-code", "codex", "aider", "gemini", "ollama"]
                    .iter()
                    .any(|needle| n.contains(needle))
            } else {
                false
            };

            let payload = match &from_creator {
                Some(creator) if is_agent => format!("From: {creator}: {keys}"),
                _ => keys,
            };
            if is_agent || is_ink_tui {
                // Ink/agent TUI submits on LF. A long/multiline payload needs
                // bracketed paste (atomic ingest) so it isn't garbled — then Enter
                // separately. A SHORT one is typed + LF in ONE write: that's how
                // terminal_run reliably submits claude-code (a separate Enter after
                // a bracketed paste often types a newline but does NOT submit).
                let large = payload.chars().count() > 120 || payload.contains('\n');
                if large {
                    let wrapped = format!("\u{1b}[200~{payload}\u{1b}[201~");
                    let _ = self
                        .send_command(serde_json::json!({
                            "type": "Keys", "uid": pane, "keys": wrapped, "interrupt": false
                        }))
                        .await;
                    if submit {
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                        let _ = self
                            .send_command(serde_json::json!({
                                "type": "Keys", "uid": pane, "keys": "\n", "interrupt": false
                            }))
                            .await;
                    }
                } else {
                    let body = if submit { format!("{payload}\n") } else { payload };
                    let _ = self
                        .send_command(serde_json::json!({
                            "type": "Keys", "uid": pane, "keys": body, "interrupt": false
                        }))
                        .await;
                }
            } else {
                // Shell (pwsh/bash/cmd): CR submits on Windows; LF submits on Unix.
                // No bracketed paste — shells don't enable it.
                let enter_char = if cfg!(target_os = "windows") { "\r" } else { "\n" };
                let body = if submit { format!("{payload}{enter_char}") } else { payload };
                let _ = self
                    .send_command(serde_json::json!({
                        "type": "Keys", "uid": pane, "keys": body, "interrupt": false
                    }))
                    .await;
            }
        }
    }

    /// Fire-and-forget a JSON message to Electron (no seq, no response wait).
    /// Used for sidecar-initiated pushes the renderer handles out-of-band
    /// (e.g. permission prompts, which reply over HTTP rather than the WS).
    pub async fn notify(&self, msg: serde_json::Value) -> Result<(), String> {
        let guard = self.inner.cmd_tx.lock().await;
        match guard.as_ref() {
            Some(sender) => sender
                .send(msg.to_string())
                .map_err(|_| "Electron disconnected".to_string()),
            None => Err("No Electron client connected".into()),
        }
    }

    /// Whether an Electron client is connected.
    #[allow(dead_code)]
    pub async fn is_connected(&self) -> bool {
        self.inner.cmd_tx.lock().await.is_some()
    }

    /// Get mutable access to sessions for direct updates.
    pub async fn sessions(&self) -> tokio::sync::MutexGuard<'_, HashMap<String, SessionInfo>> {
        self.inner.sessions.lock().await
    }

    /// Send a command to Electron and wait for the ToolResult response.
    /// Automatically assigns a sequence number. Times out after 10s.
    pub async fn send_command(&self, mut msg: serde_json::Value) -> Result<String, String> {
        let seq = self.inner.seq.fetch_add(1, Ordering::Relaxed);
        msg["seq"] = serde_json::json!(seq);

        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(seq, tx);

        // Send downstream
        {
            let guard = self.inner.cmd_tx.lock().await;
            match guard.as_ref() {
                Some(sender) => {
                    if sender.send(msg.to_string()).is_err() {
                        self.inner.pending.lock().await.remove(&seq);
                        return Err("Electron disconnected".into());
                    }
                }
                None => {
                    self.inner.pending.lock().await.remove(&seq);
                    return Err("No Electron client connected".into());
                }
            }
        }

        // Await response with timeout
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err("Response channel dropped".into()),
            Err(_) => {
                self.inner.pending.lock().await.remove(&seq);
                Err("Timeout waiting for Electron response".into())
            }
        }
    }

    /// Read the vt100 screen buffer for a session uid.
    /// No round-trip to Electron — reads from the local ScreenBuffer fed by SessionData.
    /// Return (tab_name, pane_label, window_id) for a session uid, or None.
    /// Used by the HTTP handlers to add per-pane context to log lines so
    /// every PTY write/read is attributable to a specific tab and pane.
    pub async fn pane_address_for_log(&self, uid: &str) -> Option<(String, String, u32)> {
        let sessions = self.inner.sessions.lock().await;
        sessions.get(uid).map(|info| {
            let label = if info.split_label.is_empty() {
                // No split label = single-pane tab. Use a short paneId prefix
                // so the line is still parseable even when there's no letter.
                format!("[{}]", &uid[..uid.len().min(8)])
            } else {
                info.split_label.clone()
            };
            (info.tab_name.clone(), label, info.window_id)
        })
    }

    pub async fn get_screen_text_by_uid(&self, uid: &str) -> String {
        let sessions = self.inner.sessions.lock().await;
        if let Some(info) = sessions.get(uid) {
            let dump = info.screen.screen_dump();
            dump.lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            "No screen data".into()
        }
    }

    /// Send keys to a session and collect PTY output until `quiet_ms` of silence.
    /// Returns the raw text that came back, or falls back to a screen snapshot.
    pub async fn type_and_collect(&self, uid: &str, keys: &str, quiet_ms: u64) -> String {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        // Register subscriber before sending keys
        {
            let mut subs = self.inner.output_subs.lock().await;
            subs.entry(uid.to_string()).or_default().push(tx);
        }

        let cmd = serde_json::json!({"type": "Keys", "uid": uid, "keys": keys});
        let _ = self.send_command(cmd).await;

        // Collect output until quiet_ms of silence, cap at 8s total
        let mut collected: Vec<u8> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() { break; }
            match tokio::time::timeout(Duration::from_millis(quiet_ms), rx.recv()).await {
                Ok(Some(chunk)) => collected.extend_from_slice(&chunk),
                Ok(None) => break, // channel closed
                Err(_) => break,   // quiet_ms elapsed with no new data
            }
        }

        // Clean up subscriber
        {
            let mut subs = self.inner.output_subs.lock().await;
            if let Some(txs) = subs.get_mut(uid) {
                txs.retain(|t| !t.is_closed());
            }
        }

        if collected.is_empty() {
            // Nothing came back — return screen snapshot
            self.get_screen_text_by_uid(uid).await
        } else {
            String::from_utf8_lossy(&collected).into_owned()
        }
    }

    /// Set description for a pane by uid.
    pub async fn set_description_by_uid(&self, uid: &str, description: &str) {
        let mut sessions = self.inner.sessions.lock().await;
        if let Some(info) = sessions.get_mut(uid) {
            info.description = description.to_string();
        }
    }

    pub async fn session_count(&self) -> usize {
        self.inner.sessions.lock().await.len()
    }

    pub async fn get_last_tab_activity(&self, target_uid: &str) -> Option<std::time::Duration> {
        let sessions = self.inner.sessions.lock().await;
        let target_root_tab_uid = sessions.get(target_uid).map(|s| s.root_tab_uid.clone())?;
        
        let mut most_recent: Option<std::time::Instant> = None;
        for info in sessions.values() {
            if info.root_tab_uid == target_root_tab_uid {
                if let Some(act) = info.last_user_activity {
                    most_recent = Some(most_recent.map_or(act, |m| m.max(act)));
                }
            }
        }
        
        most_recent.map(|inst| inst.elapsed())
    }

    /// Resolve a window/tab/pane address to its session uid.
    pub async fn resolve_pane_uid(
        &self,
        window: Option<u32>,
        tab: Option<&str>,
        pane: Option<&str>,
    ) -> Option<String> {
        let focused_window_id = *self.inner.focused_window_id.lock().await;
        let sessions = self.inner.sessions.lock().await;

        // A paneId (session uid) is globally unique — it IS the sessions map
        // key — so an exact match is the canonical, layout-stable handle and
        // must resolve regardless of which window/tab is active. Short-circuit
        // before the window→tab→pane narrowing below: without this, the lookup
        // is scoped to the default (active) tab, so a correct full paneId for a
        // pane in a *different* tab fails with "No pane at that address". (#78)
        if let Some(p) = pane {
            if sessions.contains_key(p) {
                return Some(p.to_string());
            }
            // A uid PREFIX (the pane-band copy emits an 8-char prefix) is just
            // as safe to resolve globally when it matches exactly one uid. If
            // ambiguous, fall through to the tab-scoped matching below.
            if p.len() >= 4 {
                let mut hits = sessions.keys().filter(|uid| uid.starts_with(p));
                if let Some(first) = hits.next() {
                    if hits.next().is_none() {
                        return Some(first.clone());
                    }
                }
            }
        }

        let mut windows_map: std::collections::BTreeMap<u32, Vec<(&String, &SessionInfo)>> =
            std::collections::BTreeMap::new();
        for (uid, info) in sessions.iter() {
            windows_map.entry(info.window_id).or_default().push((uid, info));
        }

        let (_, win_sessions) = if let Some(window_id) = window {
            windows_map.iter().find(|(id, _)| **id == window_id).map(|(id, s)| (*id, s.clone()))?
        } else {
            if let Some(focused_id) = focused_window_id {
                windows_map
                    .iter()
                    .find(|(id, _)| **id == focused_id)
                    .map(|(id, s)| (*id, s.clone()))
                    .or_else(|| windows_map.iter().next().map(|(id, s)| (*id, s.clone())))?
            } else {
                windows_map.iter().next().map(|(id, s)| (*id, s.clone()))?
            }
        };

        let mut tabs_map: std::collections::BTreeMap<String, Vec<(&String, &SessionInfo)>> =
            std::collections::BTreeMap::new();
        for (uid, info) in win_sessions {
            tabs_map.entry(info.root_tab_uid.clone()).or_default().push((uid, info));
        }

        let mut ordered_tabs: Vec<(String, Vec<(&String, &SessionInfo)>)> = tabs_map.into_iter().collect();
        ordered_tabs.sort_by_key(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_order).unwrap_or(0));

        let (_, tab_sessions) = if let Some(tab_name) = tab {
            ordered_tabs
                .into_iter()
                .find(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_name.as_str() == tab_name).unwrap_or(false))?
        } else {
            ordered_tabs
                .iter()
                .find(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_active).unwrap_or(false))
                .cloned()
                .or_else(|| ordered_tabs.into_iter().next())?
        };

        let mut sorted_panes = tab_sessions;
        sorted_panes.sort_by_key(|(_, info)| {
            if info.split_label.is_empty() {
                '{'
            } else {
                info.split_label.chars().next().unwrap_or('{')
            }
        });

        if let Some(label) = pane {
            sorted_panes
                .into_iter()
                // Resolution order, stable identity first:
                //   1. exact session uid (paneId) — the immutable canonical key
                //   2. paneId PREFIX (>=4 chars). The pane-band "copy" produces
                //      an 8-char prefix (e.g. "dbccc3fe"), so agents paste a
                //      prefix, not the full UUID — accept it.
                //   3. friendly `name` (e.g. "Suspicious Marlin 🧄"), matched
                //      case-insensitively and tolerant of a missing trailing
                //      emoji/whitespace — the STABLE human handle.
                // Panes are addressed by NAME or paneId only. The positional
                // a/b/c split letter is intentionally NOT a match key — it shifts
                // when siblings open/close, so it's never exposed to agents.
                .find(|(uid, info)| {
                    uid.as_str() == label
                        || (label.len() >= 4 && uid.starts_with(label))
                        || name_matches(&info.shell_name, label)
                        || name_matches(&info.title, label)
                })
                .map(|(uid, _)| uid.clone())
        } else {
            sorted_panes
                .iter()
                .find(|(_, info)| info.pane_active)
                .map(|(uid, _)| (*uid).clone())
                .or_else(|| sorted_panes.first().map(|(uid, _)| (*uid).clone()))
        }
    }

    /// Resolve a window/tab address to the first pane's session uid in that tab.
    pub async fn resolve_tab_uid(&self, window: Option<u32>, tab: Option<&str>) -> Option<String> {
        self.resolve_pane_uid(window, tab, None).await
    }

    /// Get status of all registered sessions, grouped by window and tab.
    pub async fn get_status(&self) -> serde_json::Value {
        use sysinfo::{Pid, ProcessesToUpdate, System};
        // Snapshot all processes once; reused for every pane's foreground detection.
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);

        let focused_window_id = *self.inner.focused_window_id.lock().await;
        let win_bounds = self.inner.window_bounds.lock().await.clone();
        let sessions = self.inner.sessions.lock().await;

        // Group sessions by window_id
        let mut windows_map: std::collections::BTreeMap<u32, Vec<(&String, &SessionInfo)>> =
            std::collections::BTreeMap::new();
        for (uid, info) in sessions.iter() {
            windows_map.entry(info.window_id).or_default().push((uid, info));
        }

        let mut windows = Vec::new();
        for (win_id, win_sessions) in &windows_map {
            // Group by root_tab_uid within this window
            let mut tabs_map: std::collections::BTreeMap<&str, Vec<(&String, &SessionInfo)>> =
                std::collections::BTreeMap::new();
            for (uid, info) in win_sessions {
                tabs_map.entry(&info.root_tab_uid).or_default().push((uid, info));
            }

            let mut tabs = Vec::new();
            let mut ordered_tabs: Vec<(&str, &Vec<(&String, &SessionInfo)>)> = tabs_map.iter().map(|(k, v)| (*k, v)).collect();
            ordered_tabs.sort_by_key(|(_, sessions)| sessions.first().map(|(_, info)| info.tab_order).unwrap_or(0));

            for (_root_uid, tab_sessions) in ordered_tabs {
                let mut sorted_panes = tab_sessions.clone();
                sorted_panes.sort_by_key(|(_, info)| {
                    if info.split_label.is_empty() {
                        '{'
                    } else {
                        info.split_label.chars().next().unwrap_or('{')
                    }
                });

                let tab_name = sorted_panes.first()
                    .map(|(_, info)| info.tab_name.as_str())
                    .unwrap_or("shell");

                let active = sorted_panes.first().map(|(_, info)| info.tab_active).unwrap_or(false);

                let tab_id = sorted_panes.first()
                    .map(|(_, info)| info.root_tab_uid.as_str())
                    .unwrap_or("");

                let panes: Vec<serde_json::Value> = sorted_panes
                    .iter()
                    .map(|(uid, info)| {
                        // Normalise shell path to just the binary name (e.g. /bin/bash → bash)
                        let shell = std::path::Path::new(&info.name)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(&info.name)
                            .trim_end_matches(".exe")
                            .to_string();
                        // Walk child process tree to find the foreground app.
                        let process = if info.pid > 0 {
                            crate::process::foreground_process_with(&sys, info.pid)
                        } else {
                            String::new()
                        };
                        // `focused` = this pane is where the human's keyboard
                        // actually goes right now: the active pane of the
                        // focused window. `userActiveSecsAgo` = seconds since
                        // the human last typed in this pane (null if never /
                        // not tracked). Together they let an agent see "the
                        // human is in this pane and was just typing" before it
                        // sends keys.
                        let focused = focused_window_id == Some(*win_id) && info.pane_active;
                        let user_active_secs_ago = info
                            .last_user_activity
                            .map(|t| t.elapsed().as_secs());
                        // `name` = the friendly, layout-stable pane name
                        // (e.g. "Suspicious Marlin 🧄"). Fall back to `title`
                        // until the renderer's first `SessionName` arrives, so
                        // a freshly-registered pane is never nameless.
                        let friendly = if info.shell_name.is_empty() {
                            info.title.clone()
                        } else {
                            info.shell_name.clone()
                        };
                        let is_fallback_idle = (process.is_empty() || process.to_lowercase() == shell.to_lowercase()) && user_active_secs_ago.unwrap_or(999) > 15;
                        let state = if info.shell_has_integration { &info.shell_state } else if is_fallback_idle { "idle" } else { "running" };

                        let app_val = if state == "idle" {
                            serde_json::Value::Null
                        } else if let Some(ref app_info) = info.shell_app {
                            serde_json::to_value(app_info).unwrap_or(serde_json::Value::Null)
                        } else {
                            if !process.is_empty() {
                                serde_json::json!({
                                    "name": process,
                                    "path": "",
                                    "cmdline": "",
                                    "pid": 0
                                })
                            } else {
                                serde_json::Value::Null
                            }
                        };

                        serde_json::json!({
                            "paneId": uid,
                            "name": friendly,
                            "shell": shell,
                            "process": process,
                            "cols": info.cols,
                            "rows": info.rows,
                            "pid": info.pid,
                            "active": info.pane_active,
                            "focused": focused,
                            "userActiveSecsAgo": user_active_secs_ago,
                            "cwd": info.cwd,
                            "title": info.title,
                            "state": state,
                            "app": app_val,
                            "lastExit": info.shell_last_exit,
                            // BSP bounding box in 0–100 % — lets tab_image
                            // draw the layout to scale.
                            "bspX": info.bsp_x,
                            "bspY": info.bsp_y,
                            "bspW": info.bsp_w,
                            "bspH": info.bsp_h,
                        })
                    })
                    .collect();

                tabs.push(serde_json::json!({
                    "tabId": tab_id,
                    "name": tab_name,
                    "active": active,
                    "panes": panes,
                }));
            }

            let focused = focused_window_id.map(|id| id == *win_id).unwrap_or_else(|| windows.is_empty());
            let mut win_obj = serde_json::json!({
                "id": win_id,
                "focused": focused,
                "tabs": tabs,
            });
            // Real OS pixel size (from the renderer's WindowBounds reports), so
            // the agent can answer "how big is the window" and resize by it.
            if let Some(b) = win_bounds.get(win_id) {
                win_obj["width"] = b["width"].clone();
                win_obj["height"] = b["height"].clone();
                win_obj["x"] = b["x"].clone();
                win_obj["y"] = b["y"].clone();
            }
            windows.push(win_obj);
        }

        serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "windows": windows })
    }

    /// Handle an incoming message from Electron.
    async fn handle_message(&self, text: &str) {
        let msg: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("Bad message from Electron: {e}");
                return;
            }
        };

        let msg_type = msg["type"].as_str().unwrap_or("");

        match msg_type {
            "SessionRegister" => {
                let uid = msg["uid"].as_str().unwrap_or("").to_string();
                let name = msg["name"].as_str().unwrap_or("shell").to_string();
                let tab_name = msg["tabName"].as_str().unwrap_or(&name).to_string();
                let description = msg["description"].as_str().unwrap_or("").to_string();
                let rows = msg["rows"].as_u64().unwrap_or(24) as u16;
                let cols = msg["cols"].as_u64().unwrap_or(80) as u16;
                let pid = msg["pid"].as_u64().unwrap_or(0) as u32;
                let root_tab_uid = msg["rootTabUid"].as_str().unwrap_or(&uid).to_string();
                let window_id = msg["windowId"].as_u64().unwrap_or(0) as u32;
                let split_label = msg["splitLabel"].as_str().unwrap_or("").to_string();
                let tab_order = msg["tabOrder"].as_u64().unwrap_or(0) as u32;
                let tab_active = msg["tabActive"].as_bool().unwrap_or(false);
                let pane_active = msg["paneActive"].as_bool().unwrap_or(false);
                let title = msg["title"].as_str().unwrap_or("").to_string();
                let shell_name = msg["shellName"].as_str().unwrap_or("").to_string();
                tracing::info!("Session registered: {uid} ({tab_name}) {cols}x{rows} pid={pid} tab={root_tab_uid} win={window_id}");
                // Register the pane's injected identity token so an in-pane
                // agent's Authorization header resolves to this pane.
                let agent_token = msg["agentToken"].as_str().unwrap_or("");
                if !agent_token.is_empty() {
                    self.inner.perms.set_pane_token(&uid, agent_token).await;
                }
                let mut focused_window_id = self.inner.focused_window_id.lock().await;
                if focused_window_id.is_none() {
                    *focused_window_id = Some(window_id);
                }
                self.inner.sessions.lock().await.insert(
                    uid,
                    SessionInfo {
                        name,
                        shell_name,
                        tab_name,
                        description,
                        rows,
                        cols,
                        pid,
                        root_tab_uid,
                        window_id,
                        split_label,
                        tab_order,
                        tab_active,
                        pane_active,
                        screen: ScreenBuffer::new(rows, cols, 1000),
                        bsp_x: 0.0,
                        bsp_y: 0.0,
                        bsp_w: 100.0,
                        bsp_h: 100.0,
                        cwd: String::new(),
                        last_user_activity: None,
                        title,
                        shell_state: "idle".to_string(),
                        shell_app: None,
                        shell_last_exit: None,
                        shell_has_integration: false,
                    },
                );
            }

            "SessionTabName" => {
                let uid = msg["uid"].as_str().unwrap_or("").to_string();
                let tab_name = msg["tabName"].as_str().unwrap_or("").to_string();
                let mut sessions = self.inner.sessions.lock().await;
                // Find the root_tab_uid for this session, then update ALL sessions in the tab group
                let root = sessions.get(&uid).map(|s| s.root_tab_uid.clone());
                if let Some(root_uid) = root {
                    for (sid, info) in sessions.iter_mut() {
                        if info.root_tab_uid == root_uid {
                            info.tab_name = tab_name.clone();
                            tracing::info!("Session {sid} tab name: {tab_name}");
                        }
                    }
                }
            }

            "SessionDescribe" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let description = msg["description"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.description = description.clone();
                    tracing::info!("Session {uid} described: {description}");
                }
            }

            "SessionCwd" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let cwd = msg["cwd"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.cwd = cwd.clone();
                    tracing::info!("Session {uid} cwd updated: {cwd}");
                }
            }

            "SessionShellState" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let state = msg["state"].as_str().unwrap_or("idle").to_string();
                let last_exit = msg["lastExit"].as_i64().map(|x| x as i32);
                let app = if msg["app"].is_null() {
                    None
                } else {
                    msg["app"].as_object().map(|obj| {
                        ShellAppInfo {
                            name: obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            path: obj.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            cmdline: obj.get("cmdline").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            pid: obj.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32).unwrap_or(0),
                        }
                    })
                };
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.shell_has_integration = true;
                    info.shell_state = state.clone();
                    info.shell_app = app.clone();
                    info.shell_last_exit = last_exit;
                    tracing::info!("Session {uid} shell state updated: state={state}, app={app:?}, last_exit={last_exit:?}");
                }
            }

            "SessionTitle" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let title = msg["title"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.title = title.clone();
                    tracing::info!("Session {uid} title updated: {title}");
                }
            }

            "SessionName" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let name = msg["name"].as_str().unwrap_or("").to_string();
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    info.shell_name = name.clone();
                    tracing::info!("Session {uid} name updated: {name}");
                }
            }

            "SessionLayout" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let root_tab_uid = msg["rootTabUid"].as_str().unwrap_or("").to_string();
                let split_label = msg["splitLabel"].as_str().unwrap_or("").to_string();
                let tab_order = msg["tabOrder"].as_u64().unwrap_or(0) as u32;
                let tab_active = msg["tabActive"].as_bool().unwrap_or(false);
                let bsp = &msg["bsp"];
                if let Some(info) = self.inner.sessions.lock().await.get_mut(uid) {
                    if !root_tab_uid.is_empty() {
                        info.root_tab_uid = root_tab_uid;
                    }
                    info.split_label = split_label;
                    info.tab_order = tab_order;
                    info.tab_active = tab_active;
                    if bsp.is_object() {
                        info.bsp_x = bsp["x"].as_f64().unwrap_or(0.0) as f32;
                        info.bsp_y = bsp["y"].as_f64().unwrap_or(0.0) as f32;
                        info.bsp_w = bsp["width"].as_f64().unwrap_or(100.0) as f32;
                        info.bsp_h = bsp["height"].as_f64().unwrap_or(100.0) as f32;
                    }
                }
            }

            "SessionActive" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let window_id = msg["windowId"].as_u64().unwrap_or(0) as u32;
                let mut sessions = self.inner.sessions.lock().await;
                for (_sid, info) in sessions.iter_mut() {
                    if info.window_id == window_id {
                        info.pane_active = false;
                    }
                }
                if let Some(info) = sessions.get_mut(uid) {
                    info.pane_active = true;
                }
            }

            "WindowBounds" => {
                let window_id = msg["windowId"].as_u64().unwrap_or(0) as u32;
                tracing::info!(target: "doors", "WindowBounds recv win={} {}x{}", window_id, msg["width"], msg["height"]);
                if window_id != 0 {
                    self.inner.window_bounds.lock().await.insert(
                        window_id,
                        serde_json::json!({
                            "width": msg["width"], "height": msg["height"],
                            "x": msg["x"], "y": msg["y"],
                        }),
                    );
                }
            }

            "WindowFocus" => {
                let window_id = msg["windowId"].as_u64().unwrap_or(0) as u32;
                *self.inner.focused_window_id.lock().await = Some(window_id);
            }

            "AppFocus" => {
                // Whether a Hyperia window is the OS-foreground app (false → the
                // human is in another application, e.g. Chrome).
                let fg = msg["foreground"].as_bool().unwrap_or(true);
                *self.inner.app_foreground.lock().await = fg;
            }

            "SessionData" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                if let Some(data_b64) = msg["data"].as_str() {
                    if let Ok(bytes) = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        data_b64,
                    ) {
                        let mut sessions = self.inner.sessions.lock().await;
                        if let Some(info) = sessions.get_mut(uid) {
                            info.screen.process(&bytes);
                        }
                        drop(sessions);
                        // Append ANSI-stripped text to the lume per-shell log
                        // (the searchable store of record beyond the screen ring).
                        self.inner.lume.append_shell_bytes(uid, &bytes).await;
                        // Forward raw bytes to any waiting output subscribers
                        let mut subs = self.inner.output_subs.lock().await;
                        if let Some(txs) = subs.get_mut(uid) {
                            txs.retain(|tx| tx.send(bytes.clone()).is_ok());
                        }
                    }
                }
            }

            "SessionExit" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                tracing::info!("Session exited: {uid}");
                self.inner.sessions.lock().await.remove(uid);
                // Revoke any cross-pane grants/prompts tied to the closed pane.
                self.inner.perms.cleanup_pane(uid).await;
            }

            "Resize" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let rows = msg["rows"].as_u64().unwrap_or(24) as u16;
                let cols = msg["cols"].as_u64().unwrap_or(80) as u16;
                let mut sessions = self.inner.sessions.lock().await;
                if let Some(info) = sessions.get_mut(uid) {
                    info.rows = rows;
                    info.cols = cols;
                    info.screen.resize(rows, cols);
                }
            }

            "ToolResult" => {
                let seq = msg["seq"].as_u64().unwrap_or(0);
                let result = msg["result"].as_str().unwrap_or("").to_string();
                let mut pending = self.inner.pending.lock().await;
                if let Some(tx) = pending.remove(&seq) {
                    let _ = tx.send(result);
                }
            }

            "Heartbeat" => {
                // Reconcile in BOTH directions. The renderer is the source of
                // truth for which panes exist, so every heartbeat carries its
                // full session-uid list.
                if let Some(uids) = msg["sessionUids"].as_array() {
                    let bridge_uids: std::collections::HashSet<String> = uids
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                    let missing: Vec<String> = {
                        let mut sessions = self.inner.sessions.lock().await;
                        // (1) Prune sessions we still hold that the renderer dropped.
                        let stale: Vec<String> = sessions
                            .keys()
                            .filter(|uid| !bridge_uids.contains(*uid))
                            .cloned()
                            .collect();
                        for uid in &stale {
                            tracing::info!("Heartbeat reconcile: removing stale session {uid}");
                            sessions.remove(uid);
                        }
                        // (2) Find sessions the renderer tracks but we're missing
                        // (a registration lost to a crash / disconnect race).
                        // Without this the drift never self-heals — the pane stays
                        // invisible to terminal_status / hyper status / agents
                        // until it is recreated.
                        bridge_uids
                            .iter()
                            .filter(|uid| !sessions.contains_key(*uid))
                            .cloned()
                            .collect()
                    };
                    // (3) Ask the renderer to re-register anything we lack. Its
                    // SessionRegister rebuilds the entry; this converges in one
                    // heartbeat and can't loop (once present it is no longer
                    // "missing").
                    if !missing.is_empty() {
                        tracing::warn!(
                            "Heartbeat reconcile: {} session(s) tracked by renderer but missing here; requesting re-register: {:?}",
                            missing.len(),
                            missing
                        );
                        let _ = self
                            .notify(serde_json::json!({ "type": "ResyncSessions", "uids": missing }))
                            .await;
                    }
                }
            }

            "UserActivity" => {
                let uid = msg["uid"].as_str().unwrap_or("");
                let mut sessions = self.inner.sessions.lock().await;
                if let Some(info) = sessions.get_mut(uid) {
                    info.last_user_activity = Some(std::time::Instant::now());
                    tracing::info!("User activity registered for session {uid}");
                }
            }

            _ => {
                tracing::warn!("Unknown message type from Electron: {msg_type}");
            }
        }
    }

    /// Called when a WebSocket client disconnects.
    async fn on_disconnect(&self) {
        *self.inner.cmd_tx.lock().await = None;
        // Fail all pending requests
        let mut pending = self.inner.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send("Electron disconnected".into());
        }
        // Clear sessions
        self.inner.sessions.lock().await.clear();
        tracing::info!("Electron disconnected — sessions cleared");
    }
}

// ---------------------------------------------------------------------------
// Axum WebSocket handler
// ---------------------------------------------------------------------------

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    tracing::info!("Electron WebSocket upgrade request");
    let bridge = state.bridge;
    ws.on_upgrade(move |socket| handle_socket(socket, bridge))
}

async fn handle_socket(socket: WebSocket, bridge: Bridge) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Clear stale sessions from any previous connection that didn't disconnect cleanly
    {
        let mut sessions = bridge.inner.sessions.lock().await;
        if !sessions.is_empty() {
            tracing::info!("Clearing {} stale sessions from previous connection", sessions.len());
            sessions.clear();
        }
    }

    // Create the command channel for this connection
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<String>();
    *bridge.inner.cmd_tx.lock().await = Some(cmd_tx);

    tracing::info!("Electron WebSocket connected");

    // Writer task: forwards queued commands to the WebSocket
    let writer = tokio::spawn(async move {
        while let Some(msg) = cmd_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Reader loop: process incoming messages from Electron
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                bridge.handle_message(&text).await;
            }
            Message::Binary(data) => {
                if let Ok(text) = String::from_utf8(data.to_vec()) {
                    bridge.handle_message(&text).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup
    writer.abort();
    bridge.on_disconnect().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_info(window_id: u32, root_tab_uid: &str, split_label: &str, tab_active: bool, pane_active: bool) -> SessionInfo {
        SessionInfo {
            name: "shell".into(),
            shell_name: String::new(),
            tab_name: "tab".into(),
            description: String::new(),
            rows: 24,
            cols: 80,
            pid: 1,
            root_tab_uid: root_tab_uid.into(),
            window_id,
            split_label: split_label.into(),
            tab_order: 0,
            tab_active,
            pane_active,
            screen: ScreenBuffer::new(24, 80, 1000),
            bsp_x: 0.0,
            bsp_y: 0.0,
            bsp_w: 100.0,
            bsp_h: 100.0,
            cwd: String::new(),
            last_user_activity: None,
            title: String::new(),
            shell_state: "idle".to_string(),
            shell_app: None,
            shell_last_exit: None,
            shell_has_integration: false,
        }
    }

    #[test]
    fn resolve_pane_prefers_focused_window_and_active_pane() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let bridge = Bridge::new();
            {
                let mut sessions = bridge.inner.sessions.lock().await;
                sessions.insert("win0-a".into(), session_info(10, "tab-0", "a", true, false));
                sessions.insert("win0-b".into(), session_info(10, "tab-0", "b", true, true));
                sessions.insert("win1-a".into(), session_info(20, "tab-1", "a", true, true));
            }
            *bridge.inner.focused_window_id.lock().await = Some(10);

            let resolved = bridge.resolve_pane_uid(None, None, None).await;
            assert_eq!(resolved.as_deref(), Some("win0-b"));
        });
    }

    #[test]
    fn status_marks_real_focused_window_and_active_pane() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let bridge = Bridge::new();
            {
                let mut sessions = bridge.inner.sessions.lock().await;
                sessions.insert("win0-a".into(), session_info(10, "tab-0", "a", true, true));
                sessions.insert("win1-a".into(), session_info(20, "tab-1", "a", true, true));
            }
            *bridge.inner.focused_window_id.lock().await = Some(20);

            let status = bridge.get_status().await;
            let windows = status["windows"].as_array().unwrap();
            let focused_window = windows.iter().find(|w| w["focused"].as_bool() == Some(true)).unwrap();
            assert_eq!(focused_window["id"].as_u64(), Some(20));
            let panes = focused_window["tabs"][0]["panes"].as_array().unwrap();
            assert_eq!(panes[0]["active"].as_bool(), Some(true));
        });
    }
}
