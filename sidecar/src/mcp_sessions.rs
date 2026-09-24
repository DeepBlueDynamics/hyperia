//! Durable MCP identity, independent of rmcp's disposable request transports.
#[cfg(test)]
#[path = "mcp_sessions_tests.rs"]
mod tests;
use std::path::PathBuf;
use std::io::Write;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::sync::atomic::{AtomicUsize, Ordering};
use futures::StreamExt;

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::bridge::Bridge;
use crate::identity::CallerIdentity;

const SESSION_HEADER: &str = "mcp-session-id";
const MAX_SESSIONS: usize = 10_000;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const PANE_CLAIM_QUIET_MS: u64 = 60_000;
const PANE_CONFLICT: &str = "Pane token is already bound to another live MCP session";

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct LogicalSession {
    pub session_id: String,
    pub parent: String,
    #[serde(default)]
    pub parent_is_pane: bool,
    #[serde(default)]
    pub last_used_ms: u64,
    /// Immutable mailbox / permission identity; labels never become ledger keys.
    pub name: String,
    pub label: String,
    pub client: Value,
    pub created_ms: u64,
    pub revoked: bool,
    #[serde(default)]
    pub expires_ms: Option<u64>,
    // Internal proxy credential, never returned by whoami or initialize.
    #[serde(skip)]
    pub forward_token: String,
}

#[derive(Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    sessions: Vec<LogicalSession>,
}

pub(crate) struct SessionStore {
    path: PathBuf,
    records: Mutex<Vec<LogicalSession>>,
    load_error: Option<String>,
    signals: Mutex<HashMap<String, Activity>>,
}

struct Activity {
    signal: tokio::sync::watch::Sender<bool>,
    in_flight: Arc<AtomicUsize>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl LogicalSession {
    fn active(&self) -> bool {
        !self.revoked && self.expires_ms.is_none_or(|deadline| now_ms() < deadline)
    }
}

#[derive(Clone)]
pub(crate) struct ForwardAuth(String);
impl ForwardAuth {
    pub fn header(&self) -> String { format!("Bearer {}", self.0) }
}
impl std::fmt::Debug for ForwardAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ForwardAuth([redacted])")
    }
}

pub(crate) struct Lease {
    signal: tokio::sync::watch::Receiver<bool>,
    expires_ms: Option<u64>,
    in_flight: Arc<AtomicUsize>,
}
impl Drop for Lease {
    fn drop(&mut self) { self.in_flight.fetch_sub(1, Ordering::SeqCst); }
}
impl Lease {
    pub async fn cancelled(&mut self) {
        let delay = async {
            match self.expires_ms {
                Some(deadline) => tokio::time::sleep(std::time::Duration::from_millis(deadline.saturating_sub(now_ms()))).await,
                None => std::future::pending::<()>().await,
            }
        };
        let revoked = async {
            while !*self.signal.borrow_and_update() {
                if self.signal.changed().await.is_err() { break; }
            }
        };
        tokio::select! { _ = delay => {}, _ = revoked => {} }
    }
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0; bytes];
    getrandom::getrandom(&mut value).map_err(|e| e.to_string())?;
    Ok(value.iter().map(|b| format!("{b:02x}")).collect())
}

impl SessionStore {
    pub fn open(path: PathBuf) -> Self {
        let loaded = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<SessionFile>(&bytes)
                .map_err(|e| e.to_string())
                .and_then(|mut file| {
                    if file.version != 1 || file.sessions.len() > MAX_SESSIONS {
                        return Err("Unsupported or oversized MCP session store".into());
                    }
                    let mut ids = std::collections::HashSet::new();
                    let mut labels = std::collections::HashSet::new();
                    let mut tokens = std::collections::HashSet::new();
                    for record in &mut file.sessions {
                        record.forward_token = format!("hyp_mcp_{}", random_hex(32)?);
                        if record.name != format!("mcp-session/{}", record.session_id)
                            || record.session_id.len() != 32
                            || !record.session_id.bytes().all(|b| b.is_ascii_hexdigit())
                            || !ids.insert(&record.session_id)
                            || !labels.insert(&record.label)
                            || !tokens.insert(&record.forward_token)
                        {
                            return Err("Invalid MCP session records".into());
                        }
                    }
                    Ok(file.sessions)
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        };
        match loaded {
            Ok(records) => Self { path, records: Mutex::new(records), load_error: None, signals: Mutex::new(HashMap::new()) },
            Err(error) => Self { path, records: Mutex::new(Vec::new()), load_error: Some(error), signals: Mutex::new(HashMap::new()) },
        }
    }

    fn records(&self) -> Result<MutexGuard<'_, Vec<LogicalSession>>, String> {
        if let Some(error) = &self.load_error {
            return Err(format!("MCP session storage unavailable: {error}"));
        }
        self.records.lock().map_err(|_| "MCP session lock poisoned".into())
    }

    fn persist(&self, sessions: &[LogicalSession]) -> Result<(), String> {
        let file = SessionFile { version: 1, sessions: sessions.to_vec() };
        // Credentials are memory-only. Restrict metadata too, including the
        // temporary file; a failed replace leaves the previous store intact.
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = self.path.with_extension(format!("tmp-{}", random_hex(12)?));
        let result = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(&temp)?;
            output.write_all(&serde_json::to_vec_pretty(&file)?)?;
            output.sync_all()?;
            drop(output);
            std::fs::rename(&temp, &self.path)
        })();
        if result.is_err() { let _ = std::fs::remove_file(&temp); }
        result.map_err(|e| e.to_string())
    }

    pub fn reserved(&self, name: &str) -> Result<bool, String> {
        Ok(self.records()?.iter().any(|r| r.name == name || r.label == name))
    }

    pub fn create(&self, parent: &str, client: Value, parent_names: &[String]) -> Result<LogicalSession, String> {
        self.create_owned(parent, false, client, parent_names).map(|(record, _)| record)
    }

    pub fn create_pane(&self, pane: &str, client: Value, parent_names: &[String]) -> Result<(LogicalSession, bool), String> {
        self.create_owned(pane, true, client, parent_names)
    }

    fn create_owned(&self, parent: &str, parent_is_pane: bool, client: Value, parent_names: &[String]) -> Result<(LogicalSession, bool), String> {
        let mut records = self.records()?;
        let previous = if parent_is_pane {
            records.iter().find(|r| r.parent_is_pane && r.parent == parent && r.active()).cloned()
        } else { None };
        if let Some(old) = &previous {
            let busy = self.signals.lock().map_err(|_| "MCP activity lock poisoned")?
                .get(&old.session_id).is_some_and(|a| a.in_flight.load(Ordering::SeqCst) > 0);
            if busy || now_ms().saturating_sub(old.last_used_ms) < PANE_CLAIM_QUIET_MS {
                return Err(PANE_CONFLICT.into());
            }
        }
        if records.len() >= MAX_SESSIONS {
            return Err("MCP session limit reached; existing sessions remain resumable".into());
        }
        let record = loop {
            let session_id = random_hex(16)?;
            let name = format!("mcp-session/{session_id}");
            let label = format!("{}·{}", crate::util::safe_prefix(parent, 240), &session_id[..6]);
            if parent_names.iter().any(|n| n == &label || n == &name)
                || records.iter().any(|r| r.session_id == session_id || r.label == label) {
                continue;
            }
            break LogicalSession {
                session_id, parent: parent.into(), parent_is_pane, last_used_ms: now_ms(), name, label, client,
                created_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64).unwrap_or(0),
                revoked: false,
                expires_ms: None,
                forward_token: format!("hyp_mcp_{}", random_hex(32)?),
            };
        };
        let mut next = records.clone();
        if let Some(old) = &previous {
            next.iter_mut().find(|r| r.session_id == old.session_id).unwrap().revoked = true;
        }
        next.push(record.clone());
        self.persist(&next)?;
        *records = next;
        if let Some(old) = &previous { self.cancel(&old.session_id); }
        Ok((record, previous.is_some()))
    }

    /// clientInfo.name of the session currently holding `pane`'s token, if any.
    pub fn active_pane_client(&self, pane: &str) -> Option<String> {
        let records = self.records().ok()?;
        records.iter().find(|r| r.parent_is_pane && r.parent == pane && r.active())
            .map(|r| client_name(&r.client))
    }

    pub fn resume(&self, parent: &str, parent_is_pane: bool, id: &str) -> Result<LogicalSession, String> {
        let mut records = self.records()?;
        let mut next = records.clone();
        let record = next.iter_mut().find(|r| r.session_id == id && r.parent == parent
            && r.parent_is_pane == parent_is_pane && r.active())
            .ok_or("Unknown, revoked, or foreign MCP session")?;
        record.last_used_ms = now_ms();
        let result = record.clone();
        self.persist(&next)?;
        *records = next;
        Ok(result)
    }

    pub fn by_token(&self, token: &str) -> Option<LogicalSession> {
        self.records().ok()?.iter().find(|r| r.forward_token == token && r.active()).cloned()
    }

    pub fn by_address(&self, address: &str) -> Option<LogicalSession> {
        self.records().ok()?.iter().find(|r| !r.parent_is_pane && r.active() && (r.name == address || r.label == address)).cloned()
    }

    pub fn by_name(&self, name: &str) -> Option<LogicalSession> {
        self.records().ok()?.iter().find(|r| r.active() && r.name == name).cloned()
    }

    pub fn lease_token(&self, token: &str) -> Option<Lease> {
        let records = self.records().ok()?;
        let record = records.iter().find(|r| r.forward_token == token && r.active())?;
        let mut signals = self.signals.lock().ok()?;
        let activity = signals.entry(record.session_id.clone())
            .or_insert_with(|| Activity { signal: tokio::sync::watch::channel(false).0,
                in_flight: Arc::new(AtomicUsize::new(0)) });
        activity.in_flight.fetch_add(1, Ordering::SeqCst);
        Some(Lease { signal: activity.signal.subscribe(), expires_ms: record.expires_ms,
            in_flight: activity.in_flight.clone() })
    }

    pub fn principal_active(&self, principal: &str) -> bool {
        match principal.strip_prefix("agent:mcp-session/") {
            Some(id) => self.records().map(|records| records.iter().any(|r| r.session_id == id && r.active())).unwrap_or(false),
            None => true,
        }
    }

    pub fn parent_pairs(&self) -> Vec<(String, Option<String>, Option<u64>)> {
        self.records().map(|records| records.iter().filter(|r| !r.parent_is_pane)
            .map(|r| (format!("agent:{}", r.name), r.active().then(|| format!("agent:{}", r.parent)), r.expires_ms)).collect())
            .unwrap_or_default()
    }

    pub fn set_label(&self, name: &str, label: &str, parent_names: &[String]) -> Result<LogicalSession, String> {
        let label = label.trim();
        if label.is_empty() || label.len() > 256 || label.chars().any(char::is_control)
            || label.starts_with("mcp-session/") || label.starts_with("agent:")
            || label.starts_with("pane:") || label.to_ascii_lowercase().starts_with("pane ")
            || ["system", "hyperia", "anonymous"].iter().any(|s| label.eq_ignore_ascii_case(s)) {
            return Err("Invalid or reserved session label".into());
        }
        let mut records = self.records()?;
        if parent_names.iter().any(|n| n == label)
            || records.iter().any(|r| r.name != name && (r.label == label || r.name == label)) {
            return Err("Label already belongs to another identity".into());
        }
        let mut next = records.clone();
        let record = next.iter_mut().find(|r| r.name == name && r.active())
            .ok_or("Active MCP session required")?;
        record.label = label.into();
        let result = record.clone();
        self.persist(&next)?;
        *records = next;
        Ok(result)
    }

    pub fn revoke(&self, parent: &str, parent_is_pane: bool, id: &str) -> Result<(), String> {
        let mut records = self.records()?;
        let mut next = records.clone();
        let record = next.iter_mut().find(|r| r.parent == parent && r.parent_is_pane == parent_is_pane && r.session_id == id)
            .ok_or("Unknown or foreign MCP session")?;
        record.revoked = true;
        self.persist(&next)?;
        *records = next;
        self.cancel(id);
        Ok(())
    }

    fn cancel(&self, id: &str) {
        if let Some(activity) = self.signals.lock().unwrap().get(id) { activity.signal.send_replace(true); }
    }
}

#[derive(Clone)]
struct HttpState {
    bridge: Bridge,
    port: u16,
}

pub fn routes(bridge: Bridge, port: u16) -> Router {
    Router::new()
        .route("/mcp", axum::routing::any(handle))
        .route("/mcp/", axum::routing::any(handle))
        .route("/api/identity/whoami", axum::routing::get(whoami))
        .route("/api/identity/set-label", axum::routing::post(set_label))
        .with_state(HttpState { bridge, port })
}

fn failure(status: StatusCode, error: impl ToString) -> Response {
    (status, Json(json!({"ok": false, "error": error.to_string()}))).into_response()
}

/// `clientInfo.name` from an MCP initialize's params (what the client calls itself).
pub(crate) fn client_name(client: &Value) -> String {
    client["clientInfo"]["name"].as_str().filter(|s| !s.is_empty()).unwrap_or("an unnamed client").to_owned()
}

/// Human-facing text for the pane-claim notice. Names both clients and the
/// usual cause, so the user isn't left guessing at a "token crossing": in
/// practice it is one agent with two Hyperia MCP servers configured, often
/// because its container fell back to the pane token.
pub(crate) fn pane_notice_text(pane: &str, conflict: bool, newcomer: &str, holder: Option<&str>) -> String {
    let short = &pane[..pane.len().min(8)];
    if conflict {
        format!(
            "Pane {short}: two MCP clients presented this pane's token. {} holds the session; {newcomer} was refused. \
             Usually one agent configured with two Hyperia MCP servers, or a container that fell back to the pane \
             token because its agent name was already taken.",
            holder.unwrap_or("another client")
        )
    } else {
        format!("Pane {short}: {newcomer} took over this pane's session after the previous client went quiet.")
    }
}

async fn pane_notice(bridge: &Bridge, pane: &str, conflict: bool, newcomer: &str, holder: Option<String>) {
    let text = pane_notice_text(pane, conflict, newcomer, holder.as_deref());
    crate::audit::record(json!({"ts": now_ms(), "identity": format!("pane:{pane}"),
        "kind": "pane", "path": "/mcp", "event": if conflict { "pane_token_conflict" } else { "pane_session_takeover" },
        "status": if conflict { 409 } else { 200 }, "text": text}));
    if let Err(error) = bridge.notify(json!({"type": "AgentNotice", "text": text})).await {
        tracing::warn!("Pane session notice could not reach Electron: {error}");
    }
}

fn guard_body(response: Response, mut lease: Lease) -> Response {
    let (parts, body) = response.into_parts();
    let stream = async_stream::stream! {
        let mut source = body.into_data_stream();
        loop {
            tokio::select! {
                biased;
                _ = lease.cancelled() => {
                    yield Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "MCP session revoked or expired"));
                    break;
                }
                item = source.next() => match item {
                    Some(item) => yield item.map_err(std::io::Error::other),
                    None => break,
                },
            }
        }
    };
    Response::from_parts(parts, Body::from_stream(stream))
}

async fn handle(State(state): State<HttpState>, mut request: Request<Body>) -> Response {
    let token = crate::bearer_token(request.headers());
    // Only original credentials can initialize or resume; internal child
    // credentials cannot mint descendants or impersonate their parent.
    let owner = match token.as_deref() {
        Some(token) => match state.bridge.identity().resolve(token).await {
            Some(parent) => Some((parent.name, false)),
            None => state.bridge.perms().pane_for_token(token).await.map(|pane| (pane, true)),
        },
        None => None,
    };
    if token.as_deref().is_some_and(|t| t.starts_with("hyp_mcp_")) {
        return failure(StatusCode::UNAUTHORIZED, "Original session-owner credential required");
    }
    let id = match request.headers().get(SESSION_HEADER) {
        Some(id) => match id.to_str() {
            Ok(id) if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) => Some(id.to_owned()),
            _ => return failure(StatusCode::BAD_REQUEST, "Invalid MCP session ID"),
        },
        None => None,
    };
    let mut new_session = None;
    let mut lease = None;
    if let Some(id) = id {
        let Some((parent, is_pane)) = owner else {
            return failure(StatusCode::UNAUTHORIZED, "A session requires its original owner credential");
        };
        let record = match state.bridge.identity().sessions.resume(&parent, is_pane, &id) {
            Ok(record) => record,
            Err(error) => return failure(StatusCode::UNAUTHORIZED, error),
        };
        if request.method() == Method::DELETE {
            let _workflow = crate::delivery_service::WORKFLOW.lock().await;
            return match state.bridge.identity().sessions.revoke(&parent, is_pane, &id) {
                Ok(()) => {
                    if !is_pane { state.bridge.perms().remove_parent(&format!("agent:{}", record.name)); }
                    StatusCode::NO_CONTENT.into_response()
                }
                Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, error),
            };
        }
        lease = state.bridge.identity().sessions.lease_token(&record.forward_token);
        if lease.is_none() { return failure(StatusCode::UNAUTHORIZED, "MCP session revoked or expired"); }
        request.extensions_mut().insert(ForwardAuth(record.forward_token));
    } else if request.method() == Method::POST && owner.is_some() {
        let (parts, body) = request.into_parts();
        let bytes = match to_bytes(body, MAX_REQUEST_BYTES).await {
            Ok(bytes) => bytes,
            Err(error) => return failure(StatusCode::PAYLOAD_TOO_LARGE, error),
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => return failure(StatusCode::BAD_REQUEST, error),
        };
        if value["method"] == "initialize" {
            let parsed = serde_json::from_value::<rmcp::model::ClientJsonRpcMessage>(value.clone());
            if !matches!(parsed, Ok(rmcp::model::ClientJsonRpcMessage::Request(_))) {
                return failure(StatusCode::BAD_REQUEST, "Invalid initialize request");
            }
            new_session = Some((owner.unwrap(), value["params"].clone()));
        }
        request = Request::from_parts(parts, Body::from(bytes));
    }
    request.headers_mut().remove(SESSION_HEADER);
    let service = crate::mcp::streamable_http_service(state.port);
    let pending = service.handle(request);
    let mut response = if let Some(guard) = lease.as_mut() {
        tokio::select! {
            biased;
            _ = guard.cancelled() => return failure(StatusCode::UNAUTHORIZED, "MCP session revoked or expired"),
            result = pending => result.into_response(),
        }
    } else { pending.await.into_response() };
    if let Some(((parent, is_pane), client)) = new_session {
        let newcomer = client_name(&client);
        if response.status().is_success() {
            let result = if is_pane {
                // Serialize takeovers with queued work, just like DELETE.
                let _workflow = crate::delivery_service::WORKFLOW.lock().await;
                state.bridge.identity().create_pane_session(&parent, client).await
            } else {
                state.bridge.identity().create_session(&parent, client).await.map(|r| (r, false))
            };
            match result {
                Ok((record, takeover)) => {
                    if !is_pane {
                        state.bridge.perms().set_parent(&format!("agent:{}", record.name), &format!("agent:{}", parent));
                    }
                    lease = state.bridge.identity().sessions.lease_token(&record.forward_token);
                    if takeover { pane_notice(&state.bridge, &parent, false, &newcomer, None).await; }
                    response.headers_mut().insert(SESSION_HEADER, HeaderValue::from_str(&record.session_id).unwrap());
                }
                Err(error) if is_pane && error == PANE_CONFLICT => {
                    let holder = state.bridge.identity().sessions.active_pane_client(&parent);
                    pane_notice(&state.bridge, &parent, true, &newcomer, holder).await;
                    return failure(StatusCode::CONFLICT, error);
                }
                Err(error) => return failure(StatusCode::INTERNAL_SERVER_ERROR, error),
            }
        }
    }
    match lease { Some(lease) => guard_body(response, lease), None => response }
}

async fn whoami(State(state): State<HttpState>, headers: HeaderMap) -> Response {
    let id = state.bridge.resolve_caller(crate::bearer_token(&headers).as_deref()).await;
    if id.is_anonymous() { return failure(StatusCode::UNAUTHORIZED, "Authentication required"); }
    let session = crate::bearer_token(&headers).and_then(|token| state.bridge.identity().sessions.by_token(&token));
    let actor = crate::messaging::actor_from_identity(&state.bridge, &id).await.ok();
    let pane = actor.as_ref().and_then(|a| a.pane.clone()).or_else(|| match &id {
        CallerIdentity::Pane { pane, .. } => Some(pane.clone()),
        _ => None,
    });
    let mailbox = actor.as_ref().map(|a| a.principal.to_key()).unwrap_or_else(|| id.principal_key());
    Json(json!({
        "principal": id.principal_key(), "mailbox": mailbox, "label": id.label(), "kind": id.kind(),
        "credential_kind": match &id { CallerIdentity::Pane { .. } => "pane token", CallerIdentity::Agent { .. } => "agent token", _ => "system token" },
        "canonical_address": match &id { CallerIdentity::Agent { name, .. } => Some(name), _ => None },
        "parent": session.as_ref().map(|s| format!("{}:{}", if s.parent_is_pane { "pane" } else { "agent" }, s.parent)),
        "session_id": session.as_ref().map(|s| &s.session_id),
        "legacy": session.is_none(), "pane": pane,
        "parent_mailbox_rule": "Bare parent labels address a separate parent mailbox; children do not consume it."
    })).into_response()
}

#[derive(Deserialize)]
struct LabelRequest { label: String }

async fn set_label(State(state): State<HttpState>, headers: HeaderMap, Json(req): Json<LabelRequest>) -> Response {
    let id = state.bridge.resolve_caller(crate::bearer_token(&headers).as_deref()).await;
    let CallerIdentity::Agent { name, .. } = id else {
        return failure(StatusCode::UNAUTHORIZED, "An authenticated MCP child session is required");
    };
    match state.bridge.identity().set_session_label(&name, &req.label).await {
        Ok(record) => Json(json!({"ok": true, "principal": format!("agent:{}", record.name),
            "canonical_address": record.name, "label": record.label})).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error),
    }
}
