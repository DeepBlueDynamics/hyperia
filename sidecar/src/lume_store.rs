//! Lume-backed internal search for Hyperia.
//!
//! Two primitives, both built on lume's local BM25 index (no network, no CLI):
//!
//!   1. Per-shell text logs — a growing, ANSI-stripped line buffer per PTY
//!      session, fed from the same SessionData path that drives the screen
//!      buffer. Searchable per-shell or across all shells. This is the store
//!      of record for shell scrollback beyond the 1000-line screen ring.
//!
//!   2. Sticky-note search — BM25 over ~/.hyperia/stickys/notes.json
//!      (name + text per note).
//!
//! Persistence: the per-shell line buffers are pickled to
//! ~/.hyperia/lume/shell-logs.json on Hyperia shutdown and reloaded on boot,
//! so a shell's history survives a restart. The BM25 index itself is derived
//! and rebuilt on demand — only the source lines are persisted.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use lume::bm25::{Bm25Index, Bm25Params, SearchVariant, Section};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Hard cap on lines retained per shell, to bound memory. Oldest lines drop
/// off the front (ring). Persisted on shutdown regardless.
const MAX_LINES_PER_SHELL: usize = 20_000;

/// A single search hit in a shell's log.
#[derive(Debug, Clone, Serialize)]
pub struct ShellLogHit {
    pub session_uid: String,
    pub line_number: usize,
    pub text: String,
    pub score: f64,
}

/// A single sticky-note search hit.
#[derive(Debug, Clone, Serialize)]
pub struct StickyHit {
    pub id: String,
    pub name: String,
    pub preview: String,
    pub score: f64,
}

/// On-disk shape for the persisted shell logs.
#[derive(Default, Serialize, Deserialize)]
struct ShellLogsDisk {
    /// uid -> lines
    logs: HashMap<String, Vec<String>>,
}

#[derive(Clone)]
pub struct LumeStore {
    inner: Arc<Inner>,
}

struct Inner {
    shell_logs: Mutex<HashMap<String, Vec<String>>>,
}

impl LumeStore {
    /// Construct empty, then warm-load any persisted shell logs from disk.
    pub fn new() -> Self {
        let store = Self {
            inner: Arc::new(Inner {
                shell_logs: Mutex::new(HashMap::new()),
            }),
        };
        store.load_blocking();
        store
    }

    fn persist_path() -> PathBuf {
        let home = std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| ".".into());
        PathBuf::from(home).join(".hyperia").join("lume").join("shell-logs.json")
    }

    fn load_blocking(&self) {
        let path = Self::persist_path();
        let Ok(content) = std::fs::read_to_string(&path) else { return };
        let Ok(disk): Result<ShellLogsDisk, _> = serde_json::from_str(&content) else { return };
        // We're in `new()` before any async runtime use of the mutex — use
        // try_lock; on the cold path it's always free.
        if let Ok(mut guard) = self.inner.shell_logs.try_lock() {
            *guard = disk.logs;
        }
    }

    /// Pickle all shell logs to disk. Call on Hyperia shutdown.
    pub async fn persist(&self) {
        let path = Self::persist_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let guard = self.inner.shell_logs.lock().await;
        let disk = ShellLogsDisk { logs: guard.clone() };
        if let Ok(json) = serde_json::to_string(&disk) {
            let _ = std::fs::write(&path, json);
        }
    }

    /// Append a chunk of raw PTY bytes (ANSI-stripped) to a shell's log.
    /// Splits into lines; bounds the per-shell buffer to MAX_LINES_PER_SHELL.
    pub async fn append_shell_bytes(&self, uid: &str, bytes: &[u8]) {
        let text = strip_ansi(bytes);
        if text.trim().is_empty() {
            return;
        }
        let mut guard = self.inner.shell_logs.lock().await;
        let buf = guard.entry(uid.to_string()).or_default();
        for line in text.split('\n') {
            let trimmed = line.trim_end_matches('\r');
            if !trimmed.trim().is_empty() {
                buf.push(trimmed.to_string());
            }
        }
        if buf.len() > MAX_LINES_PER_SHELL {
            let overflow = buf.len() - MAX_LINES_PER_SHELL;
            buf.drain(0..overflow);
        }
    }

    /// Drop a shell's log. Not called on SessionExit (a just-closed shell
    /// stays searchable + gets pickled); reserved for a future "clear shell
    /// log" tool.
    #[allow(dead_code)]
    pub async fn remove_shell(&self, uid: &str) {
        self.inner.shell_logs.lock().await.remove(uid);
    }

    /// Search one shell (Some uid) or every shell (None). Returns hits sorted
    /// by descending BM25 score, capped at `limit`.
    pub async fn search_shell(&self, uid: Option<&str>, query: &str, limit: usize) -> Vec<ShellLogHit> {
        let guard = self.inner.shell_logs.lock().await;
        let mut hits: Vec<ShellLogHit> = Vec::new();
        for (sess_uid, lines) in guard.iter() {
            if let Some(want) = uid {
                if sess_uid != want {
                    continue;
                }
            }
            if lines.is_empty() {
                continue;
            }
            let sections: Vec<Section> = lines
                .iter()
                .enumerate()
                .map(|(i, line)| Section {
                    title: String::new(),
                    body: line.clone(),
                    line_number: i,
                    filename: Some(sess_uid.clone()),
                })
                .collect();
            let index = Bm25Index::build(sections, None);
            let results = index.search(query, SearchVariant::Plus, &Bm25Params::default(), None);
            for hit in results {
                if let Some(line) = lines.get(hit.section_index) {
                    hits.push(ShellLogHit {
                        session_uid: sess_uid.clone(),
                        line_number: hit.section_index,
                        text: line.clone(),
                        score: hit.score,
                    });
                }
            }
        }
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(limit);
        hits
    }

    /// Search all sticky notes. Reads notes.json fresh each call (it's small),
    /// builds a BM25 index over name+text, returns hits sorted by score.
    pub async fn search_stickies(&self, query: &str, limit: usize) -> Vec<StickyHit> {
        let notes = load_sticky_notes();
        if notes.is_empty() {
            return Vec::new();
        }
        let sections: Vec<Section> = notes
            .iter()
            .map(|n| Section {
                title: n.name.clone(),
                body: n.text.clone(),
                line_number: 0,
                filename: Some(n.id.clone()),
            })
            .collect();
        let index = Bm25Index::build(sections, None);
        let results = index.search(query, SearchVariant::Plus, &Bm25Params::default(), None);
        let mut hits: Vec<StickyHit> = results
            .into_iter()
            .filter_map(|h| {
                notes.get(h.section_index).map(|n| {
                    let preview: String = n.text.chars().take(120).collect();
                    StickyHit {
                        id: n.id.clone(),
                        name: n.name.clone(),
                        preview,
                        score: h.score,
                    }
                })
            })
            .collect();
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(limit);
        hits
    }
}

impl Default for LumeStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Minimal sticky note shape from notes.json (only the fields we index).
#[derive(Deserialize)]
struct StickyNote {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    text: String,
}

fn load_sticky_notes() -> Vec<StickyNote> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    let path = PathBuf::from(home).join(".hyperia").join("stickys").join("notes.json");
    let Ok(content) = std::fs::read_to_string(&path) else { return Vec::new() };
    serde_json::from_str(&content).unwrap_or_default()
}

/// Strip ANSI/VT escape sequences and most control characters from a PTY byte
/// chunk, leaving searchable text. Keeps `\n` and `\t`. Not a full terminal
/// emulator — good enough to index words for BM25.
fn strip_ansi(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => {
                // ESC — consume the following sequence.
                match chars.peek().copied() {
                    Some('[') => {
                        // CSI: ESC [ ... <final byte 0x40..0x7e>
                        chars.next();
                        while let Some(&n) = chars.peek() {
                            chars.next();
                            if ('\x40'..='\x7e').contains(&n) {
                                break;
                            }
                        }
                    }
                    Some(']') => {
                        // OSC: ESC ] ... terminated by BEL or ESC \
                        chars.next();
                        while let Some(&n) = chars.peek() {
                            if n == '\x07' {
                                chars.next();
                                break;
                            }
                            if n == '\x1b' {
                                chars.next();
                                if chars.peek() == Some(&'\\') {
                                    chars.next();
                                }
                                break;
                            }
                            chars.next();
                        }
                    }
                    Some(_) => {
                        // Two-char escape (e.g. ESC =, ESC >) — drop next char.
                        chars.next();
                    }
                    None => {}
                }
            }
            '\n' | '\t' => out.push(c),
            c if (c as u32) < 0x20 || c == '\x7f' => {
                // Drop other control chars (incl. bare CR, BEL, backspace).
            }
            c => out.push(c),
        }
    }
    out
}
