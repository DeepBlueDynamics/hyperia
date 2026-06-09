//! Persistent agent identities + caller resolution.
//!
//! Two token namespaces feed one `CallerIdentity`:
//!   - **agent tokens** (here): persistent, file-backed (`~/.hyperia/agents.json`),
//!     decoupled from any pane. The right credential for an EXTERNAL agent (e.g.
//!     Claude Code running in a terminal) that outlives panes across restarts.
//!   - **pane tokens** (`perms::PermStore`): ephemeral, minted per pane, revoked
//!     on close. For handing a specific pane's identity to a helper.
//!
//! A caller presents `Authorization: Bearer <token>`; the bridge resolves it to
//! an agent, a pane, or anonymous.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Who is making a request, once the Authorization header is resolved.
#[derive(Clone, Debug)]
pub enum CallerIdentity {
    Anonymous,
    /// Hyperia's own internal calls (system token) — always trusted.
    System,
    /// A persistent external agent (survives restarts).
    Agent { name: String, token: String },
    /// Acting as a specific pane (ephemeral pane token).
    Pane { pane: String, token: String },
}

impl CallerIdentity {
    /// Human-readable label for prompts / logs.
    pub fn label(&self) -> String {
        match self {
            CallerIdentity::Anonymous => "anonymous".into(),
            CallerIdentity::System => "Hyperia".into(),
            CallerIdentity::Agent { name, .. } => name.clone(),
            CallerIdentity::Pane { pane, .. } => format!("pane {}", &pane[..pane.len().min(8)]),
        }
    }
    pub fn is_anonymous(&self) -> bool {
        matches!(self, CallerIdentity::Anonymous)
    }
    pub fn is_system(&self) -> bool {
        matches!(self, CallerIdentity::System)
    }
    pub fn kind(&self) -> &'static str {
        match self {
            CallerIdentity::Anonymous => "anonymous",
            CallerIdentity::System => "system",
            CallerIdentity::Agent { .. } => "agent",
            CallerIdentity::Pane { .. } => "pane",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentRecord {
    pub token: String,
    pub name: String,
    pub created_ms: u64,
}

/// File-backed set of persistent agent identities.
pub struct IdentityStore {
    agents: Mutex<Vec<AgentRecord>>,
    /// Internal-trust token for Hyperia's own HTTP calls (sticky runner, etc.).
    /// Set by the Electron main process via the HYPERIA_SYSTEM_TOKEN env var at
    /// spawn; None if absent (then nothing resolves to System).
    system_token: Option<String>,
}

impl Default for IdentityStore {
    fn default() -> Self {
        Self::new()
    }
}

impl IdentityStore {
    pub fn new() -> Self {
        Self {
            agents: Mutex::new(Self::load()),
            system_token: std::env::var("HYPERIA_SYSTEM_TOKEN").ok().filter(|s| !s.is_empty()),
        }
    }

    /// True if `token` is the internal Hyperia system token.
    pub fn is_system(&self, token: &str) -> bool {
        self.system_token.as_deref() == Some(token)
    }

    fn path() -> PathBuf {
        let home = std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| ".".into());
        PathBuf::from(home).join(".hyperia").join("agents.json")
    }

    fn load() -> Vec<AgentRecord> {
        match std::fs::read_to_string(Self::path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    fn persist(agents: &[AgentRecord]) {
        let path = Self::path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(agents) {
            let _ = std::fs::write(&path, json);
        }
    }

    /// Mint (or return existing) a persistent agent token for `name`. Names are
    /// unique: minting an existing name returns its current token so the same
    /// agent keeps a stable identity across calls and restarts.
    pub async fn mint(&self, name: &str) -> AgentRecord {
        // Fast path: name already has an identity.
        if let Some(rec) = self.agents.lock().await.iter().find(|a| a.name == name).cloned() {
            return rec;
        }
        // Generate WITHOUT holding the lock — random_token may do network I/O
        // (CSPRNG base + best-effort sdrrand mix). 16 bytes = 128-bit token.
        let token = format!("hyp_agent_{}", crate::util::random_token(16).await);
        let created_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut agents = self.agents.lock().await;
        // Re-check: a concurrent mint may have created it while we generated.
        if let Some(rec) = agents.iter().find(|a| a.name == name).cloned() {
            return rec;
        }
        let rec = AgentRecord {
            token,
            name: name.to_string(),
            created_ms,
        };
        agents.push(rec.clone());
        Self::persist(&agents);
        rec
    }

    pub async fn resolve(&self, token: &str) -> Option<AgentRecord> {
        self.agents.lock().await.iter().find(|a| a.token == token).cloned()
    }

    pub async fn list(&self) -> Vec<AgentRecord> {
        self.agents.lock().await.clone()
    }
}
