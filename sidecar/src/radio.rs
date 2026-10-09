//! Radio call signs for agent panes.
//!
//! Each agent pane that hertz-radio may message gets a random two-word NATO
//! call sign. While the radio is running and was just used, the signs show as
//! gold badges on those panes. hertz routes a call by sign, and delivering on
//! a sign rotates it: a sign heard over the air (or replayed) never works twice.
//! Signs are only ever given to the human (badges) and to hertz-radio.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::bridge::Bridge;
use crate::AppState;

const WORDS: [&str; 26] = [
    "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima",
    "Mike", "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey",
    "X-ray", "Yankee", "Zulu",
];
/// Badges stay up this long after the last transmission heard.
const SHOW_FOR: Duration = Duration::from_secs(5 * 60);
/// Retired signs not handed out again for a while.
const RECENT: usize = 120;

#[derive(Default)]
struct RadioState {
    running: bool,
    heard_at: Option<Instant>,
    /// pane uid → call sign
    signs: HashMap<String, String>,
    recent: VecDeque<String>,
    /// Last rotation (pane, unix ms) so the badge can flash.
    rotated: Option<(String, u64)>,
    last_push: String,
}

static STATE: Mutex<Option<RadioState>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut RadioState) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(RadioState::default))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn config() -> serde_json::Value {
    crate::ghost::api::read_shared_config()["config"]["radio"].clone()
}

/// The agent allowed to read and use signs (config.radio.agent).
fn radio_agent() -> String {
    config()["agent"].as_str().unwrap_or("hertz-radio").to_string()
}

/// hertz daemon base URL; "off" disables the radio features.
fn hertz_url() -> Option<String> {
    let u = std::env::var("HYPERIA_HERTZ_URL")
        .ok()
        .or_else(|| config()["hertz_url"].as_str().map(str::to_string))
        .unwrap_or_else(|| "http://127.0.0.1:9080".into());
    let u = u.trim().trim_end_matches('/').to_string();
    (!u.is_empty() && !matches!(u.to_ascii_lowercase().as_str(), "off" | "none" | "disabled")).then_some(u)
}

/// Unbiased index in 0..26 from the OS CSPRNG.
fn pick() -> usize {
    loop {
        let mut b = [0u8; 1];
        if getrandom::getrandom(&mut b).is_err() {
            continue;
        }
        if (b[0] as usize) < 26 * 9 {
            return b[0] as usize % 26;
        }
    }
}

fn new_sign(taken: &HashSet<String>, recent: &VecDeque<String>) -> String {
    for _ in 0..2000 {
        let (a, b) = (pick(), pick());
        if a == b {
            continue;
        }
        let s = format!("{} {}", WORDS[a], WORDS[b]);
        let k = normalize(&s);
        if !taken.contains(&k) && !recent.iter().any(|r| normalize(r) == k) {
            return s;
        }
    }
    format!("{} {}", WORDS[pick()], WORDS[pick()])
}

/// Case/punctuation-insensitive form: "x-ray tango" == "Xray, Tango".
pub fn normalize(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c == ',' || c == '.')
        .filter(|w| !w.is_empty())
        .map(|w| w.chars().filter(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_lowercase())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn visible(s: &RadioState) -> bool {
    s.running && s.heard_at.is_some_and(|t| t.elapsed() < SHOW_FOR)
}

/// Push the badge state to the renderer when it changed (or `force`).
async fn push(bridge: &Bridge, force: bool) {
    let msg = with(|s| {
        let body = json!({
            "type": "RadioCallsigns",
            "running": s.running,
            "visible": visible(s),
            "signs": s.signs,
            "rotated": s.rotated.as_ref().map(|(p, t)| json!({"pane": p, "at": t})),
        });
        let key = body.to_string();
        if !force && key == s.last_push {
            return None;
        }
        s.last_push = key;
        Some(body)
    });
    if let Some(m) = msg {
        let _ = bridge.notify(m).await;
    }
}

/// Keep signs on exactly the agent panes hertz-radio may message.
async fn refresh(bridge: &Bridge) {
    let uids: Vec<String> = bridge
        .sessions()
        .await
        .iter()
        .filter(|(_, i)| i.name != "web")
        .map(|(u, _)| u.clone())
        .collect();
    let requester = format!("agent:{}", radio_agent());
    let mut eligible = HashSet::new();
    for uid in uids {
        if bridge.perms().has_message_grant(&requester, &format!("pane:{uid}")).await && bridge.is_agent_pane(&uid).await {
            eligible.insert(uid);
        }
    }
    with(|s| {
        s.signs.retain(|uid, _| eligible.contains(uid));
        let mut taken: HashSet<String> = s.signs.values().map(|v| normalize(v)).collect();
        for uid in eligible {
            if !s.signs.contains_key(&uid) {
                let sign = new_sign(&taken, &s.recent);
                taken.insert(normalize(&sign));
                s.signs.insert(uid, sign);
            }
        }
    });
}

/// Watch hertz's event stream: connected = running; a transcription = heard.
async fn watch_hertz(bridge: Bridge) {
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(3)).build().unwrap_or_default();
    loop {
        let Some(base) = hertz_url() else {
            with(|s| s.running = false);
            push(&bridge, false).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
            continue;
        };
        let mut rb = client.get(format!("{base}/events")).header("accept", "text/event-stream");
        if let Some(t) = config()["hertz_token"].as_str() {
            rb = rb.bearer_auth(t);
        }
        if let Ok(resp) = rb.send().await {
            if resp.status().is_success() {
                with(|s| s.running = true);
                push(&bridge, false).await;
                use futures::StreamExt;
                let mut stream = resp.bytes_stream();
                let mut buf = String::new();
                while let Some(Ok(chunk)) = stream.next().await {
                    buf.push_str(&String::from_utf8_lossy(&chunk));
                    while let Some(i) = buf.find('\n') {
                        let line = buf[..i].trim().to_string();
                        buf.drain(..=i);
                        if line == "event: transcription" {
                            with(|s| s.heard_at = Some(Instant::now()));
                            refresh(&bridge).await;
                            push(&bridge, false).await;
                        }
                    }
                    if buf.len() > 1 << 20 {
                        buf.clear();
                    }
                }
            }
        }
        with(|s| s.running = false);
        push(&bridge, false).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

pub fn spawn(bridge: Bridge) {
    tokio::spawn(watch_hertz(bridge.clone()));
    tokio::spawn(async move {
        let mut n = 0u32;
        loop {
            refresh(&bridge).await;
            // Re-send now and then so a reloaded renderer catches up.
            push(&bridge, n % 10 == 0).await;
            n = n.wrapping_add(1);
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

/// Use a sign: the pane it names, after giving that pane a fresh sign.
pub fn consume(sign: &str) -> Option<String> {
    let want = normalize(sign);
    if want.split(' ').count() != 2 {
        return None;
    }
    with(|s| {
        let uid = s.signs.iter().find(|(_, v)| normalize(v) == want).map(|(u, _)| u.clone())?;
        let old = s.signs.remove(&uid)?;
        s.recent.push_back(old);
        while s.recent.len() > RECENT {
            s.recent.pop_front();
        }
        let taken: HashSet<String> = s.signs.values().map(|v| normalize(v)).collect();
        let fresh = new_sign(&taken, &s.recent);
        s.signs.insert(uid.clone(), fresh);
        s.rotated = Some((uid.clone(), now_ms()));
        s.heard_at = Some(Instant::now());
        Some(uid)
    })
}

/// The caller is hertz-radio (or a session it owns).
async fn is_radio_agent(state: &AppState, headers: &HeaderMap) -> bool {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().trim_start_matches("Bearer ").trim_start_matches("bearer ").trim().to_string());
    let id = state.bridge.resolve_caller(token.as_deref()).await;
    let crate::identity::CallerIdentity::Agent { name, .. } = &id else { return false };
    let agent = radio_agent();
    if *name == agent {
        return true;
    }
    state.bridge.identity().sessions.by_name(name).filter(|s| !s.parent_is_pane).is_some_and(|s| s.parent == agent)
}

/// GET /api/radio/callsigns — hertz-radio only: the live signs (no pane names).
pub async fn get_callsigns(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !is_radio_agent(&state, &headers).await {
        return (StatusCode::FORBIDDEN, Json(json!({"ok": false, "error": "only the radio agent can read call signs"}))).into_response();
    }
    refresh(&state.bridge).await;
    let (running, signs) = with(|s| (s.running, s.signs.values().cloned().collect::<Vec<_>>()));
    Json(json!({"ok": true, "running": running, "callsigns": signs})).into_response()
}

#[derive(Deserialize)]
pub struct DeliverReq {
    callsign: String,
    #[serde(default)]
    subject: String,
    body: String,
}

/// POST /api/radio/deliver {callsign, subject, body} — hertz-radio only. Mails
/// the pane holding that sign (normal consent rules apply) and rotates the sign.
pub async fn deliver(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<DeliverReq>) -> Response {
    if !is_radio_agent(&state, &headers).await {
        return (StatusCode::FORBIDDEN, Json(json!({"ok": false, "error": "only the radio agent can deliver by call sign"}))).into_response();
    }
    let Some(pane) = consume(&req.callsign) else {
        return (StatusCode::NOT_FOUND, Json(json!({"ok": false, "error": "no pane holds that call sign (it may have rotated)"}))).into_response();
    };
    push(&state.bridge, false).await;
    let send = crate::messaging::SendRequest {
        window: None,
        tab: None,
        pane: Some(pane),
        to_label: None,
        subject: req.subject,
        body: req.body,
        idempotency_key: None,
    };
    crate::delivery_service::send_mail(State(state), headers, Json(send)).await.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_normalize_and_rotate_once() {
        assert_eq!(normalize("X-ray, Tango."), "xray tango");
        assert_eq!(normalize("xray tango"), normalize("X-ray Tango"));
        with(|s| {
            s.signs.clear();
            s.signs.insert("pane-a".into(), "Bravo Tango".into());
        });
        assert_eq!(consume("bravo tango").as_deref(), Some("pane-a"));
        // The heard sign is spent; the pane has a new one.
        assert!(consume("Bravo Tango").is_none());
        let fresh = with(|s| s.signs.get("pane-a").cloned()).unwrap();
        assert_ne!(normalize(&fresh), "bravo tango");
        assert_eq!(fresh.split(' ').count(), 2);
        assert!(consume("Bravo").is_none());
    }

    #[test]
    fn new_signs_avoid_taken_and_recent() {
        let mut taken = HashSet::new();
        let recent = VecDeque::new();
        for _ in 0..300 {
            let s = new_sign(&taken, &recent);
            assert!(taken.insert(normalize(&s)), "duplicate sign {s}");
        }
    }
}
