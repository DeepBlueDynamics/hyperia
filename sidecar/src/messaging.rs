//! Authenticated mailbox boundary shared by HTTP, MCP and pane notifications.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use crate::{AppState, bridge::Bridge, identity::CallerIdentity};
use crate::msgbus::mailbox::{self, BindingStore, MailboxError, Principal, ProofOfResidency};

pub type ApiError = (StatusCode, Json<serde_json::Value>);

pub struct MailContext {
    pub bindings: BindingStore,
    pub messages: PathBuf,
    pub reads: PathBuf,
}

static MAIL: OnceLock<Result<MailContext, String>> = OnceLock::new();

pub fn context() -> Result<&'static MailContext, ApiError> {
    MAIL.get_or_init(|| {
        let root = crate::fsnav::home_dir().join(".hyperia");
        Ok(MailContext {
            bindings: BindingStore::new(root.join("agent-bindings.json")).map_err(|e| e.to_string())?,
            messages: root.join("logs/messages.jsonl"),
            reads: root.join("logs/message-reads.jsonl"),
        })
    }).as_ref().map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))
}

pub fn error(status: StatusCode, message: impl ToString) -> ApiError {
    (status, Json(serde_json::json!({"ok": false, "error": message.to_string()})))
}

pub fn mailbox_error(e: MailboxError) -> ApiError {
    let status = match &e {
        MailboxError::Unauthorized => StatusCode::UNAUTHORIZED,
        MailboxError::Forbidden(_) => StatusCode::FORBIDDEN,
        MailboxError::NotFound(_) => StatusCode::NOT_FOUND,
        MailboxError::Conflict(_) => StatusCode::CONFLICT,
        MailboxError::Validation(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error(status, e)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MailActor {
    pub principal: Principal,
    pub label: String,
    pub pane: Option<String>,
    /// Authentication label used by the consent ledger, never a user-supplied name.
    pub requester: String,
}

pub async fn actor(bridge: &Bridge, headers: &HeaderMap) -> Result<MailActor, ApiError> {
    let id = bridge.resolve_caller(crate::bearer_token(headers).as_deref()).await;
    actor_from_identity(bridge, &id).await
}

pub async fn actor_from_identity(bridge: &Bridge, id: &CallerIdentity) -> Result<MailActor, ApiError> {
    if id.is_anonymous() { return Err(error(StatusCode::UNAUTHORIZED, "Authentication required for messaging.")); }
    let store = context()?;
    let requester = id.principal_key();
    match id {
        CallerIdentity::Anonymous => Err(error(StatusCode::UNAUTHORIZED, "Authentication required for messaging.")),
        CallerIdentity::System => Ok(MailActor { principal: Principal::System, label: "Hyperia".into(), pane: None, requester }),
        CallerIdentity::Agent { name, .. } => {
            let sessions = bridge.sessions().await;
            let (principal, pane) = store.bindings.mailbox_identity(
                &Principal::Agent(name.clone()), |pane| sessions.contains_key(pane),
            ).map_err(mailbox_error)?;
            Ok(MailActor { principal, label: id.label(), pane, requester })
        }
        CallerIdentity::Pane { pane, .. } => {
            let sessions = bridge.sessions().await;
            let (principal, _) = store.bindings.mailbox_identity(
                &Principal::Pane(pane.clone()), |pane| sessions.contains_key(pane),
            ).map_err(mailbox_error)?;
            let label = bridge.pane_display_name(pane).await.unwrap_or_else(|| pane.clone());
            Ok(MailActor { principal, label, pane: Some(pane.clone()), requester })
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SendRequest {
    pub window: Option<u32>,
    pub tab: Option<String>,
    pub pane: Option<String>,
    pub to_label: Option<String>,
    #[serde(default)]
    pub subject: String,
    pub body: String,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreparedMessage {
    pub sender: MailActor,
    pub recipient: Principal,
    pub recipient_label: String,
    pub target_pane: Option<String>,
    pub subject: String,
    pub body: String,
    pub idempotency_key: Option<String>,
}

fn normalized_name(s: &str) -> String {
    s.trim().trim_end_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

/// Resolve exactly one explicit target. Ambiguous names/prefixes fail closed.
pub async fn resolve_target(bridge: &Bridge, req: &SendRequest) -> Result<String, ApiError> {
    let sessions = bridge.sessions().await;
    let pane_arg = req.pane.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut candidates = Vec::new();
    for (uid, session) in sessions.iter() {
        if req.window.is_some_and(|w| w != session.window_id) { continue; }
        if let Some(tab) = &req.tab {
            if session.tab_name != *tab && session.root_tab_uid != *tab { continue; }
        } else if pane_arg.is_none() && !session.tab_active {
            continue;
        }
        if let Some(pane) = pane_arg {
            if uid != pane && !(pane.len() >= 4 && uid.starts_with(pane))
                && normalized_name(&session.shell_name) != normalized_name(pane) {
                continue;
            }
        } else if !session.pane_active {
            continue;
        }
        candidates.push(uid.clone());
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err(error(StatusCode::NOT_FOUND, "No active pane at that address.")),
        _ => Err(error(StatusCode::CONFLICT, "Ambiguous pane address; use its full pane ID.")),
    }
}

pub async fn prepare(bridge: &Bridge, headers: &HeaderMap, req: SendRequest) -> Result<PreparedMessage, ApiError> {
    let sender = actor(bridge, headers).await?;
    if req.body.trim().is_empty() || req.body.chars().count() > mailbox::MAX_BODY_CHARS {
        return Err(error(StatusCode::BAD_REQUEST, "Message body must contain 1–16384 characters."));
    }
    if req.subject.chars().count() > 512 || req.idempotency_key.as_ref().is_some_and(|s| s.is_empty() || s.len() > 128) {
        return Err(error(StatusCode::BAD_REQUEST, "Subject or idempotency key exceeds its limit."));
    }
    let has_pane = req.window.is_some() || req.tab.is_some() || req.pane.is_some();
    if has_pane && req.to_label.is_some() {
        return Err(error(StatusCode::BAD_REQUEST, "Use either a pane address or a registered agent name."));
    }
    let store = context()?;
    let (recipient, recipient_label, target_pane) = if has_pane {
        let pane = resolve_target(bridge, &req).await?;
        // Preserve the explicit address: pane mail belongs to the pane even if
        // its agent binding changes before delivery or before the next read.
        let principal = Principal::Pane(pane.clone());
        let label = bridge.pane_display_name(&pane).await.unwrap_or_else(|| pane.clone());
        (principal, label, Some(pane))
    } else {
        let name = req.to_label.as_deref().map(str::trim).filter(|s| !s.is_empty())
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "An explicit recipient is required."))?;
        // Parent labels remain parent mailboxes; child aliases resolve to an
        // immutable child principal before storage or permission checks.
        let (name, label) = bridge.identity().mail_address(name).await
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "Unknown registered agent or MCP session address."))?;
        let pane = store.bindings.pane_for_agent(&name);
        let pane = match pane {
            Some(pane) if bridge.sessions().await.contains_key(&pane) => Some(pane),
            _ => None,
        };
        (Principal::Agent(name), label, pane)
    };
    Ok(PreparedMessage {
        sender, recipient, recipient_label, target_pane,
        subject: req.subject.trim().into(), body: req.body, idempotency_key: req.idempotency_key,
    })
}

/// Called only after the shared operation executor verifies message authorization.
pub async fn store_approved(bridge: &Bridge, msg: &PreparedMessage) -> Result<String, ApiError> {
    let store = context()?;
    let id = mailbox::send_message(&store.messages, mailbox::SendParams {
        from: &msg.sender.principal, to: &msg.recipient,
        subject: &msg.subject, body: &msg.body,
        to_pane_hint: msg.target_pane.as_deref(), from_pane_hint: msg.sender.pane.as_deref(),
        to_label: Some(&msg.recipient_label), from_label: Some(&msg.sender.label),
        idempotency_key: msg.idempotency_key.as_deref(),
    }).map_err(mailbox_error)?;
    if let Some(pane) = &msg.target_pane {
        if msg.sender.pane.as_ref() != Some(pane) {
            bridge.arm_msg_notify(pane).await;
        }
    }
    Ok(id)
}

pub async fn unread_for_pane(bridge: &Bridge, pane: &str) -> Result<usize, ApiError> {
    let store = context()?;
    let sessions = bridge.sessions().await;
    let (principal, _) = store.bindings.mailbox_identity(
        &Principal::Pane(pane.into()), |pane| sessions.contains_key(pane),
    ).map_err(mailbox_error)?;
    Ok(mailbox::inbox(&store.messages, &store.reads, &principal, Some(pane), true, 2000)
        .map_err(mailbox_error)?.len())
}

fn limit(params: &HashMap<String, String>) -> usize {
    params.get("limit").and_then(|s| s.parse().ok()).unwrap_or(100).clamp(1, 2000)
}

pub async fn inbox(
    State(state): State<AppState>, headers: HeaderMap, Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let who = actor(&state.bridge, &headers).await?;
    let store = context()?;
    let unread = params.get("unread_only").is_some_and(|s| s == "1" || s == "true");
    let results = mailbox::inbox(&store.messages, &store.reads, &who.principal, who.pane.as_deref(), unread, limit(&params))
        .map_err(mailbox_error)?;
    if let Some(pane) = who.pane.as_deref() {
        state.bridge.clear_msg_notify_delivered(pane).await;
    }
    Ok(Json(serde_json::json!({"ok": true, "me": who.label, "principal": who.principal.to_key(), "pane": who.pane, "binding_required": matches!(who.principal, Principal::Agent(_)) && who.pane.is_none(), "binding_hint": if matches!(who.principal, Principal::Agent(_)) && who.pane.is_none() { Some("Call pane_bind with your current pane ID; provide its credential or approve the association. Pane-addressed mail requires this verified binding.") } else { None }, "count": results.len(), "results": results})))
}

pub async fn search(
    State(state): State<AppState>, headers: HeaderMap, Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let who = actor(&state.bridge, &headers).await?;
    let store = context()?;
    let scope = match params.get("box").map(String::as_str) {
        Some("sent") => mailbox::SearchScope::Sent,
        Some("received") => mailbox::SearchScope::Received,
        _ => mailbox::SearchScope::All,
    };
    let results = mailbox::search(&store.messages, &store.reads, &who.principal, who.pane.as_deref(),
        scope, params.get("q").map(String::as_str), limit(&params)).map_err(mailbox_error)?;
    Ok(Json(serde_json::json!({"ok": true, "me": who.label, "count": results.len(), "results": results})))
}

#[derive(Deserialize)]
pub struct ReadRequest { pub id: String }

pub async fn read(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<ReadRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let who = actor(&state.bridge, &headers).await?;
    let store = context()?;
    let receipt = mailbox::acknowledge_message(&store.reads, &store.messages, &req.id, &who.principal, who.pane.as_deref())
        .map_err(mailbox_error)?;
    Ok(Json(serde_json::json!({"ok": true, "receipt": receipt})))
}

#[derive(Deserialize)]
pub struct CheckRequest {
    pub limit: Option<usize>,
    pub ack_ids: Option<Vec<String>>,
}

pub async fn check(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<CheckRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let who = actor(&state.bridge, &headers).await?;
    let store = context()?;
    let results = mailbox::check_inbox_with_ack(&store.messages, &store.reads, &who.principal, who.pane.as_deref(),
        req.limit.unwrap_or(100).clamp(1, 2000), req.ack_ids.as_deref()).map_err(mailbox_error)?;
    if let Some(pane) = who.pane.as_deref() {
        state.bridge.clear_msg_notify_delivered(pane).await;
    }
    Ok(Json(serde_json::json!({"ok": true, "me": who.label, "principal": who.principal.to_key(), "pane": who.pane, "binding_required": matches!(who.principal, Principal::Agent(_)) && who.pane.is_none(), "binding_hint": if matches!(who.principal, Principal::Agent(_)) && who.pane.is_none() { Some("Call pane_bind with your current pane ID; provide its credential or approve the association. Pane-addressed mail requires this verified binding.") } else { None }, "count": results.len(), "results": results})))
}

pub async fn approve_binding(bridge: &Bridge, req: &crate::perms::PermRequest) -> Result<(), ApiError> {
    let name = req.action.strip_prefix("bind:").ok_or_else(|| error(StatusCode::BAD_REQUEST, "Not a binding request."))?;
    let requester_key = format!("agent:{name}");
    if req.requester != requester_key || !bridge.sessions().await.contains_key(&req.target_pane)
        || !bridge.identity().list().await.iter().any(|agent| agent.name == name) {
        return Err(error(StatusCode::CONFLICT, "Binding target or requester changed; submit a new binding request."));
    }
    context()?.bindings.verify_and_bind(name, &req.target_pane, ProofOfResidency::System, |_, _| false)
        .map_err(mailbox_error)?;
    bridge.arm_msg_notify(&req.target_pane).await;
    Ok(())
}

#[derive(Deserialize)]
pub struct BindRequest {
    pub pane: String,
    pub agent: Option<String>,
    pub pane_token: Option<String>,
}

pub async fn bind(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<BindRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let caller = state.bridge.resolve_caller(crate::bearer_token(&headers).as_deref()).await;
    let name = match &caller {
        CallerIdentity::System => req.agent.as_deref().ok_or_else(|| error(StatusCode::BAD_REQUEST, "Agent is required."))?,
        CallerIdentity::Agent { name, .. } if req.agent.as_deref().is_none_or(|s| s == name) => name,
        CallerIdentity::Anonymous => return Err(error(StatusCode::UNAUTHORIZED, "Authentication required.")),
        _ => return Err(error(StatusCode::FORBIDDEN, "Only the agent itself or Hyperia can establish this binding.")),
    };
    if !state.bridge.sessions().await.contains_key(&req.pane)
        || !state.bridge.identity().list().await.iter().any(|a| a.name == name) {
        return Err(error(StatusCode::NOT_FOUND, "Active pane and registered agent are required."));
    }
    let token = req.pane_token.as_deref().unwrap_or("");
    let verified = !token.is_empty() && state.bridge.perms().pane_for_token(token).await.as_deref() == Some(&req.pane);
    if !caller.is_system() && !verified {
        if req.pane_token.is_some() {
            return Err(error(StatusCode::FORBIDDEN, "The pane credential is invalid."));
        }
        let store = context()?;
        if store.bindings.pane_for_agent(name).as_deref() == Some(&req.pane) {
            return Ok(Json(serde_json::json!({"ok": true, "agent": name, "pane": req.pane, "state": "bound"})));
        }
        let action = format!("bind:{name}");
        let requester_key = caller.principal_key();
        if state.bridge.perms().recently_denied(&requester_key, &action).await {
            return Err(error(StatusCode::FORBIDDEN, "Mailbox binding was denied."));
        }
        let pending = match state.bridge.perms().pending_action_for(&requester_key, &action).await {
            Some(pending) if pending.target_pane == req.pane => pending,
            Some(_) => return Err(error(StatusCode::CONFLICT, "Another binding request is pending for this identity.")),
            None => {
                let pending = state.bridge.perms().create_request(&requester_key, "", &req.pane, &action,
                    "Associate this authenticated agent's inbox with the addressed pane.").await;
                state.bridge.notify(serde_json::json!({
                    "type": "PermissionRequest", "id": pending.id, "requester": pending.requester,
                    "requesterName": name, "requesterPane": "", "targetPane": req.pane,
                    "action": action, "purpose": pending.purpose,
                })).await.map_err(|e| error(StatusCode::SERVICE_UNAVAILABLE, e))?;
                pending
            }
        };
        return Ok(Json(serde_json::json!({"ok": true, "state": "awaiting_approval", "request_id": pending.id,
            "message": "Mailbox binding is awaiting approval. Approval applies the stored binding request automatically."})));
    }
    let proof = if caller.is_system() { ProofOfResidency::System } else { ProofOfResidency::PaneToken(token) };
    let binding = context()?.bindings.verify_and_bind(name, &req.pane, proof, |_, _| verified).map_err(mailbox_error)?;
    state.bridge.arm_msg_notify(&req.pane).await;
    Ok(Json(serde_json::json!({"ok": true, "binding": binding})))
}
