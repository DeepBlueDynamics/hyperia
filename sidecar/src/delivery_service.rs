//! One retained-operation boundary for mailbox sends, agent input and shell commands.
use axum::{extract::{Query, State as HttpState}, http::{HeaderMap, StatusCode}, Json};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};
use tokio::sync::{Mutex, OnceCell};
use crate::{AppState, bridge::Bridge, delivery::{DeliveryStore, NewOperation, Operation, State}};
use crate::messaging::{self, ApiError, MailActor, SendRequest};
use crate::msgbus::mailbox::Principal;

pub static WORKFLOW: Mutex<()> = Mutex::const_new(());
static STORE: OnceCell<DeliveryStore> = OnceCell::const_new();
// Retry metadata persistence only; never repeat transport after an uncertain write.
static COMPLETIONS: Mutex<Vec<(String, State, serde_json::Value)>> = Mutex::const_new(Vec::new());
static PROMPTS: Mutex<Vec<(String, serde_json::Value)>> = Mutex::const_new(Vec::new());

async fn store() -> Result<&'static DeliveryStore, ApiError> {
    STORE.get_or_try_init(|| async {
        let path: PathBuf = crate::fsnav::home_dir().join(".hyperia").join("delivery-operations.json");
        DeliveryStore::open(path).await.map_err(operation_error)
    }).await
}

fn store_error(e: impl std::fmt::Display) -> ApiError {
    messaging::error(StatusCode::INTERNAL_SERVER_ERROR, e)
}

fn operation_error(e: crate::delivery::Error) -> ApiError {
    use crate::delivery::DeliveryError;
    let status = match &e {
        DeliveryError::NotFound(_) => StatusCode::NOT_FOUND,
        DeliveryError::Forbidden(_) => StatusCode::FORBIDDEN,
        DeliveryError::Conflict(_) | DeliveryError::InvalidState(_) => StatusCode::CONFLICT,
        DeliveryError::Validation(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    messaging::error(status, e)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InputRequest {
    pub window: Option<u32>,
    pub tab: Option<String>,
    pub pane: Option<String>,
    pub text: String,
    pub submit: Option<bool>,
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct InputPayload {
    sender: MailActor,
    recipient: Principal,
    pane: String,
    pid: u32,
    text: String,
    agent: bool,
    #[serde(default)]
    raw: bool,
    #[serde(default)]
    interrupt: bool,
}

fn value<T: Serialize>(v: &T) -> Result<serde_json::Value, ApiError> {
    serde_json::to_value(v).map_err(store_error)
}

type OperationResponse = (StatusCode, Json<serde_json::Value>);

fn response_body(op: Operation) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "operation": op}))
}

fn response(op: Operation) -> OperationResponse {
    let status = if op.state.is_active() { StatusCode::ACCEPTED } else { StatusCode::OK };
    (status, response_body(op))
}

fn request_metadata(mut request: serde_json::Value) -> serde_json::Value {
    if let Some(fields) = request.as_object_mut() {
        fields.remove("body");
        fields.remove("text");
    }
    request
}

fn replay_matches(op: &Operation, kind: &str, request: &serde_json::Value) -> bool {
    let body_key = if kind == "mail" { "body" } else { "text" };
    op.kind == kind && op.payload.get("request") == Some(&request_metadata(request.clone()))
        && op.payload.get(body_key) == request.get(body_key)
}

async fn replay(sender: &MailActor, key: Option<&str>, kind: &str, request: &serde_json::Value)
    -> Result<Option<Operation>, ApiError> {
    let Some(key) = key else { return Ok(None) };
    let prior = store().await?.find_by_key(&sender.requester, key).await.map_err(operation_error)?;
    if let Some(op) = &prior {
        if !replay_matches(op, kind, request) {
            return Err(messaging::error(StatusCode::CONFLICT, "Idempotency key was used with different input."));
        }
    }
    Ok(prior)
}

async fn message_allowed(bridge: &Bridge, sender: &MailActor, recipient: &Principal) -> bool {
    sender.principal == Principal::System || &sender.principal == recipient
        || bridge.perms().has_message_grant(&sender.requester, &recipient.to_key()).await
}

/// Called under WORKFLOW. Persist the payload and consent association before displaying a prompt.
async fn retain(
    bridge: &Bridge, sender: &MailActor, target: &str, kind: &str,
    payload: serde_json::Value, submit: bool, key: Option<String>,
    approved: bool, action: &str, purpose: &str,
) -> Result<Operation, ApiError> {
    let denial_key = if action == "drive" { target } else { action };
    if !approved && bridge.perms().recently_denied(&sender.requester, denial_key).await {
        return Err(messaging::error(StatusCode::FORBIDDEN, "The user denied this operation."));
    }
    let store = store().await?;
    let mut op = store.create(NewOperation {
        requester: sender.requester.clone(), target: target.into(), kind: kind.into(),
        payload, submit, idempotency_key: key, expires_ms: now_ms() + 900_000,
    }, approved).await.map_err(operation_error)?;
    if matches!(op.state, State::AwaitingApproval) {
        let existing = match &op.consent_id {
            Some(id) => bridge.perms().pending_request(id).await,
            None => bridge.perms().pending_action_target(&sender.requester, action, target).await,
        };
        if existing.is_none() && op.consent_id.is_some() {
            return store.cancel(&op.id, &sender.requester).await.map_err(operation_error);
        }
        let req = match existing {
            Some(req) => req,
            None => bridge.perms().create_request(&sender.requester, sender.pane.as_deref().unwrap_or(""),
                target, action, purpose).await,
        };
        if op.consent_id.as_deref() != Some(&req.id) {
            op = store.associate(&op.id, &sender.requester, &req.id).await.map_err(operation_error)?;
        }
        crate::consent_log::record_request(&req.id, &req.requester, &sender.label, sender.principal.kind_str(),
            &req.action, &req.target_pane, &req.purpose);
        let prompt = serde_json::json!({
            "type": "PermissionRequest", "id": req.id, "requester": req.requester,
            "requesterName": sender.label, "requesterPane": req.requester_pane,
            "targetPane": req.target_pane, "action": req.action, "purpose": req.purpose,
        });
        if let Err(error) = bridge.notify(prompt.clone()).await {
            let mut pending = PROMPTS.lock().await;
            if !pending.iter().any(|(id, _)| id == &req.id) {
                pending.push((req.id.clone(), prompt));
            }
            // The operation is already durable: return its ID even if the UI is disconnected.
            op.outcome = Some(serde_json::json!({"notification_pending": true, "detail": error.to_string()}));
        }
    }
    Ok(op)
}

pub async fn send_mail(HttpState(state): HttpState<AppState>, headers: HeaderMap, Json(req): Json<SendRequest>)
    -> Result<OperationResponse, ApiError> {
    let _gate = WORKFLOW.lock().await;
    let sender = messaging::actor(&state.bridge, &headers).await?;
    let original = value(&req)?;
    if let Some(op) = replay(&sender, req.idempotency_key.as_deref(), "mail", &original).await? { return Ok(response(op)); }
    let msg = messaging::prepare(&state.bridge, &headers, req).await?;
    let mut payload = value(&msg)?;
    payload["request"] = request_metadata(original);
    let approved = message_allowed(&state.bridge, &msg.sender, &msg.recipient).await;
    let target = msg.target_pane.clone().unwrap_or_else(|| msg.recipient.to_key());
    let action = format!("message:{}", msg.recipient.to_key());
    let op = retain(&state.bridge, &msg.sender, &target, "mail", payload, false,
        msg.idempotency_key.clone(), approved, &action, &format!("Deliver stored mail to {}.", msg.recipient_label)).await?;
    Ok(response(op))
}

pub async fn pane_send(HttpState(state): HttpState<AppState>, headers: HeaderMap, Json(req): Json<InputRequest>)
    -> Result<OperationResponse, ApiError> {
    submit_input(&state.bridge, &headers, req, true).await.map(response)
}

pub async fn terminal_run(HttpState(state): HttpState<AppState>, headers: HeaderMap, Json(req): Json<InputRequest>)
    -> Result<OperationResponse, ApiError> {
    submit_input(&state.bridge, &headers, req, false).await.map(response)
}

pub async fn submit_input(bridge: &Bridge, headers: &HeaderMap, req: InputRequest, agent: bool)
    -> Result<Operation, ApiError> {
    let _gate = WORKFLOW.lock().await;
    let sender = messaging::actor(bridge, headers).await?;
    let kind = if agent { "pane" } else { "shell" };
    let original = value(&req)?;
    if let Some(op) = replay(&sender, req.idempotency_key.as_deref(), kind, &original).await? { return Ok(op); }
    if req.text.trim().is_empty() || req.text.chars().count() > 16_384
        || req.text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(messaging::error(StatusCode::BAD_REQUEST, "Input must be plain text of 1–16384 characters, without control sequences."));
    }
    if !agent && !req.submit.unwrap_or(true) && req.text.contains('\n') {
        return Err(messaging::error(StatusCode::BAD_REQUEST, "Staging shell input requires one line; newline bytes could execute it."));
    }
    let address = SendRequest { window: req.window, tab: req.tab, pane: req.pane, to_label: None,
        subject: String::new(), body: req.text.clone(), idempotency_key: req.idempotency_key.clone() };
    if address.window.is_none() && address.tab.is_none() && address.pane.is_none() {
        return Err(messaging::error(StatusCode::BAD_REQUEST, "An explicit pane address is required."));
    }
    let pane = messaging::resolve_target(bridge, &address).await?;
    let candidate = bridge.classification_for(&pane).await
        .ok_or_else(|| messaging::error(StatusCode::NOT_FOUND, "Target pane closed."))?;
    let compatible = if agent { candidate.classification.accepts_direct_input() } else { candidate.classification.terminal_run_allowed() };
    if !compatible {
        return Err(messaging::error(StatusCode::CONFLICT, format!("{} Use pane_send for agent input and terminal_run only at a shell prompt.", candidate.classification.summary)));
    }
    let pid = bridge.sessions().await.get(&pane).map(|s| s.pid).unwrap_or(0);
    let recipient = messaging::context()?.bindings.agent_for_pane(&pane)
        .map(Principal::Agent).unwrap_or_else(|| Principal::Pane(pane.clone()));
    let (approved, action) = if agent {
        (message_allowed(bridge, &sender, &recipient).await, format!("message:{}", recipient.to_key()))
    } else {
        let id = bridge.resolve_caller(crate::bearer_token(headers).as_deref()).await;
        let decision = bridge.authorize_drive(&id, &pane).await;
        if matches!(decision, crate::perms::AuthDecision::Denied | crate::perms::AuthDecision::RefuseHome) {
            return Err(messaging::error(StatusCode::FORBIDDEN, "Terminal control is denied for this target."));
        }
        let allowed = matches!(decision, crate::perms::AuthDecision::Allow)
            || bridge.grant_allows(&sender.requester, &pane).await;
        (allowed, "drive".to_string())
    };
    let payload = InputPayload { sender: sender.clone(), recipient, pane: pane.clone(), pid, text: req.text, agent, raw: false, interrupt: false };
    let mut payload = value(&payload)?;
    payload["request"] = request_metadata(original);
    retain(bridge, &sender, &pane, kind, payload,
        req.submit.unwrap_or(true), req.idempotency_key, approved, &action,
        if agent { "Send this retained text to the agent." } else { "Run this retained command at the shell prompt." }).await
}

/// Retain explicitly requested raw control keys under terminal-control permission.
/// These never acquire an implicit Enter or pass through the mailbox grant.
pub async fn raw_keys(bridge: &Bridge, headers: &HeaderMap, req: InputRequest, interrupt: bool) -> Result<Operation, ApiError> {
    let _gate = WORKFLOW.lock().await;
    let sender = messaging::actor(bridge, headers).await?;
    let mut original = value(&req)?;
    original["interrupt"] = serde_json::json!(interrupt);
    if let Some(op) = replay(&sender, req.idempotency_key.as_deref(), "keys", &original).await? { return Ok(op); }
    if req.text.is_empty() || req.text.len() > 1024 {
        return Err(messaging::error(StatusCode::BAD_REQUEST, "Raw control input must be 1–1024 bytes."));
    }
    let address = SendRequest { window: req.window, tab: req.tab, pane: req.pane, to_label: None,
        subject: String::new(), body: req.text.clone(), idempotency_key: req.idempotency_key.clone() };
    if address.window.is_none() && address.tab.is_none() && address.pane.is_none() {
        return Err(messaging::error(StatusCode::BAD_REQUEST, "An explicit pane address is required."));
    }
    let pane = messaging::resolve_target(bridge, &address).await?;
    let pid = bridge.sessions().await.get(&pane).map(|s| s.pid).unwrap_or(0);
    if pid == 0 { return Err(messaging::error(StatusCode::CONFLICT, "No live terminal target.")); }
    let id = bridge.resolve_caller(crate::bearer_token(headers).as_deref()).await;
    let decision = bridge.authorize_drive(&id, &pane).await;
    if matches!(decision, crate::perms::AuthDecision::Denied | crate::perms::AuthDecision::RefuseHome) {
        return Err(messaging::error(StatusCode::FORBIDDEN, "Terminal control is denied for this target."));
    }
    let approved = matches!(decision, crate::perms::AuthDecision::Allow)
        || bridge.grant_allows(&sender.requester, &pane).await;
    let recipient = messaging::context()?.bindings.agent_for_pane(&pane)
        .map(Principal::Agent).unwrap_or_else(|| Principal::Pane(pane.clone()));
    let payload = InputPayload { sender: sender.clone(), recipient, pane: pane.clone(), pid,
        text: req.text, agent: false, raw: true, interrupt };
    let mut payload = value(&payload)?;
    payload["request"] = request_metadata(original);
    retain(bridge, &sender, &pane, "keys", payload, false, req.idempotency_key,
        approved, "drive", "Send these exact retained terminal-control keys without adding Enter.").await
}

/// Main's approval handler holds WORKFLOW while applying this decision and the grant.
pub async fn resolve_approval(req: &crate::perms::PermRequest, allow: bool) -> Result<Vec<Operation>, ApiError> {
    store().await?.resolve(&req.id, &req.requester, allow).await.map_err(operation_error)
}

/// Query all operations linked to a consent prompt under exact requester matching.
/// Includes terminal and expired records to distinguish delivery-linked prompts from explicit access requests.
pub async fn consent_operations(consent_id: &str, requester: &str) -> Result<Vec<Operation>, ApiError> {
    store().await?.consent_operations(consent_id, requester).await.map_err(operation_error)
}

pub async fn status(HttpState(state): HttpState<AppState>, headers: HeaderMap, Query(params): Query<HashMap<String, String>>)
    -> Result<OperationResponse, ApiError> {
    let who = messaging::actor(&state.bridge, &headers).await?;
    let id = params.get("id").ok_or_else(|| messaging::error(StatusCode::BAD_REQUEST, "Operation id required."))?;
    let op = store().await?.get(id, &who.requester).await.map_err(operation_error)?;
    let mut body = response_body(op);
    if let Some((_, state, outcome)) = COMPLETIONS.lock().await.iter().find(|(pending, _, _)| pending == id) {
        body.0["completion_pending"] = serde_json::json!({"state": state, "outcome": outcome});
    }
    Ok((StatusCode::OK, body))
}

async fn finish(store: &DeliveryStore, op: &Operation, state: State, outcome: serde_json::Value) {
    if let Err(error) = store.complete(&op.id, state, outcome.clone()).await {
        tracing::error!("Delivery outcome persistence failed for {}: {}", op.id, error);
        COMPLETIONS.lock().await.push((op.id.clone(), state, outcome));
    }
}

pub async fn tick(bridge: &Bridge) {
    let store = match store().await { Ok(store) => store, Err(_) => return };
    let completions = std::mem::take(&mut *COMPLETIONS.lock().await);
    for (id, state, outcome) in completions {
        if store.complete(&id, state, outcome.clone()).await.is_err() {
            COMPLETIONS.lock().await.push((id, state, outcome));
        }
    }
    let prompts = std::mem::take(&mut *PROMPTS.lock().await);
    for (id, prompt) in prompts {
        if bridge.perms().pending_request(&id).await.is_some() && bridge.notify(prompt.clone()).await.is_err() {
            PROMPTS.lock().await.push((id, prompt));
        }
    }
    let queue = match store.queued().await { Ok(queue) => queue, Err(error) => { tracing::error!("Delivery queue read failed: {error}"); return; } };
    for queued in queue {
        if !matches!(queued.kind.as_str(), "mail" | "pane" | "shell" | "keys") {
            if let Ok(Some(op)) = store.claim(&queued.id).await {
                finish(store, &op, State::Failed, serde_json::json!({"error":"Unknown operation kind."})).await;
            }
            continue;
        }
        if queued.kind != "mail" {
            if let Ok(payload) = serde_json::from_value::<InputPayload>(queued.payload.clone()) {
                if let Some(candidate) = bridge.classification_for(&payload.pane).await {
                    if !payload.interrupt && (candidate.focus_protected || candidate.actively_typed) { continue; }
                }
            }
        }
        let op = match store.claim(&queued.id).await {
            Ok(Some(op)) => op,
            Ok(None) => continue,
            Err(error) => { tracing::error!("Delivery claim failed: {error}"); continue; }
        };
        if op.kind == "mail" {
            let mut msg: messaging::PreparedMessage = match serde_json::from_value(op.payload.clone()) {
                Ok(msg) => msg,
                Err(error) => { finish(store, &op, State::Failed, serde_json::json!({"error": error.to_string()})).await; continue; }
            };
            if msg.idempotency_key.is_none() { msg.idempotency_key = Some(format!("operation:{}", op.id)); }
            match messaging::store_approved(bridge, &msg).await {
                Ok(id) => finish(store, &op, State::Submitted, serde_json::json!({"message_id": id, "stored": true, "read": false})).await,
                Err((status, Json(error))) => finish(store, &op,
                    if status.is_server_error() { State::Indeterminate } else { State::Failed }, error).await,
            }
            continue;
        }
        let payload: InputPayload = match serde_json::from_value(op.payload.clone()) {
            Ok(payload) => payload,
            Err(error) => { finish(store, &op, State::Failed, serde_json::json!({"error": error.to_string()})).await; continue; }
        };
        let same_pid = bridge.sessions().await.get(&payload.pane).is_some_and(|s| s.pid == payload.pid);
        let candidate = bridge.classification_for(&payload.pane).await;
        let compatible = payload.raw || candidate.as_ref().is_some_and(|c| if payload.agent {
            c.classification.accepts_direct_input()
        } else { c.classification.terminal_run_allowed() });
        let recipient = messaging::context().ok().and_then(|c| c.bindings.agent_for_pane(&payload.pane))
            .map(Principal::Agent).unwrap_or_else(|| Principal::Pane(payload.pane.clone()));
        if !same_pid || !compatible || recipient != payload.recipient {
            finish(store, &op, State::Failed, serde_json::json!({"error": "Target pane incarnation, recipient, or foreground changed."})).await;
            continue;
        }
        let result = bridge.guarded_input(&payload.pane, serde_json::json!({
            "type": "GuardedInput", "uid": payload.pane, "pid": payload.pid,
            "text": payload.text, "submit": op.submit, "agent": payload.agent,
            "control": payload.raw, "interrupt": payload.interrupt,
        })).await;
        let outcome = result.ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .unwrap_or_else(|| serde_json::json!({"state": "indeterminate", "detail": "Transport response missing; do not replay."}));
        let state = match outcome["state"].as_str() {
            Some("submitted") => State::Submitted,
            Some("deferred") => State::Queued,
            Some("failed") => State::Failed,
            _ => State::Indeterminate,
        };
        finish(store, &op, state, outcome).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_compares_content_target_and_submit_without_duplicating_unicode_body() {
        let text = "🦩".repeat(16_384);
        let request = serde_json::json!({"pane": "p1", "text": text, "submit": false, "idempotency_key": "retry"});
        let payload = serde_json::json!({"text": text, "request": request_metadata(request.clone())});
        assert!(serde_json::to_vec(&payload).unwrap().len() < crate::delivery::MAX_PAYLOAD_BYTES);
        let op = Operation {
            id: "op".into(), requester: "agent:alice".into(), target: "p1".into(),
            kind: "pane".into(), payload, submit: false, idempotency_key: Some("retry".into()),
            expires_ms: 0, created_ms: 0, state: State::Denied, consent_id: None, outcome: None,
        };
        assert!(replay_matches(&op, "pane", &request));
        for (field, different) in [("text", serde_json::json!("changed")), ("pane", serde_json::json!("p2")), ("submit", serde_json::json!(true))] {
            let mut changed = request.clone();
            changed[field] = different;
            assert!(!replay_matches(&op, "pane", &changed));
        }
        assert!(!replay_matches(&op, "shell", &request));
    }
}
