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
    /// For a per-session MCP child: its registered parent agent, whose mailbox
    /// (and pane binding) the child also reads. Sends still go out as the child.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<Principal>,
}

impl MailActor {
    /// Mailbox view: own mail, delegated pane mail, and the parent agent's mail.
    pub fn reader(&self) -> mailbox::Reader<'_> {
        mailbox::Reader::new(&self.principal, self.pane.as_deref()).with_parent(self.parent.as_ref())
    }
}

pub async fn actor(bridge: &Bridge, headers: &HeaderMap) -> Result<MailActor, ApiError> {
    let id = bridge.resolve_caller(crate::bearer_token(headers).as_deref()).await;
    actor_from_identity(bridge, &id).await
}

pub async fn actor_from_identity(bridge: &Bridge, id: &CallerIdentity) -> Result<MailActor, ApiError> {
    if id.is_anonymous() { return Err(error(StatusCode::UNAUTHORIZED, "Authentication required for messaging.")); }
    actor_in(bridge, context()?, id).await
}

/// `actor_from_identity` against an explicit mail store (tests use fixtures).
pub(crate) async fn actor_in(bridge: &Bridge, store: &MailContext, id: &CallerIdentity) -> Result<MailActor, ApiError> {
    let requester = id.principal_key();
    match id {
        CallerIdentity::Anonymous => Err(error(StatusCode::UNAUTHORIZED, "Authentication required for messaging.")),
        CallerIdentity::System => Ok(MailActor { principal: Principal::System, label: "Hyperia".into(), pane: None, requester, parent: None }),
        CallerIdentity::Agent { name, .. } => {
            // Resolve before taking the session lock (it locks the agent list).
            let parent = bridge.identity().session_parent(name).await.map(Principal::Agent);
            let (principal, pane) = {
                let sessions = bridge.sessions().await;
                let active = |pane: &str| sessions.contains_key(pane);
                let (principal, own_pane) = store.bindings
                    .mailbox_identity(&Principal::Agent(name.clone()), active).map_err(mailbox_error)?;
                // A child has no binding of its own; it inherits its parent's
                // pane for pane-mailbox delegation while that pane is live.
                let pane = match (own_pane, &parent) {
                    (Some(pane), _) => Some(pane),
                    (None, Some(parent)) => store.bindings.mailbox_identity(parent, active).map_err(mailbox_error)?.1,
                    (None, None) => None,
                };
                (principal, pane)
            };
            Ok(MailActor { principal, label: id.label(), pane, requester, parent })
        }
        CallerIdentity::Pane { pane, .. } => {
            // pane_display_name also locks the session table. Drop this guard
            // before awaiting it so pane-token mailbox calls cannot self-deadlock.
            let (principal, _) = {
                let sessions = bridge.sessions().await;
                store.bindings.mailbox_identity(
                    &Principal::Pane(pane.clone()), |pane| sessions.contains_key(pane),
                ).map_err(mailbox_error)?
            };
            let label = bridge.pane_display_name(pane).await.unwrap_or_else(|| pane.clone());
            Ok(MailActor { principal, label, pane: Some(pane.clone()), requester, parent: None })
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

/// Unread count for a pane's badge. Only registered agents are ever bound
/// (a child's pane_bind binds its parent), so the principal here is never a
/// child and needs no parent view; a child reading its parent's mail writes an
/// `onBehalfOf` receipt, which clears the parent's count too.
/// Unread count for a pane plus its newest unread message (inbox is newest-first).
pub async fn unread_for_pane(bridge: &Bridge, pane: &str) -> Result<(usize, Option<mailbox::MessageEnvelope>), ApiError> {
    let store = context()?;
    let (principal, _) = {
        let sessions = bridge.sessions().await;
        store.bindings.mailbox_identity(
            &Principal::Pane(pane.into()), |pane| sessions.contains_key(pane),
        ).map_err(mailbox_error)?
    };
    let unread = mailbox::inbox(&store.messages, &store.reads, &principal, Some(pane), true, 2000)
        .map_err(mailbox_error)?;
    Ok((unread.len(), unread.into_iter().next()))
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
    let results = mailbox::inbox_as(&store.messages, &store.reads, &who.reader(), unread, limit(&params))
        .map_err(mailbox_error)?;
    if let Some(pane) = who.pane.as_deref() {
        state.bridge.clear_msg_notify_delivered(pane).await;
    }
    Ok(Json(serde_json::json!({"ok": true, "me": who.label, "principal": who.principal.to_key(), "pane": who.pane, "parent_mailbox": who.parent.as_ref().map(Principal::to_key), "binding_required": matches!(who.principal, Principal::Agent(_)) && who.pane.is_none(), "binding_hint": if matches!(who.principal, Principal::Agent(_)) && who.pane.is_none() { Some("Call pane_bind with your current pane ID; provide its credential or approve the association. Pane-addressed mail requires this verified binding.") } else { None }, "count": results.len(), "results": results})))
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
    let results = mailbox::search_as(&store.messages, &store.reads, &who.reader(),
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
    let receipt = mailbox::acknowledge_as(&store.reads, &store.messages, &req.id, &who.reader())
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
    let results = mailbox::check_inbox_as(&store.messages, &store.reads, &who.reader(),
        req.limit.unwrap_or(100).clamp(1, 2000), req.ack_ids.as_deref()).map_err(mailbox_error)?;
    if let Some(pane) = who.pane.as_deref() {
        state.bridge.clear_msg_notify_delivered(pane).await;
    }
    Ok(Json(serde_json::json!({"ok": true, "me": who.label, "principal": who.principal.to_key(), "pane": who.pane, "parent_mailbox": who.parent.as_ref().map(Principal::to_key), "binding_required": matches!(who.principal, Principal::Agent(_)) && who.pane.is_none(), "binding_hint": if matches!(who.principal, Principal::Agent(_)) && who.pane.is_none() { Some("Call pane_bind with your current pane ID; provide its credential or approve the association. Pane-addressed mail requires this verified binding.") } else { None }, "count": results.len(), "results": results})))
}

pub async fn approve_binding(bridge: &Bridge, req: &crate::perms::PermRequest) -> Result<(), ApiError> {
    approve_binding_in(bridge, context()?, req).await
}

/// `approve_binding` against an explicit mail store (tests use fixtures).
pub(crate) async fn approve_binding_in(bridge: &Bridge, store: &MailContext, req: &crate::perms::PermRequest) -> Result<(), ApiError> {
    let name = req.action.strip_prefix("bind:").ok_or_else(|| error(StatusCode::BAD_REQUEST, "Not a binding request."))?;
    // The requester is the agent itself or, for pane_bind from a per-session
    // MCP child, one of that agent's live children.
    let requester_ok = req.requester == format!("agent:{name}") || match req.requester.strip_prefix("agent:") {
        Some(child) => bridge.identity().session_parent(child).await.as_deref() == Some(name),
        None => false,
    };
    let pane_is_active = bridge.sessions().await.contains_key(&req.target_pane);
    if !requester_ok || !pane_is_active
        || !bridge.identity().list().await.iter().any(|agent| agent.name == name) {
        return Err(error(StatusCode::CONFLICT, "Binding target or requester changed; submit a new binding request."));
    }
    store.bindings.verify_and_bind(name, &req.target_pane, ProofOfResidency::System, |_, _| false)
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
    if caller.is_anonymous() { return Err(error(StatusCode::UNAUTHORIZED, "Authentication required.")); }
    bind_in(&state.bridge, context()?, &caller, req).await
}

/// Which registered agent a bind from `caller` targets, and the child session
/// it came from. A per-session MCP child (`mcp-session/…`) is not a registered
/// agent and has no binding of its own: pane_bind from it binds its PARENT,
/// under the same residency and active-pane checks.
async fn bind_target(bridge: &Bridge, caller: &CallerIdentity, requested: Option<&str>) -> Result<(String, Option<String>), ApiError> {
    let forbidden = || error(StatusCode::FORBIDDEN, "Only the agent itself or Hyperia can establish this binding.");
    match caller {
        CallerIdentity::System => Ok((requested.ok_or_else(|| error(StatusCode::BAD_REQUEST, "Agent is required."))?.to_owned(), None)),
        CallerIdentity::Agent { name, .. } => match bridge.identity().session_parent(name).await {
            Some(parent) if requested.is_none_or(|s| s == name || s == parent) => Ok((parent, Some(name.clone()))),
            None if requested.is_none_or(|s| s == name) => Ok((name.clone(), None)),
            _ => Err(forbidden()),
        },
        CallerIdentity::Anonymous => Err(error(StatusCode::UNAUTHORIZED, "Authentication required.")),
        CallerIdentity::Pane { .. } => Err(forbidden()),
    }
}

/// `bind` against an explicit mail store (tests use fixtures).
pub(crate) async fn bind_in(
    bridge: &Bridge, store: &MailContext, caller: &CallerIdentity, req: BindRequest,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (agent, session) = bind_target(bridge, caller, req.agent.as_deref()).await?;
    let name = agent.as_str();
    let pane_is_active = bridge.sessions().await.contains_key(&req.pane);
    if !pane_is_active
        || !bridge.identity().list().await.iter().any(|a| a.name == name) {
        return Err(error(StatusCode::NOT_FOUND, "Active pane and registered agent are required."));
    }
    let token = req.pane_token.as_deref().unwrap_or("");
    let verified = !token.is_empty() && bridge.perms().pane_for_token(token).await.as_deref() == Some(&req.pane);
    if !caller.is_system() && !verified {
        if req.pane_token.is_some() {
            return Err(error(StatusCode::FORBIDDEN, "The pane credential is invalid."));
        }
        if store.bindings.pane_for_agent(name).as_deref() == Some(&req.pane) {
            return Ok(Json(serde_json::json!({"ok": true, "agent": name, "session": session, "pane": req.pane, "state": "bound"})));
        }
        let action = format!("bind:{name}");
        let requester_key = caller.principal_key();
        if bridge.perms().recently_denied(&requester_key, &action).await {
            return Err(error(StatusCode::FORBIDDEN, "Mailbox binding was denied."));
        }
        let pending = match bridge.perms().pending_action_for(&requester_key, &action).await {
            Some(pending) if pending.target_pane == req.pane => pending,
            Some(_) => return Err(error(StatusCode::CONFLICT, "Another binding request is pending for this identity.")),
            None => {
                let pending = bridge.perms().create_request(&requester_key, "", &req.pane, &action,
                    "Associate this authenticated agent's inbox with the addressed pane.").await;
                bridge.notify(serde_json::json!({
                    "type": "PermissionRequest", "id": pending.id, "requester": pending.requester,
                    "requesterName": name, "requesterPane": "", "targetPane": req.pane,
                    "action": action, "purpose": pending.purpose,
                })).await.map_err(|e| error(StatusCode::SERVICE_UNAVAILABLE, e))?;
                pending
            }
        };
        return Ok(Json(serde_json::json!({"ok": true, "agent": name, "session": session, "state": "awaiting_approval", "request_id": pending.id,
            "message": "Mailbox binding is awaiting approval. Approval applies the stored binding request automatically."})));
    }
    let proof = if caller.is_system() { ProofOfResidency::System } else { ProofOfResidency::PaneToken(token) };
    let binding = store.bindings.verify_and_bind(name, &req.pane, proof, |_, _| verified).map_err(mailbox_error)?;
    bridge.arm_msg_notify(&req.pane).await;
    Ok(Json(serde_json::json!({"ok": true, "agent": name, "session": session, "binding": binding})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::SessionInfo;
    use crate::screen::ScreenBuffer;
    use std::time::Duration;

    #[tokio::test]
    async fn pane_token_actor_completes_without_relocking_sessions() {
        let bridge = Bridge::new();
        let pane = "messaging-pane-token-deadlock-regression";
        bridge.sessions().await.insert(pane.into(), SessionInfo {
            name: "shell".into(),
            shell_name: "Mailbox regression".into(),
            tab_name: "test".into(),
            description: String::new(),
            rows: 24,
            cols: 80,
            pid: 1,
            root_tab_uid: "messaging-test-tab".into(),
            window_id: 1,
            split_label: "a".into(),
            tab_order: 0,
            tab_active: true,
            pane_active: true,
            screen: ScreenBuffer::new(24, 80, 1000),
            bsp_x: 0.0,
            bsp_y: 0.0,
            bsp_w: 100.0,
            bsp_h: 100.0,
            cwd: String::new(),
            last_user_activity: None,
            last_output_at: None,
            title: String::new(),
            shell_state: "idle".into(),
            shell_app: None,
            shell_last_exit: None,
            shell_has_integration: false,
        });
        let token = bridge.perms().token_for(pane).await;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );

        // Exercise the real pane-token resolution used by check/inbox/send,
        // then actor_from_identity's pane branch and its display-name lookup.
        let who = tokio::time::timeout(Duration::from_secs(2), actor(&bridge, &headers))
            .await.expect("pane-token mailbox actor deadlocked")
            .expect("pane-token caller should be authorized");
        assert_eq!(who.principal, Principal::Pane(pane.into()));
        assert_eq!(who.pane.as_deref(), Some(pane));
        assert_eq!(who.label, "Mailbox regression");
        assert_eq!(who.requester, format!("pane:{pane}"));

        // A successful call must also leave the shared session table usable.
        drop(tokio::time::timeout(Duration::from_secs(2), bridge.sessions())
            .await.expect("mailbox actor retained the session lock"));
    }
}
