//! Agent message bus — a local, searchable "email for agents".
//!
//! Agents send each other durable messages instead of typing raw text into each
//! other's panes (which floods the pane, has no length limit, no delivery record,
//! and no reply channel). A message is addressed to a pane (or to an agent by
//! label), sits unread until the recipient reads it, and every message is
//! searchable by sender/recipient and content.
//!
//! Two append-only files under `~/.hyperia/logs/` (append-only, like the audit /
//! consent / bug logs — concurrency-safe: no whole-file rewrite, so concurrent
//! senders can't clobber each other):
//!   - `messages.jsonl`      — one line per sent message
//!   - `message-reads.jsonl` — one line per read receipt
//!
//! A message is "unread for me" when it is addressed to me and no read receipt
//! from me exists for it.

#[path = "mailbox.rs"]
pub mod mailbox;

pub use mailbox::{
    acknowledge_message, check_inbox, generate_message_id, matches_recipient, matches_sender,
    send_message, BindingRecord, BindingStore, MailboxError, MessageEnvelope, Principal,
    ProofOfResidency, ReadReceipt, SearchScope, SendParams,
};

use std::collections::HashSet;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

fn logs_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    std::path::PathBuf::from(home).join(".hyperia").join("logs")
}

fn messages_path() -> std::path::PathBuf {
    logs_dir().join("messages.jsonl")
}

fn reads_path() -> std::path::PathBuf {
    logs_dir().join("message-reads.jsonl")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn append_line(path: &std::path::Path, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let mut s = line.to_string();
        s.push('\n');
        let _ = f.write_all(s.as_bytes());
    }
}

/// Cap on a bus message body. Generous (this is the long-message channel), unlike
/// the 512-char pane-injection cap — but bounded so the log can't be flooded.
pub const MAX_BODY_CHARS: usize = 16 * 1024;

/// Append one message; returns its id (`msg_<hex-ts>`). Fields mirror the bug /
/// consent log shape. `to_pane` is the recipient pane uid (empty when addressed
/// only by label); `to_label` is the recipient's display name / agent name.
#[allow(clippy::too_many_arguments)]
pub fn record(
    from_label: &str,
    from_kind: &str,
    from_pane: &str,
    to_pane: &str,
    to_label: &str,
    subject: &str,
    body: &str,
) -> String {
    let ts = now_ms();
    let id = format!("msg_{ts:x}");
    let entry = serde_json::json!({
        "id": id,
        "ts": ts,
        "from": from_label,
        "fromKind": from_kind,
        "fromPane": from_pane,
        "toPane": to_pane,
        "to": to_label,
        "subject": subject,
        "body": body,
    });
    append_line(&messages_path(), &entry.to_string());
    id
}

/// Append a read receipt: `reader` has read `msg_id`.
pub fn record_read(msg_id: &str, reader_label: &str) {
    let entry = serde_json::json!({ "msgId": msg_id, "reader": reader_label, "ts": now_ms() });
    append_line(&reads_path(), &entry.to_string());
}

/// The set of message ids `reader` has read.
fn reads_for(reader_label: &str) -> HashSet<String> {
    let Ok(content) = std::fs::read_to_string(reads_path()) else {
        return HashSet::new();
    };
    read_ids_from(&content, reader_label)
}

/// Which box a search targets. `Sent` = from me, `Received` = to me, `All` = either.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Sent,
    Received,
    All,
}

fn to_me(m: &serde_json::Value, me_label: &str, me_pane: &str) -> bool {
    m["to"].as_str() == Some(me_label) || (!me_pane.is_empty() && m["toPane"].as_str() == Some(me_pane))
}

fn from_me(m: &serde_json::Value, me_label: &str, me_pane: &str) -> bool {
    m["from"].as_str() == Some(me_label) || (!me_pane.is_empty() && m["fromPane"].as_str() == Some(me_pane))
}

/// Inbox: messages addressed to me, newest-first, each annotated with `read`.
pub fn inbox(me_label: &str, me_pane: &str, unread_only: bool, limit: usize) -> Vec<serde_json::Value> {
    let msgs = std::fs::read_to_string(messages_path()).unwrap_or_default();
    let reads = std::fs::read_to_string(reads_path()).unwrap_or_default();
    inbox_from(&msgs, &reads, me_label, me_pane, unread_only, limit)
}

/// Search my messages (sent / received / all), newest-first, `read`-annotated.
pub fn search(
    me_label: &str,
    me_pane: &str,
    scope: Scope,
    q: Option<&str>,
    limit: usize,
) -> Vec<serde_json::Value> {
    let msgs = std::fs::read_to_string(messages_path()).unwrap_or_default();
    let reads = std::fs::read_to_string(reads_path()).unwrap_or_default();
    search_from(&msgs, &reads, me_label, me_pane, scope, q, limit)
}

// ---- pure cores (filesystem-free, unit-tested) ----------------------------

fn read_ids_from(reads_content: &str, reader_label: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    for line in reads_content.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v["reader"].as_str() == Some(reader_label) {
                if let Some(id) = v["msgId"].as_str() {
                    set.insert(id.to_string());
                }
            }
        }
    }
    set
}

fn annotate_read(mut m: serde_json::Value, read: &HashSet<String>) -> serde_json::Value {
    let is_read = m["id"].as_str().map(|id| read.contains(id)).unwrap_or(false);
    m["read"] = serde_json::json!(is_read);
    m
}

fn inbox_from(
    messages_content: &str,
    reads_content: &str,
    me_label: &str,
    me_pane: &str,
    unread_only: bool,
    limit: usize,
) -> Vec<serde_json::Value> {
    let read = read_ids_from(reads_content, me_label);
    let mut out = Vec::new();
    for line in messages_content.lines().rev() {
        if out.len() >= limit {
            break;
        }
        let Ok(m) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if !to_me(&m, me_label, me_pane) {
            continue;
        }
        let is_read = m["id"].as_str().map(|id| read.contains(id)).unwrap_or(false);
        if unread_only && is_read {
            continue;
        }
        out.push(annotate_read(m, &read));
    }
    out
}

fn search_from(
    messages_content: &str,
    reads_content: &str,
    me_label: &str,
    me_pane: &str,
    scope: Scope,
    q: Option<&str>,
    limit: usize,
) -> Vec<serde_json::Value> {
    let read = read_ids_from(reads_content, me_label);
    let q_lc = q.map(|s| s.to_lowercase());
    let mut out = Vec::new();
    for line in messages_content.lines().rev() {
        if out.len() >= limit {
            break;
        }
        if let Some(q) = &q_lc {
            if !line.to_lowercase().contains(q.as_str()) {
                continue;
            }
        }
        let Ok(m) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let keep = match scope {
            Scope::Sent => from_me(&m, me_label, me_pane),
            Scope::Received => to_me(&m, me_label, me_pane),
            Scope::All => from_me(&m, me_label, me_pane) || to_me(&m, me_label, me_pane),
        };
        if !keep {
            continue;
        }
        out.push(annotate_read(m, &read));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two messages: alice→bob and bob→alice, plus one read receipt (bob read m1).
    fn fixture() -> (String, String) {
        let msgs = [
            serde_json::json!({"id":"msg_1","ts":1,"from":"alice","fromKind":"agent","fromPane":"","toPane":"pB","to":"bob","subject":"","body":"rebuild the index please"}),
            serde_json::json!({"id":"msg_2","ts":2,"from":"bob","fromKind":"pane","fromPane":"pB","toPane":"","to":"alice","subject":"re","body":"done, index rebuilt"}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let reads = serde_json::json!({"msgId":"msg_1","reader":"bob","ts":3}).to_string();
        (msgs, reads)
    }

    #[test]
    fn inbox_returns_messages_to_me_newest_first_with_read_flag() {
        let (msgs, reads) = fixture();
        let got = inbox_from(&msgs, &reads, "bob", "pB", false, 50);
        assert_eq!(got.len(), 1); // only alice->bob is to bob
        assert_eq!(got[0]["id"], "msg_1");
        assert_eq!(got[0]["read"], serde_json::json!(true)); // bob read it
    }

    #[test]
    fn to_me_matches_by_pane_uid_even_without_label() {
        let (msgs, reads) = fixture();
        // Address bob only by pane uid (label mismatch) — still delivered.
        let got = inbox_from(&msgs, &reads, "bob-other-name", "pB", false, 50);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"], "msg_1");
    }

    #[test]
    fn unread_only_filters_out_read_messages() {
        let (msgs, reads) = fixture();
        let got = inbox_from(&msgs, &reads, "bob", "pB", true, 50);
        assert!(got.is_empty()); // the one message to bob is already read
    }

    #[test]
    fn search_scopes_sent_received_all() {
        let (msgs, reads) = fixture();
        assert_eq!(search_from(&msgs, &reads, "alice", "", Scope::Sent, None, 50).len(), 1); // alice sent m1
        assert_eq!(search_from(&msgs, &reads, "alice", "", Scope::Received, None, 50).len(), 1); // alice recv m2
        assert_eq!(search_from(&msgs, &reads, "alice", "", Scope::All, None, 50).len(), 2);
    }

    #[test]
    fn search_substring_is_case_insensitive() {
        let (msgs, reads) = fixture();
        let got = search_from(&msgs, &reads, "alice", "", Scope::All, Some("REBUILT"), 50);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"], "msg_2");
    }

    #[test]
    fn read_ids_only_counts_my_receipts() {
        let reads = [
            serde_json::json!({"msgId":"msg_1","reader":"bob"}),
            serde_json::json!({"msgId":"msg_9","reader":"carol"}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let ids = read_ids_from(&reads, "bob");
        assert!(ids.contains("msg_1"));
        assert!(!ids.contains("msg_9"));
    }
}
