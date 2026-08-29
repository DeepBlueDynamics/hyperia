//! Named workspaces — the pure data layer (epic #146, chunk 1: #167).
//!
//! A workspace is a versioned JSON snapshot of the whole app: one entry per
//! window, each carrying its OS geometry plus the renderer's layout blob
//! (term groups, sessions, web panes). Files live one-per-workspace at
//! `~/.hyperia/workspaces/<name>.json` and are written atomically via
//! [`crate::util::write_json_file_atomic`].
//!
//! This module owns file I/O, naming rules, and validation. It never talks to
//! Electron — capture and restore round-trips live in the HTTP layer
//! (`main.rs`) and the bridge. Every function takes the workspace directory as
//! a parameter so tests run against a tempdir.
//!
//! Safety invariants established here (see `docs/workspace-format.md`, chunk 3):
//! - `layout.sessions` entries never carry a `pid` (a restored PTY is a fresh
//!   process; a stale pid is an invitation to signal the wrong one).
//! - The scraped last command lives only at `annotations.lastCommand` —
//!   display-only metadata; restore never executes it.

use serde::{Deserialize, Serialize};

/// Discriminator for workspace files. A file without it is not a workspace.
pub const WORKSPACE_KIND: &str = "hyperia-workspace";
/// Highest schema version this build reads and writes.
pub const SCHEMA_VERSION: u32 = 1;
/// Names longer than this are rejected (they're filenames).
pub const MAX_NAME_LEN: usize = 100;

// ---------------------------------------------------------------------------
// Schema (v1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub kind: String,
    pub schema_version: u32,
    pub name: String,
    /// RFC3339 UTC timestamp of the save.
    pub saved_at: String,
    /// Hyperia version that wrote the file (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    pub windows: Vec<WorkspaceWindow>,
    /// Sticky-note references. Reserved in v1; populated by chunk 4 (#170).
    /// Content stays canonical in `~/.hyperia/stickys/notes.json` — a
    /// workspace only records ids and positions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stickys: Option<Vec<StickyRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWindow {
    pub geometry: Geometry,
    /// The renderer's layout blob: `{activeUid, activeRootGroup,
    /// activeTermGroup, activeSessions, termGroups, sessions}`. Kept as an
    /// opaque value — the renderer owns that schema — but structurally
    /// validated by [`validate`].
    pub layout: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_id: Option<serde_json::Value>,
    #[serde(default)]
    pub is_maximized: bool,
    #[serde(default)]
    pub is_full_screen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StickyRef {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub open: bool,
}

/// One row of `list()` output.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub name: String,
    pub saved_at: String,
    pub windows: usize,
    pub panes: usize,
    pub web_panes: usize,
    pub valid: bool,
    /// Present only when `valid` is false — why the file didn't parse.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum WorkspaceError {
    InvalidName(String),
    NotFound(String),
    AlreadyExists(String),
    /// The file exists but isn't a valid workspace (parse or validation).
    Corrupt(String),
    /// `kind` is present but isn't [`WORKSPACE_KIND`].
    WrongKind(String),
    /// Written by a newer Hyperia; refuse rather than guess.
    NewerThanSupported(u32),
    Io(String),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkspaceError::InvalidName(r) => write!(f, "invalid workspace name: {r}"),
            WorkspaceError::NotFound(n) => write!(f, "no workspace named '{n}'"),
            WorkspaceError::AlreadyExists(n) => {
                write!(f, "workspace '{n}' already exists (pass overwrite to replace it)")
            }
            WorkspaceError::Corrupt(r) => write!(f, "corrupt workspace file: {r}"),
            WorkspaceError::WrongKind(k) => {
                write!(f, "not a hyperia-workspace file (kind: '{k}')")
            }
            WorkspaceError::NewerThanSupported(v) => write!(
                f,
                "workspace schemaVersion {v} is newer than this Hyperia supports (max {SCHEMA_VERSION}) — update Hyperia to open it"
            ),
            WorkspaceError::Io(e) => write!(f, "workspace I/O error: {e}"),
        }
    }
}

impl From<std::io::Error> for WorkspaceError {
    fn from(e: std::io::Error) -> Self {
        WorkspaceError::Io(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Names & paths
// ---------------------------------------------------------------------------

/// Validate a user-supplied workspace name and return it trimmed.
///
/// Names become filenames, so anything that could escape the workspaces
/// directory or confuse a filesystem is rejected rather than escaped — the
/// name the user typed is the name they see in `list`.
pub fn sanitize_name(name: &str) -> Result<String, WorkspaceError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::InvalidName("name is empty".into()));
    }
    if trimmed.len() > MAX_NAME_LEN {
        return Err(WorkspaceError::InvalidName(format!(
            "name is longer than {MAX_NAME_LEN} characters"
        )));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(WorkspaceError::InvalidName("name must not be '.' or '..'".into()));
    }
    if trimmed.contains(['/', '\\', '\0']) {
        return Err(WorkspaceError::InvalidName(
            "name must not contain path separators".into(),
        ));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(WorkspaceError::InvalidName(
            "name must not contain control characters".into(),
        ));
    }
    // Windows-reserved characters; rejected on every platform so a workspace
    // saved on Linux still exports to a Windows box.
    if trimmed.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err(WorkspaceError::InvalidName(
            "name must not contain any of < > : \" | ? *".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// The default on-disk workspace directory: `~/.hyperia/workspaces`.
pub fn default_workspaces_dir() -> Option<std::path::PathBuf> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    home.map(|h| std::path::PathBuf::from(h).join(".hyperia").join("workspaces"))
}

fn file_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    dir.join(format!("{name}.json"))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Structural validation of a workspace value beyond serde's shape check.
pub fn validate(ws: &WorkspaceFile) -> Result<(), WorkspaceError> {
    if ws.kind != WORKSPACE_KIND {
        return Err(WorkspaceError::WrongKind(ws.kind.clone()));
    }
    if ws.schema_version > SCHEMA_VERSION {
        return Err(WorkspaceError::NewerThanSupported(ws.schema_version));
    }
    if ws.schema_version == 0 {
        return Err(WorkspaceError::Corrupt("schemaVersion 0 is not valid".into()));
    }
    sanitize_name(&ws.name)?;
    if ws.windows.is_empty() {
        return Err(WorkspaceError::Corrupt("workspace has no windows".into()));
    }
    for (i, w) in ws.windows.iter().enumerate() {
        let layout = w
            .layout
            .as_object()
            .ok_or_else(|| WorkspaceError::Corrupt(format!("windows[{i}].layout is not an object")))?;
        for key in ["termGroups", "sessions"] {
            if !layout.get(key).map(|v| v.is_object()).unwrap_or(false) {
                return Err(WorkspaceError::Corrupt(format!(
                    "windows[{i}].layout.{key} is missing or not an object"
                )));
            }
        }
        if let Some(sessions) = layout.get("sessions").and_then(|v| v.as_object()) {
            for (uid, s) in sessions {
                if s.get("pid").is_some() {
                    return Err(WorkspaceError::Corrupt(format!(
                        "windows[{i}].layout.sessions.{uid} carries a pid — workspace files must not (strip it at capture)"
                    )));
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// Assemble and persist a workspace from captured window snapshots.
///
/// `windows` is what the Electron capture round-trip produced (geometry +
/// layout per window). Validation runs on the assembled file BEFORE anything
/// touches disk; the write itself is atomic.
pub fn save(
    dir: &std::path::Path,
    name: &str,
    windows: Vec<WorkspaceWindow>,
    app_version: Option<String>,
    overwrite: bool,
) -> Result<WorkspaceFile, WorkspaceError> {
    let name = sanitize_name(name)?;
    let path = file_path(dir, &name);
    if path.exists() && !overwrite {
        return Err(WorkspaceError::AlreadyExists(name));
    }
    let ws = WorkspaceFile {
        kind: WORKSPACE_KIND.to_string(),
        schema_version: SCHEMA_VERSION,
        name: name.clone(),
        saved_at: now_rfc3339(),
        app_version,
        windows,
        stickys: None,
    };
    validate(&ws)?;
    let value = serde_json::to_value(&ws)
        .map_err(|e| WorkspaceError::Io(format!("serialize failed: {e}")))?;
    crate::util::write_json_file_atomic(&path, &value)?;
    Ok(ws)
}

/// List every `*.json` in the directory, newest save first. Files that fail to
/// parse still show up, flagged `valid: false` — a corrupt workspace is
/// surfaced, never hidden or deleted.
pub fn list(dir: &std::path::Path) -> Result<Vec<WorkspaceSummary>, WorkspaceError> {
    let mut out: Vec<WorkspaceSummary> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        // No directory yet just means no workspaces saved yet.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        match read_and_validate(&path) {
            Ok(ws) => {
                let (panes, web_panes) = count_panes(&ws);
                out.push(WorkspaceSummary {
                    name: stem,
                    saved_at: ws.saved_at,
                    windows: ws.windows.len(),
                    panes,
                    web_panes,
                    valid: true,
                    error: None,
                });
            }
            Err(err) => out.push(WorkspaceSummary {
                name: stem,
                saved_at: String::new(),
                windows: 0,
                panes: 0,
                web_panes: 0,
                valid: false,
                error: Some(err.to_string()),
            }),
        }
    }
    // Newest first; invalid rows (empty savedAt) sink to the bottom.
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

/// Delete a saved workspace. The name is sanitized so this can only ever
/// remove a file inside `dir`.
pub fn delete(dir: &std::path::Path, name: &str) -> Result<(), WorkspaceError> {
    let name = sanitize_name(name)?;
    let path = file_path(dir, &name);
    if !path.exists() {
        return Err(WorkspaceError::NotFound(name));
    }
    std::fs::remove_file(&path)?;
    Ok(())
}

/// Rename a saved workspace: rewrite the `name` field and move the file
/// atomically. Refuses to clobber an existing target unless `overwrite`.
pub fn rename(
    dir: &std::path::Path,
    from: &str,
    to: &str,
    overwrite: bool,
) -> Result<(), WorkspaceError> {
    let from = sanitize_name(from)?;
    let to = sanitize_name(to)?;
    let from_path = file_path(dir, &from);
    let to_path = file_path(dir, &to);
    if !from_path.exists() {
        return Err(WorkspaceError::NotFound(from));
    }
    if from == to {
        return Ok(());
    }
    if to_path.exists() && !overwrite {
        return Err(WorkspaceError::AlreadyExists(to));
    }
    let mut ws = read_and_validate(&from_path)?;
    ws.name = to.clone();
    let value = serde_json::to_value(&ws)
        .map_err(|e| WorkspaceError::Io(format!("serialize failed: {e}")))?;
    // Write the new file first, remove the old only on success — a crash in
    // between leaves both, never neither.
    crate::util::write_json_file_atomic(&to_path, &value)?;
    std::fs::remove_file(&from_path)?;
    Ok(())
}

/// Load one saved workspace by name, with typed errors: `NotFound`,
/// `Corrupt`, `WrongKind`, `NewerThanSupported`.
pub fn load_workspace(dir: &std::path::Path, name: &str) -> Result<WorkspaceFile, WorkspaceError> {
    let name = sanitize_name(name)?;
    let path = file_path(dir, &name);
    if !path.exists() {
        return Err(WorkspaceError::NotFound(name));
    }
    read_and_validate(&path)
}

// ---------------------------------------------------------------------------
// Preview (chunk 2: #168) — what would restore do, computed without touching
// Electron. cwd existence via the injected checker (std::fs in production,
// a closure in tests); profiles against the names the config file declares.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewIssue {
    /// "missing-cwd" | "unknown-profile" (more kinds in later chunks).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_uid: Option<String>,
    pub value: String,
    pub resolution: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReport {
    pub name: String,
    pub schema_version: u32,
    pub saved_at: String,
    pub windows: usize,
    pub panes: usize,
    pub web_panes: usize,
    pub stickys: usize,
    pub issues: Vec<PreviewIssue>,
}

/// Compute a restore preview. `known_profiles` is the set of profile names the
/// config declares — pass `None` when the config lists no profiles at all
/// (Electron auto-detects shells at startup, so an empty config can't prove a
/// profile unknown; restore still falls back loudly if one turns out missing).
pub fn preview(
    ws: &WorkspaceFile,
    known_profiles: Option<&std::collections::HashSet<String>>,
    dir_exists: impl Fn(&str) -> bool,
) -> PreviewReport {
    let (panes, web_panes) = count_panes(ws);
    let mut issues = Vec::new();
    for w in &ws.windows {
        let sessions = match w.layout.get("sessions").and_then(|v| v.as_object()) {
            Some(s) => s,
            None => continue,
        };
        for (uid, s) in sessions {
            if let Some(cwd) = s.get("cwd").and_then(|c| c.as_str()) {
                if !cwd.is_empty() && !dir_exists(cwd) {
                    issues.push(PreviewIssue {
                        kind: "missing-cwd".into(),
                        session_uid: Some(uid.clone()),
                        value: cwd.to_string(),
                        resolution: "will open in the home directory".into(),
                    });
                }
            }
            if let (Some(profiles), Some(profile)) =
                (known_profiles, s.get("profile").and_then(|p| p.as_str()))
            {
                if !profile.is_empty() && !profiles.contains(profile) {
                    issues.push(PreviewIssue {
                        kind: "unknown-profile".into(),
                        session_uid: Some(uid.clone()),
                        value: profile.to_string(),
                        resolution: "will use the default shell if unavailable".into(),
                    });
                }
            }
        }
    }
    PreviewReport {
        name: ws.name.clone(),
        schema_version: ws.schema_version,
        saved_at: ws.saved_at.clone(),
        windows: ws.windows.len(),
        panes,
        web_panes,
        stickys: ws.stickys.as_ref().map(|s| s.len()).unwrap_or(0),
        issues,
    }
}

/// Production preview: cwd checks against the real filesystem.
pub fn preview_fs(
    ws: &WorkspaceFile,
    known_profiles: Option<&std::collections::HashSet<String>>,
) -> PreviewReport {
    preview(ws, known_profiles, |cwd| std::path::Path::new(cwd).is_dir())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn read_and_validate(path: &std::path::Path) -> Result<WorkspaceFile, WorkspaceError> {
    let content = std::fs::read_to_string(path)?;
    // Distinguish "wrong kind" from "unparseable" for better list/error rows.
    let raw: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| WorkspaceError::Corrupt(format!("not valid JSON: {e}")))?;
    match raw.get("kind").and_then(|k| k.as_str()) {
        Some(k) if k == WORKSPACE_KIND => {}
        Some(k) => return Err(WorkspaceError::WrongKind(k.to_string())),
        None => return Err(WorkspaceError::Corrupt("missing 'kind' field".into())),
    }
    if let Some(v) = raw.get("schemaVersion").and_then(|v| v.as_u64()) {
        if v as u32 > SCHEMA_VERSION {
            return Err(WorkspaceError::NewerThanSupported(v as u32));
        }
    }
    let ws: WorkspaceFile = serde_json::from_value(raw)
        .map_err(|e| WorkspaceError::Corrupt(format!("schema mismatch: {e}")))?;
    validate(&ws)?;
    Ok(ws)
}

fn count_panes(ws: &WorkspaceFile) -> (usize, usize) {
    let mut panes = 0usize;
    let mut web_panes = 0usize;
    for w in &ws.windows {
        if let Some(groups) = w.layout.get("termGroups").and_then(|v| v.as_object()) {
            for g in groups.values() {
                let is_leaf = g
                    .get("children")
                    .and_then(|c| c.as_array())
                    .map(|c| c.is_empty())
                    .unwrap_or(true);
                if !is_leaf {
                    continue;
                }
                if g.get("webUrl").map(|u| !u.is_null()).unwrap_or(false) {
                    web_panes += 1;
                } else {
                    panes += 1;
                }
            }
        }
    }
    (panes, web_panes)
}

fn now_rfc3339() -> String {
    // Seconds precision is plenty for a save timestamp; avoids a chrono dep.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_rfc3339(secs)
}

/// Minimal UTC formatter (proleptic Gregorian, valid for the epoch range we
/// care about).
fn epoch_to_rfc3339(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hyperia-workspace-test-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_layout() -> serde_json::Value {
        serde_json::json!({
            "activeUid": "s1",
            "activeRootGroup": "g1",
            "activeTermGroup": "g1",
            "activeSessions": {"g1": "s1"},
            "termGroups": {
                "g1": {"uid": "g1", "sessionUid": "s1", "parentUid": null,
                        "direction": null, "sizes": null, "children": [],
                        "webUrl": null, "webName": null, "tabName": "work"},
                "g2": {"uid": "g2", "sessionUid": null, "parentUid": null,
                        "direction": null, "sizes": null, "children": [],
                        "webUrl": "https://example.com", "webName": "ex", "tabName": null}
            },
            "sessions": {
                "s1": {"uid": "s1", "title": "zsh", "cwd": "/home/x", "profile": "zsh",
                        "shell": "/bin/zsh", "cols": 80, "rows": 24,
                        "annotations": {"lastCommand": "vim ."}}
            }
        })
    }

    fn sample_window() -> WorkspaceWindow {
        WorkspaceWindow {
            geometry: Geometry {
                x: 10,
                y: 20,
                width: 1400,
                height: 800,
                display_id: Some(serde_json::json!(60)),
                is_maximized: false,
                is_full_screen: false,
            },
            layout: sample_layout(),
        }
    }

    // ---- names -------------------------------------------------------------

    #[test]
    fn sanitize_accepts_ordinary_names() {
        for ok in ["deploy-day", "My Workspace 2", "a.b_c", "日本語"] {
            assert!(sanitize_name(ok).is_ok(), "should accept {ok:?}");
        }
        assert_eq!(sanitize_name("  padded  ").unwrap(), "padded");
    }

    #[test]
    fn sanitize_rejects_path_escapes_and_junk() {
        for bad in [
            "", " ", "..", ".", "../evil", "a/b", "a\\b", "nul\0byte", "tab\tname",
            "win<dows", "q?mark", "co:lon",
        ] {
            assert!(sanitize_name(bad).is_err(), "should reject {bad:?}");
        }
        assert!(sanitize_name(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
    }

    // ---- save / round-trip -------------------------------------------------

    #[test]
    fn save_then_read_round_trips() {
        let dir = tempdir();
        let ws = save(&dir, "demo", vec![sample_window()], Some("0.17.50".into()), false).unwrap();
        assert_eq!(ws.kind, WORKSPACE_KIND);
        assert_eq!(ws.schema_version, SCHEMA_VERSION);
        let read = read_and_validate(&dir.join("demo.json")).unwrap();
        assert_eq!(read, ws);
        // camelCase on disk
        let raw = std::fs::read_to_string(dir.join("demo.json")).unwrap();
        assert!(raw.contains("\"schemaVersion\": 1"));
        assert!(raw.contains("\"savedAt\""));
        assert!(!raw.contains("saved_at"));
    }

    #[test]
    fn save_refuses_overwrite_unless_flagged() {
        let dir = tempdir();
        save(&dir, "demo", vec![sample_window()], None, false).unwrap();
        let err = save(&dir, "demo", vec![sample_window()], None, false).unwrap_err();
        assert!(matches!(err, WorkspaceError::AlreadyExists(_)));
        save(&dir, "demo", vec![sample_window()], None, true).unwrap();
    }

    #[test]
    fn save_rejects_pid_in_sessions() {
        let dir = tempdir();
        let mut w = sample_window();
        w.layout["sessions"]["s1"]["pid"] = serde_json::json!(4242);
        let err = save(&dir, "demo", vec![w], None, false).unwrap_err();
        assert!(matches!(err, WorkspaceError::Corrupt(_)), "got {err:?}");
        assert!(!dir.join("demo.json").exists(), "nothing written on validation failure");
    }

    #[test]
    fn save_rejects_empty_and_malformed() {
        let dir = tempdir();
        assert!(matches!(
            save(&dir, "demo", vec![], None, false).unwrap_err(),
            WorkspaceError::Corrupt(_)
        ));
        let mut w = sample_window();
        w.layout = serde_json::json!({"termGroups": {}});
        assert!(matches!(
            save(&dir, "demo", vec![w], None, false).unwrap_err(),
            WorkspaceError::Corrupt(_)
        ));
    }

    // ---- list --------------------------------------------------------------

    #[test]
    fn list_empty_and_missing_dir() {
        let dir = tempdir();
        assert!(list(&dir).unwrap().is_empty());
        assert!(list(&dir.join("nonexistent")).unwrap().is_empty());
    }

    #[test]
    fn list_counts_and_flags_invalid() {
        let dir = tempdir();
        save(&dir, "good", vec![sample_window()], None, false).unwrap();
        std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
        std::fs::write(
            dir.join("other.json"),
            r#"{"kind": "something-else", "schemaVersion": 1}"#,
        )
        .unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();

        let rows = list(&dir).unwrap();
        assert_eq!(rows.len(), 3);
        let good = rows.iter().find(|r| r.name == "good").unwrap();
        assert!(good.valid);
        assert_eq!(good.windows, 1);
        assert_eq!(good.panes, 1);
        assert_eq!(good.web_panes, 1);
        let broken = rows.iter().find(|r| r.name == "broken").unwrap();
        assert!(!broken.valid);
        assert!(broken.error.as_deref().unwrap().contains("not valid JSON"));
        let other = rows.iter().find(|r| r.name == "other").unwrap();
        assert!(!other.valid);
        assert!(other.error.as_deref().unwrap().contains("something-else"));
    }

    #[test]
    fn list_newest_first() {
        let dir = tempdir();
        let mut a = save(&dir, "older", vec![sample_window()], None, false).unwrap();
        // Force distinct timestamps without sleeping.
        a.saved_at = "2020-01-01T00:00:00Z".into();
        crate::util::write_json_file_atomic(
            &dir.join("older.json"),
            &serde_json::to_value(&a).unwrap(),
        )
        .unwrap();
        save(&dir, "newer", vec![sample_window()], None, false).unwrap();
        let rows = list(&dir).unwrap();
        assert_eq!(rows[0].name, "newer");
        assert_eq!(rows[1].name, "older");
    }

    // ---- delete / rename ---------------------------------------------------

    #[test]
    fn delete_and_missing() {
        let dir = tempdir();
        save(&dir, "demo", vec![sample_window()], None, false).unwrap();
        delete(&dir, "demo").unwrap();
        assert!(!dir.join("demo.json").exists());
        assert!(matches!(delete(&dir, "demo").unwrap_err(), WorkspaceError::NotFound(_)));
        assert!(matches!(delete(&dir, "../evil").unwrap_err(), WorkspaceError::InvalidName(_)));
    }

    #[test]
    fn rename_moves_and_rewrites_name() {
        let dir = tempdir();
        save(&dir, "old", vec![sample_window()], None, false).unwrap();
        rename(&dir, "old", "new", false).unwrap();
        assert!(!dir.join("old.json").exists());
        let ws = read_and_validate(&dir.join("new.json")).unwrap();
        assert_eq!(ws.name, "new");
    }

    #[test]
    fn rename_collision_and_noop() {
        let dir = tempdir();
        save(&dir, "a", vec![sample_window()], None, false).unwrap();
        save(&dir, "b", vec![sample_window()], None, false).unwrap();
        assert!(matches!(
            rename(&dir, "a", "b", false).unwrap_err(),
            WorkspaceError::AlreadyExists(_)
        ));
        rename(&dir, "a", "b", true).unwrap();
        assert!(!dir.join("a.json").exists());
        // Renaming to itself is a no-op, not an error.
        rename(&dir, "b", "b", false).unwrap();
        assert!(matches!(rename(&dir, "ghost", "x", false).unwrap_err(), WorkspaceError::NotFound(_)));
    }

    // ---- load / preview ----------------------------------------------------

    #[test]
    fn load_workspace_typed_errors() {
        let dir = tempdir();
        assert!(matches!(
            load_workspace(&dir, "ghost").unwrap_err(),
            WorkspaceError::NotFound(_)
        ));
        assert!(matches!(
            load_workspace(&dir, "../evil").unwrap_err(),
            WorkspaceError::InvalidName(_)
        ));
        save(&dir, "demo", vec![sample_window()], None, false).unwrap();
        assert_eq!(load_workspace(&dir, "demo").unwrap().name, "demo");
        std::fs::write(dir.join("trunc.json"), "{\"kind\": \"hyperia-worksp").unwrap();
        assert!(matches!(
            load_workspace(&dir, "trunc").unwrap_err(),
            WorkspaceError::Corrupt(_)
        ));
    }

    #[test]
    fn preview_clean_workspace_has_no_issues() {
        let ws = WorkspaceFile {
            kind: WORKSPACE_KIND.into(),
            schema_version: SCHEMA_VERSION,
            name: "demo".into(),
            saved_at: "2026-08-28T00:00:00Z".into(),
            app_version: None,
            windows: vec![sample_window()],
            stickys: None,
        };
        let profiles: std::collections::HashSet<String> = ["zsh".to_string()].into();
        let report = preview(&ws, Some(&profiles), |_| true);
        assert_eq!(report.windows, 1);
        assert_eq!(report.panes, 1);
        assert_eq!(report.web_panes, 1);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn preview_flags_missing_cwd_and_unknown_profile() {
        let ws = WorkspaceFile {
            kind: WORKSPACE_KIND.into(),
            schema_version: SCHEMA_VERSION,
            name: "demo".into(),
            saved_at: "2026-08-28T00:00:00Z".into(),
            app_version: None,
            windows: vec![sample_window()],
            stickys: None,
        };
        let profiles: std::collections::HashSet<String> = ["bash".to_string()].into();
        let report = preview(&ws, Some(&profiles), |_| false);
        let kinds: Vec<&str> = report.issues.iter().map(|i| i.kind.as_str()).collect();
        assert!(kinds.contains(&"missing-cwd"));
        assert!(kinds.contains(&"unknown-profile"));
        let cwd_issue = report.issues.iter().find(|i| i.kind == "missing-cwd").unwrap();
        assert_eq!(cwd_issue.value, "/home/x");
        assert_eq!(cwd_issue.session_uid.as_deref(), Some("s1"));
    }

    #[test]
    fn preview_skips_profile_check_without_config_profiles() {
        // Electron auto-detects shells; an empty config can't prove a profile
        // unknown, so None disables that check entirely.
        let ws = WorkspaceFile {
            kind: WORKSPACE_KIND.into(),
            schema_version: SCHEMA_VERSION,
            name: "demo".into(),
            saved_at: "2026-08-28T00:00:00Z".into(),
            app_version: None,
            windows: vec![sample_window()],
            stickys: None,
        };
        let report = preview(&ws, None, |_| true);
        assert!(report.issues.is_empty());
    }

    // ---- version gates -----------------------------------------------------

    #[test]
    fn future_version_refused() {
        let dir = tempdir();
        let ws = save(&dir, "demo", vec![sample_window()], None, false).unwrap();
        let mut v = serde_json::to_value(&ws).unwrap();
        v["schemaVersion"] = serde_json::json!(99);
        crate::util::write_json_file_atomic(&dir.join("future.json"), &v).unwrap();
        let err = read_and_validate(&dir.join("future.json")).unwrap_err();
        assert!(matches!(err, WorkspaceError::NewerThanSupported(99)));
        // list surfaces it as invalid rather than hiding it
        let rows = list(&dir).unwrap();
        let f = rows.iter().find(|r| r.name == "future").unwrap();
        assert!(!f.valid);
    }

    #[test]
    fn timestamp_is_rfc3339ish() {
        let s = now_rfc3339();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.ends_with('Z'));
        assert_eq!(epoch_to_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(epoch_to_rfc3339(1_756_400_000), "2025-08-28T16:53:20Z");
        assert_eq!(epoch_to_rfc3339(1_787_936_000), "2026-08-28T16:53:20Z");
    }
}
