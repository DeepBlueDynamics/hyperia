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
    /// Human-readable label for prompts and logs. Not a permission key.
    pub fn label(&self) -> String {
        match self {
            CallerIdentity::Anonymous => "anonymous".into(),
            CallerIdentity::System => "Hyperia".into(),
            CallerIdentity::Agent { name, .. } => name.clone(),
            CallerIdentity::Pane { pane, .. } => format!("pane {pane}"),
        }
    }

    /// Stable ledger key: `agent:<name>`, `pane:<uid>`, or `system`.
    /// Anonymous has no grant key.
    pub fn principal_key(&self) -> String {
        match self {
            CallerIdentity::Anonymous => String::new(),
            CallerIdentity::System => "system".into(),
            CallerIdentity::Agent { name, .. } => format!("agent:{name}"),
            CallerIdentity::Pane { pane, .. } => format!("pane:{pane}"),
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

/// `perms.json` schema that stores principal keys, not display labels.
pub const PERMS_SCHEMA_VERSION: u64 = 2;

/// Result of reading one pre-schema requester.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequesterCutover {
    /// Unambiguous principal key to store.
    Key(String),
    /// Could belong to more than one identity, or to none. Drop it.
    Invalidate,
}

/// Map a legacy permission requester onto one principal key using the agent
/// registry. A string that starts with `agent:` is not assumed to be a key:
/// an agent may be registered under that exact name. When the stored text is
/// both some agent's label and some agent's key, the grant is invalidated.
pub fn cutover_requester(stored: &str, registered_names: &[String]) -> RequesterCutover {
    let s = stored.trim();
    if s.is_empty() || s == "anonymous" {
        return RequesterCutover::Invalidate;
    }
    let label_hit = registered_names.iter().any(|name| name == s);
    let key_hit = registered_names.iter().any(|name| format!("agent:{name}") == s);
    if s.eq_ignore_ascii_case("hyperia") {
        return if label_hit {
            RequesterCutover::Invalidate
        } else {
            RequesterCutover::Key("system".into())
        };
    }
    if s == "system" {
        return if label_hit {
            RequesterCutover::Invalidate
        } else {
            RequesterCutover::Key("system".into())
        };
    }
    if let Some(uid) = s.strip_prefix("pane ") {
        let uid = uid.trim();
        if uid.is_empty() || uid.contains(' ') || label_hit {
            return RequesterCutover::Invalidate;
        }
        return RequesterCutover::Key(format!("pane:{uid}"));
    }
    if let Some(uid) = s.strip_prefix("pane:") {
        if uid.is_empty() || uid.contains(' ') || label_hit {
            return RequesterCutover::Invalidate;
        }
        return RequesterCutover::Key(s.to_string());
    }
    if label_hit && key_hit {
        return RequesterCutover::Invalidate;
    }
    if label_hit {
        return RequesterCutover::Key(format!("agent:{s}"));
    }
    if key_hit {
        return RequesterCutover::Key(s.to_string());
    }
    RequesterCutover::Invalidate
}

/// Legacy permission records use labels. Reserve the system/pane label namespace
/// so an agent credential cannot inherit a pane's or the application's grants.
fn valid_agent_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name.len() <= 256
        && !name.chars().any(char::is_control)
        && !name.to_ascii_lowercase().starts_with("pane ")
        && !name.eq_ignore_ascii_case("hyperia")
        && !name.eq_ignore_ascii_case("anonymous")
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

    /// Registration may create a new identity, but only that identity or System
    /// may retrieve its existing credential. Recheck under the insertion lock.
    pub async fn register(&self, name: &str, may_retrieve: bool) -> Result<AgentRecord, &'static str> {
        if !valid_agent_name(name) { return Err("Invalid or reserved identity name."); }
        if let Some(rec) = self.agents.lock().await.iter().find(|a| a.name == name).cloned() {
            return if may_retrieve { Ok(rec) } else { Err("Identity already exists; present its credential.") };
        }
        let token = format!("hyp_agent_{}", crate::util::random_token(16).await);
        let created_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let mut agents = self.agents.lock().await;
        if let Some(rec) = agents.iter().find(|a| a.name == name).cloned() {
            return if may_retrieve { Ok(rec) } else { Err("Identity already exists; present its credential.") };
        }
        let rec = AgentRecord { token, name: name.to_string(), created_ms };
        agents.push(rec.clone());
        Self::persist(&agents);
        Ok(rec)
    }

    pub async fn resolve(&self, token: &str) -> Option<AgentRecord> {
        self.agents.lock().await.iter().find(|a| a.token == token && valid_agent_name(&a.name)).cloned()
    }

    pub async fn list(&self) -> Vec<AgentRecord> {
        self.agents.lock().await.clone()
    }

    /// Names currently in `agents.json`, for a one-time permission-ledger cutover.
    pub fn registered_names_from_disk() -> Vec<String> {
        Self::load().into_iter().map(|agent| agent.name).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_names_cannot_impersonate_legacy_permission_labels() {
        assert!(!valid_agent_name("pane a1b2c3d4"));
        assert!(!valid_agent_name("Hyperia"));
        assert!(!valid_agent_name("anonymous"));
        assert!(valid_agent_name("nemesis8/hyperia"));
        assert_ne!(
            CallerIdentity::Pane { pane: "abcdefgh-1".into(), token: String::new() }.label(),
            CallerIdentity::Pane { pane: "abcdefgh-2".into(), token: String::new() }.label(),
        );
        let pane = CallerIdentity::Pane { pane: "abcdefgh-1".into(), token: String::new() };
        assert_eq!(pane.principal_key(), "pane:abcdefgh-1");
        assert_ne!(pane.principal_key(), pane.label());
        assert_eq!(CallerIdentity::Agent { name: "codex".into(), token: String::new() }.principal_key(), "agent:codex");
        assert_eq!(CallerIdentity::System.principal_key(), "system");
        let only_codex = vec!["codex".into()];
        assert_eq!(cutover_requester("codex", &only_codex), RequesterCutover::Key("agent:codex".into()));
        assert_eq!(cutover_requester("agent:codex", &only_codex), RequesterCutover::Key("agent:codex".into()));
        let literal = vec!["agent:codex".into()];
        assert_eq!(
            cutover_requester("agent:codex", &literal),
            RequesterCutover::Key("agent:agent:codex".into())
        );
        let both = vec!["codex".into(), "agent:codex".into()];
        assert_eq!(cutover_requester("agent:codex", &both), RequesterCutover::Invalidate);
        assert_eq!(cutover_requester("codex", &Vec::new()), RequesterCutover::Invalidate);
        assert_eq!(cutover_requester("Hyperia", &only_codex), RequesterCutover::Key("system".into()));
        assert_eq!(
            cutover_requester("pane abcdefgh-1", &only_codex),
            RequesterCutover::Key("pane:abcdefgh-1".into())
        );
    }

    #[tokio::test]
    async fn existing_identity_requires_its_credential() {
        let store = IdentityStore {
            agents: Mutex::new(vec![AgentRecord { token: "test-secret".into(), name: "owner".into(), created_ms: 1 }]),
            system_token: Some("test-system".into()),
        };
        assert!(store.register("owner", false).await.is_err());
        assert_eq!(store.register("owner", true).await.unwrap().token, "test-secret");
        assert!(store.resolve("wrong").await.is_none());
        assert_eq!(store.resolve("test-secret").await.unwrap().name, "owner");
        assert!(store.is_system("test-system"));
        assert!(!store.is_system("test-secret"));
        assert_eq!(store.list().await.len(), 1);
    }
}

