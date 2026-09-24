//! Canonical agent mailbox service & binding store.
//!
//! Enforces:
//! - Namespaced stable principal keys: `agent:<name>`, `pane:<uuid>`, `system`.
//! - Canonical `toPrincipal` and `fromPrincipal` matching (display labels never grant authority).
//! - Pane mailbox delegation: bound agent access to `pane:<uuid>` envelopes (never arbitrary OR-matching).
//! - Dual-credential / system-authorized agent-to-pane binding (no tokens persisted).
//! - Staged atomic binding persistence (in-memory state unchanged on save failure).
//! - Local collision-resistant 128-bit random IDs (`getrandom`).
//! - Scoped idempotency keys with payload conflict detection.
//! - Recipient-only, idempotent read receipts (strictly isolating canonical mail from legacy receipts).
//! - Shared store synchronization preventing race conditions during concurrent sends/acks.
//! - Pure inbox/search vs explicit `check_inbox` atomic acknowledgment (returning `read: true`).
//! - Bounded metadata (body <= 16KB, subject <= 512, idempotency key <= 256).
//! - Strict error propagation across disk I/O with data sync.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const MAX_BODY_CHARS: usize = 16 * 1024;
pub const MAX_SUBJECT_CHARS: usize = 512;
pub const MAX_IDEMPOTENCY_KEY_CHARS: usize = 256;

/// Process-local synchronization lock protecting shared mailbox store operations.
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub enum MailboxError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    Crypto(String),
    NotFound(String),
    Forbidden(String),
    Conflict(String),
    Validation(String),
    Unauthorized,
}

impl std::fmt::Display for MailboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailboxError::Io(e) => write!(f, "I/O error: {e}"),
            MailboxError::Serde(e) => write!(f, "Serialization error: {e}"),
            MailboxError::Crypto(s) => write!(f, "Cryptographic randomness error: {s}"),
            MailboxError::NotFound(s) => write!(f, "Not found: {s}"),
            MailboxError::Forbidden(s) => write!(f, "Forbidden: {s}"),
            MailboxError::Conflict(s) => write!(f, "Conflict: {s}"),
            MailboxError::Validation(s) => write!(f, "Validation error: {s}"),
            MailboxError::Unauthorized => write!(f, "Authentication required"),
        }
    }
}

impl std::error::Error for MailboxError {}

impl From<std::io::Error> for MailboxError {
    fn from(e: std::io::Error) -> Self {
        MailboxError::Io(e)
    }
}

impl From<serde_json::Error> for MailboxError {
    fn from(e: serde_json::Error) -> Self {
        MailboxError::Serde(e)
    }
}

/// Namespaced stable principal key.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Principal {
    Agent(String), // "agent:<name>"
    Pane(String),  // "pane:<uuid>"
    System,        // "system"
}

impl Principal {
    pub fn parse(s: &str) -> Result<Self, MailboxError> {
        let s = s.trim();
        if s == "system" {
            Ok(Principal::System)
        } else if let Some(agent) = s.strip_prefix("agent:") {
            if agent.trim().is_empty() {
                return Err(MailboxError::Validation("empty agent principal name".into()));
            }
            Ok(Principal::Agent(agent.trim().to_string()))
        } else if let Some(pane) = s.strip_prefix("pane:") {
            if pane.trim().is_empty() {
                return Err(MailboxError::Validation("empty pane principal uuid".into()));
            }
            Ok(Principal::Pane(pane.trim().to_string()))
        } else {
            Err(MailboxError::Validation(format!(
                "invalid principal format '{s}'; expected 'agent:<name>', 'pane:<uuid>', or 'system'"
            )))
        }
    }

    pub fn to_key(&self) -> String {
        match self {
            Principal::Agent(name) => format!("agent:{name}"),
            Principal::Pane(uid) => format!("pane:{uid}"),
            Principal::System => "system".to_string(),
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            Principal::Agent(_) => "agent",
            Principal::Pane(_) => "pane",
            Principal::System => "system",
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Generate collision-resistant message ID with >= 128 bits of local randomness.
pub fn generate_message_id(ts: u64) -> Result<String, MailboxError> {
    let mut random_bytes = [0u8; 16]; // 128 bits
    getrandom::getrandom(&mut random_bytes)
        .map_err(|e| MailboxError::Crypto(format!("getrandom failed: {e}")))?;
    let hex_random: String = random_bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("msg_{ts:x}_{hex_random}"))
}

/// Canonical message envelope supporting backward-compatible legacy deserialization.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageEnvelope {
    pub id: String,
    pub ts: u64,
    #[serde(default, rename = "toPrincipal")]
    pub to_principal: String,
    #[serde(default, rename = "fromPrincipal")]
    pub from_principal: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(default, rename = "toPane")]
    pub to_pane: String,
    #[serde(default, rename = "fromPane")]
    pub from_pane: String,
    #[serde(default, rename = "to")]
    pub to_label: String,
    #[serde(default, rename = "from")]
    pub from_label: String,
    #[serde(default, rename = "fromKind")]
    pub from_kind: String,
    #[serde(default)]
    pub subject: String,
    pub body: String,
    #[serde(default, rename = "deliveryState")]
    pub delivery_state: String,
    #[serde(default)]
    pub read: bool,
}

impl MessageEnvelope {
    /// True if this envelope originated from legacy un-canonicalized storage.
    pub fn is_legacy(&self) -> bool {
        self.to_principal.is_empty()
    }
}

/// Normalizes envelope fields, setting fallback canonical keys for legacy messages.
pub fn normalize_envelope(mut env: MessageEnvelope) -> MessageEnvelope {
    if env.to_principal.is_empty() {
        if !env.to_pane.is_empty() {
            env.to_principal = format!("pane:{}", env.to_pane);
        } else if !env.to_label.is_empty() {
            env.to_principal = format!("legacy:{}", env.to_label);
        }
    }
    if env.from_principal.is_empty() {
        if !env.from_pane.is_empty() {
            env.from_principal = format!("pane:{}", env.from_pane);
        } else if !env.from_label.is_empty() {
            env.from_principal = format!("legacy:{}", env.from_label);
        }
    }
    if env.delivery_state.is_empty() {
        env.delivery_state = "stored".to_string();
    }
    env
}

/// Read receipt record.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadReceipt {
    #[serde(rename = "msgId")]
    pub msg_id: String,
    #[serde(default, rename = "readerPrincipal")]
    pub reader_principal: String,
    #[serde(default, rename = "reader")]
    pub reader_label: String,
    pub ts: u64,
}

/// Proof of residency presented to bind an agent to a pane.
pub enum ProofOfResidency<'a> {
    System,
    PaneToken(&'a str),
}

/// Safe binding store associating registered agents with active terminal panes.
/// Invariants:
/// - 1-to-1 current mapping between agent and pane.
/// - Prior reverse maps revoked on rebind.
/// - NO raw tokens persisted in binding records.
/// - Staged mutation: in-memory state is only updated after successful disk write.
pub struct BindingStore {
    path: PathBuf,
    records: Mutex<Vec<BindingRecord>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BindingRecord {
    pub agent: String,
    pub pane: String,
    #[serde(rename = "boundAt")]
    pub bound_at: u64,
}

impl BindingStore {
    pub fn new(path: PathBuf) -> Result<Self, MailboxError> {
        let records = Self::load_file(&path)?;
        Ok(Self {
            path,
            records: Mutex::new(records),
        })
    }

    fn load_file(path: &Path) -> Result<Vec<BindingRecord>, MailboxError> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let data = std::fs::read_to_string(path)?;
        if data.trim().is_empty() {
            return Ok(Vec::new());
        }
        let records: Vec<BindingRecord> = serde_json::from_str(&data)?;
        Ok(records)
    }

    fn save_file(&self, records: &[BindingRecord]) -> Result<(), MailboxError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp_path = self.path.with_extension(format!("tmp.{}", now_ms()));
        let json = serde_json::to_string_pretty(records)?;
        {
            let mut f = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&temp_path)?;
            f.write_all(json.as_bytes())?;
            f.sync_data()?;
        }
        std::fs::rename(&temp_path, &self.path)?;
        Ok(())
    }

    /// Authoritatively bind agent to pane with proof of residency or system authorization.
    pub fn verify_and_bind<F>(
        &self,
        agent: &str,
        pane: &str,
        proof: ProofOfResidency,
        pane_token_validator: F,
    ) -> Result<BindingRecord, MailboxError>
    where
        F: FnOnce(&str, &str) -> bool,
    {
        let agent = agent.trim();
        let pane = pane.trim();
        if agent.is_empty() {
            return Err(MailboxError::Validation("agent name is empty".into()));
        }
        if pane.is_empty() {
            return Err(MailboxError::Validation("pane uuid is empty".into()));
        }

        match proof {
            ProofOfResidency::System => self.bind_internal(agent, pane),
            ProofOfResidency::PaneToken(token) => {
                let token = token.trim();
                if token.is_empty() {
                    return Err(MailboxError::Forbidden("missing pane token for proof of residency".into()));
                }
                if !pane_token_validator(pane, token) {
                    return Err(MailboxError::Forbidden(format!(
                        "provided pane token is invalid for pane '{pane}'"
                    )));
                }
                self.bind_internal(agent, pane)
            }
        }
    }

    fn bind_internal(&self, agent: &str, pane: &str) -> Result<BindingRecord, MailboxError> {
        let mut recs_lock = self.records.lock().unwrap();
        // Stage mutation on a cloned vector first
        let mut staged = recs_lock.clone();
        staged.retain(|r| r.agent != agent && r.pane != pane);
        let record = BindingRecord {
            agent: agent.to_string(),
            pane: pane.to_string(),
            bound_at: now_ms(),
        };
        staged.push(record.clone());

        // Attempt persistence: if save fails, recs_lock remains untouched
        self.save_file(&staged)?;

        // Only on success update live in-memory records
        *recs_lock = staged;
        Ok(record)
    }

    /// Resolve mailbox authority from an authenticated principal and a live,
    /// verified binding. Never infer residency from a label or message pane hint.
    /// Used for every mailbox read and for notification counts.
    pub fn mailbox_identity(
        &self,
        caller: &Principal,
        pane_is_active: impl Fn(&str) -> bool,
    ) -> Result<(Principal, Option<String>), MailboxError> {
        let records = self.records.lock().unwrap();
        match caller {
            Principal::Pane(pane) => {
                if !pane_is_active(pane) {
                    return Err(MailboxError::Unauthorized);
                }
                let principal = records.iter().find(|r| r.pane == *pane)
                    .map(|r| Principal::Agent(r.agent.clone()))
                    .unwrap_or_else(|| caller.clone());
                Ok((principal, Some(pane.clone())))
            }
            Principal::Agent(agent) => {
                let pane = records.iter().find(|r| r.agent == *agent)
                    .filter(|r| pane_is_active(&r.pane))
                    .map(|r| r.pane.clone());
                Ok((caller.clone(), pane))
            }
            Principal::System => Ok((Principal::System, None)),
        }
    }

    pub fn pane_for_agent(&self, agent: &str) -> Option<String> {
        let recs = self.records.lock().unwrap();
        recs.iter().find(|r| r.agent == agent).map(|r| r.pane.clone())
    }

    pub fn agent_for_pane(&self, pane: &str) -> Option<String> {
        let recs = self.records.lock().unwrap();
        recs.iter().find(|r| r.pane == pane).map(|r| r.agent.clone())
    }

    pub fn unbind_agent(&self, agent: &str) -> Result<bool, MailboxError> {
        let mut recs_lock = self.records.lock().unwrap();
        let mut staged = recs_lock.clone();
        let before = staged.len();
        staged.retain(|r| r.agent != agent);
        let changed = staged.len() != before;
        if changed {
            self.save_file(&staged)?;
            *recs_lock = staged;
        }
        Ok(changed)
    }

    pub fn unbind_pane(&self, pane: &str) -> Result<bool, MailboxError> {
        let mut recs_lock = self.records.lock().unwrap();
        let mut staged = recs_lock.clone();
        let before = staged.len();
        staged.retain(|r| r.pane != pane);
        let changed = staged.len() != before;
        if changed {
            self.save_file(&staged)?;
            *recs_lock = staged;
        }
        Ok(changed)
    }

    pub fn list(&self) -> Vec<BindingRecord> {
        self.records.lock().unwrap().clone()
    }
}

/// Parameters for dispatching a message.
pub struct SendParams<'a> {
    pub from: &'a Principal,
    pub to: &'a Principal,
    pub subject: &'a str,
    pub body: &'a str,
    pub to_pane_hint: Option<&'a str>,
    pub from_pane_hint: Option<&'a str>,
    pub to_label: Option<&'a str>,
    pub from_label: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
}

fn append_line(path: &Path, line: &str) -> Result<(), MailboxError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(())
}

/// Send a message with canonical addressing, metadata bounds, and idempotency verification.
pub fn send_message(messages_path: &Path, params: SendParams) -> Result<String, MailboxError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    send_message_locked(messages_path, params)
}

fn send_message_locked(messages_path: &Path, params: SendParams) -> Result<String, MailboxError> {
    let body_trimmed = params.body.trim();
    if body_trimmed.is_empty() {
        return Err(MailboxError::Validation("body must not be empty".into()));
    }
    let char_count = params.body.chars().count();
    if char_count > MAX_BODY_CHARS {
        return Err(MailboxError::Validation(format!(
            "body is {char_count} chars; maximum allowed is {MAX_BODY_CHARS}"
        )));
    }
    let subject_chars = params.subject.chars().count();
    if subject_chars > MAX_SUBJECT_CHARS {
        return Err(MailboxError::Validation(format!(
            "subject is {subject_chars} chars; maximum allowed is {MAX_SUBJECT_CHARS}"
        )));
    }
    if let Some(key) = params.idempotency_key {
        let key_chars = key.trim().chars().count();
        if key_chars > MAX_IDEMPOTENCY_KEY_CHARS {
            return Err(MailboxError::Validation(format!(
                "idempotency key is {key_chars} chars; maximum allowed is {MAX_IDEMPOTENCY_KEY_CHARS}"
            )));
        }
    }

    let from_key = params.from.to_key();
    let to_key = params.to.to_key();

    // Idempotency check: requester scope
    if let Some(key) = params.idempotency_key {
        let key = key.trim();
        if !key.is_empty() && messages_path.exists() {
            let content = std::fs::read_to_string(messages_path)?;
            for line in content.lines() {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                    if val["fromPrincipal"].as_str() == Some(&from_key)
                        && val["idempotencyKey"].as_str() == Some(key)
                    {
                        // Found prior send with this idempotency key
                        let match_to = val["toPrincipal"].as_str() == Some(&to_key);
                        let match_subject = val["subject"].as_str() == Some(params.subject);
                        let match_body = val["body"].as_str() == Some(params.body);
                        if match_to && match_subject && match_body {
                            return Ok(val["id"].as_str().unwrap_or("").to_string());
                        } else {
                            return Err(MailboxError::Conflict(format!(
                                "idempotency key '{key}' was previously used with different payload or recipient"
                            )));
                        }
                    }
                }
            }
        }
    }

    let ts = now_ms();
    let id = generate_message_id(ts)?;

    let envelope = MessageEnvelope {
        id: id.clone(),
        ts,
        to_principal: to_key,
        from_principal: from_key,
        idempotency_key: params.idempotency_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        to_pane: params.to_pane_hint.unwrap_or("").to_string(),
        from_pane: params.from_pane_hint.unwrap_or("").to_string(),
        to_label: params.to_label.unwrap_or("").to_string(),
        from_label: params.from_label.unwrap_or("").to_string(),
        from_kind: params.from.kind_str().to_string(),
        subject: params.subject.to_string(),
        body: params.body.to_string(),
        delivery_state: "stored".to_string(),
        read: false,
    };

    let serialized = serde_json::to_string(&envelope)?;
    append_line(messages_path, &serialized)?;
    Ok(id)
}

/// Evaluates whether a message is addressed to the caller.
/// Rules:
/// 1. Canonical toPrincipal takes absolute precedence.
/// 2. Pane mailbox delegation: bound agent occupant is delegated access to `pane:<uuid>` envelopes.
/// 3. Legacy compatibility strictly applies only when toPrincipal is absent.
pub fn matches_recipient(
    msg: &serde_json::Value,
    caller: &Principal,
    caller_pane: Option<&str>,
) -> bool {
    let caller_key = caller.to_key();

    // 1. Canonical toPrincipal matching
    if let Some(to_p) = msg["toPrincipal"].as_str().filter(|s| !s.is_empty()) {
        if to_p == caller_key {
            return true;
        }
        // Pane mailbox delegation: bound agent occupant has delegated access to its pane's mailbox
        if let Some(cp) = caller_pane {
            if to_p == format!("pane:{cp}") {
                return true;
            }
        }
        return false;
    }

    // 2. Legacy envelope fallback (toPrincipal absent or empty)
    let caller_pane_uid = match caller {
        Principal::Pane(uid) => Some(uid.as_str()),
        _ => caller_pane,
    };
    if let Some(p_uid) = caller_pane_uid {
        if let Some(to_pane) = msg["toPane"].as_str() {
            if !to_pane.is_empty() && to_pane == p_uid {
                return true;
            }
        }
    }
    // Only match legacy label if toPane was empty and agent name equals label
    if msg["toPane"].as_str().unwrap_or("").is_empty() {
        if let Some(to_lbl) = msg["to"].as_str() {
            if !to_lbl.is_empty() {
                match caller {
                    Principal::Agent(name) if name == to_lbl => return true,
                    _ => {}
                }
            }
        }
    }

    false
}

/// Evaluates whether a message was sent by the caller.
pub fn matches_sender(
    msg: &serde_json::Value,
    caller: &Principal,
    caller_pane: Option<&str>,
) -> bool {
    let caller_key = caller.to_key();

    if let Some(from_p) = msg["fromPrincipal"].as_str().filter(|s| !s.is_empty()) {
        if from_p == caller_key {
            return true;
        }
        if let Some(cp) = caller_pane {
            if from_p == format!("pane:{cp}") {
                return true;
            }
        }
        return false;
    }

    // Legacy fallback
    let caller_pane_uid = match caller {
        Principal::Pane(uid) => Some(uid.as_str()),
        _ => caller_pane,
    };
    if let Some(p_uid) = caller_pane_uid {
        if let Some(from_pane) = msg["fromPane"].as_str() {
            if !from_pane.is_empty() && from_pane == p_uid {
                return true;
            }
        }
    }
    if msg["fromPane"].as_str().unwrap_or("").is_empty() {
        if let Some(from_lbl) = msg["from"].as_str() {
            if !from_lbl.is_empty() {
                match caller {
                    Principal::Agent(name) if name == from_lbl => return true,
                    _ => {}
                }
            }
        }
    }

    false
}

/// Check if a message has been read by its canonical recipient.
/// Canonical receipts strictly isolate canonical mail from legacy receipts.
pub fn is_message_read(reads_content: &str, msg: &serde_json::Value) -> bool {
    let msg_id = match msg["id"].as_str() {
        Some(id) => id,
        None => return false,
    };
    let canonical_to = msg.get("toPrincipal").and_then(|v| v.as_str()).filter(|s| !s.is_empty());

    for line in reads_content.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v["msgId"].as_str() == Some(msg_id) {
                if let Some(target_p) = canonical_to {
                    // Canonical message: ONLY receipts with readerPrincipal == target_p match!
                    if v["readerPrincipal"].as_str() == Some(target_p) {
                        return true;
                    }
                    // NEVER fall through to legacy reader label for canonical messages!
                } else {
                    // Legacy message (no toPrincipal):
                    if let Some(to_pane) = msg["toPane"].as_str().filter(|s| !s.is_empty()) {
                        let pane_key = format!("pane:{to_pane}");
                        if v["readerPrincipal"].as_str() == Some(&pane_key) {
                            return true;
                        }
                    }
                    if let Some(to_lbl) = msg["to"].as_str() {
                        if v["reader"].as_str() == Some(to_lbl) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// Read-only receipt lookup for an already-authorized sender status request.
/// Exposes only whether the canonical recipient acknowledged this message.
/// The caller must authorize access to the operation before invoking this.
pub fn recipient_has_read(
    messages_path: &Path,
    reads_path: &Path,
    msg_id: &str,
) -> Result<bool, MailboxError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let messages = std::fs::read_to_string(messages_path)?;
    let message = messages.lines().filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|message| message["id"].as_str() == Some(msg_id))
        .ok_or_else(|| MailboxError::NotFound(format!("message '{msg_id}' not found")))?;
    let receipts = match std::fs::read_to_string(reads_path) {
        Ok(receipts) => receipts,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    Ok(is_message_read(&receipts, &message))
}

/// Pure inbox query: returns messages addressed to caller, newest-first, read-annotated.
pub fn inbox(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    unread_only: bool,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    inbox_locked(messages_path, reads_path, caller, caller_pane, unread_only, limit)
}

fn inbox_locked(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    unread_only: bool,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError> {
    let msgs_content = if messages_path.exists() {
        std::fs::read_to_string(messages_path)?
    } else {
        String::new()
    };
    let reads_content = if reads_path.exists() {
        std::fs::read_to_string(reads_path)?
    } else {
        String::new()
    };

    let clamped_limit = if limit == 0 { 100 } else { limit.min(2000) };
    let mut results = Vec::new();

    for line in msgs_content.lines().rev() {
        if results.len() >= clamped_limit {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if !matches_recipient(&v, caller, caller_pane) {
            continue;
        }
        let read = is_message_read(&reads_content, &v);
        if unread_only && read {
            continue;
        }
        let mut envelope: MessageEnvelope = serde_json::from_value(v)?;
        envelope = normalize_envelope(envelope);
        envelope.read = read;
        results.push(envelope);
    }

    Ok(results)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SearchScope {
    Sent,
    Received,
    All,
}

/// Pure search query: returns messages sent or received, newest-first, read-annotated.
pub fn search(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    scope: SearchScope,
    q: Option<&str>,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    search_locked(messages_path, reads_path, caller, caller_pane, scope, q, limit)
}

fn search_locked(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    scope: SearchScope,
    q: Option<&str>,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError> {
    let msgs_content = if messages_path.exists() {
        std::fs::read_to_string(messages_path)?
    } else {
        String::new()
    };
    let reads_content = if reads_path.exists() {
        std::fs::read_to_string(reads_path)?
    } else {
        String::new()
    };

    let clamped_limit = if limit == 0 { 100 } else { limit.min(2000) };
    let q_lc = q.map(|s| s.to_lowercase());
    let mut results = Vec::new();

    for line in msgs_content.lines().rev() {
        if results.len() >= clamped_limit {
            break;
        }
        if let Some(ref query) = q_lc {
            if !line.to_lowercase().contains(query) {
                continue;
            }
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let is_recv = matches_recipient(&v, caller, caller_pane);
        let is_sent = matches_sender(&v, caller, caller_pane);
        let matched = match scope {
            SearchScope::Received => is_recv,
            SearchScope::Sent => is_sent,
            SearchScope::All => is_recv || is_sent,
        };
        if !matched {
            continue;
        }
        let read = is_message_read(&reads_content, &v);
        let mut envelope: MessageEnvelope = serde_json::from_value(v)?;
        envelope = normalize_envelope(envelope);
        envelope.read = read;
        results.push(envelope);
    }

    Ok(results)
}

/// Explicit recipient-only acknowledgement.
/// Invariants:
/// - Message must exist.
/// - Caller must be verified recipient.
/// - Repeated calls are idempotent and do NOT append duplicate receipts.
pub fn acknowledge_message(
    reads_path: &Path,
    messages_path: &Path,
    msg_id: &str,
    caller: &Principal,
    caller_pane: Option<&str>,
) -> Result<ReadReceipt, MailboxError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    acknowledge_message_locked(reads_path, messages_path, msg_id, caller, caller_pane)
}

fn acknowledge_message_locked(
    reads_path: &Path,
    messages_path: &Path,
    msg_id: &str,
    caller: &Principal,
    caller_pane: Option<&str>,
) -> Result<ReadReceipt, MailboxError> {
    let msg_id = msg_id.trim();
    if msg_id.is_empty() {
        return Err(MailboxError::Validation("message id must not be empty".into()));
    }

    if !messages_path.exists() {
        return Err(MailboxError::NotFound(format!("message '{msg_id}' not found")));
    }
    let msgs_content = std::fs::read_to_string(messages_path)?;
    let mut target_msg = None;
    for line in msgs_content.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v["id"].as_str() == Some(msg_id) {
                target_msg = Some(v);
                break;
            }
        }
    }

    let msg = target_msg.ok_or_else(|| MailboxError::NotFound(format!("message '{msg_id}' not found")))?;

    if !matches_recipient(&msg, caller, caller_pane) {
        return Err(MailboxError::Forbidden(format!(
            "caller '{}' is not the recipient of message '{msg_id}'",
            caller.to_key()
        )));
    }

    // Determine canonical recipient key for this message
    let caller_key = caller.to_key();
    let canonical_to = msg
        .get("toPrincipal")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&caller_key);

    if reads_path.exists() {
        let reads_content = std::fs::read_to_string(reads_path)?;
        for line in reads_content.lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v["msgId"].as_str() == Some(msg_id) {
                    if v["readerPrincipal"].as_str() == Some(canonical_to)
                        || v["readerPrincipal"].as_str() == Some(&caller_key)
                    {
                        return Ok(ReadReceipt {
                            msg_id: msg_id.to_string(),
                            reader_principal: canonical_to.to_string(),
                            reader_label: v["reader"].as_str().unwrap_or("").to_string(),
                            ts: v["ts"].as_u64().unwrap_or(0),
                        });
                    }
                }
            }
        }
    }

    let ts = now_ms();
    let receipt = ReadReceipt {
        msg_id: msg_id.to_string(),
        reader_principal: canonical_to.to_string(),
        reader_label: caller_key.clone(),
        ts,
    };
    let serialized = serde_json::to_string(&receipt)?;
    append_line(reads_path, &serialized)?;
    Ok(receipt)
}

/// Explicit check operation: fetches unread messages AND acknowledges only the returned batch.
/// Returns envelopes with `read: true` reflecting the atomic acknowledgment.
pub fn check_inbox(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError> {
    check_inbox_with_ack(messages_path, reads_path, caller, caller_pane, limit, None)
}

pub const MAX_ACK_IDS: usize = 2000;

/// With ack_ids present, acknowledge only the explicitly confirmed prior batch.
/// Newly returned messages stay unread so a lost reply can be fetched again.
/// Omitting ack_ids retains the original fetch-and-ack behavior.
pub fn check_inbox_with_ack(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    limit: usize,
    ack_ids: Option<&[String]>,
) -> Result<Vec<MessageEnvelope>, MailboxError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ids) = ack_ids {
        if ids.len() > MAX_ACK_IDS {
            return Err(MailboxError::Validation(format!("ack_ids exceeds {MAX_ACK_IDS} entries")));
        }
        let mut unique = HashSet::new();
        let mut confirmed = Vec::new();
        for id in ids {
            let id = id.trim();
            if id.is_empty() || id.len() > 128 {
                return Err(MailboxError::Validation("ack_ids contains an invalid message ID".into()));
            }
            if unique.insert(id) {
                confirmed.push(id);
            }
        }
        if !confirmed.is_empty() {
            let messages = if messages_path.exists() {
                std::fs::read_to_string(messages_path)?
            } else {
                String::new()
            };
            let by_id: HashMap<String, serde_json::Value> = messages.lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter_map(|message| message["id"].as_str().map(str::to_owned).map(|id| (id, message)))
                .collect();
            // Validate the WHOLE batch before any receipt is appended.
            // Pane hints and display labels never substitute for recipient authority.
            for id in &confirmed {
                let message = by_id.get(*id)
                    .ok_or_else(|| MailboxError::NotFound(format!("message '{id}' not found")))?;
                if !matches_recipient(message, caller, caller_pane) {
                    return Err(MailboxError::Forbidden(format!("caller is not the recipient of message '{id}'")));
                }
            }
            for id in confirmed {
                acknowledge_message_locked(reads_path, messages_path, id, caller, caller_pane)?;
            }
        }
        return inbox_locked(messages_path, reads_path, caller, caller_pane, true, limit);
    }
    let mut unread_messages = inbox_locked(messages_path, reads_path, caller, caller_pane, true, limit)?;
    for msg in &mut unread_messages {
        let _ = acknowledge_message_locked(reads_path, messages_path, &msg.id, caller, caller_pane)?;
        msg.read = true;
    }
    Ok(unread_messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn temp_test_paths(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let ts = now_ms();
        let mut random_bytes = [0u8; 8];
        let _ = getrandom::getrandom(&mut random_bytes);
        let hex_rand: String = random_bytes.iter().map(|b| format!("{b:02x}")).collect();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest.parent().unwrap_or(&manifest);
        let dir = root
            .join("target")
            .join("test_fixtures")
            .join(format!("{name}_{ts}_{hex_rand}"));
        let _ = std::fs::create_dir_all(&dir);
        let msgs = dir.join("messages.jsonl");
        let reads = dir.join("message-reads.jsonl");
        let bindings = dir.join("bindings.json");
        (msgs, reads, bindings)
    }

    #[test]
    fn test_canonical_principal_beats_label_or_pane_bypass() {
        let (msgs_p, reads_p, _) = temp_test_paths("bypass");
        let alice = Principal::Agent("alice".into());
        let bob = Principal::Agent("bob".into());

        // Send canonical envelope to alice
        let id = send_message(
            &msgs_p,
            SendParams {
                from: &bob,
                to: &alice,
                subject: "secret",
                body: "for alice eyes only",
                to_pane_hint: Some("pane-123"),
                from_pane_hint: None,
                to_label: Some("Alice"),
                from_label: Some("Bob"),
                idempotency_key: None,
            },
        )
        .unwrap();

        // 1. Bob presenting Alice's display label cannot read it
        let bob_fake_label = Principal::Agent("bob".into());
        let bob_inbox = inbox(&msgs_p, &reads_p, &bob_fake_label, None, false, 50).unwrap();
        assert!(bob_inbox.is_empty(), "bob should not receive alice's mail");

        // 2. Attacker in pane-123 without alice principal cannot read canonical agent mail
        let intruder_in_pane = Principal::Agent("mallory".into());
        let pane_inbox = inbox(&msgs_p, &reads_p, &intruder_in_pane, Some("pane-123"), false, 50).unwrap();
        assert!(pane_inbox.is_empty(), "intruder in pane cannot read canonical agent mail");

        // 3. Alice can read it
        let alice_inbox = inbox(&msgs_p, &reads_p, &alice, None, false, 50).unwrap();
        assert_eq!(alice_inbox.len(), 1);
        assert_eq!(alice_inbox[0].id, id);
    }

    #[test]
    fn test_pane_mailbox_delegation() {
        let (msgs_p, reads_p, _) = temp_test_paths("delegation");
        let sender = Principal::System;
        let pane_principal = Principal::Pane("pane-target-123".into());

        // Message explicitly addressed to pane mailbox
        let id = send_message(
            &msgs_p,
            SendParams {
                from: &sender,
                to: &pane_principal,
                subject: "pane task",
                body: "execute task in this pane",
                to_pane_hint: Some("pane-target-123"),
                from_pane_hint: None,
                to_label: Some("Worker Pane"),
                from_label: Some("System"),
                idempotency_key: None,
            },
        )
        .unwrap();

        // Agent bound to pane-target-123 has delegated access
        let agent_occupant = Principal::Agent("occupant_agent".into());
        let inbox_res = inbox(&msgs_p, &reads_p, &agent_occupant, Some("pane-target-123"), false, 10).unwrap();
        assert_eq!(inbox_res.len(), 1);
        assert_eq!(inbox_res[0].id, id);

        // Another agent NOT bound to that pane has no access
        let other_agent = Principal::Agent("other_agent".into());
        let other_inbox = inbox(&msgs_p, &reads_p, &other_agent, Some("pane-other-456"), false, 10).unwrap();
        assert!(other_inbox.is_empty());
    }

    #[test]
    fn test_two_identities_sharing_display_label_stay_isolated() {
        let (msgs_p, reads_p, _) = temp_test_paths("shared_label");
        let alice_team = Principal::Agent("team_a/alice".into());
        let alice_other = Principal::Agent("team_b/alice".into());

        let id = send_message(
            &msgs_p,
            SendParams {
                from: &Principal::System,
                to: &alice_team,
                subject: "role assignment",
                body: "welcome to team a",
                to_pane_hint: None,
                from_pane_hint: None,
                to_label: Some("Alice"), // shared display label
                from_label: Some("System"),
                idempotency_key: None,
            },
        )
        .unwrap();

        // team_b/alice cannot see team_a/alice's message
        let inbox_b = inbox(&msgs_p, &reads_p, &alice_other, None, false, 50).unwrap();
        assert!(inbox_b.is_empty(), "shared display label must not expose mail to wrong principal");

        // team_a/alice can see it
        let inbox_a = inbox(&msgs_p, &reads_p, &alice_team, None, false, 50).unwrap();
        assert_eq!(inbox_a.len(), 1);
        assert_eq!(inbox_a[0].id, id);
    }

    #[test]
    fn test_recipient_only_acknowledgement() {
        let (msgs_p, reads_p, _) = temp_test_paths("recipient_ack");
        let alice = Principal::Agent("alice".into());
        let eve = Principal::Agent("eve".into());

        let id = send_message(
            &msgs_p,
            SendParams {
                from: &Principal::System,
                to: &alice,
                subject: "urgent",
                body: "action required",
                to_pane_hint: None,
                from_pane_hint: None,
                to_label: Some("Alice"),
                from_label: Some("System"),
                idempotency_key: None,
            },
        )
        .unwrap();

        // Eve tries to ack Alice's message -> 403 Forbidden
        let eve_err = acknowledge_message(&reads_p, &msgs_p, &id, &eve, None);
        assert!(matches!(eve_err, Err(MailboxError::Forbidden(_))));

        // Nonexistent message ID -> 404 Not Found
        let missing_err = acknowledge_message(&reads_p, &msgs_p, "msg_nonexistent", &alice, None);
        assert!(matches!(missing_err, Err(MailboxError::NotFound(_))));

        // Alice acks -> Success
        let receipt = acknowledge_message(&reads_p, &msgs_p, &id, &alice, None).unwrap();
        assert_eq!(receipt.msg_id, id);
        assert_eq!(receipt.reader_principal, alice.to_key());
    }

    #[test]
    fn test_legacy_file_deserialization_and_receipt_isolation() {
        let (msgs_p, reads_p, _) = temp_test_paths("legacy_isolation");
        let alice = Principal::Agent("alice".into());

        // 1. Write an actual legacy JSONL line without toPrincipal/fromPrincipal
        let legacy_line = serde_json::json!({
            "id": "msg_legacy_1",
            "ts": 1000,
            "from": "bob",
            "fromKind": "agent",
            "fromPane": "",
            "toPane": "",
            "to": "alice",
            "subject": "legacy hello",
            "body": "legacy body content"
        }).to_string();
        std::fs::write(&msgs_p, format!("{legacy_line}\n")).unwrap();

        // 2. Write a legacy read receipt with reader: "Alice" (display label)
        let legacy_receipt = serde_json::json!({
            "msgId": "msg_canonical_2",
            "reader": "Alice",
            "ts": 1005
        }).to_string();
        std::fs::write(&reads_p, format!("{legacy_receipt}\n")).unwrap();

        // 3. Write a NEW canonical message to agent:alice with display label "Alice"
        let id_canon = send_message(
            &msgs_p,
            SendParams {
                from: &Principal::System,
                to: &alice,
                subject: "canonical",
                body: "canonical content",
                to_pane_hint: None,
                from_pane_hint: None,
                to_label: Some("Alice"),
                from_label: Some("System"),
                idempotency_key: None,
            },
        ).unwrap();

        // Verify: Legacy message deserializes cleanly without error
        let alice_all = inbox(&msgs_p, &reads_p, &alice, None, false, 10).unwrap();
        assert_eq!(alice_all.len(), 2, "both legacy and canonical envelopes must be returned");

        // Verify: Canonical message is NOT marked read by the legacy reader receipt with matching label!
        let canon_in_inbox = alice_all.iter().find(|m| m.id == id_canon).unwrap();
        assert!(!canon_in_inbox.read, "canonical envelope must NOT fall through to legacy label receipt");

        // Now acknowledge canonical message properly
        acknowledge_message(&reads_p, &msgs_p, &id_canon, &alice, None).unwrap();
        let unread_remaining = inbox(&msgs_p, &reads_p, &alice, None, true, 10).unwrap();
        assert_eq!(unread_remaining.len(), 1);
        assert_eq!(unread_remaining[0].id, "msg_legacy_1");
    }

    #[test]
    fn test_concurrent_same_key_sends() {
        let (msgs_p, _, _) = temp_test_paths("concurrent_send");
        let msgs_arc = Arc::new(msgs_p);
        let sender = Principal::Agent("sender_agent".into());
        let recipient = Principal::Agent("target_agent".into());
        let key = "shared_idempotency_key";

        let mut handles = Vec::new();
        for _ in 0..10 {
            let p = Arc::clone(&msgs_arc);
            let s = sender.clone();
            let r = recipient.clone();
            handles.push(thread::spawn(move || {
                send_message(
                    &p,
                    SendParams {
                        from: &s,
                        to: &r,
                        subject: "concurrent job",
                        body: "concurrent payload",
                        to_pane_hint: None,
                        from_pane_hint: None,
                        to_label: None,
                        from_label: None,
                        idempotency_key: Some(key),
                    },
                )
            }));
        }

        let mut returned_ids = Vec::new();
        for h in handles {
            let res = h.join().unwrap();
            assert!(res.is_ok(), "concurrent idempotent send must succeed");
            returned_ids.push(res.unwrap());
        }

        // All 10 threads got the exact same message ID
        let first_id = &returned_ids[0];
        for id in &returned_ids {
            assert_eq!(id, first_id);
        }

        // File must contain exactly ONE message line
        let file_content = std::fs::read_to_string(&*msgs_arc).unwrap();
        assert_eq!(file_content.lines().count(), 1, "exactly one message line must be written");
    }

    #[test]
    fn test_concurrent_acknowledgements() {
        let (msgs_p, reads_p, _) = temp_test_paths("concurrent_ack");
        let alice = Principal::Agent("alice".into());
        let id = send_message(
            &msgs_p,
            SendParams {
                from: &Principal::System,
                to: &alice,
                subject: "ping",
                body: "ping payload",
                to_pane_hint: None,
                from_pane_hint: None,
                to_label: None,
                from_label: None,
                idempotency_key: None,
            },
        ).unwrap();

        let msgs_arc = Arc::new(msgs_p);
        let reads_arc = Arc::new(reads_p);
        let id_arc = Arc::new(id);

        let mut handles = Vec::new();
        for _ in 0..10 {
            let m = Arc::clone(&msgs_arc);
            let r = Arc::clone(&reads_arc);
            let i = Arc::clone(&id_arc);
            let a = alice.clone();
            handles.push(thread::spawn(move || {
                acknowledge_message(&r, &m, &i, &a, None)
            }));
        }

        for h in handles {
            let res = h.join().unwrap();
            assert!(res.is_ok(), "concurrent ack must succeed");
        }

        // Receipt file must contain exactly ONE receipt line
        let content = std::fs::read_to_string(&*reads_arc).unwrap();
        assert_eq!(content.lines().count(), 1, "concurrent ack must not produce duplicate lines");
    }

    #[test]
    fn test_metadata_bounds() {
        let (msgs_p, _, _) = temp_test_paths("bounds");
        let sender = Principal::Agent("sender".into());
        let recipient = Principal::Agent("recipient".into());

        // Body over 16KB fails
        let huge_body = "x".repeat(MAX_BODY_CHARS + 1);
        let err1 = send_message(&msgs_p, SendParams {
            from: &sender,
            to: &recipient,
            subject: "test",
            body: &huge_body,
            to_pane_hint: None,
            from_pane_hint: None,
            to_label: None,
            from_label: None,
            idempotency_key: None,
        });
        assert!(matches!(err1, Err(MailboxError::Validation(_))));

        // Subject over 512 chars fails
        let huge_sub = "s".repeat(MAX_SUBJECT_CHARS + 1);
        let err2 = send_message(&msgs_p, SendParams {
            from: &sender,
            to: &recipient,
            subject: &huge_sub,
            body: "ok body",
            to_pane_hint: None,
            from_pane_hint: None,
            to_label: None,
            from_label: None,
            idempotency_key: None,
        });
        assert!(matches!(err2, Err(MailboxError::Validation(_))));

        // Idempotency key over 256 chars fails
        let huge_key = "k".repeat(MAX_IDEMPOTENCY_KEY_CHARS + 1);
        let err3 = send_message(&msgs_p, SendParams {
            from: &sender,
            to: &recipient,
            subject: "sub",
            body: "ok body",
            to_pane_hint: None,
            from_pane_hint: None,
            to_label: None,
            from_label: None,
            idempotency_key: Some(&huge_key),
        });
        assert!(matches!(err3, Err(MailboxError::Validation(_))));
    }

    #[test]
    fn test_binding_store_staged_save_failure_leaves_memory_untouched() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest.parent().unwrap_or(&manifest);
        let unwritable_dir = root.join("target").join("test_fixtures").join("unwritable_binding_dir");
        let _ = std::fs::create_dir_all(&unwritable_dir);
        // Pointing file path directly to an existing directory causes writing/creating a file to fail on all OSes
        let file_path = unwritable_dir;

        // If file_path is unwritable on save:
        let store = BindingStore {
            path: file_path,
            records: Mutex::new(vec![BindingRecord {
                agent: "existing_agent".into(),
                pane: "existing_pane".into(),
                bound_at: 100,
            }]),
        };

        // Try to bind new agent
        let res = store.bind_internal("new_agent", "new_pane");
        assert!(res.is_err(), "save failure must return Error");

        // Verify in-memory state is UNCHANGED:
        assert_eq!(store.pane_for_agent("existing_agent"), Some("existing_pane".into()));
        assert_eq!(store.agent_for_pane("existing_pane"), Some("existing_agent".into()));
        assert_eq!(store.pane_for_agent("new_agent"), None);
        assert_eq!(store.agent_for_pane("new_pane"), None);
    }

    #[test]
    fn test_check_inbox_atomicity_and_read_true() {
        let (msgs_p, reads_p, _) = temp_test_paths("check_atomicity");
        let alice = Principal::Agent("alice".into());

        for i in 1..=3 {
            send_message(
                &msgs_p,
                SendParams {
                    from: &Principal::System,
                    to: &alice,
                    subject: &format!("msg {i}"),
                    body: &format!("body {i}"),
                    to_pane_hint: None,
                    from_pane_hint: None,
                    to_label: None,
                    from_label: None,
                    idempotency_key: None,
                },
            ).unwrap();
        }

        // check_inbox returns 2 messages with read = true
        let checked = check_inbox(&msgs_p, &reads_p, &alice, None, 2).unwrap();
        assert_eq!(checked.len(), 2);
        for m in &checked {
            assert!(m.read, "returned envelopes from check_inbox must have read: true");
        }

        // Remaining unread is exactly 1
        let unread = inbox(&msgs_p, &reads_p, &alice, None, true, 10).unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].subject, "msg 1");
    }

    #[test]
    fn read_status_counts_only_canonical_recipient_receipts() {
        let (messages, reads, _) = temp_test_paths("read_status_isolation");
        let recipient = Principal::Agent("recipient".into());
        let id = send_test_mail(&messages, &recipient, "pane-a");
        // Display-label and unrelated-principal receipts cannot mark canonical mail read.
        std::fs::write(&reads, format!("{}\n{}\n",
            serde_json::json!({"msgId": id, "reader": "Shared Display Name", "ts": 1}),
            serde_json::json!({"msgId": id, "readerPrincipal": "agent:sender", "ts": 2}),
        )).unwrap();
        assert!(!recipient_has_read(&messages, &reads, &id).unwrap());
        acknowledge_message(&reads, &messages, &id, &recipient, None).unwrap();
        assert!(recipient_has_read(&messages, &reads, &id).unwrap());
        assert!(matches!(recipient_has_read(&messages, &reads, "missing"),
            Err(MailboxError::NotFound(_))));
    }

    #[test]
    fn reliable_check_replays_lost_reply_and_reack_is_idempotent() {
        let (messages, reads, _) = temp_test_paths("reliable_replay");
        let recipient = Principal::Agent("recipient".into());
        let first = send_test_mail(&messages, &recipient, "pane-a");
        let fetch = |ack: &[String]| check_inbox_with_ack(
            &messages, &reads, &recipient, None, 10, Some(ack)).unwrap();
        let lost = fetch(&[]);
        assert_eq!(lost.len(), 1);
        assert_eq!(lost[0].id, first);
        assert!(!lost[0].read);
        assert!(!reads.exists());
        assert_eq!(fetch(&[]), lost, "lost response must remain available on retry");
        assert_eq!(inbox(&messages, &reads, &recipient, None, true, 10).unwrap(), lost);
        let second = send_test_mail(&messages, &recipient, "pane-a");
        let confirmed = vec![first.clone(), first.clone()];
        let next = fetch(&confirmed);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].id, second);
        assert!(!next[0].read);
        assert_eq!(fetch(&confirmed), next, "retrying the same checkpoint must not ack the new batch");
        assert_eq!(std::fs::read_to_string(&reads).unwrap().lines().count(), 1);
        assert!(recipient_has_read(&messages, &reads, &first).unwrap());
        assert!(!recipient_has_read(&messages, &reads, &second).unwrap());
        acknowledge_message(&reads, &messages, &second, &recipient, None).unwrap();
        assert!(fetch(&[]).is_empty(), "msg_read also confirms reliable batches");
    }

    #[test]
    fn reliable_check_rejects_entire_foreign_or_missing_batch_before_writing() {
        let (messages, reads, _) = temp_test_paths("reliable_atomic_auth");
        let recipient = Principal::Agent("recipient".into());
        let own = send_test_mail(&messages, &recipient, "pane-a");
        let foreign = send_test_mail(&messages, &Principal::Agent("foreign".into()), "pane-a");
        let result = check_inbox_with_ack(&messages, &reads, &recipient, None, 10,
            Some(&[own.clone(), foreign]));
        assert!(matches!(result, Err(MailboxError::Forbidden(_))));
        assert!(!reads.exists(), "foreign ID must not partially acknowledge the valid ID");
        let missing = check_inbox_with_ack(&messages, &reads, &recipient, None, 10,
            Some(&[own.clone(), "missing".into()]));
        assert!(matches!(missing, Err(MailboxError::NotFound(_))));
        assert!(!reads.exists());
        assert_eq!(inbox(&messages, &reads, &recipient, None, true, 10).unwrap()[0].id, own);
    }

    #[test]
    fn reliable_check_bounds_and_validates_ids_before_writing() {
        let (messages, reads, _) = temp_test_paths("reliable_bounds");
        let recipient = Principal::Agent("recipient".into());
        let own = send_test_mail(&messages, &recipient, "pane-a");
        for batch in [vec![own.clone(); MAX_ACK_IDS + 1],
            vec![own.clone(), String::new()], vec![own.clone(), "x".repeat(129)]] {
            assert!(matches!(check_inbox_with_ack(&messages, &reads, &recipient, None, 10,
                Some(&batch)), Err(MailboxError::Validation(_))));
            assert!(!reads.exists());
        }
    }

    #[test]
    fn omitted_ack_ids_preserves_automatic_acknowledgement() {
        let (messages, reads, _) = temp_test_paths("reliable_compat");
        let recipient = Principal::Agent("recipient".into());
        send_test_mail(&messages, &recipient, "pane-a");
        let checked = check_inbox_with_ack(&messages, &reads, &recipient, None, 10, None).unwrap();
        assert_eq!(checked.len(), 1);
        assert!(checked[0].read);
        assert!(check_inbox(&messages, &reads, &recipient, None, 10).unwrap().is_empty());
    }

    #[test]
    fn reliable_ack_does_not_retain_pane_authority_after_rebind() {
        let (messages, reads, bindings) = temp_test_paths("reliable_rebind");
        let store = BindingStore::new(bindings).unwrap();
        store.verify_and_bind("worker", "pane-a", ProofOfResidency::System, |_, _| false).unwrap();
        let worker = Principal::Agent("worker".into());
        let pane_a = Principal::Pane("pane-a".into());
        let id = send_test_mail(&messages, &pane_a, "pane-a");
        let (principal, residency) = store.mailbox_identity(&worker, |_| true).unwrap();
        let batch = check_inbox_with_ack(&messages, &reads, &principal, residency.as_deref(), 10,
            Some(&[])).unwrap();
        assert_eq!(batch[0].id, id);
        store.verify_and_bind("worker", "pane-b", ProofOfResidency::System, |_, _| false).unwrap();
        let (principal, residency) = store.mailbox_identity(&worker, |_| true).unwrap();
        assert!(matches!(check_inbox_with_ack(&messages, &reads, &principal, residency.as_deref(), 10,
            Some(&[id.clone()])), Err(MailboxError::Forbidden(_))));
        assert!(!reads.exists());
        let (principal, residency) = store.mailbox_identity(&pane_a, |_| true).unwrap();
        assert!(check_inbox_with_ack(&messages, &reads, &principal, residency.as_deref(), 10,
            Some(&[id])).unwrap().is_empty());
    }

    fn send_test_mail(path: &Path, recipient: &Principal, pane: &str) -> String {
        send_message(path, SendParams {
            from: &Principal::Agent("sender".into()),
            to: recipient,
            subject: "assignment",
            body: "private task",
            to_pane_hint: Some(pane),
            from_pane_hint: None,
            to_label: Some("Shared Display Name"),
            from_label: None,
            idempotency_key: None,
        }).unwrap()
    }

    #[test]
    fn pane_address_is_readable_with_either_verified_credential() {
        let (msgs, reads, bindings) = temp_test_paths("pane_credentials");
        let store = BindingStore::new(bindings).unwrap();
        store.verify_and_bind("worker", "pane-a", ProofOfResidency::PaneToken("credential"),
            |pane, token| pane == "pane-a" && token == "credential").unwrap();
        let agent = Principal::Agent("worker".into());
        let pane = Principal::Pane("pane-a".into());
        let id = send_test_mail(&msgs, &pane, "pane-a");

        for credential in [&agent, &pane] {
            let (principal, residency) = store.mailbox_identity(credential, |_| true).unwrap();
            let preview = inbox(&msgs, &reads, &principal, residency.as_deref(), true, 10).unwrap();
            assert_eq!(preview.len(), 1);
            assert_eq!(preview[0].id, id);
            assert!(!preview[0].read, "inbox must not acknowledge");
        }
        let (principal, residency) = store.mailbox_identity(&agent, |_| true).unwrap();
        let checked = check_inbox(&msgs, &reads, &principal, residency.as_deref(), 10).unwrap();
        assert_eq!(checked.len(), 1);
        assert!(checked[0].read);
        let (principal, residency) = store.mailbox_identity(&pane, |_| true).unwrap();
        assert!(inbox(&msgs, &reads, &principal, residency.as_deref(), true, 10).unwrap().is_empty());
        let receipt = acknowledge_message(&reads, &msgs, &id, &principal, residency.as_deref()).unwrap();
        assert_eq!(receipt.reader_principal, "pane:pane-a");
        assert_eq!(std::fs::read_to_string(reads).unwrap().lines().count(), 1);
    }

    #[test]
    fn old_agent_addressed_pane_mail_is_visible_to_verified_pane_token() {
        let (msgs, reads, bindings) = temp_test_paths("old_agent_address");
        let store = BindingStore::new(bindings).unwrap();
        store.verify_and_bind("worker", "pane-a", ProofOfResidency::System, |_, _| false).unwrap();
        let agent = Principal::Agent("worker".into());
        let pane = Principal::Pane("pane-a".into());
        // The old send path stored this canonical agent key with a pane hint.
        let id = send_test_mail(&msgs, &agent, "pane-a");
        let (principal, residency) = store.mailbox_identity(&pane, |_| true).unwrap();
        assert_eq!(principal, agent);
        let preview = inbox(&msgs, &reads, &principal, residency.as_deref(), true, 10).unwrap();
        assert_eq!(preview.len(), 1);
        assert!(!preview[0].read);
        let found = search(&msgs, &reads, &principal, residency.as_deref(),
            SearchScope::Received, None, 10).unwrap();
        assert_eq!(found[0].id, id);
        let checked = check_inbox(&msgs, &reads, &principal, residency.as_deref(), 10).unwrap();
        assert_eq!(checked.len(), 1);
        assert!(checked[0].read);
        let receipt = acknowledge_message(&reads, &msgs, &id, &principal, residency.as_deref()).unwrap();
        assert_eq!(receipt.reader_principal, agent.to_key());
        assert!(inbox(&msgs, &reads, &agent, None, true, 10).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(reads).unwrap().lines().count(), 1);
    }

    #[test]
    fn pane_mail_stays_at_its_address_when_agent_moves() {
        let (msgs, reads, bindings) = temp_test_paths("pane_rebind");
        let store = BindingStore::new(bindings).unwrap();
        store.verify_and_bind("worker", "pane-a", ProofOfResidency::System, |_, _| false).unwrap();
        let pane = Principal::Pane("pane-a".into());
        let id = send_test_mail(&msgs, &pane, "pane-a");
        store.verify_and_bind("worker", "pane-b", ProofOfResidency::System, |_, _| false).unwrap();

        for credential in [Principal::Agent("worker".into()), Principal::Pane("pane-b".into())] {
            let (principal, residency) = store.mailbox_identity(&credential, |_| true).unwrap();
            assert!(inbox(&msgs, &reads, &principal, residency.as_deref(), false, 10).unwrap().is_empty());
            assert!(check_inbox(&msgs, &reads, &principal, residency.as_deref(), 10).unwrap().is_empty());
            assert!(matches!(acknowledge_message(&reads, &msgs, &id, &principal, residency.as_deref()),
                Err(MailboxError::Forbidden(_))));
        }
        let (principal, residency) = store.mailbox_identity(&pane, |_| true).unwrap();
        assert_eq!(principal, pane);
        let receipt = acknowledge_message(&reads, &msgs, &id, &principal, residency.as_deref()).unwrap();
        assert_eq!(receipt.reader_principal, pane.to_key());
    }

    #[test]
    fn pane_hint_or_replacement_binding_cannot_grant_old_agents_mail() {
        let (msgs, reads, bindings) = temp_test_paths("binding_isolation");
        let store = BindingStore::new(bindings).unwrap();
        let old = Principal::Agent("old-worker".into());
        let pane = Principal::Pane("pane-a".into());
        let id = send_test_mail(&msgs, &old, "pane-a");
        // Same pane hint, but no verified binding: no authority.
        let (principal, residency) = store.mailbox_identity(&pane, |_| true).unwrap();
        assert!(inbox(&msgs, &reads, &principal, residency.as_deref(), false, 10).unwrap().is_empty());
        store.verify_and_bind("new-worker", "pane-a", ProofOfResidency::System, |_, _| false).unwrap();
        for credential in [pane, Principal::Agent("new-worker".into()),
            Principal::Agent("Shared Display Name".into()), Principal::Agent("sender".into())] {
            let (principal, residency) = store.mailbox_identity(&credential, |_| true).unwrap();
            assert!(inbox(&msgs, &reads, &principal, residency.as_deref(), false, 10).unwrap().is_empty());
            assert!(check_inbox(&msgs, &reads, &principal, residency.as_deref(), 10).unwrap().is_empty());
            assert!(matches!(acknowledge_message(&reads, &msgs, &id, &principal, residency.as_deref()),
                Err(MailboxError::Forbidden(_))));
        }
        assert!(!reads.exists(), "unauthorized checks must not create receipts");
    }

    #[test]
    fn inactive_pane_and_invalid_residency_proof_grant_no_delegation() {
        let (_, _, bindings) = temp_test_paths("inactive_binding");
        let store = BindingStore::new(bindings).unwrap();
        assert!(matches!(store.verify_and_bind("worker", "pane-a",
            ProofOfResidency::PaneToken("wrong"), |_, _| false), Err(MailboxError::Forbidden(_))));
        let agent = Principal::Agent("worker".into());
        assert_eq!(store.mailbox_identity(&agent, |_| true).unwrap(), (agent.clone(), None));
        store.verify_and_bind("worker", "pane-a", ProofOfResidency::System, |_, _| false).unwrap();
        assert_eq!(store.mailbox_identity(&agent, |_| false).unwrap(), (agent, None));
        assert!(matches!(store.mailbox_identity(&Principal::Pane("pane-a".into()), |_| false),
            Err(MailboxError::Unauthorized)));
    }

    #[test]
    fn test_unique_128bit_random_ids() {
        let mut ids = HashSet::new();
        let ts = now_ms();
        for _ in 0..1000 {
            let id = generate_message_id(ts).unwrap();
            assert!(id.starts_with("msg_"));
            let parts: Vec<&str> = id.split('_').collect();
            assert_eq!(parts.len(), 3);
            assert_eq!(parts[2].len(), 32, "must contain 32 hex chars (128 bits)");
            assert!(ids.insert(id), "collision detected in 128-bit random IDs");
        }
    }

    #[test]
    fn test_binding_store_new_fails_on_malformed_json() {
        let (msgs_p, _, bindings_p) = temp_test_paths("malformed");
        std::fs::write(&bindings_p, "this is not valid json! { [").unwrap();

        let res = BindingStore::new(bindings_p);
        assert!(res.is_err(), "BindingStore::new must return Error on malformed data, not silently reset");
    }
}
