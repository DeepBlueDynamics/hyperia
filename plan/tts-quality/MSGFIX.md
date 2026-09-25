# Pane-token mailbox deadlock fix

Status: patch and regression test written; compilation/test execution blocked by missing container toolchain and a host terminal_run timeout. No commit or deployment performed.

## Cause and change

Verified by reading messaging.rs actor_from_identity and bridge.rs pane_display_name: the pane identity branch retained the sessions mutex guard while awaiting pane_display_name, which acquires the same mutex. The patch limits the guard to the synchronous mailbox_identity lookup before awaiting the display name. This preserves active-pane authorization and binding lookup.

The Agent branch has no subsequent await while holding its guard; it now uses the same explicit scope. unread_for_pane likewise drops its guard before synchronous inbox file I/O. bind and approve_binding compute pane_is_active in a separate statement before awaiting identity.list, preventing a temporary session guard from spanning that await. resolve_target has no await after acquiring its guard; prepare uses a match guard with no second await inside that match. No other retained session guards across awaits were found in messaging.rs.

## Regression coverage

Added messaging::tests::pane_token_actor_completes_without_relocking_sessions. It registers an active pane in an in-memory Bridge, obtains a pane token, sends it through the same actor authentication path used by check/inbox/send, and requires completion within two seconds. It asserts the principal, pane, display name, and requester, then requires the session table to remain lockable within two seconds. This exercises actor_from_identity indirectly through actor; it does not write or acknowledge mailbox messages. Existing Bridge/context initialization reads the standard local stores, following the existing Bridge unit-test convention.

## Validation

- git diff --check -- sidecar/src/messaging.rs: passed after removing an extra EOF blank line (only Git CRLF normalization warning).
- Attempted: cargo test --manifest-path sidecar/Cargo.toml --target-dir sidecar/target/codex-linux --no-default-features messaging::tests::pane_token_actor_completes_without_relocking_sessions -- --exact
- Result: cargo could not start; rustup has no installed toolchains and no default. No test passed, and compilation remains unverified. The n8 build --rust image option supplies the missing toolchain.
- Requested host access and opened worker shell c0a1ba1a-6833-4518-88c7-d232c3149bf8. terminal_screen verified a PowerShell prompt in the host repository. terminal_run of cargo --version returned MCP -32603 after about 30 seconds: timed out waiting (possibly for consent); approve and retry. No host Cargo output received. The shell remains open; do not blindly replay a potentially retained operation.
- Host-claude can run the command above against the shared patch. All Cargo artifacts must stay in sidecar/target/codex-linux. The no-default-features flag excludes unrelated TTS/native audio dependencies for this messaging regression.

## Diff

```diff
diff --git a/sidecar/src/messaging.rs b/sidecar/src/messaging.rs
index b92edcc6..defa7234 100644
--- a/sidecar/src/messaging.rs
+++ b/sidecar/src/messaging.rs
@@ -68,17 +68,23 @@ pub async fn actor_from_identity(bridge: &Bridge, id: &CallerIdentity) -> Result
         CallerIdentity::Anonymous => Err(error(StatusCode::UNAUTHORIZED, "Authentication required for messaging.")),
         CallerIdentity::System => Ok(MailActor { principal: Principal::System, label: "Hyperia".into(), pane: None, requester }),
         CallerIdentity::Agent { name, .. } => {
-            let sessions = bridge.sessions().await;
-            let (principal, pane) = store.bindings.mailbox_identity(
-                &Principal::Agent(name.clone()), |pane| sessions.contains_key(pane),
-            ).map_err(mailbox_error)?;
+            let (principal, pane) = {
+                let sessions = bridge.sessions().await;
+                store.bindings.mailbox_identity(
+                    &Principal::Agent(name.clone()), |pane| sessions.contains_key(pane),
+                ).map_err(mailbox_error)?
+            };
             Ok(MailActor { principal, label: id.label(), pane, requester })
         }
         CallerIdentity::Pane { pane, .. } => {
-            let sessions = bridge.sessions().await;
-            let (principal, _) = store.bindings.mailbox_identity(
-                &Principal::Pane(pane.clone()), |pane| sessions.contains_key(pane),
-            ).map_err(mailbox_error)?;
+            // pane_display_name also locks the session table. Drop this guard
+            // before awaiting it so pane-token mailbox calls cannot self-deadlock.
+            let (principal, _) = {
+                let sessions = bridge.sessions().await;
+                store.bindings.mailbox_identity(
+                    &Principal::Pane(pane.clone()), |pane| sessions.contains_key(pane),
+                ).map_err(mailbox_error)?
+            };
             let label = bridge.pane_display_name(pane).await.unwrap_or_else(|| pane.clone());
             Ok(MailActor { principal, label, pane: Some(pane.clone()), requester })
         }
@@ -201,10 +207,12 @@ pub async fn store_approved(bridge: &Bridge, msg: &PreparedMessage) -> Result<St
 
 pub async fn unread_for_pane(bridge: &Bridge, pane: &str) -> Result<usize, ApiError> {
     let store = context()?;
-    let sessions = bridge.sessions().await;
-    let (principal, _) = store.bindings.mailbox_identity(
-        &Principal::Pane(pane.into()), |pane| sessions.contains_key(pane),
-    ).map_err(mailbox_error)?;
+    let (principal, _) = {
+        let sessions = bridge.sessions().await;
+        store.bindings.mailbox_identity(
+            &Principal::Pane(pane.into()), |pane| sessions.contains_key(pane),
+        ).map_err(mailbox_error)?
+    };
     Ok(mailbox::inbox(&store.messages, &store.reads, &principal, Some(pane), true, 2000)
         .map_err(mailbox_error)?.len())
 }
@@ -277,7 +285,8 @@ pub async fn check(
 pub async fn approve_binding(bridge: &Bridge, req: &crate::perms::PermRequest) -> Result<(), ApiError> {
     let name = req.action.strip_prefix("bind:").ok_or_else(|| error(StatusCode::BAD_REQUEST, "Not a binding request."))?;
     let requester_key = format!("agent:{name}");
-    if req.requester != requester_key || !bridge.sessions().await.contains_key(&req.target_pane)
+    let pane_is_active = bridge.sessions().await.contains_key(&req.target_pane);
+    if req.requester != requester_key || !pane_is_active
         || !bridge.identity().list().await.iter().any(|agent| agent.name == name) {
         return Err(error(StatusCode::CONFLICT, "Binding target or requester changed; submit a new binding request."));
     }
@@ -304,7 +313,8 @@ pub async fn bind(
         CallerIdentity::Anonymous => return Err(error(StatusCode::UNAUTHORIZED, "Authentication required.")),
         _ => return Err(error(StatusCode::FORBIDDEN, "Only the agent itself or Hyperia can establish this binding.")),
     };
-    if !state.bridge.sessions().await.contains_key(&req.pane)
+    let pane_is_active = state.bridge.sessions().await.contains_key(&req.pane);
+    if !pane_is_active
         || !state.bridge.identity().list().await.iter().any(|a| a.name == name) {
         return Err(error(StatusCode::NOT_FOUND, "Active pane and registered agent are required."));
     }
@@ -345,3 +355,65 @@ pub async fn bind(
     state.bridge.arm_msg_notify(&req.pane).await;
     Ok(Json(serde_json::json!({"ok": true, "binding": binding})))
 }
+
+#[cfg(test)]
+mod tests {
+    use super::*;
+    use crate::bridge::SessionInfo;
+    use crate::screen::ScreenBuffer;
+    use std::time::Duration;
+
+    #[tokio::test]
+    async fn pane_token_actor_completes_without_relocking_sessions() {
+        let bridge = Bridge::new();
+        let pane = "messaging-pane-token-deadlock-regression";
+        bridge.sessions().await.insert(pane.into(), SessionInfo {
+            name: "shell".into(),
+            shell_name: "Mailbox regression".into(),
+            tab_name: "test".into(),
+            description: String::new(),
+            rows: 24,
+            cols: 80,
+            pid: 1,
+            root_tab_uid: "messaging-test-tab".into(),
+            window_id: 1,
+            split_label: "a".into(),
+            tab_order: 0,
+            tab_active: true,
+            pane_active: true,
+            screen: ScreenBuffer::new(24, 80, 1000),
+            bsp_x: 0.0,
+            bsp_y: 0.0,
+            bsp_w: 100.0,
+            bsp_h: 100.0,
+            cwd: String::new(),
+            last_user_activity: None,
+            last_output_at: None,
+            title: String::new(),
+            shell_state: "idle".into(),
+            shell_app: None,
+            shell_last_exit: None,
+            shell_has_integration: false,
+        });
+        let token = bridge.perms().token_for(pane).await;
+        let mut headers = HeaderMap::new();
+        headers.insert(
+            axum::http::header::AUTHORIZATION,
+            format!("Bearer {token}").parse().unwrap(),
+        );
+
+        // Exercise the real pane-token resolution used by check/inbox/send,
+        // then actor_from_identity's pane branch and its display-name lookup.
+        let who = tokio::time::timeout(Duration::from_secs(2), actor(&bridge, &headers))
+            .await.expect("pane-token mailbox actor deadlocked")
+            .expect("pane-token caller should be authorized");
+        assert_eq!(who.principal, Principal::Pane(pane.into()));
+        assert_eq!(who.pane.as_deref(), Some(pane));
+        assert_eq!(who.label, "Mailbox regression");
+        assert_eq!(who.requester, format!("pane:{pane}"));
+
+        // A successful call must also leave the shared session table usable.
+        drop(tokio::time::timeout(Duration::from_secs(2), bridge.sessions())
+            .await.expect("mailbox actor retained the session lock"));
+    }
+}
```
