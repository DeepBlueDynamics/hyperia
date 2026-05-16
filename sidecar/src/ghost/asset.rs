//! AssetStore — receives pasted/dropped files (images, PDFs, text) from the
//! shell and stores them on disk at `~/.hyperia/assets/<id>.<ext>`. The
//! shell renders the asset inline in the chat scrollback (thumbnail for
//! images, filename + size for everything else). The agent picks them up
//! later via a follow-up phase (this module is storage + retrieval only).
//!
//! Endpoints (wired in api.rs / main.rs):
//!   POST /api/ghost/asset            body: raw bytes; headers: content-type, x-filename
//!     → { id, url: "/api/ghost/asset/<id>", content_type, filename, size }
//!   GET  /api/ghost/asset/:id        → raw bytes with original content-type
//!   GET  /api/ghost/assets           → list of all stored assets (for UI restore)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AssetMeta {
    pub id: String,
    pub content_type: String,
    pub filename: String,
    pub size: u64,
    #[serde(skip)]
    pub path: PathBuf,
    pub created_ts: u64,
}

pub struct AssetStore {
    items: Mutex<HashMap<String, AssetMeta>>,
    counter: AtomicU64,
    storage_dir: PathBuf,
}

impl Default for AssetStore {
    fn default() -> Self {
        Self::new()
    }
}

impl AssetStore {
    pub fn new() -> Self {
        let storage_dir = home_assets_dir();
        let _ = std::fs::create_dir_all(&storage_dir);
        Self {
            items: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            storage_dir,
        }
    }

    /// Store an asset. Generates a fresh id, writes the bytes to disk
    /// under ~/.hyperia/assets/<id>.<ext>, records metadata in-memory.
    /// Returns the AssetMeta for the renderer to render.
    pub fn store(
        &self,
        content_type: String,
        filename: String,
        bytes: &[u8],
    ) -> std::io::Result<AssetMeta> {
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let id = format!("a-{:x}{:04x}", now_nanos, n & 0xffff);

        let ext = ext_from_content_type(&content_type);
        let path = self.storage_dir.join(format!("{}{}", id, ext));
        std::fs::write(&path, bytes)?;

        let meta = AssetMeta {
            id: id.clone(),
            content_type,
            filename,
            size: bytes.len() as u64,
            path,
            created_ts: now_nanos / 1_000_000_000,
        };
        self.items.lock().unwrap().insert(id.clone(), meta.clone());
        Ok(meta)
    }

    /// Get the on-disk path + content-type for serving back.
    pub fn get(&self, id: &str) -> Option<(PathBuf, String, String)> {
        let items = self.items.lock().unwrap();
        items.get(id).map(|m| (m.path.clone(), m.content_type.clone(), m.filename.clone()))
    }

    /// List all stored assets (used by UI restore on shell refresh).
    pub fn list(&self) -> Vec<AssetMeta> {
        let items = self.items.lock().unwrap();
        let mut v: Vec<AssetMeta> = items.values().cloned().collect();
        v.sort_by_key(|m| m.created_ts);
        v
    }

    /// Drop an asset from in-memory index and unlink the file.
    pub fn delete(&self, id: &str) -> bool {
        let mut items = self.items.lock().unwrap();
        if let Some(meta) = items.remove(id) {
            let _ = std::fs::remove_file(&meta.path);
            true
        } else {
            false
        }
    }
}

fn home_assets_dir() -> PathBuf {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    PathBuf::from(home).join(".hyperia").join("assets")
}

fn ext_from_content_type(ct: &str) -> &'static str {
    let base = ct.split(';').next().unwrap_or("").trim().to_lowercase();
    match base.as_str() {
        "image/png" => ".png",
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "image/bmp" => ".bmp",
        "image/tiff" => ".tif",
        "application/pdf" => ".pdf",
        "text/plain" => ".txt",
        "text/markdown" | "text/x-markdown" => ".md",
        "text/csv" => ".csv",
        "application/json" => ".json",
        "text/html" => ".html",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_recognizes_common_types() {
        assert_eq!(ext_from_content_type("image/png"), ".png");
        assert_eq!(ext_from_content_type("image/jpeg; charset=binary"), ".jpg");
        assert_eq!(ext_from_content_type("application/pdf"), ".pdf");
        assert_eq!(ext_from_content_type("text/plain"), ".txt");
        assert_eq!(ext_from_content_type("application/octet-stream"), "");
    }

    #[test]
    fn store_and_get_round_trips() {
        // Uses a real tempdir-ish — write under the system temp.
        let store = AssetStore {
            items: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            storage_dir: std::env::temp_dir().join(format!("hyperia-asset-test-{}", std::process::id())),
        };
        let _ = std::fs::create_dir_all(&store.storage_dir);
        let meta = store
            .store("image/png".into(), "hello.png".into(), &[1, 2, 3, 4, 5])
            .expect("store should succeed");
        assert!(meta.id.starts_with("a-"));
        assert_eq!(meta.size, 5);
        assert!(meta.path.ends_with(format!("{}.png", meta.id)));

        let (path, ct, name) = store.get(&meta.id).expect("get should resolve");
        assert_eq!(ct, "image/png");
        assert_eq!(name, "hello.png");
        let bytes = std::fs::read(&path).expect("file exists");
        assert_eq!(bytes, vec![1, 2, 3, 4, 5]);

        // Cleanup.
        let _ = std::fs::remove_dir_all(&store.storage_dir);
    }

    #[test]
    fn delete_unlinks_file_and_removes_meta() {
        let store = AssetStore {
            items: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            storage_dir: std::env::temp_dir().join(format!("hyperia-asset-del-{}", std::process::id())),
        };
        let _ = std::fs::create_dir_all(&store.storage_dir);
        let meta = store
            .store("text/plain".into(), "x.txt".into(), b"hello")
            .unwrap();
        assert!(meta.path.exists());
        assert!(store.delete(&meta.id));
        assert!(!meta.path.exists());
        assert!(store.get(&meta.id).is_none());
        // Cleanup parent.
        let _ = std::fs::remove_dir_all(&store.storage_dir);
    }
}
