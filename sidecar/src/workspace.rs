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
    stickys: Option<Vec<StickyRef>>,
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
        stickys: stickys.filter(|s| !s.is_empty()),
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
    existing_sticky_ids: Option<&std::collections::HashSet<String>>,
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
                // 'picker' is the internal new-pane chooser, not a config
                // profile — a pane saved mid-choose restores as the chooser
                // again, nothing to warn about.
                if !profile.is_empty() && profile != "picker" && !profiles.contains(profile) {
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
    // Sticky refs point into ~/.hyperia/stickys/notes.json by id; a note the
    // user has since deleted is skipped at restore, and preview says so.
    // `None` = the notes file was unreadable, so absence can't be proven.
    if let (Some(ids), Some(refs)) = (existing_sticky_ids, ws.stickys.as_ref()) {
        for r in refs {
            if !ids.contains(&r.id) {
                issues.push(PreviewIssue {
                    kind: "missing-sticky".into(),
                    session_uid: None,
                    value: r.id.clone(),
                    resolution: "skipped (note no longer exists)".into(),
                });
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

/// Production preview: cwd checks against the real filesystem, sticky ids
/// against ~/.hyperia/stickys/notes.json.
pub fn preview_fs(
    ws: &WorkspaceFile,
    known_profiles: Option<&std::collections::HashSet<String>>,
) -> PreviewReport {
    preview(ws, known_profiles, sticky_ids_fs().as_ref(), |cwd| {
        std::path::Path::new(cwd).is_dir()
    })
}

/// Note ids present in ~/.hyperia/stickys/notes.json. A missing file means "no
/// notes exist" (Some(empty) — refs will report missing); an unreadable or
/// unparseable file means "can't know" (None — the check is skipped).
pub fn sticky_ids_fs() -> Option<std::collections::HashSet<String>> {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Some(std::collections::HashSet::new())
        }
        Err(_) => return None,
    };
    let notes: Vec<serde_json::Value> = serde_json::from_str(&content).ok()?;
    Some(
        notes
            .iter()
            .filter_map(|n| n["id"].as_str().map(String::from))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Import / export / migration (chunk 3: #169)
//
// Export and import speak the same schema as the library files — an exported
// file IS a workspace file, so import ≈ migrate + validate + copy into the
// library. The migration chain also accepts the pre-workspace legacy shape
// (v0): the `savedLayoutState` blob Hyperia used to keep in hyperia.json.
// ---------------------------------------------------------------------------

/// What `migrate` needs beyond the raw value. Kept as a struct so migration
/// stays pure and testable — the HTTP layer fills in real-world defaults.
pub struct MigrateOpts {
    /// Name for files that don't carry one (the v0 blob has no name field).
    pub name_hint: String,
    /// Geometry for v0 blobs (they predate geometry capture). The caller may
    /// pass the last-known window rect from window-state.json.
    pub fallback_geometry: Geometry,
}

pub fn default_v0_geometry() -> Geometry {
    Geometry {
        x: 60,
        y: 60,
        width: 1200,
        height: 800,
        display_id: None,
        is_maximized: false,
        is_full_screen: false,
    }
}

/// Does this value look like the legacy `savedLayoutState` blob — the
/// pre-workspace single-window layout (no `kind`, but the renderer's
/// termGroups/sessions maps at top level)?
fn looks_like_v0_blob(v: &serde_json::Value) -> bool {
    v.get("kind").is_none()
        && v.get("termGroups").map(|t| t.is_object()).unwrap_or(false)
        && v.get("sessions").map(|s| s.is_object()).unwrap_or(false)
}

/// Bring an arbitrary parsed JSON value up to the current schema.
///
/// Accepted inputs, in order of detection:
/// - a current (v1) workspace file → validated as-is
/// - a future version → `NewerThanSupported` (refuse rather than guess)
/// - a legacy v0 `savedLayoutState` blob, bare or still wrapped in a
///   hyperia.json (`{"savedLayoutState": {…}}`) → adapted to v1: one window
///   with the fallback geometry, pids stripped, bare `lastCommand` demoted to
///   `annotations.lastCommand`
/// - anything else → `WrongKind` / `Corrupt`
pub fn migrate(raw: serde_json::Value, opts: &MigrateOpts) -> Result<WorkspaceFile, WorkspaceError> {
    match raw.get("kind").and_then(|k| k.as_str()) {
        Some(k) if k == WORKSPACE_KIND => {
            if let Some(v) = raw.get("schemaVersion").and_then(|v| v.as_u64()) {
                if v as u32 > SCHEMA_VERSION {
                    return Err(WorkspaceError::NewerThanSupported(v as u32));
                }
            }
            let ws: WorkspaceFile = serde_json::from_value(raw)
                .map_err(|e| WorkspaceError::Corrupt(format!("schema mismatch: {e}")))?;
            validate(&ws)?;
            return Ok(ws);
        }
        Some(k) => return Err(WorkspaceError::WrongKind(k.to_string())),
        None => {}
    }
    // No kind — v0 territory. Accept the blob bare or under savedLayoutState.
    let blob = if looks_like_v0_blob(&raw) {
        raw
    } else if raw.get("savedLayoutState").map(looks_like_v0_blob).unwrap_or(false) {
        raw["savedLayoutState"].clone()
    } else {
        return Err(WorkspaceError::Corrupt(
            "not a workspace file and not a legacy savedLayoutState blob".into(),
        ));
    };
    let ws = WorkspaceFile {
        kind: WORKSPACE_KIND.to_string(),
        schema_version: SCHEMA_VERSION,
        name: sanitize_name(&opts.name_hint)?,
        saved_at: now_rfc3339(),
        app_version: None,
        windows: vec![WorkspaceWindow {
            geometry: opts.fallback_geometry.clone(),
            layout: sanitize_v0_layout(blob),
        }],
        stickys: None,
    };
    validate(&ws)?;
    Ok(ws)
}

/// v0 → v1 layout cleanup: strip pids (workspace files must not carry them)
/// and fold a bare `lastCommand` into `annotations.lastCommand`.
fn sanitize_v0_layout(mut blob: serde_json::Value) -> serde_json::Value {
    if let Some(sessions) = blob.get_mut("sessions").and_then(|s| s.as_object_mut()) {
        for s in sessions.values_mut() {
            if let Some(obj) = s.as_object_mut() {
                obj.remove("pid");
                if let Some(last) = obj.remove("lastCommand") {
                    if last.as_str().map(|t| !t.is_empty()).unwrap_or(false) {
                        obj.entry("annotations")
                            .or_insert_with(|| serde_json::json!({}))
                            .as_object_mut()
                            .map(|a| a.insert("lastCommand".to_string(), last));
                    }
                }
            }
        }
    }
    blob
}

/// Export a saved workspace to an arbitrary destination path (validate, then
/// write atomically). The library file is the source of truth; the export is
/// a byte-equivalent copy of its re-serialized content.
pub fn export(
    dir: &std::path::Path,
    name: &str,
    dest: &std::path::Path,
    overwrite: bool,
) -> Result<WorkspaceFile, WorkspaceError> {
    let ws = load_workspace(dir, name)?;
    if dest.exists() && !overwrite {
        return Err(WorkspaceError::AlreadyExists(dest.to_string_lossy().into_owned()));
    }
    let value = serde_json::to_value(&ws)
        .map_err(|e| WorkspaceError::Io(format!("serialize failed: {e}")))?;
    crate::util::write_json_file_atomic(dest, &value)?;
    Ok(ws)
}

/// Import a workspace (or legacy blob) from an arbitrary source path into the
/// library: read → migrate → validate → atomic write. The source file is
/// NEVER modified or deleted, whatever happens.
pub fn import(
    dir: &std::path::Path,
    src: &std::path::Path,
    name: Option<&str>,
    overwrite: bool,
    fallback_geometry: Geometry,
) -> Result<(WorkspaceFile, bool), WorkspaceError> {
    let content = std::fs::read_to_string(src)?;
    let raw: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| WorkspaceError::Corrupt(format!("not valid JSON: {e}")))?;
    let was_v0 = raw.get("kind").is_none();
    // Name precedence: explicit > the file's own name field > source filename.
    let fallback_name = name
        .map(|n| n.to_string())
        .or_else(|| raw.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .or_else(|| src.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "imported".to_string());
    let mut ws = migrate(
        raw,
        &MigrateOpts {
            name_hint: fallback_name.clone(),
            fallback_geometry,
        },
    )?;
    let final_name = sanitize_name(name.unwrap_or(&ws.name))?;
    ws.name = final_name.clone();
    let path = file_path(dir, &final_name);
    if path.exists() && !overwrite {
        return Err(WorkspaceError::AlreadyExists(final_name));
    }
    let value = serde_json::to_value(&ws)
        .map_err(|e| WorkspaceError::Io(format!("serialize failed: {e}")))?;
    crate::util::write_json_file_atomic(&path, &value)?;
    Ok((ws, was_v0))
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
        let ws = save(&dir, "demo", vec![sample_window()], None, Some("0.17.50".into()), false).unwrap();
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
        save(&dir, "demo", vec![sample_window()], None, None, false).unwrap();
        let err = save(&dir, "demo", vec![sample_window()], None, None, false).unwrap_err();
        assert!(matches!(err, WorkspaceError::AlreadyExists(_)));
        save(&dir, "demo", vec![sample_window()], None, None, true).unwrap();
    }

    #[test]
    fn save_rejects_pid_in_sessions() {
        let dir = tempdir();
        let mut w = sample_window();
        w.layout["sessions"]["s1"]["pid"] = serde_json::json!(4242);
        let err = save(&dir, "demo", vec![w], None, None, false).unwrap_err();
        assert!(matches!(err, WorkspaceError::Corrupt(_)), "got {err:?}");
        assert!(!dir.join("demo.json").exists(), "nothing written on validation failure");
    }

    #[test]
    fn save_rejects_empty_and_malformed() {
        let dir = tempdir();
        assert!(matches!(
            save(&dir, "demo", vec![], None, None, false).unwrap_err(),
            WorkspaceError::Corrupt(_)
        ));
        let mut w = sample_window();
        w.layout = serde_json::json!({"termGroups": {}});
        assert!(matches!(
            save(&dir, "demo", vec![w], None, None, false).unwrap_err(),
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
        save(&dir, "good", vec![sample_window()], None, None, false).unwrap();
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
        let mut a = save(&dir, "older", vec![sample_window()], None, None, false).unwrap();
        // Force distinct timestamps without sleeping.
        a.saved_at = "2020-01-01T00:00:00Z".into();
        crate::util::write_json_file_atomic(
            &dir.join("older.json"),
            &serde_json::to_value(&a).unwrap(),
        )
        .unwrap();
        save(&dir, "newer", vec![sample_window()], None, None, false).unwrap();
        let rows = list(&dir).unwrap();
        assert_eq!(rows[0].name, "newer");
        assert_eq!(rows[1].name, "older");
    }

    // ---- delete / rename ---------------------------------------------------

    #[test]
    fn delete_and_missing() {
        let dir = tempdir();
        save(&dir, "demo", vec![sample_window()], None, None, false).unwrap();
        delete(&dir, "demo").unwrap();
        assert!(!dir.join("demo.json").exists());
        assert!(matches!(delete(&dir, "demo").unwrap_err(), WorkspaceError::NotFound(_)));
        assert!(matches!(delete(&dir, "../evil").unwrap_err(), WorkspaceError::InvalidName(_)));
    }

    #[test]
    fn rename_moves_and_rewrites_name() {
        let dir = tempdir();
        save(&dir, "old", vec![sample_window()], None, None, false).unwrap();
        rename(&dir, "old", "new", false).unwrap();
        assert!(!dir.join("old.json").exists());
        let ws = read_and_validate(&dir.join("new.json")).unwrap();
        assert_eq!(ws.name, "new");
    }

    #[test]
    fn rename_collision_and_noop() {
        let dir = tempdir();
        save(&dir, "a", vec![sample_window()], None, None, false).unwrap();
        save(&dir, "b", vec![sample_window()], None, None, false).unwrap();
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
        save(&dir, "demo", vec![sample_window()], None, None, false).unwrap();
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
        let report = preview(&ws, Some(&profiles), None, |_| true);
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
        let report = preview(&ws, Some(&profiles), None, |_| false);
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
        let report = preview(&ws, None, None, |_| true);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn preview_reports_missing_stickys() {
        let mut ws = WorkspaceFile {
            kind: WORKSPACE_KIND.into(),
            schema_version: SCHEMA_VERSION,
            name: "demo".into(),
            saved_at: "2026-08-28T00:00:00Z".into(),
            app_version: None,
            windows: vec![sample_window()],
            stickys: Some(vec![
                StickyRef {id: "note-alive".into(), x: 1, y: 2, width: 300, height: 200, open: true},
                StickyRef {id: "note-gone".into(), x: 5, y: 6, width: 300, height: 200, open: true},
            ]),
        };
        let ids: std::collections::HashSet<String> = ["note-alive".to_string()].into();
        let report = preview(&ws, None, Some(&ids), |_| true);
        assert_eq!(report.stickys, 2);
        let missing: Vec<&PreviewIssue> =
            report.issues.iter().filter(|i| i.kind == "missing-sticky").collect();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].value, "note-gone");
        assert!(missing[0].resolution.contains("skipped"));

        // Unreadable notes file (None) → the check is skipped entirely.
        let report2 = preview(&ws, None, None, |_| true);
        assert!(report2.issues.iter().all(|i| i.kind != "missing-sticky"));

        // No stickys in the file → nothing to report either way.
        ws.stickys = None;
        let report3 = preview(&ws, None, Some(&ids), |_| true);
        assert_eq!(report3.stickys, 0);
        assert!(report3.issues.is_empty());
    }

    #[test]
    fn save_persists_sticky_refs_and_drops_empty() {
        let dir = tempdir();
        let refs = vec![StickyRef {id: "note-1".into(), x: 0, y: 0, width: 300, height: 200, open: true}];
        let ws = save(&dir, "with-sticky", vec![sample_window()], Some(refs.clone()), None, false).unwrap();
        assert_eq!(ws.stickys.as_ref().unwrap().len(), 1);
        let read = load_workspace(&dir, "with-sticky").unwrap();
        assert_eq!(read.stickys.unwrap(), refs);
        // Empty vec normalizes to absent, keeping old files byte-shape stable.
        let ws2 = save(&dir, "no-sticky", vec![sample_window()], Some(vec![]), None, false).unwrap();
        assert!(ws2.stickys.is_none());
    }

    // ---- export / import / migrate (#169) ----------------------------------

    fn v0_blob() -> serde_json::Value {
        serde_json::json!({
            "activeUid": "s1",
            "activeRootGroup": "g1",
            "activeSessions": {"g1": "s1"},
            "termGroups": {
                "g1": {"uid": "g1", "sessionUid": "s1", "parentUid": null,
                        "direction": null, "sizes": null, "children": [],
                        "tabName": "legacy"}
            },
            "sessions": {
                "s1": {"uid": "s1", "title": "zsh", "cwd": "/home/x", "profile": "zsh",
                        "shell": "/bin/zsh", "cols": 80, "rows": 24, "pid": 999,
                        "lastCommand": "vim ."}
            }
        })
    }

    #[test]
    fn export_then_import_round_trips_byte_stable() {
        let dir = tempdir();
        save(&dir, "demo", vec![sample_window()], None, Some("x".into()), false).unwrap();
        let dest = dir.join("exported").join("demo-export.json");
        export(&dir, "demo", &dest, false).unwrap();
        // The export equals the library file byte-for-byte (same serializer).
        let lib = std::fs::read_to_string(dir.join("demo.json")).unwrap();
        let exp = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(lib, exp);
        // Import it back under a new name: identical except the name field.
        let (ws, was_v0) = import(&dir, &dest, Some("demo-copy"), false, default_v0_geometry()).unwrap();
        assert!(!was_v0);
        assert_eq!(ws.name, "demo-copy");
        let orig = load_workspace(&dir, "demo").unwrap();
        let copy = load_workspace(&dir, "demo-copy").unwrap();
        assert_eq!(orig.windows, copy.windows);
        assert_eq!(orig.saved_at, copy.saved_at, "import preserves the save timestamp");
    }

    #[test]
    fn export_refuses_existing_dest_unless_overwrite() {
        let dir = tempdir();
        save(&dir, "demo", vec![sample_window()], None, None, false).unwrap();
        let dest = dir.join("out.json");
        std::fs::write(&dest, "occupied").unwrap();
        assert!(matches!(
            export(&dir, "demo", &dest, false).unwrap_err(),
            WorkspaceError::AlreadyExists(_)
        ));
        export(&dir, "demo", &dest, true).unwrap();
        assert!(std::fs::read_to_string(&dest).unwrap().contains(WORKSPACE_KIND));
    }

    #[test]
    fn import_migrates_v0_blob_bare_and_wrapped() {
        let dir = tempdir();
        let srcdir = dir.join("incoming");
        std::fs::create_dir_all(&srcdir).unwrap();
        let bare = srcdir.join("legacy-bare.json");
        std::fs::write(&bare, v0_blob().to_string()).unwrap();
        let (ws, was_v0) = import(&dir, &bare, None, false, default_v0_geometry()).unwrap();
        assert!(was_v0);
        assert_eq!(ws.name, "legacy-bare", "name falls back to the source filename");
        assert_eq!(ws.schema_version, SCHEMA_VERSION);
        assert_eq!(ws.windows.len(), 1);
        let s1 = &ws.windows[0].layout["sessions"]["s1"];
        assert!(s1.get("pid").is_none(), "v0 pid stripped");
        assert!(s1.get("lastCommand").is_none(), "bare lastCommand demoted");
        assert_eq!(s1["annotations"]["lastCommand"], "vim .");

        // Wrapped in a whole hyperia.json — the shape the boot key lived in.
        let wrapped = srcdir.join("old-config.json");
        std::fs::write(
            &wrapped,
            serde_json::json!({"config": {"fontSize": 12}, "savedLayoutState": v0_blob()}).to_string(),
        )
        .unwrap();
        let (ws2, was_v0b) = import(&dir, &wrapped, Some("from-config"), false, default_v0_geometry()).unwrap();
        assert!(was_v0b);
        assert_eq!(ws2.name, "from-config");
        assert!(load_workspace(&dir, "from-config").is_ok());
    }

    #[test]
    fn import_failures_are_typed_and_leave_source_untouched() {
        let dir = tempdir();
        let cases: Vec<(&str, String)> = vec![
            ("garbage.json", "{ not json".to_string()),
            ("wrongkind.json", r#"{"kind": "something-else"}"#.to_string()),
            (
                "future.json",
                serde_json::json!({"kind": WORKSPACE_KIND, "schemaVersion": 99}).to_string(),
            ),
            ("unrelated.json", r#"{"hello": "world"}"#.to_string()),
        ];
        let srcdir = dir.join("incoming");
        std::fs::create_dir_all(&srcdir).unwrap();
        for (fname, content) in &cases {
            let src = srcdir.join(fname);
            std::fs::write(&src, content).unwrap();
            let err = import(&dir, &src, None, false, default_v0_geometry()).unwrap_err();
            match *fname {
                "garbage.json" | "unrelated.json" => assert!(matches!(err, WorkspaceError::Corrupt(_)), "{fname}: {err:?}"),
                "wrongkind.json" => assert!(matches!(err, WorkspaceError::WrongKind(_)), "{fname}: {err:?}"),
                "future.json" => assert!(matches!(err, WorkspaceError::NewerThanSupported(99)), "{fname}: {err:?}"),
                _ => unreachable!(),
            }
            // Source file byte-identical afterwards.
            assert_eq!(&std::fs::read_to_string(&src).unwrap(), content, "{fname} modified!");
        }
        // Nothing snuck into the library.
        assert!(list(&dir).unwrap().is_empty());
    }

    #[test]
    fn import_name_collision_and_overwrite() {
        let dir = tempdir();
        save(&dir, "demo", vec![sample_window()], None, None, false).unwrap();
        let srcdir = dir.join("incoming");
        std::fs::create_dir_all(&srcdir).unwrap();
        let src = srcdir.join("incoming.json");
        std::fs::write(&src, v0_blob().to_string()).unwrap();
        assert!(matches!(
            import(&dir, &src, Some("demo"), false, default_v0_geometry()).unwrap_err(),
            WorkspaceError::AlreadyExists(_)
        ));
        let (ws, _) = import(&dir, &src, Some("demo"), true, default_v0_geometry()).unwrap();
        assert_eq!(ws.name, "demo");
    }

    #[test]
    fn migrate_v1_passthrough_validates() {
        let ws = WorkspaceFile {
            kind: WORKSPACE_KIND.into(),
            schema_version: SCHEMA_VERSION,
            name: "demo".into(),
            saved_at: "2026-08-28T00:00:00Z".into(),
            app_version: None,
            windows: vec![sample_window()],
            stickys: None,
        };
        let raw = serde_json::to_value(&ws).unwrap();
        let opts = MigrateOpts {name_hint: "x".into(), fallback_geometry: default_v0_geometry()};
        assert_eq!(migrate(raw, &opts).unwrap(), ws);
        // v1 with a pid smuggled in fails validation even through migrate.
        let mut bad = serde_json::to_value(&ws).unwrap();
        bad["windows"][0]["layout"]["sessions"]["s1"]["pid"] = serde_json::json!(1);
        assert!(matches!(migrate(bad, &opts).unwrap_err(), WorkspaceError::Corrupt(_)));
    }

    // ---- version gates -----------------------------------------------------

    #[test]
    fn future_version_refused() {
        let dir = tempdir();
        let ws = save(&dir, "demo", vec![sample_window()], None, None, false).unwrap();
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
