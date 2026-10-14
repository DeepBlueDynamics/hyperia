//! Agent input held because the human is in the target pane. The owning window
//! shows a toast; "Send now" releases that one operation past the focus guard.
//! Holds are keyed by delivery op ID, or by `mail_key(pane)` for a mail notice.
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// A release the queue couldn't use in this long lapses; the hold is shown again.
pub const RELEASE_TTL: Duration = Duration::from_secs(30);

pub static HELD: LazyLock<Mutex<Held>> = LazyLock::new(Default::default);

const MAIL_PREFIX: &str = "mail:";

/// Hold key for a pane's pending mail notice.
pub fn mail_key(pane: &str) -> String {
    format!("{MAIL_PREFIX}{pane}")
}

pub fn is_mail_key(key: &str) -> bool {
    key.starts_with(MAIL_PREFIX)
}

#[derive(Default)]
pub struct Held {
    ops: HashMap<String, Entry>,
}

struct Entry {
    pane: String,
    released: Option<Instant>,
}

impl Held {
    /// Record an op held for focus. True when the window should be told
    /// (first hold, or a release that lapsed unused).
    pub fn hold(&mut self, op: &str, pane: &str, now: Instant) -> bool {
        match self.ops.get_mut(op) {
            Some(e) => match e.released {
                Some(at) if now.duration_since(at) >= RELEASE_TTL => {
                    e.released = None;
                    true
                }
                _ => false,
            },
            None => {
                self.ops.insert(op.into(), Entry { pane: pane.into(), released: None });
                true
            }
        }
    }

    /// Drop a hold (announcement failed, or it was delivered). True if one existed.
    pub fn forget(&mut self, op: &str) -> bool {
        self.ops.remove(op).is_some()
    }

    pub fn contains(&self, op: &str) -> bool {
        self.ops.contains_key(op)
    }

    /// (sends, mail notices) currently held for the human's focus.
    pub fn counts(&self) -> (usize, usize) {
        let mail = self.ops.keys().filter(|k| is_mail_key(k)).count();
        (self.ops.len() - mail, mail)
    }

    /// The human chose "Send now". False if the op isn't held (gone or delivered).
    pub fn release(&mut self, op: &str, now: Instant) -> bool {
        match self.ops.get_mut(op) {
            Some(e) => {
                e.released = Some(now);
                true
            }
            None => false,
        }
    }

    pub fn released(&self, op: &str, now: Instant) -> bool {
        self.ops.get(op)
            .and_then(|e| e.released)
            .is_some_and(|at| now.duration_since(at) < RELEASE_TTL)
    }

    /// Drop holds whose op left the queue (delivered, expired, cancelled).
    /// Returns (op, pane) for each so the window can close its toast.
    pub fn sweep(&mut self, still_queued: impl Fn(&str) -> bool) -> Vec<(String, String)> {
        let gone: Vec<String> = self.ops.keys().filter(|id| !still_queued(id)).cloned().collect();
        gone.into_iter()
            .filter_map(|id| self.ops.remove(&id).map(|e| (id, e.pane)))
            .collect()
    }
}

/// Short single-line preview of held text for the toast.
pub fn preview(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 140 {
        flat
    } else {
        format!("{}…", flat.chars().take(139).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn announces_once_and_again_after_an_unused_release_lapses() {
        let mut h = Held::default();
        let t0 = Instant::now();
        assert!(h.hold("op1", "pane-a", t0));
        assert!(!h.hold("op1", "pane-a", t0), "already announced");
        assert!(h.release("op1", t0));
        assert!(h.released("op1", t0 + Duration::from_secs(1)));
        assert!(!h.hold("op1", "pane-a", t0 + Duration::from_secs(1)), "release still live");
        let later = t0 + RELEASE_TTL;
        assert!(!h.released("op1", later));
        assert!(h.hold("op1", "pane-a", later), "lapsed release shows the toast again");
    }

    #[test]
    fn release_of_unknown_op_fails_and_sweep_clears_gone_ops() {
        let mut h = Held::default();
        let t0 = Instant::now();
        assert!(!h.release("nope", t0));
        h.hold("op1", "pane-a", t0);
        h.hold("op2", "pane-b", t0);
        let cleared = h.sweep(|id| id == "op2");
        assert_eq!(cleared, vec![("op1".to_string(), "pane-a".to_string())]);
        assert!(!h.release("op1", t0));
        assert!(h.release("op2", t0));
    }

    #[test]
    fn mail_keys_are_distinct_from_op_ids() {
        assert_eq!(mail_key("abc"), "mail:abc");
        assert!(is_mail_key(&mail_key("abc")));
        assert!(!is_mail_key("op_1a13b3a1408_ebb0"));
    }

    #[test]
    fn preview_flattens_and_truncates() {
        assert_eq!(preview("a\n  b\tc"), "a b c");
        let long = "x".repeat(300);
        let p = preview(&long);
        assert_eq!(p.chars().count(), 140);
        assert!(p.ends_with('…'));
    }
}
