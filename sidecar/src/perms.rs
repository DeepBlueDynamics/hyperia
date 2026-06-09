//! Per-pane access permissions (the cross-pane consent ledger).
//!
//! When one caller wants to drive a pane it does not own, Hyperia raises a
//! consent prompt *in the target pane*. The human there allows or denies,
//! picks a scope ("just this pane" / "any pane") and a duration. Grants are
//! remembered until they expire or the relevant pane closes.
//!
//! This is only the cross-pane tier. Home-pane refusal (an agent can't drive
//! the pane it's running in) and owned-pane free access are handled elsewhere;
//! this module is purely the request/grant bookkeeping + the test surface.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Sentinel "pane" key for create-capability grants/denials (create has no
/// real pane target). Kept out-of-band so it can't collide with a real uid.
pub const CREATE_KEY: &str = "__create__";

/// A pending consent prompt awaiting a human decision.
#[derive(Clone)]
pub struct PermRequest {
    pub id: String,
    /// Friendly identity of the caller (e.g. "Maximus 🤖", or an external label).
    pub requester: String,
    /// Pane uid the caller lives in, if it's an in-Hyperia agent ("" if external).
    pub requester_pane: String,
    /// For drive: the pane being asked for. For create: a focused-pane hint (display only).
    pub target_pane: String,
    /// "drive" (default) or "create_pane" / "create_tab" / "create_window" /
    /// "create_web" / "create_sticky" — drives prompt text + grant type.
    pub action: String,
}

/// A granted permission. `expires_at == None` means "always" — it lives until
/// revoked or the pane closes.
#[derive(Clone)]
struct Grant {
    requester: String,
    /// "any" = caller may drive any pane; "pane" = only `pane`.
    scope: String,
    pane: String,
    expires_at: Option<Instant>,
}

impl Grant {
    fn live(&self, now: Instant) -> bool {
        self.expires_at.map_or(true, |t| t > now)
    }
}

/// A per-agent create-capability grant. `once` = consume on next create;
/// otherwise `expires_at` (None = always) bounds it.
#[derive(Clone)]
struct CreateGrant {
    agent: String,
    expires_at: Option<Instant>,
    once: bool,
}

/// Outcome of an authorization check for driving a pane.
pub enum AuthDecision {
    /// Proceed.
    Allow,
    /// Caller IS this pane — can't drive its own terminal.
    RefuseHome,
    /// Anonymous caller under enforcement — needs an identity first.
    SoftWall,
    /// The user recently denied this caller for this pane — report it, don't re-prompt.
    Denied,
    /// Identified but not owner/granted — raise a consent prompt.
    NeedConsent,
}

pub struct PermStore {
    pending: Mutex<HashMap<String, PermRequest>>,
    grants: Mutex<Vec<Grant>>,
    /// pane uid → access token. Minted lazily on first request, stable for the
    /// pane's lifetime, revoked when the pane closes. The human copies one from
    /// the pane menu and hands it to an external agent, which presents it in its
    /// MCP Authorization header to be recognised as that pane.
    tokens: Mutex<HashMap<String, String>>,
    /// pane uid → owner label. Stamped when an identified caller creates the
    /// pane (split/new-tab); owners may drive their own panes freely.
    owners: Mutex<HashMap<String, String>>,
    /// (requester, pane) → time the user denied it. A denial reports back and
    /// suppresses re-prompts for a cooldown window, so a "no" actually sticks.
    /// Create denials use the `CREATE_KEY` sentinel as the pane.
    denials: Mutex<HashMap<(String, String), Instant>>,
    /// Per-agent create-capability grants (capability="create", no pane scope).
    create_grants: Mutex<Vec<CreateGrant>>,
    /// Master enforcement switch. ON by default — every boot comes up gated
    /// (home-refusal / ownership / grants / consent / soft-wall). Grants reset
    /// each start, identities persist, so agents re-earn access every session.
    /// Runtime-toggleable for debugging; resets to ON on restart.
    enforce: AtomicBool,
    next_id: AtomicU64,
}

impl Default for PermStore {
    fn default() -> Self {
        Self {
            pending: Mutex::default(),
            grants: Mutex::default(),
            tokens: Mutex::default(),
            owners: Mutex::default(),
            denials: Mutex::default(),
            create_grants: Mutex::default(),
            enforce: AtomicBool::new(true), // gated out of the box
            next_id: AtomicU64::default(),
        }
    }
}

impl PermStore {
    /// Register a pending request and return it (with a freshly-minted id).
    pub async fn create_request(
        &self,
        requester: &str,
        requester_pane: &str,
        target_pane: &str,
        action: &str,
    ) -> PermRequest {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = PermRequest {
            id: format!("perm-{n}"),
            requester: requester.to_string(),
            requester_pane: requester_pane.to_string(),
            target_pane: target_pane.to_string(),
            action: action.to_string(),
        };
        self.pending.lock().await.insert(req.id.clone(), req.clone());
        req
    }

    /// Resolve a pending request. On "allow", records a grant. Returns the
    /// request that was resolved (so the caller can notify the right pane), or
    /// None if the id was unknown.
    pub async fn respond(
        &self,
        id: &str,
        allow: bool,
        scope: &str,
        duration_secs: Option<u64>,
    ) -> Option<PermRequest> {
        let req = self.pending.lock().await.remove(id)?;
        let is_create = req.action.starts_with("create");
        // Drive denials/grants key on the target pane; create on the sentinel.
        let key = if is_create { CREATE_KEY.to_string() } else { req.target_pane.clone() };
        if allow {
            if is_create {
                // For create, `scope == "once"` flags a one-shot; else duration
                // (None == always).
                let once = scope == "once";
                self.grant_create(&req.requester, once, duration_secs).await;
            } else {
                // 0 / None == "always" (no expiry).
                let expires_at = duration_secs
                    .filter(|s| *s > 0)
                    .map(|s| Instant::now() + Duration::from_secs(s));
                let scope = match scope {
                    "any" => "any",
                    "tab" => "tab",
                    _ => "pane",
                };
                self.grants.lock().await.push(Grant {
                    requester: req.requester.clone(),
                    scope: scope.into(),
                    pane: req.target_pane.clone(),
                    expires_at,
                });
            }
            // A fresh allow clears any prior denial for this pair.
            self.denials.lock().await.remove(&(req.requester.clone(), key));
        } else {
            // Remember the "no" so the caller is told (not silently re-prompted).
            self.denials.lock().await.insert((req.requester.clone(), key), Instant::now());
        }
        Some(req)
    }

    /// Record a create-capability grant for `agent`.
    pub async fn grant_create(&self, agent: &str, once: bool, secs: Option<u64>) {
        let expires_at = if once {
            None
        } else {
            secs.filter(|s| *s > 0).map(|s| Instant::now() + Duration::from_secs(s))
        };
        self.create_grants.lock().await.push(CreateGrant {
            agent: agent.to_string(),
            expires_at,
            once,
        });
    }

    /// Does `agent` currently hold a create grant? Prunes expired grants and
    /// consumes a one-shot ("Just once") as a side effect.
    pub async fn has_create(&self, agent: &str) -> bool {
        let now = Instant::now();
        let mut grants = self.create_grants.lock().await;
        grants.retain(|g| g.expires_at.map_or(true, |t| t > now));
        if let Some(pos) = grants.iter().position(|g| g.agent == agent) {
            if grants[pos].once {
                grants.remove(pos);
            }
            true
        } else {
            false
        }
    }

    /// Live (scope, pane) grant pairs for `requester`. Lets the bridge resolve
    /// tab-scoped grants (it can map a pane → tab; the store can't).
    pub async fn grants_for(&self, requester: &str) -> Vec<(String, String)> {
        let now = Instant::now();
        let mut grants = self.grants.lock().await;
        grants.retain(|g| g.live(now));
        grants
            .iter()
            .filter(|g| g.requester == requester)
            .map(|g| (g.scope.clone(), g.pane.clone()))
            .collect()
    }

    /// Is there already a pending prompt for this (requester, pane)? Used to
    /// dedupe so retries don't stack duplicate consent prompts.
    pub async fn has_pending(&self, requester: &str, target_pane: &str) -> bool {
        self.pending
            .lock()
            .await
            .values()
            .any(|r| r.requester == requester && r.target_pane == target_pane)
    }

    /// Is there already a pending CREATE prompt for this requester? (Create
    /// requests' target_pane is a varying focus hint, so dedupe by action.)
    pub async fn has_pending_create(&self, requester: &str) -> bool {
        self.pending
            .lock()
            .await
            .values()
            .any(|r| r.requester == requester && r.action.starts_with("create"))
    }

    /// Did the user recently deny this (requester, pane)? Cooldown-limited
    /// (prunes as it checks) so a denial reports back but doesn't block forever.
    pub async fn recently_denied(&self, requester: &str, target_pane: &str) -> bool {
        const COOLDOWN: Duration = Duration::from_secs(300);
        let now = Instant::now();
        let mut denials = self.denials.lock().await;
        denials.retain(|_, t| now.duration_since(*t) < COOLDOWN);
        denials.contains_key(&(requester.to_string(), target_pane.to_string()))
    }

    /// Return the pane's access token, minting (and caching) one on first ask.
    /// Stable for the pane's lifetime so a copied token keeps working.
    pub async fn token_for(&self, pane: &str) -> String {
        // Fast path: already minted.
        if let Some(t) = self.tokens.lock().await.get(pane) {
            return t.clone();
        }
        // Generate WITHOUT holding the lock — random_token may do network I/O
        // (CSPRNG base + best-effort sdrrand mix). 16 bytes = 128-bit token.
        let token = format!("hyp_{}", crate::util::random_token(16).await);
        // Insert, but honour a concurrent mint for the same pane (first wins).
        self.tokens.lock().await.entry(pane.to_string()).or_insert(token).clone()
    }

    /// Flip the master enforcement switch.
    pub fn set_enforce(&self, on: bool) {
        self.enforce.store(on, Ordering::Relaxed);
    }
    /// Is drive-gating active?
    pub fn enforced(&self) -> bool {
        self.enforce.load(Ordering::Relaxed)
    }

    /// Record that `owner` created `pane` (so it may drive it freely).
    pub async fn stamp_owner(&self, pane: &str, owner: &str) {
        if pane.is_empty() || owner.is_empty() {
            return;
        }
        self.owners.lock().await.insert(pane.to_string(), owner.to_string());
    }
    /// Who owns this pane, if anyone?
    pub async fn owner_of(&self, pane: &str) -> Option<String> {
        self.owners.lock().await.get(pane).cloned()
    }

    /// Register a pane's token, minted + injected into the pane's PTY env by the
    /// Electron main process at spawn. Makes `pane_for_token` resolve an in-pane
    /// agent's Authorization header → this pane, and makes `token_for` / the
    /// "Copy access token" menu return the same token the agent already holds.
    pub async fn set_pane_token(&self, pane: &str, token: &str) {
        if pane.is_empty() || token.is_empty() {
            return;
        }
        self.tokens.lock().await.insert(pane.to_string(), token.to_string());
    }

    /// Reverse lookup: which pane does this token identify? (For #58's header
    /// validation.) None if the token is unknown/revoked.
    pub async fn pane_for_token(&self, token: &str) -> Option<String> {
        self.tokens
            .lock()
            .await
            .iter()
            .find(|(_, t)| t.as_str() == token)
            .map(|(p, _)| p.clone())
    }

    /// Drop everything tied to a pane that just closed: pending prompts aimed
    /// at it (or originating from it), pane-scoped grants for it, and its token.
    pub async fn cleanup_pane(&self, uid: &str) {
        self.pending
            .lock()
            .await
            .retain(|_, r| r.target_pane != uid && r.requester_pane != uid);
        self.grants
            .lock()
            .await
            .retain(|g| !((g.scope == "pane" || g.scope == "tab") && g.pane == uid));
        self.tokens.lock().await.remove(uid);
        self.owners.lock().await.remove(uid);
        self.denials.lock().await.retain(|(_, p), _| p != uid);
    }

    /// JSON snapshot for debugging / the test surface.
    pub async fn snapshot(&self) -> serde_json::Value {
        let now = Instant::now();
        let pending: Vec<_> = self
            .pending
            .lock()
            .await
            .values()
            .map(|r| {
                serde_json::json!({
                    "id": r.id,
                    "requester": r.requester,
                    "requesterPane": r.requester_pane,
                    "targetPane": r.target_pane,
                })
            })
            .collect();
        let grants: Vec<_> = self
            .grants
            .lock()
            .await
            .iter()
            .map(|g| {
                serde_json::json!({
                    "requester": g.requester,
                    "scope": g.scope,
                    "pane": g.pane,
                    "expiresInSecs": g.expires_at.map(|t| t.saturating_duration_since(now).as_secs()),
                })
            })
            .collect();
        let owners: Vec<_> = self
            .owners
            .lock()
            .await
            .iter()
            .map(|(p, o)| serde_json::json!({ "pane": p, "owner": o }))
            .collect();
        let create_grants: Vec<_> = {
            let now = Instant::now();
            self.create_grants
                .lock()
                .await
                .iter()
                .filter(|g| g.expires_at.map_or(true, |t| t > now))
                .map(|g| {
                    serde_json::json!({
                        "agent": g.agent,
                        "once": g.once,
                        "expiresInSecs": g.expires_at.map(|t| t.saturating_duration_since(now).as_secs()),
                    })
                })
                .collect()
        };
        serde_json::json!({
            "enforce": self.enforced(),
            "pending": pending,
            "grants": grants,
            "owners": owners,
            "createGrants": create_grants,
        })
    }
}
