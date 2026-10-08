//! Folder watcher for agents running directly on the host.
//!
//! Every few seconds we pick the panes the classifier calls an agent that is
//! NOT an n8 container (n8's own monitor reports those) and watch each one's
//! working folder recursively. Raw notifications are coalesced per path so one
//! save is one event, capped per pane so a build or checkout can't flood, then
//! recorded locally (proto_viz Live) and forwarded to n8 as `fs` events.
//!
//! Two panes in the same folder: the pane that claimed it first keeps it while
//! it still qualifies. Changes can't be told apart by writer, so crediting one
//! pane beats double-counting every save.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::json;
use tokio::sync::mpsc;

use crate::bridge::Bridge;
use crate::telemetry::{FileOp, TelemetryEvent, TelemetryStore};

const SCAN_EVERY: Duration = Duration::from_secs(5);
/// A path's raw events within this window become one event.
const SETTLE: Duration = Duration::from_millis(700);
const FLUSH_EVERY: Duration = Duration::from_millis(250);
/// Per pane, per CAP_WINDOW.
const CAP_EVENTS: usize = 200;
const CAP_WINDOW: Duration = Duration::from_secs(5);
const MAX_SIZES: usize = 50_000;

const EXCLUDED_DIRS: &[&str] = &[
    ".git", "target", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "venv",
];

/// Agents that run inside n8 containers; their files are n8's to report.
fn is_n8_token(token: &str) -> bool {
    matches!(token, "n8" | "nemesis8")
}

/// Should this pane's folder be watched? Only host agents. The classifier
/// already resolves n8 → docker panes to the "n8" token (and a bare docker
/// foreground to no agent at all), so the token alone decides.
pub(crate) fn should_watch(agent_token: Option<&str>) -> bool {
    agent_token.is_some_and(|t| !is_n8_token(t))
}

/// A project folder worth watching: an existing directory, not the user's
/// home (or above it), at least two levels below the root.
pub(crate) fn watchable_folder(cwd: &str, home: &Path) -> Option<PathBuf> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return None;
    }
    let p = PathBuf::from(cwd);
    let depth = p.components().filter(|c| matches!(c, Component::Normal(_))).count();
    if depth < 2 || home.starts_with(&p) {
        return None;
    }
    p.is_dir().then_some(p)
}

/// Build output, VCS internals, editor temp files and nuts-files temp writes.
/// Dot-directories are skipped; dotfiles in the project itself are kept.
pub(crate) fn excluded(root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let parts: Vec<&str> = rel.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    }).collect();
    let Some((name, dirs)) = parts.split_last() else { return true };
    // The excluded folder itself (its own create/delete) as well as anything in it.
    if EXCLUDED_DIRS.contains(name) || dirs.iter().any(|d| EXCLUDED_DIRS.contains(d) || d.starts_with('.')) {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".tmp") || lower.ends_with(".swp") || lower.ends_with('~') || lower.contains(".nutstmp")
}

/// What a raw notification says about a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Raw {
    Create,
    Modify,
    Remove,
}

pub(crate) fn raw_kind(kind: &EventKind) -> Option<Raw> {
    match kind {
        EventKind::Create(_) => Some(Raw::Create),
        EventKind::Modify(notify::event::ModifyKind::Name(notify::event::RenameMode::From)) => Some(Raw::Remove),
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some(Raw::Create),
        EventKind::Modify(_) => Some(Raw::Modify),
        EventKind::Remove(_) => Some(Raw::Remove),
        _ => None,
    }
}

/// One coalesced change, ready to report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Change {
    pub pane: String,
    pub path: PathBuf,
    /// "created" | "modified" | "removed" (n8's kind_detail).
    pub detail: &'static str,
}

struct Pending {
    pane: String,
    saw_create: bool,
    last: Instant,
}

/// Coalesces raw events per path and applies the per-pane cap.
pub(crate) struct Coalescer {
    pending: HashMap<PathBuf, Pending>,
    window: HashMap<String, (Instant, usize, usize)>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self { pending: HashMap::new(), window: HashMap::new() }
    }

    pub fn push(&mut self, pane: &str, path: PathBuf, raw: Raw, now: Instant) {
        let e = self.pending.entry(path).or_insert(Pending { pane: pane.to_string(), saw_create: false, last: now });
        e.pane = pane.to_string();
        e.saw_create |= raw == Raw::Create;
        e.last = now;
    }

    /// Settled paths become changes. `exists` decides created/modified/removed
    /// from the file's state now; something created and gone again is dropped.
    pub fn flush(&mut self, now: Instant, exists: impl Fn(&Path) -> bool, known: impl Fn(&Path) -> bool) -> Vec<Change> {
        let ready: Vec<PathBuf> = self.pending.iter()
            .filter(|(_, p)| now.duration_since(p.last) >= SETTLE)
            .map(|(k, _)| k.clone())
            .collect();
        let mut out = Vec::new();
        for path in ready {
            let p = self.pending.remove(&path).expect("listed above");
            let detail = match (exists(&path), p.saw_create) {
                (true, true) => "created",
                (true, false) => "modified",
                (false, true) if !known(&path) => continue,
                (false, _) => "removed",
            };
            if self.allow(&p.pane, now) {
                out.push(Change { pane: p.pane, path, detail });
            }
        }
        out
    }

    /// Per-pane cap. Logs one line per window for what it dropped.
    fn allow(&mut self, pane: &str, now: Instant) -> bool {
        let w = self.window.entry(pane.to_string()).or_insert((now, 0, 0));
        if now.duration_since(w.0) >= CAP_WINDOW {
            if w.2 > 0 {
                tracing::info!("host telemetry: dropped {} file event(s) for pane {pane} (over {CAP_EVENTS}/{}s)", w.2, CAP_WINDOW.as_secs());
            }
            *w = (now, 0, 0);
        }
        if w.1 >= CAP_EVENTS {
            w.2 += 1;
            return false;
        }
        w.1 += 1;
        true
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Report one change: locally for proto_viz, and to n8.
fn report(telemetry: &TelemetryStore, sizes: &mut HashMap<PathBuf, u64>, c: Change) {
    let size = std::fs::metadata(&c.path).ok().filter(|m| m.is_file()).map(|m| m.len());
    if c.detail != "removed" && size.is_none() {
        return; // a directory, or gone already
    }
    let before = sizes.get(&c.path).copied();
    let delta: i64 = match (c.detail, size, before) {
        ("removed", _, Some(b)) => -(b as i64),
        (_, Some(s), Some(b)) => s as i64 - b as i64,
        (_, Some(s), None) if c.detail == "created" => s as i64,
        _ => 0,
    };
    match size {
        Some(s) if c.detail != "removed" => {
            if sizes.len() >= MAX_SIZES {
                sizes.clear();
            }
            sizes.insert(c.path.clone(), s);
        }
        _ => {
            sizes.remove(&c.path);
        }
    }
    let path = c.path.to_string_lossy().into_owned();
    let op = match c.detail {
        "created" => FileOp::Create,
        "removed" => FileOp::Delete,
        _ => FileOp::Write,
    };
    telemetry.record(&c.pane, TelemetryEvent::FileOp { path: path.clone(), op, bytes: size });
    crate::host_telemetry::forward::enqueue(&c.pane, json!({
        "kind": "fs", "ts": now_secs(), "path": path, "kind_detail": c.detail,
        "size_bytes": size.unwrap_or(0), "delta_bytes": delta,
    }));
}

/// Current folder → owning pane, for panes that qualify right now.
async fn scan(bridge: &Bridge, owners: &HashMap<PathBuf, String>) -> HashMap<PathBuf, String> {
    let home = crate::fsnav::home_dir();
    let panes: Vec<(String, u32, String)> = {
        let sessions = bridge.sessions().await;
        sessions.iter().map(|(uid, s)| (uid.clone(), s.pid, s.cwd.clone())).collect()
    };
    // Folder → every pane that qualifies for it right now.
    let mut claims: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for (uid, pid, cwd) in panes {
        let Some(folder) = watchable_folder(&cwd, &home) else { continue };
        if pid == 0 {
            continue;
        }
        let token = bridge.classification_for(&uid).await
            .and_then(|c| c.classification.agent_token().map(str::to_string));
        if should_watch(token.as_deref()) {
            claims.entry(folder).or_default().push(uid);
        }
    }
    claims.into_iter().map(|(folder, mut uids)| {
        let owner = pick_owner(owners.get(&folder).map(String::as_str), &mut uids);
        (folder, owner)
    }).collect()
}

/// The current owner keeps a shared folder while it still qualifies;
/// otherwise the lowest uid, so the choice is stable between scans.
pub(crate) fn pick_owner(current: Option<&str>, candidates: &mut [String]) -> String {
    if let Some(c) = current.filter(|c| candidates.iter().any(|u| u == c)) {
        return c.to_string();
    }
    candidates.sort();
    candidates[0].clone()
}

/// Start the watcher loop. Call once at startup.
pub fn spawn(bridge: Bridge, telemetry: TelemetryStore) {
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, PathBuf, Raw)>();
    tokio::spawn(async move {
        let mut watchers: HashMap<PathBuf, (String, notify::RecommendedWatcher)> = HashMap::new();
        let mut coalescer = Coalescer::new();
        let mut sizes: HashMap<PathBuf, u64> = HashMap::new();
        let mut scan_tick = tokio::time::interval(SCAN_EVERY);
        let mut flush_tick = tokio::time::interval(FLUSH_EVERY);
        loop {
            tokio::select! {
                _ = scan_tick.tick() => {
                    let owners: HashMap<PathBuf, String> = watchers.iter().map(|(f, (p, _))| (f.clone(), p.clone())).collect();
                    let wanted = scan(&bridge, &owners).await;
                    watchers.retain(|folder, (pane, _)| wanted.get(folder) == Some(pane));
                    for (folder, pane) in wanted {
                        if watchers.contains_key(&folder) {
                            continue;
                        }
                        match start_watch(&folder, &pane, tx.clone()) {
                            Ok(w) => {
                                tracing::info!("host telemetry: watching {} for pane {pane}", folder.display());
                                watchers.insert(folder, (pane, w));
                            }
                            Err(e) => tracing::warn!("host telemetry: can't watch {}: {e}", folder.display()),
                        }
                    }
                }
                _ = flush_tick.tick() => {
                    let known = |p: &Path| sizes.contains_key(p);
                    let changes = coalescer.flush(Instant::now(), |p| p.exists(), known);
                    for c in changes {
                        report(&telemetry, &mut sizes, c);
                    }
                }
                Some((pane, path, raw)) = rx.recv() => {
                    coalescer.push(&pane, path, raw, Instant::now());
                }
            }
        }
    });
}

fn start_watch(folder: &Path, pane: &str, tx: mpsc::UnboundedSender<(String, PathBuf, Raw)>) -> notify::Result<notify::RecommendedWatcher> {
    let root = folder.to_path_buf();
    let pane = pane.to_string();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        let Some(raw) = raw_kind(&ev.kind) else { return };
        for path in ev.paths {
            if !excluded(&root, &path) {
                let _ = tx.send((pane.clone(), path, raw));
            }
        }
    })?;
    w.watch(folder, RecursiveMode::Recursive)?;
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn a_shared_folder_keeps_its_first_owner() {
        let mut c = vec!["b".to_string(), "a".to_string()];
        assert_eq!(pick_owner(Some("b"), &mut c), "b", "current owner still qualifies");
        assert_eq!(pick_owner(Some("gone"), &mut c), "a", "owner left: lowest uid");
        assert_eq!(pick_owner(None, &mut c), "a");
    }

    #[test]
    fn only_host_agents_are_watched() {
        assert!(should_watch(Some("claude")));
        assert!(should_watch(Some("agy")));
        assert!(!should_watch(None), "not an agent (a bare docker foreground classifies as none)");
        assert!(!should_watch(Some("n8")), "n8 container pane");
        assert!(!should_watch(Some("nemesis8")));
    }

    #[test]
    fn home_root_and_shallow_folders_are_not_watched() {
        let tmp = std::env::temp_dir().join(format!("hy-watch-{}", std::process::id()));
        let proj = tmp.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let home = tmp.clone();
        assert_eq!(watchable_folder(proj.to_str().unwrap(), &home), Some(proj.clone()));
        assert_eq!(watchable_folder(home.to_str().unwrap(), &home), None, "home itself");
        assert_eq!(watchable_folder("", &home), None);
        assert_eq!(watchable_folder(if cfg!(windows) { "C:\\" } else { "/" }, &home), None, "root");
        assert_eq!(watchable_folder(proj.join("missing").to_str().unwrap(), &home), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn build_output_vcs_and_temp_files_are_excluded() {
        let root = Path::new("/w/proj");
        for p in ["/w/proj/target", "/w/proj/.git/index", "/w/proj/target/debug/x", "/w/proj/a/node_modules/m/i.js", "/w/proj/.venv/lib/x.py",
            "/w/proj/src/main.rs.tmp", "/w/proj/notes.swp", "/w/proj/x.txt~", "/w/proj/Cargo.nutstmp94", "/w/proj/.cache/f"] {
            assert!(excluded(root, Path::new(p)), "{p} should be excluded");
        }
        for p in ["/w/proj/src/main.rs", "/w/proj/.env", "/w/proj/README.md", "/w/proj/crates/a/src/lib.rs"] {
            assert!(!excluded(root, Path::new(p)), "{p} should be kept");
        }
    }

    #[test]
    fn raw_events_coalesce_to_one_change_per_path() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        let p = PathBuf::from("/w/proj/a.rs");
        for raw in [Raw::Create, Raw::Modify, Raw::Modify, Raw::Modify] {
            c.push("pane", p.clone(), raw, t0);
        }
        assert!(c.flush(t0 + Duration::from_millis(100), |_| true, |_| false).is_empty(), "not settled yet");
        let out = c.flush(t0 + SETTLE, |_| true, |_| false);
        assert_eq!(out, vec![Change { pane: "pane".into(), path: p.clone(), detail: "created" }]);
        // A plain save of a known file is "modified"; a delete is "removed".
        c.push("pane", p.clone(), Raw::Modify, t0);
        assert_eq!(c.flush(t0 + SETTLE, |_| true, |_| true)[0].detail, "modified");
        c.push("pane", p.clone(), Raw::Remove, t0);
        assert_eq!(c.flush(t0 + SETTLE, |_| false, |_| true)[0].detail, "removed");
        // Created and gone within the window, never seen before: nothing.
        c.push("pane", p.clone(), Raw::Create, t0);
        assert!(c.flush(t0 + SETTLE, |_| false, |_| false).is_empty());
    }

    #[test]
    fn raw_kinds_map_from_notify() {
        use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
        assert_eq!(raw_kind(&EventKind::Create(CreateKind::File)), Some(Raw::Create));
        assert_eq!(raw_kind(&EventKind::Modify(ModifyKind::Data(DataChange::Content))), Some(Raw::Modify));
        assert_eq!(raw_kind(&EventKind::Remove(RemoveKind::File)), Some(Raw::Remove));
        assert_eq!(raw_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::From))), Some(Raw::Remove));
        assert_eq!(raw_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::To))), Some(Raw::Create));
        assert_eq!(raw_kind(&EventKind::Access(notify::event::AccessKind::Read)), None);
    }

    #[test]
    fn per_pane_cap_limits_a_flood() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        for i in 0..(CAP_EVENTS + 50) {
            c.push("busy", PathBuf::from(format!("/w/proj/f{i}")), Raw::Modify, t0);
        }
        c.push("quiet", PathBuf::from("/w/other/x"), Raw::Modify, t0);
        let out = c.flush(t0 + SETTLE, |_| true, |_| true);
        assert_eq!(out.iter().filter(|c| c.pane == "busy").count(), CAP_EVENTS);
        assert_eq!(out.iter().filter(|c| c.pane == "quiet").count(), 1, "other panes aren't starved");
    }

    #[test]
    fn real_watch_on_a_temp_folder_reports_a_save() {
        let tmp = std::env::temp_dir().join(format!("hy-watch-real-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("src")).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _w = start_watch(&tmp, "pane", tx).expect("watch");
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(tmp.join("src").join("lib.rs"), b"fn x() {}").unwrap();
        std::fs::create_dir_all(tmp.join("target")).unwrap();
        std::fs::write(tmp.join("target").join("junk.o"), b"x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen: HashSet<PathBuf> = HashSet::new();
        while Instant::now() < deadline {
            while let Ok((_, p, _)) = rx.try_recv() {
                seen.insert(p);
            }
            if seen.iter().any(|p| p.ends_with("lib.rs")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(seen.iter().any(|p| p.ends_with("lib.rs")), "save under src/ is reported: {seen:?}");
        assert!(!seen.iter().any(|p| p.components().any(|c| c.as_os_str() == "target")), "target/ is excluded: {seen:?}");
        drop(_w);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
