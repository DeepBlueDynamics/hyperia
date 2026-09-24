use super::*;

fn isolated_store() -> PermStore {
    PermStore {
        parents: std::sync::RwLock::default(),
        pending: Mutex::default(), grants: Mutex::default(), tokens: Mutex::default(),
        owners: Mutex::default(), denials: Mutex::default(), create_grants: Mutex::default(),
        cap_grants: Mutex::default(), enforce: AtomicBool::new(true),
        next_id: AtomicU64::default(), persist_path: None,
    }
}

#[tokio::test]
async fn message_approval_never_grants_drive_or_another_recipient() {
    let store = isolated_store();
    let req = store.create_request("alice", "pA", "pB", "message:agent:bob", "send mail").await;
    store.respond(&req.id, true, "any", None).await.unwrap();
    assert!(store.has_message_grant("alice", "agent:bob").await);
    assert!(!store.has_message_grant("alice", "agent:carol").await);
    assert!(!store.has_message_grant("eve", "agent:bob").await);
    assert!(store.grants_for("alice").await.is_empty());
}

#[tokio::test]
async fn pending_message_does_not_suppress_drive_and_denial_grants_nothing() {
    let store = isolated_store();
    let req = store.create_request("alice", "pA", "pB", "message:agent:bob", "").await;
    assert!(!store.has_pending("alice", "pB").await);
    assert!(store.pending_action_for("alice", "message:agent:bob").await.is_some());
    assert!(store.pending_action_for("eve", "message:agent:bob").await.is_none());
    store.respond(&req.id, false, "pane", None).await.unwrap();
    assert!(!store.has_message_grant("alice", "agent:bob").await);
    assert!(store.pending_action_for("alice", "message:agent:bob").await.is_none());
}

#[tokio::test]
async fn expired_message_grant_is_rejected() {
    let store = isolated_store();
    store.grants.lock().await.push(Grant {
        requester: "alice".into(), scope: "message".into(), pane: "agent:bob".into(),
        expires_at: Some(Instant::now() - Duration::from_secs(1)),
    });
    assert!(!store.has_message_grant("alice", "agent:bob").await);
}

#[tokio::test]
async fn binding_approval_never_grants_drive_and_isolates_denial() {
    let store = isolated_store();
    let req = store.create_request("alice", "", "pB", "bind:alice", "associate mailbox").await;
    assert!(!store.has_pending("alice", "pB").await);
    assert!(store.pending_action_for("alice", "bind:alice").await.is_some());

    // Approval must not grant drive access to pB or any other pane
    let resolved = store.respond(&req.id, true, "pane", None).await.unwrap();
    assert_eq!(resolved.id, req.id);
    assert!(store.grants_for("alice").await.is_empty());
    assert!(!store.has_message_grant("alice", "pB").await);
    assert!(store.pending_action_for("alice", "bind:alice").await.is_none());

    // Denial must be scoped to bind:alice, never suppressing drive on target pane
    let req2 = store.create_request("alice", "", "pB", "bind:alice", "retry").await;
    store.respond(&req2.id, false, "pane", None).await.unwrap();
    assert!(store.recently_denied("alice", "bind:alice").await);
    assert!(!store.recently_denied("alice", "pB").await);
    assert!(store.grants_for("alice").await.is_empty());
}

