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
    /// Caller-supplied rationale (from request_access purpose=). Shown on the
    /// consent prompt + audited so the human knows WHY. "" if none given.
    pub purpose: String,
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
    /// Per-agent capability grants for the non-create/non-drive gated actions:
    /// identity label → set of capability names ("files", "settings", "web_eval",
    /// "manage", ...). Persisted (perms.json) like all durable grants.
    cap_grants: Mutex<HashMap<String, std::collections::HashSet<String>>>,
    /// Master enforcement switch. ON by default — every boot comes up gated
    /// (home-refusal / ownership / grants / consent / soft-wall). Durable
    /// grants + pane tokens persist across restarts (perms.json); timed and
    /// one-shot grants stay ephemeral. Runtime-toggleable for debugging;
    /// resets to ON on restart.
    enforce: AtomicBool,
    next_id: AtomicU64,
}

// ---------------------------------------------------------------------------
// Persistence — pane tokens/owners and durable grants survive sidecar
// restarts. The documented pane-token lifecycle is "stable for the pane's
// LIFETIME, revoked when the pane closes" — panes (and their uids) survive a
// sidecar restart via session reattach, so the old restart-wipe was the bug:
// every restart stranded the whole container fleet on "No identity" and
// re-consent storms. Timed and one-shot grants stay ephemeral by design;
// denial cooldowns and the enforce switch still reset every boot.
// ---------------------------------------------------------------------------

fn perms_path() -> std::path::PathBuf {
    crate::fsnav::home_dir().join(".hyperia").join("perms.json")
}

fn load_persisted() -> (
    HashMap<String, String>,
    HashMap<String, String>,
    Vec<Grant>,
    Vec<CreateGrant>,
    HashMap<String, std::collections::HashSet<String>>,
) {
    let mut tokens = HashMap::new();
    let mut owners = HashMap::new();
    let mut grants = Vec::new();
    let mut create_grants = Vec::new();
    let mut cap_grants: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    if let Ok(data) = std::fs::read_to_string(perms_path()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(m) = v["tokens"].as_object() {
                for (k, val) in m {
                    if let Some(s) = val.as_str() {
                        tokens.insert(k.clone(), s.to_string());
                    }
                }
            }
            if let Some(m) = v["owners"].as_object() {
                for (k, val) in m {
                    if let Some(s) = val.as_str() {
                        owners.insert(k.clone(), s.to_string());
                    }
                }
            }
            if let Some(arr) = v["grants"].as_array() {
                for g in arr {
                    let (Some(requester), Some(scope), Some(pane)) =
                        (g["requester"].as_str(), g["scope"].as_str(), g["pane"].as_str())
                    else {
                        continue;
                    };
                    grants.push(Grant {
                        requester: requester.to_string(),
                        scope: scope.to_string(),
                        pane: pane.to_string(),
                        expires_at: None,
                    });
                }
            }
            if let Some(arr) = v["create_grants"].as_array() {
                for a in arr {
                    if let Some(agent) = a.as_str() {
                        create_grants.push(CreateGrant {
                            agent: agent.to_string(),
                            expires_at: None,
                            once: false,
                        });
                    }
                }
            }
            if let Some(m) = v["cap_grants"].as_object() {
                for (agent, caps) in m {
                    if let Some(arr) = caps.as_array() {
                        let set: std::collections::HashSet<String> =
                            arr.iter().filter_map(|c| c.as_str().map(String::from)).collect();
                        if !set.is_empty() {
                            cap_grants.insert(agent.clone(), set);
                        }
                    }
                }
            }
        }
    }
    (tokens, owners, grants, create_grants, cap_grants)
}

impl Default for PermStore {
    fn default() -> Self {
        let (tokens, owners, grants, create_grants, cap_grants) = load_persisted();
        Self {
            pending: Mutex::default(),
            grants: Mutex::new(grants),
            tokens: Mutex::new(tokens),
            owners: Mutex::new(owners),
            denials: Mutex::default(),
            create_grants: Mutex::new(create_grants),
            cap_grants: Mutex::new(cap_grants),
            enforce: AtomicBool::new(true), // gated out of the box
            next_id: AtomicU64::default(),
        }
    }
}

impl PermStore {
    /// Write-through persistence: durable state only (tokens, owners,
    /// non-expiring grants). Best-effort — a failed write never breaks the
    /// in-memory truth.
    async fn save(&self) {
        let tokens: serde_json::Map<String, serde_json::Value> = self
            .tokens
            .lock()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        let owners: serde_json::Map<String, serde_json::Value> = self
            .owners
            .lock()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        let grants: Vec<serde_json::Value> = self
            .grants
            .lock()
            .await
            .iter()
            .filter(|g| g.expires_at.is_none())
            .map(|g| serde_json::json!({"requester": g.requester, "scope": g.scope, "pane": g.pane}))
            .collect();
        let create_grants: Vec<serde_json::Value> = self
            .create_grants
            .lock()
            .await
            .iter()
            .filter(|g| !g.once && g.expires_at.is_none())
            .map(|g| serde_json::Value::String(g.agent.clone()))
            .collect();
        let cap_grants: serde_json::Map<String, serde_json::Value> = self
            .cap_grants
            .lock()
            .await
            .iter()
            .map(|(agent, caps)| {
                (
                    agent.clone(),
                    serde_json::Value::Array(caps.iter().map(|c| serde_json::Value::String(c.clone())).collect()),
                )
            })
            .collect();
        let doc = serde_json::json!({
            "tokens": tokens,
            "owners": owners,
            "grants": grants,
            "create_grants": create_grants,
            "cap_grants": cap_grants,
        });
        if let Err(e) = crate::util::write_json_file_atomic(&perms_path(), &doc) {
            tracing::warn!("perms persist failed: {e}");
        }
    }

    /// Register a pending request and return it (with a freshly-minted id).
    pub async fn create_request(
        &self,
        requester: &str,
        requester_pane: &str,
        target_pane: &str,
        action: &str,
        purpose: &str,
    ) -> PermRequest {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = PermRequest {
            id: format!("perm-{n}"),
            requester: requester.to_string(),
            requester_pane: requester_pane.to_string(),
            target_pane: target_pane.to_string(),
            action: action.to_string(),
            purpose: purpose.to_string(),
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
        let is_cap = req.action.starts_with("cap:");
        // Denials/grants key: create on the sentinel, cap on its action string,
        // drive on the target pane.
        let key = if is_create {
            CREATE_KEY.to_string()
        } else if is_cap {
            req.action.clone()
        } else {
            req.target_pane.clone()
        };
        if allow {
            if is_cap {
                let cap = req.action.strip_prefix("cap:").unwrap_or("");
                self.grant_cap(&req.requester, cap).await;
            } else if is_create {
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
            self.save().await;
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
        self.save().await;
    }

    /// Grant `agent` a named capability ("files", "settings", "web_eval", ...).
    pub async fn grant_cap(&self, agent: &str, cap: &str) {
        if agent.is_empty() || cap.is_empty() {
            return;
        }
        self.cap_grants
            .lock()
            .await
            .entry(agent.to_string())
            .or_default()
            .insert(cap.to_string());
        self.save().await;
    }

    /// Does `agent` hold capability `cap`?
    pub async fn has_cap(&self, agent: &str, cap: &str) -> bool {
        self.cap_grants
            .lock()
            .await
            .get(agent)
            .map_or(false, |s| s.contains(cap))
    }

    /// Is there already a pending capability prompt for this (requester, cap)?
    pub async fn has_pending_cap(&self, requester: &str, cap: &str) -> bool {
        let action = format!("cap:{cap}");
        self.pending
            .lock()
            .await
            .values()
            .any(|r| r.requester == requester && r.action == action)
    }

    /// Does `agent` currently hold a create grant? Prunes expired grants and
    /// consumes a one-shot ("Just once") as a side effect.
    pub async fn has_create(&self, agent: &str) -> bool {
        let now = Instant::now();
        let mut grants = self.create_grants.lock().await;
        grants.retain(|g| g.expires_at.map_or(true, |t| t > now));
        if let Some(pos) = grants.iter().position(|g| g.agent == agent) {
            let consumed_once = grants[pos].once;
            if consumed_once {
                grants.remove(pos);
                drop(grants);
                self.save().await;
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
        self.pending_create_for(requester).await.is_some()
    }

    /// The pending CREATE request for this requester, if any — used to RE-RAISE
    /// its toast on retry (the renderer's toast collapses after 45s, so a
    /// silent dedupe left the human with nothing to click while the agent
    /// waited forever).
    pub async fn pending_create_for(&self, requester: &str) -> Option<PermRequest> {
        self.pending
            .lock()
            .await
            .values()
            .find(|r| r.requester == requester && r.action.starts_with("create"))
            .cloned()
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

    /// Clear a denial for a given requester and pane (used for reauth/re-prompt).
    pub async fn clear_denial(&self, requester: &str, target_pane: &str) {
        self.denials.lock().await.remove(&(requester.to_string(), target_pane.to_string()));
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
        let out = self.tokens.lock().await.entry(pane.to_string()).or_insert(token).clone();
        self.save().await;
        out
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
        self.save().await;
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
        self.save().await;
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
        self.save().await;
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
                    "purpose": r.purpose,
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
