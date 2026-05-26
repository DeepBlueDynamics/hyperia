//! Filesystem navigation for the pane directory navigator.
//!
//! Lists the *visible* subdirectories of a path so the renderer's directory
//! navigator doesn't have to read the filesystem itself (and doesn't re-derive
//! the "what counts as a real directory" rules in TypeScript). The renderer
//! just fetches `GET /api/fs/dirs?path=...` and renders the result.
//!
//! Rules:
//! * Directories only — never files.
//! * No path / a path that doesn't exist → start in the user's home directory.
//! * Hidden/system entries are excluded: names starting with `.` (Unix-hidden)
//!   or `$` (Windows system dirs like `$Recycle.Bin`, `$WinREAgent`), plus
//!   anything carrying the Windows HIDDEN or SYSTEM file attribute.
//! * Names sorted case-insensitively.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct DirListing {
    /// The resolved absolute path that was listed.
    pub path: String,
    /// Parent directory, or `null` at a filesystem/drive root.
    pub parent: Option<String>,
    /// Visible subdirectory names (not full paths), sorted case-insensitively.
    pub dirs: Vec<String>,
}

/// The user's home directory: `USERPROFILE` on Windows, `HOME` elsewhere.
pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
}

/// Resolve the directory to list: the requested path if it exists and is a
/// directory, otherwise the home directory.
fn resolve_start(path: Option<&str>) -> PathBuf {
    if let Some(p) = path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let pb = PathBuf::from(trimmed);
            if pb.is_dir() {
                return pb;
            }
        }
    }
    home_dir()
}

fn is_hidden_name(name: &str) -> bool {
    // Unix dotfiles and Windows system dirs ($Recycle.Bin, $WinREAgent, ...).
    name.starts_with('.') || name.starts_with('$')
}

#[cfg(windows)]
fn has_hidden_attr(entry: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    match entry.metadata() {
        Ok(md) => md.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0,
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn has_hidden_attr(_entry: &std::fs::DirEntry) -> bool {
    false
}

/// List the visible subdirectories of `path` (or the home directory if `path`
/// is absent/empty/nonexistent).
pub fn list_dirs(path: Option<&str>) -> DirListing {
    let dir = resolve_start(path);

    let mut dirs: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            // Directories only. file_type() avoids a stat where possible;
            // fall through to skip on error.
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => {}
                _ => continue,
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden_name(&name) || has_hidden_attr(&entry) {
                continue;
            }
            dirs.push(name);
        }
    }
    dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));

    let parent = dir.parent().map(|p| p.to_string_lossy().into_owned());
    DirListing {
        path: dir.to_string_lossy().into_owned(),
        parent,
        dirs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_used_when_path_missing_or_bad() {
        let h = home_dir().to_string_lossy().into_owned();
        assert_eq!(list_dirs(None).path, h);
        assert_eq!(list_dirs(Some("")).path, h);
        assert_eq!(list_dirs(Some("/this/does/not/exist/anywhere")).path, h);
    }

    #[test]
    fn hidden_and_system_names_excluded() {
        assert!(is_hidden_name(".git"));
        assert!(is_hidden_name("$Recycle.Bin"));
        assert!(is_hidden_name("$WinREAgent"));
        assert!(!is_hidden_name("Documents"));
        assert!(!is_hidden_name("dev"));
    }

    #[test]
    fn lists_only_dirs_sorted() {
        // Home should exist and contain at least zero entries; result sorted.
        let listing = list_dirs(None);
        let mut sorted = listing.dirs.clone();
        sorted.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        assert_eq!(listing.dirs, sorted);
        assert!(listing.dirs.iter().all(|d| !d.starts_with('.') && !d.starts_with('$')));
    }
}
