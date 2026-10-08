//! Forwards host-pane telemetry to the n8 gateway (`POST /telemetry/ingest`).
//!
//! Contract (agreed with n8): body `{"agent_id":"hy-<pane-uid>","events":[…]}`
//! in n8's event schema (`fs`, `edit`), Bearer = the gateway's
//! NEMESIS8_AUTH_TOKEN (OS keyring, same as n8.rs), at most 1000 events or
//! ~1 MiB per request, optional per-event `id` the gateway dedups on.
//! Replies: 200 accepted, 400 malformed, 401 bad token, 413 too big, 503
//! can't persist. Anything we can't deliver stays buffered (bounded) and is
//! retried with backoff, so a gateway restart or outage loses nothing recent.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const MAX_BUFFER: usize = 20_000;
const MAX_BATCH_EVENTS: usize = 1000;
const MAX_BATCH_BYTES: usize = 900 * 1024;
const TICK: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

struct Queue {
    items: VecDeque<(String, Value)>,
    dropped: u64,
}

static QUEUE: OnceLock<Mutex<Queue>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);
static RUN: OnceLock<String> = OnceLock::new();

fn queue() -> &'static Mutex<Queue> {
    QUEUE.get_or_init(|| Mutex::new(Queue { items: VecDeque::new(), dropped: 0 }))
}

/// Distinct per sidecar run, so event ids stay unique across restarts.
fn run_id() -> &'static str {
    RUN.get_or_init(|| {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        format!("{:x}", nanos)
    })
}

/// The n8 agent id for a host pane. `hy-` keeps it clear of n8's `n8-` containers.
pub fn agent_id_for(pane_uid: &str) -> String {
    format!("hy-{pane_uid}")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Queue one n8-schema event (an object with at least `kind`) for `pane_uid`.
/// Adds `id` and `ts` when missing. Never blocks; the oldest events are
/// dropped first if the gateway has been unreachable long enough to fill
/// the buffer.
pub fn enqueue(pane_uid: &str, mut event: Value) {
    let Some(obj) = event.as_object_mut() else { return };
    if !obj.contains_key("kind") {
        return;
    }
    obj.entry("ts").or_insert_with(|| json!(now_secs()));
    obj.entry("id").or_insert_with(|| json!(format!("{}:{}", run_id(), SEQ.fetch_add(1, Ordering::Relaxed))));
    let mut q = queue().lock().unwrap_or_else(|p| p.into_inner());
    q.items.push_back((agent_id_for(pane_uid), event));
    while q.items.len() > MAX_BUFFER {
        q.items.pop_front();
        q.dropped += 1;
    }
}

/// Events waiting to be delivered (for diagnostics and tests).
pub fn pending() -> usize {
    queue().lock().map(|q| q.items.len()).unwrap_or(0)
}

/// Split queued events into request bodies: one agent per body, each within
/// the gateway's event and byte limits, in queue order.
pub(crate) fn plan_batches(items: &[(String, Value)]) -> Vec<(String, Vec<Value>)> {
    let mut out: Vec<(String, Vec<Value>)> = Vec::new();
    let mut bytes = 0usize;
    for (agent, ev) in items {
        let size = ev.to_string().len() + 1;
        let fits = matches!(out.last(), Some((a, evs)) if a == agent
            && evs.len() < MAX_BATCH_EVENTS && bytes + size <= MAX_BATCH_BYTES);
        if !fits {
            out.push((agent.clone(), Vec::new()));
            bytes = 0;
        }
        out.last_mut().expect("just pushed").1.push(ev.clone());
        bytes += size;
    }
    out
}

/// What to do with a batch after the gateway answered `status`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Delivered (or duplicates the gateway already had).
    Done,
    /// The gateway rejected the events themselves; retrying won't help.
    Drop,
    /// Too big: split and retry.
    Split,
    /// Keep the events and back off (outage, bad token, no endpoint yet).
    Retry,
}

pub(crate) fn outcome(status: Option<u16>) -> Outcome {
    match status {
        Some(200..=299) => Outcome::Done,
        Some(400) | Some(422) => Outcome::Drop,
        Some(413) => Outcome::Split,
        // 401: token missing/rotated; 404: gateway without the endpoint yet;
        // 5xx / no answer: down or can't persist.
        _ => Outcome::Retry,
    }
}

async fn post(client: &reqwest::Client, token: Option<&str>, agent: &str, events: &[Value]) -> Option<u16> {
    // HYPERIA_N8_GATEWAY points at another gateway (tests, a relocated gateway).
    let base = std::env::var("HYPERIA_N8_GATEWAY").ok().filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| crate::n8::GATEWAY.to_string());
    let url = format!("{}/telemetry/ingest", base.trim_end_matches('/'));
    let mut req = client.post(url).json(&json!({"agent_id": agent, "events": events}));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.ok().map(|r| r.status().as_u16())
}

/// Deliver one batch, halving on 413. Err carries what the gateway couldn't
/// take right now (the caller keeps it queued).
async fn deliver(client: &reqwest::Client, token: Option<&str>, agent: &str, events: Vec<Value>) -> Result<(), Vec<Value>> {
    let mut stack = vec![events];
    let mut failed = Vec::new();
    while let Some(batch) = stack.pop() {
        if !failed.is_empty() {
            failed.extend(batch);
            continue;
        }
        let status = post(client, token, agent, &batch).await;
        match outcome(status) {
            Outcome::Done => {}
            Outcome::Drop => tracing::warn!("telemetry ingest rejected {} event(s) for {agent} (HTTP 400)", batch.len()),
            Outcome::Split if batch.len() > 1 => {
                let half = batch.len() / 2;
                let mut a = batch;
                let b = a.split_off(half);
                stack.push(b);
                stack.push(a);
            }
            Outcome::Split => tracing::warn!("telemetry ingest: one event over the size limit for {agent}; dropped"),
            Outcome::Retry => {
                if let Some(code) = status {
                    tracing::debug!("telemetry ingest: HTTP {code}; keeping {} event(s) buffered", batch.len());
                }
                failed.extend(batch);
            }
        }
    }
    if failed.is_empty() { Ok(()) } else { Err(failed) }
}

/// Start the background sender. Idempotent per process: call once at startup.
pub fn spawn_sender() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let mut backoff = TICK;
        loop {
            tokio::time::sleep(backoff).await;
            let items: Vec<(String, Value)> = {
                let mut q = queue().lock().unwrap_or_else(|p| p.into_inner());
                if q.dropped > 0 {
                    tracing::warn!("telemetry forward buffer full: dropped {} oldest event(s)", q.dropped);
                    q.dropped = 0;
                }
                q.items.drain(..).collect()
            };
            if items.is_empty() {
                backoff = TICK;
                continue;
            }
            let token = crate::n8::auth_token().await;
            let mut keep: Vec<(String, Value)> = Vec::new();
            for (agent, batch) in plan_batches(&items) {
                if !keep.is_empty() {
                    // Gateway already failing this round: don't hammer it.
                    keep.extend(batch.into_iter().map(|e| (agent.clone(), e)));
                    continue;
                }
                if let Err(rest) = deliver(&client, token.as_deref(), &agent, batch).await {
                    keep.extend(rest.into_iter().map(|e| (agent.clone(), e)));
                }
            }
            if keep.is_empty() {
                backoff = TICK;
            } else {
                // Put the undelivered events back in front of anything new.
                let mut q = queue().lock().unwrap_or_else(|p| p.into_inner());
                for item in keep.into_iter().rev() {
                    q.items.push_front(item);
                }
                while q.items.len() > MAX_BUFFER {
                    q.items.pop_front();
                    q.dropped += 1;
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(n: usize) -> Value {
        json!({"kind": "fs", "path": format!("/w/{n}"), "kind_detail": "modified", "size_bytes": 1, "delta_bytes": 1})
    }

    #[test]
    fn batches_split_per_agent_and_at_the_event_limit() {
        let mut items: Vec<(String, Value)> = (0..1500).map(|i| ("hy-a".to_string(), ev(i))).collect();
        items.push(("hy-b".into(), ev(0)));
        let b = plan_batches(&items);
        assert_eq!(b.iter().map(|(a, e)| (a.as_str(), e.len())).collect::<Vec<_>>(), vec![("hy-a", 1000), ("hy-a", 500), ("hy-b", 1)]);
    }

    #[test]
    fn batches_split_at_the_byte_limit() {
        let big = "x".repeat(300 * 1024);
        let items: Vec<(String, Value)> = (0..4).map(|_| ("hy-a".to_string(), json!({"kind": "fs", "path": big}))).collect();
        let b = plan_batches(&items);
        assert!(b.len() >= 2, "4 × 300 KiB must not go in one ~900 KiB body");
        assert!(b.iter().all(|(_, e)| e.iter().map(|v| v.to_string().len()).sum::<usize>() <= MAX_BATCH_BYTES));
    }

    #[test]
    fn status_outcomes_match_the_contract() {
        assert_eq!(outcome(Some(200)), Outcome::Done);
        assert_eq!(outcome(Some(400)), Outcome::Drop);
        assert_eq!(outcome(Some(413)), Outcome::Split);
        for code in [Some(401), Some(404), Some(500), Some(503), None] {
            assert_eq!(outcome(code), Outcome::Retry, "{code:?} must keep events buffered");
        }
    }

    #[test]
    fn enqueue_stamps_id_ts_and_agent() {
        enqueue("pane-1", json!({"kind": "fs", "path": "/w/x"}));
        enqueue("pane-1", json!({"no_kind": true}));
        let q = queue().lock().unwrap();
        let (agent, e) = q.items.iter().rev().find(|(a, _)| a == "hy-pane-1").unwrap();
        assert_eq!(agent, "hy-pane-1");
        assert!(e["id"].as_str().unwrap().contains(':'));
        assert!(e["ts"].as_u64().unwrap() > 1_700_000_000);
        assert!(!q.items.iter().any(|(_, e)| e.get("no_kind").is_some()), "events without kind are refused");
    }
}
