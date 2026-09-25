use super::*;
use crate::identity::{AgentRecord, IdentityStore};
use crate::perms::PermStore;
use crate::msgbus::mailbox::{self, Principal};
use std::time::Duration;

struct Fixture { dir: PathBuf }
impl Fixture {
    fn new() -> Self {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-fixtures")
            .join(format!("mcp-sessions-{}", random_hex(12).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }
    fn bridge(&self) -> Bridge {
        Bridge::with_stores(IdentityStore::for_tests(self.dir.join("sessions.json"),
            vec![
                AgentRecord { name: "parent".into(), token: "hyp_agent_test_parent".into(), created_ms: 1, single_session: false },
                AgentRecord { name: "other".into(), token: "hyp_agent_test_other".into(), created_ms: 1, single_session: false },
                AgentRecord { name: "solo".into(), token: "hyp_agent_test_solo".into(), created_ms: 1, single_session: true },
                // Single-session by the interim nemesis8/ name rule, flag unset.
                AgentRecord { name: "nemesis8/n8-test-urchin".into(), token: "hyp_agent_test_n8".into(), created_ms: 1, single_session: false },
            ]), PermStore::for_tests())
    }
    fn mail(&self) -> crate::messaging::MailContext {
        crate::messaging::MailContext {
            bindings: mailbox::BindingStore::new(self.dir.join("bindings.json")).unwrap(),
            messages: self.dir.join("messages.jsonl"),
            reads: self.dir.join("reads.jsonl"),
        }
    }
}

async fn add_pane(bridge: &Bridge, pane: &str) {
    bridge.sessions().await.insert(pane.into(), crate::bridge::SessionInfo {
        name: "shell".into(), shell_name: "Fixture pane".into(), tab_name: "test".into(),
        description: String::new(), rows: 24, cols: 80, pid: 1, root_tab_uid: "fixture-tab".into(),
        window_id: 1, split_label: "a".into(), tab_order: 0, tab_active: true, pane_active: true,
        screen: crate::screen::ScreenBuffer::new(24, 80, 1000),
        bsp_x: 0.0, bsp_y: 0.0, bsp_w: 100.0, bsp_h: 100.0, cwd: String::new(),
        last_user_activity: None, last_output_at: None, title: String::new(), shell_state: "idle".into(),
        shell_app: None, shell_last_exit: None, shell_has_integration: false,
    });
}

fn agent(name: &str) -> CallerIdentity {
    CallerIdentity::Agent { name: name.into(), token: String::new(), label: None }
}

fn send(mail: &crate::messaging::MailContext, from: &Principal, to: &Principal, body: &str) -> String {
    mailbox::send_message(&mail.messages, mailbox::SendParams {
        from, to, body, subject: "", from_pane_hint: None, to_pane_hint: None,
        from_label: None, to_label: None, idempotency_key: None,
    }).unwrap()
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
}

struct Server { url: String, task: tokio::task::JoinHandle<()> }
impl Drop for Server { fn drop(&mut self) { self.task.abort(); } }
async fn server(bridge: Bridge, peers: bool) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = routes(bridge.clone(), port)
        .layer(axum::middleware::from_fn_with_state(bridge, crate::identity_mw));
    let task = tokio::spawn(async move {
        if peers {
            axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
        } else {
            axum::serve(listener, app).await.unwrap();
        }
    });
    Server { url: format!("http://127.0.0.1:{port}"), task }
}
fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap()
}
fn initialize() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}
    }})
}
async fn post(server: &Server, token: &str, sid: Option<&str>, body: Value) -> reqwest::Response {
    let mut request = client().post(format!("{}/mcp", server.url))
        .bearer_auth(token).header("accept", "application/json, text/event-stream")
        .header("connection", "close").json(&body);
    if let Some(sid) = sid { request = request.header(SESSION_HEADER, sid); }
    request.send().await.unwrap()
}
async fn init(server: &Server, token: &str) -> String {
    let response = post(server, token, None, initialize()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let sid = response.headers()[SESSION_HEADER].to_str().unwrap().to_owned();
    let text = response.text().await.unwrap();
    assert!(!text.contains("hyp_mcp_"));
    assert!(!text.contains(token));
    sid
}
async fn tool(server: &Server, token: &str, sid: Option<&str>, name: &str, arguments: Value) -> Value {
    let response = post(server, token, sid, json!({"jsonrpc":"2.0","id":2,
        "method":"tools/call","params":{"name":name,"arguments":arguments}})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(!body.contains("hyp_mcp_"), "internal credential in MCP response");
    assert!(!body.contains(token), "owner credential in MCP response");
    let rpc: Value = if body.trim_start().starts_with('{') {
        serde_json::from_str(&body).unwrap()
    } else {
        body.lines().filter_map(|line| line.strip_prefix("data:"))
            .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
            .find(|v| v.get("id").is_some()).unwrap_or_else(|| panic!("No RPC response: {body}"))
    };
    assert!(rpc.get("error").is_none(), "{rpc}");
    serde_json::from_str(rpc["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}
fn quiet(bridge: &Bridge, sid: &str) {
    let mut records = bridge.identity().sessions.records().unwrap();
    records.iter_mut().find(|r| r.session_id == sid).unwrap().last_used_ms =
        now_ms().saturating_sub(PANE_CLAIM_QUIET_MS + 1);
}

#[tokio::test]
async fn http_children_are_distinct_and_resume_after_restart() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let first = server(bridge.clone(), true).await;
    let a = init(&first, "hyp_agent_test_parent").await;
    let b = init(&first, "hyp_agent_test_parent").await;
    assert_ne!(a, b);
    let before = tool(&first, "hyp_agent_test_parent", Some(&a), "whoami", json!({})).await;
    let sibling = tool(&first, "hyp_agent_test_parent", Some(&b), "whoami", json!({})).await;
    assert_ne!(before["principal"], sibling["principal"]);
    assert_eq!(before["parent"], "agent:parent");
    assert_eq!(before["credential_kind"], "agent token");
    assert_eq!(before["legacy"], false);
    let named = tool(&first, "hyp_agent_test_parent", Some(&a), "set_label", json!({"label":"worker-one"})).await;
    assert_eq!(named["principal"], before["principal"]);
    assert_eq!(named["label"], "worker-one");
    assert_eq!(bridge.identity().mail_address("worker-one").await.unwrap().0, before["canonical_address"]);
    assert_eq!(bridge.identity().mail_address("parent").await.unwrap().0, "parent");
    let legacy = tool(&first, "hyp_agent_test_parent", None, "whoami", json!({})).await;
    assert_eq!(legacy["principal"], "agent:parent");
    assert_eq!(legacy["legacy"], true);
    let old_internal = bridge.identity().sessions.by_name(before["canonical_address"].as_str().unwrap()).unwrap().forward_token;
    drop(first);
    drop(bridge);
    let restarted = fixture.bridge();
    assert!(restarted.identity().sessions.by_token(&old_internal).is_none());
    let second = server(restarted, true).await;
    let after = tool(&second, "hyp_agent_test_parent", Some(&a), "whoami", json!({})).await;
    assert_eq!(after["principal"], before["principal"]);
    assert_eq!(after["label"], "worker-one");
    assert_eq!(after["session_id"], a);
    assert_eq!(post(&second, "hyp_agent_test_other", Some(&a), initialize()).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(post(&second, "hyp_agent_test_parent", Some(&"f".repeat(32)), initialize()).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn delete_revokes_credentials_and_persisted_session_without_resurrection() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let srv = server(bridge.clone(), true).await;
    let sid = init(&srv, "hyp_agent_test_parent").await;
    let record = bridge.identity().sessions.resume("parent", false, &sid).unwrap();
    let mut lease = bridge.identity().sessions.lease_token(&record.forward_token).unwrap();
    assert_eq!(post(&srv, &record.forward_token, None, initialize()).await.status(), StatusCode::UNAUTHORIZED);
    let response = client().delete(format!("{}/mcp", srv.url)).bearer_auth("hyp_agent_test_parent")
        .header(SESSION_HEADER, &sid).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    tokio::time::timeout(Duration::from_secs(1), lease.cancelled()).await.unwrap();
    assert!(!bridge.identity().sessions.principal_active(&format!("agent:{}", record.name)));
    assert!(bridge.resolve_caller(Some(&record.forward_token)).await.is_anonymous());
    assert_eq!(post(&srv, "hyp_agent_test_parent", Some(&sid), initialize()).await.status(), StatusCode::UNAUTHORIZED);
    let restarted = fixture.bridge();
    assert!(restarted.identity().sessions.resume("parent", false, &sid).is_err());
    restarted.perms().grant_cap(&format!("agent:{}", record.name), "files").await;
    assert!(!restarted.perms().has_cap(&format!("agent:{}", record.name), "files").await);
    let disk = std::fs::read_to_string(fixture.dir.join("sessions.json")).unwrap();
    assert!(!disk.contains("hyp_mcp_"));
    assert!(!disk.contains("hyp_agent_"));
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(fixture.dir.join("sessions.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test]
async fn pane_conflict_is_audited_and_quiet_takeover_fails_old_session_closed() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let pane = format!("pane-{}", random_hex(8).unwrap());
    bridge.perms().set_pane_token(&pane, "hyp_test_pane").await;
    let mut notices = bridge.test_notifications().await;
    let srv = server(bridge.clone(), true).await;
    let sid = init(&srv, "hyp_test_pane").await;
    let identity = tool(&srv, "hyp_test_pane", Some(&sid), "whoami", json!({})).await;
    assert_eq!(identity["principal"], format!("pane:{pane}"));
    assert_eq!(identity["credential_kind"], "pane token");
    assert_eq!(identity["session_id"], sid);
    let conflict = post(&srv, "hyp_test_pane", None, initialize()).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let notice: Value = serde_json::from_str(&notices.recv().await.unwrap()).unwrap();
    assert_eq!(notice["type"], "AgentNotice");
    assert_eq!(notice["text"], pane_notice_text(&pane, true, "fixture", Some("fixture")));
    assert!(crate::audit::TEST_ENTRIES.lock().unwrap().iter().any(|v|
        v["identity"] == format!("pane:{pane}") && v["event"] == "pane_token_conflict" && v["status"] == 409));
    quiet(&bridge, &sid);
    let successor = init(&srv, "hyp_test_pane").await;
    assert_ne!(sid, successor);
    let notice: Value = serde_json::from_str(&notices.recv().await.unwrap()).unwrap();
    assert_eq!(notice["text"], pane_notice_text(&pane, false, "fixture", None));
    assert!(crate::audit::TEST_ENTRIES.lock().unwrap().iter().any(|v|
        v["identity"] == format!("pane:{pane}") && v["event"] == "pane_session_takeover"));
    assert_eq!(post(&srv, "hyp_test_pane", Some(&sid), initialize()).await.status(), StatusCode::UNAUTHORIZED);
    // DELETE releases a fresh claim immediately, without the quiet-period wait.
    assert_eq!(client().delete(format!("{}/mcp", srv.url)).bearer_auth("hyp_test_pane")
        .header(SESSION_HEADER, &successor).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_ne!(init(&srv, "hyp_test_pane").await, successor);
    // Multiple agent-token sessions are independent of the exclusive pane claim.
    assert_ne!(init(&srv, "hyp_agent_test_parent").await, init(&srv, "hyp_agent_test_parent").await);
}

#[tokio::test]
async fn in_flight_pane_request_blocks_takeover_even_when_last_activity_is_old() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let (first, _) = bridge.identity().sessions.create_pane("pane", json!({}), &[]).unwrap();
    let lease = bridge.identity().sessions.lease_token(&first.forward_token).unwrap();
    quiet(&bridge, &first.session_id);
    assert_eq!(bridge.identity().sessions.create_pane("pane", json!({}), &[]).err().unwrap(), PANE_CONFLICT);
    drop(lease);
    let (second, takeover) = bridge.identity().sessions.create_pane("pane", json!({}), &[]).unwrap();
    assert!(takeover);
    assert_ne!(first.session_id, second.session_id);
    assert!(bridge.identity().sessions.by_token(&first.forward_token).is_none());
}

#[tokio::test]
async fn labels_are_unique_immutable_principals_keep_their_mail_and_receipts() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let a = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let b = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let a_principal = Principal::Agent(a.name.clone());
    let b_principal = Principal::Agent(b.name.clone());
    let parent = Principal::Agent("parent".into());
    let messages = fixture.dir.join("messages.jsonl");
    let reads = fixture.dir.join("reads.jsonl");
    for recipient in [&parent, &a_principal, &b_principal] {
        mailbox::send_message(&messages, mailbox::SendParams {
            from: &Principal::System, to: recipient, body: "assignment", subject: "",
            from_pane_hint: None, to_pane_hint: None, from_label: None, to_label: None, idempotency_key: None,
        }).unwrap();
    }
    let updated = bridge.identity().set_session_label(&a.name, "worker").await.unwrap();
    assert_eq!(updated.name, a.name);
    assert!(bridge.identity().set_session_label(&b.name, "worker").await.is_err());
    assert!(bridge.identity().set_session_label(&b.name, "parent").await.is_err());
    assert!(bridge.identity().set_session_label(&b.name, "pane:pretend").await.is_err());
    assert!(bridge.identity().register("worker", false).await.is_err());
    assert_eq!(mailbox::check_inbox(&messages, &reads, &a_principal, None, 100).unwrap().len(), 1);
    assert!(mailbox::check_inbox(&messages, &reads, &a_principal, None, 100).unwrap().is_empty());
    assert_eq!(mailbox::inbox(&messages, &reads, &parent, None, true, 100).unwrap().len(), 1);
    assert_eq!(mailbox::inbox(&messages, &reads, &b_principal, None, true, 100).unwrap().len(), 1);
    let receipts = std::fs::read_to_string(reads).unwrap();
    assert!(receipts.contains(&a_principal.to_key()));
    assert!(!receipts.contains(&b_principal.to_key()));
}

#[tokio::test]
async fn parent_grants_flow_to_children_but_child_grants_and_consent_stay_separate() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let a = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let b = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let ak = format!("agent:{}", a.name);
    let bk = format!("agent:{}", b.name);
    let parent = "agent:parent";
    for child in [&ak, &bk] { bridge.perms().set_parent(child, parent); }
    bridge.perms().grant_cap(parent, "files").await;
    bridge.perms().grant_cap(&ak, "settings").await;
    assert!(bridge.perms().has_cap(&ak, "files").await);
    assert!(bridge.perms().has_cap(&bk, "files").await);
    assert!(bridge.perms().has_cap(&ak, "settings").await);
    assert!(!bridge.perms().has_cap(&bk, "settings").await);
    assert!(!bridge.perms().has_cap(parent, "settings").await);
    bridge.perms().grant_create(parent, true, None).await;
    assert!(bridge.perms().has_create(&ak).await);
    assert!(!bridge.perms().has_create(&bk).await);
    assert!(!bridge.perms().has_create(parent).await);
    let drive = bridge.perms().create_request(parent, "", "target", "drive", "test").await;
    bridge.perms().respond(&drive.id, true, "pane", None).await;
    assert_eq!(bridge.perms().grants_for(&ak).await, vec![("pane".into(), "target".into())]);
    let message = bridge.perms().create_request(parent, "", "", "message:agent:recipient", "test").await;
    bridge.perms().respond(&message.id, true, "message", None).await;
    assert!(bridge.perms().has_message_grant(&ak, "agent:recipient").await);
    let child_request = bridge.perms().create_request(&ak, "", "target-two", "drive", "child request").await;
    assert_eq!(child_request.requester, ak);
    assert!(!bridge.perms().has_pending(&bk, "target-two").await);
    bridge.perms().respond(&child_request.id, true, "pane", None).await;
    assert!(!bridge.perms().grants_for(parent).await.iter().any(|(_, target)| target == "target-two"));
    assert!(!bridge.perms().grants_for(&bk).await.iter().any(|(_, target)| target == "target-two"));
}

#[tokio::test]
async fn internal_credential_requires_verified_loopback_peer() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let child = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let no_peer = server(bridge.clone(), false).await;
    let response = client().get(format!("{}/api/identity/whoami", no_peer.url))
        .bearer_auth(&child.forward_token).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let with_peer = server(bridge, true).await;
    let response = client().get(format!("{}/api/identity/whoami", with_peer.url))
        .bearer_auth(&child.forward_token).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(!body.contains(&child.forward_token));
}

#[tokio::test]
async fn revoke_or_expiry_cancels_in_flight_response_body() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let child = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let lease = bridge.identity().sessions.lease_token(&child.forward_token).unwrap();
    let never = futures::stream::pending::<Result<axum::body::Bytes, std::io::Error>>();
    let response = guard_body(Response::new(Body::from_stream(never)), lease);
    bridge.identity().sessions.revoke("parent", false, &child.session_id).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(1), to_bytes(response.into_body(), 100)).await.unwrap().is_err());
    let expiring = bridge.identity().create_session("parent", json!({})).await.unwrap();
    bridge.identity().sessions.records().unwrap().iter_mut()
        .find(|r| r.session_id == expiring.session_id).unwrap().expires_ms = Some(now_ms() + 100);
    let mut lease = bridge.identity().sessions.lease_token(&expiring.forward_token).unwrap();
    tokio::time::timeout(Duration::from_secs(1), lease.cancelled()).await.unwrap();
    assert!(bridge.identity().sessions.by_token(&expiring.forward_token).is_none());
    let principal = format!("agent:{}", expiring.name);
    bridge.perms().set_parent_until(&principal, "agent:parent", Some(now_ms().saturating_sub(1)));
    bridge.perms().grant_cap("agent:parent", "files").await;
    bridge.perms().grant_cap(&principal, "settings").await;
    assert!(!bridge.perms().has_cap(&principal, "files").await);
    assert!(!bridge.perms().has_cap(&principal, "settings").await);
}

#[tokio::test]
async fn revocation_cancels_pending_api_work_before_mutation() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let child = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let proceed = Arc::new(tokio::sync::Notify::new());
    let mutations = Arc::new(AtomicUsize::new(0));
    let handler_started = started.clone();
    let handler_proceed = proceed.clone();
    let handler_mutations = mutations.clone();
    let app = Router::new().route("/api/test-mutation", axum::routing::post(move || {
        let started = handler_started.clone();
        let proceed = handler_proceed.clone();
        let mutations = handler_mutations.clone();
        async move {
            started.notify_one();
            proceed.notified().await;
            mutations.fetch_add(1, Ordering::SeqCst);
            StatusCode::OK
        }
    })).layer(axum::middleware::from_fn_with_state(bridge.clone(), crate::identity_mw));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    let srv = Server { url: format!("http://127.0.0.1:{port}"), task };
    let request = client().post(format!("{}/api/test-mutation", srv.url)).bearer_auth(&child.forward_token);
    let pending = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::timeout(Duration::from_secs(2), started.notified()).await.unwrap();
    bridge.identity().sessions.revoke("parent", false, &child.session_id).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), pending).await.unwrap().unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    proceed.notify_one();
    tokio::task::yield_now().await;
    assert_eq!(mutations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn non_loopback_peer_cannot_use_internal_credentials() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let child = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = routes(bridge.clone(), port)
        .layer(axum::middleware::from_fn_with_state(bridge, crate::identity_mw))
        .layer(axum::middleware::from_fn(|mut request: Request<Body>, next: axum::middleware::Next| async move {
            request.extensions_mut().insert(axum::extract::ConnectInfo("192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap()));
            next.run(request).await
        }));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let srv = Server { url: format!("http://127.0.0.1:{port}"), task };
    let response = client().get(format!("{}/api/identity/whoami", srv.url))
        .bearer_auth(&child.forward_token).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn corrupt_store_fails_closed_instead_of_recreating_sessions() {
    let fixture = Fixture::new();
    let path = fixture.dir.join("sessions.json");
    std::fs::write(&path, b"{broken").unwrap();
    let store = SessionStore::open(path.clone());
    assert!(store.create("parent", json!({}), &[]).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"{broken");
}

#[test]
fn pane_conflict_notice_names_both_clients_and_the_usual_cause() {
    let text = pane_notice_text("11e87950-9f57-4e6b-86ff-46a5ac40be22", true, "mcp", Some("codex-mcp-client"));
    assert!(text.starts_with("Pane 11e87950:"));
    assert!(text.contains("codex-mcp-client holds the session; mcp was refused"));
    assert!(text.contains("two Hyperia MCP servers"));
    assert!(!text.contains("token crossing"));
    assert_eq!(client_name(&json!({"clientInfo": {"name": ""}})), "an unnamed client");
}

#[tokio::test]
async fn single_session_agents_initialize_as_themselves_without_a_child() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    // A pre-existing child of an agent that later opted in keeps resuming.
    let old_child = bridge.identity().create_session("solo", json!({})).await.unwrap();
    let srv = server(bridge.clone(), true).await;
    for (token, name) in [("hyp_agent_test_solo", "solo"), ("hyp_agent_test_n8", "nemesis8/n8-test-urchin")] {
        for _reconnect in 0..2 {
            let response = post(&srv, token, None, initialize()).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().get(SESSION_HEADER).is_none(), "{name} was given a child session");
            let me = tool(&srv, token, None, "whoami", json!({})).await;
            assert_eq!(me["principal"], format!("agent:{name}"));
            assert_eq!(me["canonical_address"], name);
            assert_eq!(me["legacy"], true);
            assert!(me["session_id"].is_null());
        }
    }
    let records = bridge.identity().sessions.records().unwrap().clone();
    assert!(!records.iter().any(|r| r.parent == "nemesis8/n8-test-urchin"));
    assert_eq!(records.iter().filter(|r| r.parent == "solo").count(), 1);
    let resumed = tool(&srv, "hyp_agent_test_solo", Some(&old_child.session_id), "whoami", json!({})).await;
    assert_eq!(resumed["principal"], format!("agent:{}", old_child.name));
    // A plain multi-session agent still gets a child per initialize.
    init(&srv, "hyp_agent_test_parent").await;
}

#[tokio::test]
async fn child_reads_parent_mail_but_not_sibling_mail_and_sends_as_itself() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let mail = fixture.mail();
    let a = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let b = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let parent = Principal::Agent("parent".into());
    let (a_key, b_key) = (Principal::Agent(a.name.clone()), Principal::Agent(b.name.clone()));
    let to_parent = send(&mail, &Principal::System, &parent, "for the agent");
    let to_a = send(&mail, &Principal::System, &a_key, "for session a only");

    let who_a = crate::messaging::actor_in(&bridge, &mail, &agent(&a.name)).await.unwrap();
    let who_b = crate::messaging::actor_in(&bridge, &mail, &agent(&b.name)).await.unwrap();
    assert_eq!(who_a.principal, a_key);
    assert_eq!(who_b.principal, b_key);
    assert_eq!(who_a.parent, Some(parent.clone()));
    assert_eq!(who_a.requester, format!("agent:{}", a.name));

    let a_mail = mailbox::check_inbox_as(&mail.messages, &mail.reads, &who_a.reader(), 100, None).unwrap();
    let ids: Vec<_> = a_mail.iter().map(|m| m.id.as_str()).collect();
    assert!(ids.contains(&to_parent.as_str()) && ids.contains(&to_a.as_str()));
    // Receipts are per child: b still sees the parent mail, and never the mail sent to a.
    let b_mail = mailbox::inbox_as(&mail.messages, &mail.reads, &who_b.reader(), true, 100).unwrap();
    assert_eq!(b_mail.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec![to_parent.as_str()]);
    assert!(mailbox::acknowledge_as(&mail.reads, &mail.messages, &to_a, &who_b.reader()).is_err());
    assert!(mailbox::inbox_as(&mail.messages, &mail.reads, &who_a.reader(), true, 100).unwrap().is_empty());
    // A child read counts for the parent recipient (sender status, pane badge).
    assert!(mailbox::recipient_has_read(&mail.messages, &mail.reads, &to_parent).unwrap());
    assert!(mailbox::inbox(&mail.messages, &mail.reads, &parent, None, true, 100).unwrap().is_empty());
    // A registered agent has no parent view.
    let who_parent = crate::messaging::actor_in(&bridge, &mail, &agent("parent")).await.unwrap();
    assert!(who_parent.parent.is_none());

    // Sends go out as the child, so replies route back to that session.
    let sent = send(&mail, &who_a.principal, &Principal::Agent("other".into()), "reply");
    let found = mailbox::search_as(&mail.messages, &mail.reads, &who_a.reader(), mailbox::SearchScope::Sent, None, 10).unwrap();
    assert_eq!(found[0].id, sent);
    assert_eq!(found[0].from_principal, a_key.to_key());
    assert!(mailbox::search(&mail.messages, &mail.reads, &parent, None, mailbox::SearchScope::Sent, None, 10).unwrap().is_empty());

    // A child inherits its parent's live pane binding for pane mail.
    let pane = format!("pane-{}", random_hex(8).unwrap());
    add_pane(&bridge, &pane).await;
    mail.bindings.verify_and_bind("parent", &pane, mailbox::ProofOfResidency::System, |_, _| false).unwrap();
    let who_a = crate::messaging::actor_in(&bridge, &mail, &agent(&a.name)).await.unwrap();
    assert_eq!(who_a.pane.as_deref(), Some(pane.as_str()));
    let pane_mail = send(&mail, &Principal::System, &Principal::Pane(pane.clone()), "for the pane");
    let unread = mailbox::inbox_as(&mail.messages, &mail.reads, &who_a.reader(), true, 100).unwrap();
    assert!(unread.iter().any(|m| m.id == pane_mail));
}

#[tokio::test]
async fn pane_bind_from_a_child_binds_its_registered_parent() {
    let fixture = Fixture::new();
    let bridge = fixture.bridge();
    let mail = fixture.mail();
    let child = bridge.identity().create_session("parent", json!({})).await.unwrap();
    let pane = format!("pane-{}", random_hex(8).unwrap());
    add_pane(&bridge, &pane).await;
    let token = bridge.perms().token_for(&pane).await;
    let request = |agent: Option<&str>| crate::messaging::BindRequest {
        pane: pane.clone(), agent: agent.map(String::from), pane_token: Some(token.clone()),
    };

    let bound = crate::messaging::bind_in(&bridge, &mail, &agent(&child.name), request(None)).await.unwrap().0;
    assert_eq!(bound["agent"], "parent");
    assert_eq!(bound["session"], child.name);
    assert_eq!(bound["binding"]["agent"], "parent");
    assert_eq!(mail.bindings.pane_for_agent("parent").as_deref(), Some(pane.as_str()));
    assert!(mail.bindings.pane_for_agent(&child.name).is_none());
    // Naming the parent explicitly works; naming some other agent does not.
    assert!(crate::messaging::bind_in(&bridge, &mail, &agent(&child.name), request(Some("parent"))).await.is_ok());
    let err = crate::messaging::bind_in(&bridge, &mail, &agent(&child.name), request(Some("other"))).await.unwrap_err();
    assert_eq!(err.0, StatusCode::FORBIDDEN);

    // A child whose parent is not a registered agent is still refused.
    let orphan = bridge.identity().sessions.create("unregistered-parent", json!({}), &[]).unwrap();
    let err = crate::messaging::bind_in(&bridge, &mail, &agent(&orphan.name), request(None)).await.unwrap_err();
    assert_eq!(err.0, StatusCode::NOT_FOUND);
    // So is an inactive pane, same as for the parent itself.
    let mut gone = request(None);
    gone.pane = "pane-not-open".into();
    let err = crate::messaging::bind_in(&bridge, &mail, &agent(&child.name), gone).await.unwrap_err();
    assert_eq!(err.0, StatusCode::NOT_FOUND);

    // The approval flow accepts a request raised by the child for its parent,
    let second = format!("pane-{}", random_hex(8).unwrap());
    add_pane(&bridge, &second).await;
    let approval = |requester: String| crate::perms::PermRequest {
        id: "req-1".into(), requester, requester_pane: String::new(),
        target_pane: second.clone(), action: "bind:parent".into(), purpose: String::new(),
    };
    crate::messaging::approve_binding_in(&bridge, &mail, &approval(format!("agent:{}", child.name))).await.unwrap();
    assert_eq!(mail.bindings.pane_for_agent("parent").as_deref(), Some(second.as_str()));
    // but not one raised by another agent's child, or by an orphan.
    let foreign = bridge.identity().create_session("other", json!({})).await.unwrap();
    for requester in [format!("agent:{}", foreign.name), format!("agent:{}", orphan.name)] {
        let err = crate::messaging::approve_binding_in(&bridge, &mail, &approval(requester)).await.unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
    }
}
