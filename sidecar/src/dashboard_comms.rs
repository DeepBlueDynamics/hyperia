//! GET /api/dashboard/comms — who talks to whom, for the dashboard's proto_viz
//! tab. Aggregates mail (logs/messages.jsonl), pane access (delivery
//! operations other than mail, plus allowed drive/message consents) and the
//! consent decisions into a graph and an event stream.
//!
//! Metadata only: subjects, bodies, payloads and purposes never leave here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use axum::extract::Query;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

const DEFAULT_WINDOW_MS: u64 = 86_400_000;
const MIN_WINDOW_MS: u64 = 60_000;
const MAX_WINDOW_MS: u64 = 604_800_000;
const STREAM_MAX: usize = 120;

#[derive(Clone, Debug, PartialEq)]
enum EventKind {
    /// Agent/pane mail; `system` mail is kept out of the edges.
    Mail { system: bool },
    /// A delivery operation (shell/keys/pane) or an allowed drive/message consent.
    Access,
    /// A consent decision or a still-open request.
    Consent,
}

/// One parsed record, already stripped to metadata.
#[derive(Clone, Debug)]
struct Event {
    ts: u64,
    kind: EventKind,
    from: String,
    from_label: String,
    from_pane: Option<String>,
    to: String,
    to_label: String,
    to_pane: Option<String>,
    action: String,
    state: String,
}

#[derive(Serialize, Debug)]
pub struct CommsNode {
    id: String,
    label: String,
    kind: &'static str,
    pane: Option<String>,
    sent: u64,
    received: u64,
    access: u64,
}

#[derive(Serialize, Debug)]
pub struct MailEdge {
    from: String,
    to: String,
    count: u64,
    last_ts: u64,
}

#[derive(Serialize, Debug)]
pub struct AccessEdge {
    from: String,
    pane: String,
    count: u64,
    actions: HashMap<String, u64>,
    last_ts: u64,
}

#[derive(Serialize, Debug)]
pub struct StreamItem {
    ts: u64,
    #[serde(rename = "type")]
    kind: &'static str,
    from: String,
    to: String,
    action: String,
    state: String,
}

#[derive(Serialize, Debug, Default)]
pub struct Totals {
    mail: u64,
    mail_system: u64,
    access: u64,
    consent_allow: u64,
    consent_deny: u64,
    consent_pending: u64,
}

#[derive(Serialize, Debug)]
pub struct CommsReport {
    generated_at: u64,
    window_ms: u64,
    nodes: Vec<CommsNode>,
    mail_edges: Vec<MailEdge>,
    access_edges: Vec<AccessEdge>,
    stream: Vec<StreamItem>,
    totals: Totals,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn ms(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn non_empty(x: String) -> Option<String> {
    if x.is_empty() { None } else { Some(x) }
}

/// "agent:x", "pane:<uuid>", or a bare label → a node id + its label + pane.
fn principal(raw: &str) -> Option<(String, String, Option<String>)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(uuid) = raw.strip_prefix("pane:") {
        let uuid = uuid.trim();
        return (!uuid.is_empty()).then(|| (format!("pane:{uuid}"), uuid.to_string(), Some(uuid.to_string())));
    }
    if let Some(name) = raw.strip_prefix("system:") {
        return Some((format!("system:{name}"), name.to_string(), None));
    }
    let label = raw.strip_prefix("agent:").unwrap_or(raw).trim();
    (!label.is_empty()).then(|| (format!("agent:{label}"), label.to_string(), None))
}

/// One side of a mail line. Prefers the recorded principal; otherwise a pane
/// id when one is known, else the agent label.
fn mail_side(v: &Value, side: &str) -> Option<(String, String, Option<String>)> {
    let name = s(v, side);
    let pane = non_empty(s(v, &format!("{side}Pane")));
    if let Some((id, label, p)) = principal(&s(v, &format!("{side}Principal"))) {
        // Keep the human-readable name as the label for pane principals.
        let label = if id.starts_with("pane:") && !name.is_empty() { name.clone() } else { label };
        return Some((id, label, p.or(pane)));
    }
    if let Some(uuid) = pane.clone() {
        let label = if name.is_empty() { uuid.clone() } else { name };
        return Some((format!("pane:{uuid}"), label, Some(uuid)));
    }
    principal(&name).map(|(id, label, _)| (id, label, None))
}

fn parse_messages(text: &str, out: &mut Vec<Event>) {
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let system = s(&v, "fromKind") == "system";
        let from = if system {
            let name = s(&v, "from");
            let name = if name.is_empty() { "Hyperia".to_string() } else { name };
            Some((format!("system:{name}"), name, None))
        } else {
            mail_side(&v, "from")
        };
        let (Some((from, from_label, from_pane)), Some((to, to_label, to_pane))) = (from, mail_side(&v, "to")) else {
            continue;
        };
        out.push(Event {
            ts: ms(&v, "ts"),
            kind: EventKind::Mail { system },
            from,
            from_label,
            from_pane,
            to,
            to_label,
            to_pane,
            action: "mail".into(),
            state: non_empty(s(&v, "deliveryState")).unwrap_or_else(|| "stored".into()),
        });
    }
}

fn parse_operations(text: &str, out: &mut Vec<Event>) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    let ops: Vec<&Value> = match &v {
        Value::Object(map) => map.values().collect(),
        Value::Array(list) => list.iter().collect(),
        _ => return,
    };
    for op in ops {
        let kind = s(op, "kind");
        if kind.is_empty() || kind == "mail" {
            continue;
        }
        let (Some((from, from_label, from_pane)), Some(target)) = (principal(&s(op, "requester")), non_empty(s(op, "target"))) else {
            continue;
        };
        out.push(Event {
            ts: ms(op, "created_ms"),
            kind: EventKind::Access,
            from,
            from_label,
            from_pane,
            to: format!("pane:{target}"),
            to_label: target.clone(),
            to_pane: Some(target),
            action: kind,
            state: s(op, "state"),
        });
    }
}

fn parse_consent(text: &str, out: &mut Vec<Event>) {
    // Requests still waiting at the end of the file are "pending".
    let mut open: HashMap<String, Event> = HashMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some((from, from_label, from_pane)) = principal(&s(&v, "requester")) else { continue };
        let action = s(&v, "action");
        // message:pane:<uuid> → "message"; the target carries the pane.
        let short = if action.starts_with("message:") { "message".to_string() } else { action.clone() };
        let target = s(&v, "target");
        let (to, to_label, to_pane) = if target.is_empty() {
            (String::new(), String::new(), None)
        } else if target.len() == 36 && target.chars().filter(|c| *c == '-').count() == 4 {
            (format!("pane:{target}"), target.clone(), Some(target.clone()))
        } else {
            (target.clone(), target.clone(), None)
        };
        let id = s(&v, "id");
        let event = Event {
            ts: ms(&v, "ts"),
            kind: EventKind::Consent,
            from,
            from_label,
            from_pane,
            to,
            to_label,
            to_pane,
            action: short.clone(),
            state: String::new(),
        };
        match s(&v, "event").as_str() {
            "requested" => {
                if !id.is_empty() {
                    open.insert(id, Event { state: "pending".into(), ..event });
                }
            }
            "decision" => {
                open.remove(&id);
                let decision = s(&v, "decision");
                let granted_access = decision == "allow" && (short == "drive" || short == "message") && event.to_pane.is_some();
                if granted_access {
                    out.push(Event { kind: EventKind::Access, action: format!("consent:{short}"), state: decision.clone(), ..event.clone() });
                }
                out.push(Event { state: decision, ..event });
            }
            _ => {}
        }
    }
    out.extend(open.into_values());
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

fn aggregate(events: &[Event], now: u64, window_ms: u64) -> CommsReport {
    let since = now.saturating_sub(window_ms);
    let mut nodes: HashMap<String, CommsNode> = HashMap::new();
    let mut mail: HashMap<(String, String), MailEdge> = HashMap::new();
    let mut access: HashMap<(String, String), AccessEdge> = HashMap::new();
    let mut totals = Totals::default();
    let mut stream: Vec<&Event> = Vec::new();

    fn node<'a>(nodes: &'a mut HashMap<String, CommsNode>, id: &str, label: &str, pane: &Option<String>) -> &'a mut CommsNode {
        let entry = nodes.entry(id.to_string()).or_insert_with(|| CommsNode {
            id: id.to_string(),
            label: label.to_string(),
            kind: if id.starts_with("pane:") { "pane" } else if id.starts_with("system:") { "system" } else { "agent" },
            pane: pane.clone(),
            sent: 0,
            received: 0,
            access: 0,
        });
        if entry.pane.is_none() && pane.is_some() {
            entry.pane = pane.clone();
        }
        // Prefer a readable label over a bare uuid.
        if entry.label == entry.pane.clone().unwrap_or_default() && !label.is_empty() && Some(label.to_string()) != entry.pane {
            entry.label = label.to_string();
        }
        entry
    }

    for e in events.iter().filter(|e| e.ts >= since && e.ts <= now.saturating_add(60_000)) {
        match &e.kind {
            EventKind::Mail { system } => {
                stream.push(e);
                if *system {
                    totals.mail_system += 1;
                    node(&mut nodes, &e.from, &e.from_label, &e.from_pane).sent += 1;
                    continue;
                }
                totals.mail += 1;
                node(&mut nodes, &e.from, &e.from_label, &e.from_pane).sent += 1;
                node(&mut nodes, &e.to, &e.to_label, &e.to_pane).received += 1;
                let edge = mail.entry((e.from.clone(), e.to.clone())).or_insert_with(|| MailEdge {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    count: 0,
                    last_ts: 0,
                });
                edge.count += 1;
                edge.last_ts = edge.last_ts.max(e.ts);
            }
            EventKind::Access => {
                let Some(pane) = e.to_pane.clone() else { continue };
                totals.access += 1;
                if !e.action.starts_with("consent:") {
                    stream.push(e);
                }
                node(&mut nodes, &e.from, &e.from_label, &e.from_pane).access += 1;
                node(&mut nodes, &e.to, &e.to_label, &e.to_pane).access += 1;
                let edge = access.entry((e.from.clone(), pane.clone())).or_insert_with(|| AccessEdge {
                    from: e.from.clone(),
                    pane: pane.clone(),
                    count: 0,
                    actions: HashMap::new(),
                    last_ts: 0,
                });
                edge.count += 1;
                *edge.actions.entry(e.action.clone()).or_insert(0) += 1;
                edge.last_ts = edge.last_ts.max(e.ts);
            }
            EventKind::Consent => {
                stream.push(e);
                match e.state.as_str() {
                    "allow" => totals.consent_allow += 1,
                    "pending" => totals.consent_pending += 1,
                    // deny and expired both mean "not granted".
                    _ => totals.consent_deny += 1,
                }
            }
        }
    }

    let mut mail_edges: Vec<MailEdge> = mail.into_values().collect();
    mail_edges.sort_by(|a, b| b.count.cmp(&a.count).then(b.last_ts.cmp(&a.last_ts)));
    let mut access_edges: Vec<AccessEdge> = access.into_values().collect();
    access_edges.sort_by(|a, b| b.count.cmp(&a.count).then(b.last_ts.cmp(&a.last_ts)));
    let mut nodes: Vec<CommsNode> = nodes.into_values().collect();
    nodes.sort_by(|a, b| (b.sent + b.received + b.access).cmp(&(a.sent + a.received + a.access)).then(a.id.cmp(&b.id)));
    stream.sort_by(|a, b| b.ts.cmp(&a.ts));
    let stream = stream
        .into_iter()
        .take(STREAM_MAX)
        .map(|e| StreamItem {
            ts: e.ts,
            kind: match e.kind {
                EventKind::Mail { .. } => "mail",
                EventKind::Access => "access",
                EventKind::Consent => "consent",
            },
            from: e.from.clone(),
            to: e.to.clone(),
            action: e.action.clone(),
            state: e.state.clone(),
        })
        .collect();

    CommsReport { generated_at: now, window_ms, nodes, mail_edges, access_edges, stream, totals }
}

// ---------------------------------------------------------------------------
// Files + cache
// ---------------------------------------------------------------------------

type Stamp = Option<(SystemTime, u64)>;

struct Cache {
    stamps: [Stamp; 3],
    events: Arc<Vec<Event>>,
}

// Keyed by root so tests on temp dirs never evict the live one.
static CACHE: Mutex<Option<HashMap<PathBuf, Cache>>> = Mutex::new(None);

fn stamp(p: &Path) -> Stamp {
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

fn paths(root: &Path) -> [PathBuf; 3] {
    [
        root.join("logs").join("messages.jsonl"),
        root.join("delivery-operations.json"),
        root.join("logs").join("consent.jsonl"),
    ]
}

/// Parsed events for `root` (~/.hyperia), re-read only when a file changes.
fn load_events(root: &Path) -> Arc<Vec<Event>> {
    let files = paths(root);
    let stamps = [stamp(&files[0]), stamp(&files[1]), stamp(&files[2])];
    if let Ok(guard) = CACHE.lock() {
        if let Some(cache) = guard.as_ref().and_then(|m| m.get(root)) {
            if cache.stamps == stamps {
                return cache.events.clone();
            }
        }
    }
    let mut events = Vec::new();
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    parse_messages(&read(&files[0]), &mut events);
    parse_operations(&read(&files[1]), &mut events);
    parse_consent(&read(&files[2]), &mut events);
    let events = Arc::new(events);
    if let Ok(mut guard) = CACHE.lock() {
        guard.get_or_insert_with(HashMap::new).insert(root.to_path_buf(), Cache { stamps, events: events.clone() });
    }
    events
}

fn hyperia_root() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    PathBuf::from(home).join(".hyperia")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn report_for(root: &Path, window_ms: Option<u64>) -> CommsReport {
    let window = window_ms.unwrap_or(DEFAULT_WINDOW_MS).clamp(MIN_WINDOW_MS, MAX_WINDOW_MS);
    aggregate(&load_events(root), now_ms(), window)
}

/// GET /api/dashboard/comms — metadata only (no subjects, bodies or payloads),
/// so it's readable without an identity, like /api/status.
pub async fn get_dashboard_comms(Query(q): Query<HashMap<String, String>>) -> Json<CommsReport> {
    let window = q.get("window_ms").and_then(|v| v.parse::<u64>().ok());
    let report = tokio::task::spawn_blocking(move || report_for(&hyperia_root(), window))
        .await
        .unwrap_or_else(|_| aggregate(&[], now_ms(), DEFAULT_WINDOW_MS));
    Json(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn fixture(name: &str, messages: &str, ops: &str, consent: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hyperia-comms-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs").join("messages.jsonl"), messages).unwrap();
        std::fs::write(dir.join("delivery-operations.json"), ops).unwrap();
        std::fs::write(dir.join("logs").join("consent.jsonl"), consent).unwrap();
        dir
    }

    fn mail(from: &str, from_pane: &str, to: &str, to_pane: &str, kind: &str, ts: u64) -> String {
        serde_json::json!({
            "id": format!("m{ts}"), "from": from, "fromKind": kind, "fromPane": from_pane,
            "to": to, "toPane": to_pane, "subject": "SECRET-SUBJECT", "body": "SECRET-BODY", "ts": ts
        })
        .to_string()
    }

    fn build(root: &Path, window: u64) -> CommsReport {
        let mut events = Vec::new();
        let [m, o, c] = paths(root);
        parse_messages(&std::fs::read_to_string(m).unwrap_or_default(), &mut events);
        parse_operations(&std::fs::read_to_string(o).unwrap_or_default(), &mut events);
        parse_consent(&std::fs::read_to_string(c).unwrap_or_default(), &mut events);
        aggregate(&events, NOW, window)
    }

    #[test]
    fn dashboard_comms_counts_and_sorts_mail_edges() {
        let lines = [
            mail("a", "", "b", "", "agent", NOW - 10),
            mail("a", "", "b", "", "agent", NOW - 20),
            mail("c", "", "b", "", "agent", NOW - 5),
            mail("a", "", "b", "", "agent", NOW - 30),
        ]
        .join("\n");
        let root = fixture("sort", &lines, "{}", "");
        let r = build(&root, DEFAULT_WINDOW_MS);
        assert_eq!(r.mail_edges.len(), 2);
        assert_eq!((r.mail_edges[0].from.as_str(), r.mail_edges[0].to.as_str(), r.mail_edges[0].count), ("agent:a", "agent:b", 3));
        assert_eq!(r.mail_edges[0].last_ts, NOW - 10);
        assert_eq!(r.mail_edges[1].count, 1);
        assert_eq!(r.totals.mail, 4);
        let b = r.nodes.iter().find(|n| n.id == "agent:b").unwrap();
        assert_eq!(b.received, 4);
    }

    #[test]
    fn dashboard_comms_keeps_system_mail_out_of_edges() {
        let lines = [mail("Hyperia", "", "a", "", "system", NOW - 1), mail("a", "", "b", "", "agent", NOW - 2)].join("\n");
        let r = build(&fixture("system", &lines, "{}", ""), DEFAULT_WINDOW_MS);
        assert_eq!(r.totals.mail_system, 1);
        assert_eq!(r.totals.mail, 1);
        assert!(r.mail_edges.iter().all(|e| !e.from.starts_with("system:")));
        assert!(r.stream.iter().any(|s| s.from == "system:Hyperia" && s.kind == "mail"));
    }

    #[test]
    fn dashboard_comms_uses_pane_ids_when_a_pane_is_known() {
        let pane = "4de3e53a-3c58-437f-8eb4-28501d147bec";
        let lines = [
            mail("Industrial Pike", pane, "Long Horse", "a05c4a5e-48a2-4c29-ba86-8be8788aa13f", "pane", NOW - 1),
            mail("agent:nemesis8/n8-x", "", "nemesis8/n8-y", "", "agent", NOW - 2),
        ]
        .join("\n");
        let r = build(&fixture("ids", &lines, "{}", ""), DEFAULT_WINDOW_MS);
        let from_pane = r.nodes.iter().find(|n| n.id == format!("pane:{pane}")).expect("pane node");
        assert_eq!(from_pane.kind, "pane");
        assert_eq!(from_pane.label, "Industrial Pike");
        assert_eq!(from_pane.pane.as_deref(), Some(pane));
        assert!(r.nodes.iter().any(|n| n.id == "agent:nemesis8/n8-x" && n.kind == "agent"), "agent: prefix is not doubled");
        assert!(r.nodes.iter().any(|n| n.id == "agent:nemesis8/n8-y"));
    }

    #[test]
    fn dashboard_comms_window_filters_old_events() {
        let lines = [mail("a", "", "b", "", "agent", NOW - 1_000), mail("a", "", "b", "", "agent", NOW - 10 * 60_000)].join("\n");
        let r = build(&fixture("window", &lines, "{}", ""), 5 * 60_000);
        assert_eq!(r.totals.mail, 1);
        assert_eq!(r.window_ms, 5 * 60_000);
    }

    #[test]
    fn dashboard_comms_access_from_operations_and_allowed_consent() {
        let pane = "a05c4a5e-48a2-4c29-ba86-8be8788aa13f";
        let ops = serde_json::json!({
            "op1": {"id": "op1", "requester": "agent:n8/a", "target": pane, "kind": "shell", "state": "submitted",
                    "payload": {"command": "SECRET-PAYLOAD"}, "created_ms": NOW - 5},
            "op2": {"id": "op2", "requester": "agent:n8/a", "target": pane, "kind": "keys", "state": "submitted", "created_ms": NOW - 4},
            "op3": {"id": "op3", "requester": "agent:n8/a", "target": pane, "kind": "mail", "state": "submitted", "created_ms": NOW - 3}
        })
        .to_string();
        let consent = [
            serde_json::json!({"event": "requested", "id": "p1", "action": "drive", "requester": "agent:n8/b", "target": pane, "purpose": "SECRET-PURPOSE", "ts": NOW - 9}),
            serde_json::json!({"event": "decision", "id": "p1", "action": "drive", "decision": "allow", "requester": "agent:n8/b", "target": pane, "ts": NOW - 8}),
            serde_json::json!({"event": "requested", "id": "p2", "action": "drive", "requester": "agent:n8/c", "target": pane, "ts": NOW - 7}),
            serde_json::json!({"event": "decision", "id": "p3", "action": "cap:files", "decision": "deny", "requester": "agent:n8/c", "target": "", "ts": NOW - 6}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let r = build(&fixture("access", "", &ops, &consent), DEFAULT_WINDOW_MS);
        let a = r.access_edges.iter().find(|e| e.from == "agent:n8/a").unwrap();
        assert_eq!(a.count, 2, "mail ops are not access");
        assert_eq!(a.actions.get("shell"), Some(&1));
        assert!(r.access_edges.iter().any(|e| e.from == "agent:n8/b" && e.actions.contains_key("consent:drive")));
        assert_eq!(r.totals.access, 3);
        assert_eq!((r.totals.consent_allow, r.totals.consent_deny, r.totals.consent_pending), (1, 1, 1));
    }

    #[test]
    fn dashboard_comms_never_leaks_subject_body_payload_or_purpose() {
        let pane = "a05c4a5e-48a2-4c29-ba86-8be8788aa13f";
        let ops = serde_json::json!({"op1": {"requester": "agent:x", "target": pane, "kind": "shell",
            "payload": {"command": "SECRET-PAYLOAD"}, "created_ms": NOW - 1}})
        .to_string();
        let consent = serde_json::json!({"event": "requested", "id": "p", "action": "drive", "requester": "agent:x",
            "target": pane, "purpose": "SECRET-PURPOSE", "ts": NOW - 1})
        .to_string();
        let r = build(&fixture("leak", &mail("a", "", "b", "", "agent", NOW - 1), &ops, &consent), DEFAULT_WINDOW_MS);
        let json = serde_json::to_string(&r).unwrap();
        for secret in ["SECRET-SUBJECT", "SECRET-BODY", "SECRET-PAYLOAD", "SECRET-PURPOSE"] {
            assert!(!json.contains(secret), "{secret} leaked");
        }
    }

    #[test]
    fn dashboard_comms_skips_corrupt_lines_and_missing_files() {
        let lines = format!("{{not json\n{}\n\n", mail("a", "", "b", "", "agent", NOW - 1));
        let root = fixture("corrupt", &lines, "not json at all", "garbage\n");
        let r = build(&root, DEFAULT_WINDOW_MS);
        assert_eq!(r.totals.mail, 1);
        assert_eq!(r.totals.access, 0);
        let empty = std::env::temp_dir().join(format!("hyperia-comms-missing-{}", std::process::id()));
        let r = aggregate(&load_events(&empty), NOW, DEFAULT_WINDOW_MS);
        assert!(r.nodes.is_empty() && r.stream.is_empty());
    }

    #[test]
    fn dashboard_comms_cache_reuses_until_a_file_changes() {
        let root = fixture("cache", &mail("a", "", "b", "", "agent", NOW - 1), "{}", "");
        let first = load_events(&root);
        let again = load_events(&root);
        assert!(Arc::ptr_eq(&first, &again));
        std::fs::write(
            root.join("logs").join("messages.jsonl"),
            [mail("a", "", "b", "", "agent", NOW - 1), mail("a", "", "c", "", "agent", NOW - 2)].join("\n"),
        )
        .unwrap();
        let changed = load_events(&root);
        assert_eq!(changed.len(), 2);
    }

    /// Sanity check against the real ~/.hyperia files: `cargo test real_comms -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn dashboard_comms_real_data() {
        let r = aggregate(&load_events(&hyperia_root()), now_ms(), MAX_WINDOW_MS);
        println!("nodes {} mail_edges {} access_edges {} totals {:?}", r.nodes.len(), r.mail_edges.len(), r.access_edges.len(), r.totals);
        let label = |id: &str| r.nodes.iter().find(|n| n.id == id).map(|n| n.label.clone()).unwrap_or_else(|| id.to_string());
        for e in r.mail_edges.iter().take(5) {
            println!("  {} -> {} x{}", label(&e.from), label(&e.to), e.count);
        }
    }
}
