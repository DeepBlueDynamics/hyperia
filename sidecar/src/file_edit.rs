//! Dashboard file editor: open / save / stat files that agents touched.
//!
//! Guards, all required: a loopback peer; a same-origin request (Origin, when
//! sent, must match Host — a foreign page can't send JSON here without a CORS
//! preflight we never grant); a JSON body; and the path must be one Hyperia's
//! telemetry saw an agent touch. Container paths (/workspace/<dir>/…) map to
//! the touching pane's host cwd.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::AppState;

const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({"ok": false, "error": msg.into()}))).into_response()
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return true; // non-browser client; the peer is already loopback
    };
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    origin == format!("http://{host}")
}

/// Map an agent-reported path to a host file. Host paths pass through; an n8
/// container's /workspace/<name>/rest maps under the pane cwd whose folder is <name>.
pub fn resolve(path: &str, pane_cwd: Option<&str>) -> Option<PathBuf> {
    let p = Path::new(path);
    if p.is_absolute() && !path.starts_with("/workspace/") {
        return Some(p.to_path_buf());
    }
    let rest = path.strip_prefix("/workspace/")?;
    let cwd = PathBuf::from(pane_cwd?);
    let (first, tail) = rest.split_once('/').unwrap_or((rest, ""));
    let base = cwd.file_name()?.to_string_lossy().to_string();
    if !first.eq_ignore_ascii_case(&base) {
        return None;
    }
    let mut out = cwd.clone();
    for seg in tail.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." || seg == "." {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

async fn guard(state: &AppState, peer: &SocketAddr, headers: &HeaderMap, path: &str) -> Result<PathBuf, Response> {
    if !peer.ip().is_loopback() {
        return Err(err(StatusCode::FORBIDDEN, "the editor is local-only"));
    }
    if !same_origin(headers) {
        return Err(err(StatusCode::FORBIDDEN, "cross-origin request refused"));
    }
    let Some(pane) = state.telemetry.toucher(path) else {
        return Err(err(StatusCode::FORBIDDEN, "only files an agent touched can be opened here"));
    };
    let cwd = state.bridge.sessions().await.get(&pane).map(|s| s.cwd.clone());
    resolve(path, cwd.as_deref()).ok_or_else(|| {
        err(StatusCode::NOT_FOUND, "can't map this path to a file on this machine (its pane is gone or it's inside a container)")
    })
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Deserialize)]
pub struct PathReq {
    path: String,
}

/// POST /api/files/open {path} → text (LF), eol, bom, mtime_ms, size, readonly.
pub async fn open(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<PathReq>,
) -> Response {
    let host = match guard(&state, &peer, &headers, &req.path).await {
        Ok(p) => p,
        Err(r) => return r,
    };
    let meta = match std::fs::metadata(&host) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return err(StatusCode::BAD_REQUEST, "not a file"),
        Err(_) => return err(StatusCode::NOT_FOUND, format!("no such file: {}", host.display())),
    };
    if meta.len() > MAX_BYTES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "file is over 2 MB");
    }
    let bytes = match std::fs::read(&host) {
        Ok(b) => b,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "binary file");
    }
    let (bom, body) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (true, rest),
        None => (false, &bytes[..]),
    };
    let Ok(text) = std::str::from_utf8(body) else {
        return err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not UTF-8 text");
    };
    let crlf = text.contains("\r\n");
    Json(json!({
        "ok": true, "path": req.path, "host_path": host.display().to_string(),
        "text": if crlf { text.replace("\r\n", "\n") } else { text.to_string() },
        "eol": if crlf { "crlf" } else { "lf" }, "bom": bom,
        "mtime_ms": mtime_ms(&meta), "size": meta.len(), "readonly": meta.permissions().readonly(),
    }))
    .into_response()
}

/// GET /api/files/stat?path= → mtime_ms, size. A GET so the editor's change
/// polling stays out of the audit log; it reveals only a timestamp and size.
pub async fn stat(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(req): Query<PathReq>,
) -> Response {
    let host = match guard(&state, &peer, &headers, &req.path).await {
        Ok(p) => p,
        Err(r) => return r,
    };
    match std::fs::metadata(&host) {
        Ok(m) => Json(json!({"ok": true, "mtime_ms": mtime_ms(&m), "size": m.len()})).into_response(),
        Err(_) => Json(json!({"ok": true, "missing": true})).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SaveReq {
    path: String,
    text: String,
    /// mtime the editor loaded; a different one on disk is a conflict.
    base_mtime_ms: Option<u64>,
    #[serde(default)]
    eol: Option<String>,
    #[serde(default)]
    bom: bool,
    /// Overwrite even if the file changed on disk.
    #[serde(default)]
    force: bool,
}

/// POST /api/files/save — atomic write (temp + rename), refusing to clobber an
/// outside change unless `force`.
pub async fn save(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SaveReq>,
) -> Response {
    let host = match guard(&state, &peer, &headers, &req.path).await {
        Ok(p) => p,
        Err(r) => return r,
    };
    if req.text.len() as u64 > MAX_BYTES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "text is over 2 MB");
    }
    if let (Ok(meta), Some(base), false) = (std::fs::metadata(&host), req.base_mtime_ms, req.force) {
        let now = mtime_ms(&meta);
        if now != base {
            return (StatusCode::CONFLICT, Json(json!({"ok": false, "conflict": true, "mtime_ms": now,
                "error": "the file changed on disk since you opened it"}))).into_response();
        }
    }
    let mut out = Vec::with_capacity(req.text.len() + 8);
    if req.bom {
        out.extend_from_slice(b"\xEF\xBB\xBF");
    }
    if req.eol.as_deref() == Some("crlf") {
        out.extend_from_slice(req.text.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
    } else {
        out.extend_from_slice(req.text.as_bytes());
    }
    let name = host.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = host.with_file_name(format!(".{name}.hyperia-save"));
    if let Err(e) = std::fs::write(&tmp, &out).and_then(|_| std::fs::rename(&tmp, &host)) {
        let _ = std::fs::remove_file(&tmp);
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("save failed: {e}"));
    }
    tracing::info!(target: "editor", "dashboard editor saved {} ({} bytes)", host.display(), out.len());
    let meta = std::fs::metadata(&host).ok();
    Json(json!({"ok": true, "mtime_ms": meta.as_ref().map(mtime_ms).unwrap_or(0), "size": out.len()})).into_response()
}

#[derive(Deserialize)]
pub struct RenderReq {
    text: String,
}

/// POST /api/files/render {text} → safe HTML for the editor's rendered view.
/// Renders the buffer (unsaved edits included), so no path check — only the
/// local, same-origin guards.
pub async fn render(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(req): Json<RenderReq>) -> Response {
    if !peer.ip().is_loopback() {
        return err(StatusCode::FORBIDDEN, "the editor is local-only");
    }
    if !same_origin(&headers) {
        return err(StatusCode::FORBIDDEN, "cross-origin request refused");
    }
    if req.text.len() as u64 > MAX_BYTES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "text is over 2 MB");
    }
    Json(json!({"ok": true, "html": crate::render::md_to_safe_html(&req.text)})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_markdown_is_inert() {
        let h = crate::render::md_to_safe_html(
            "# Hi\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)> ![i](data:text/html,x) [ok](https://a.b)",
        );
        assert!(h.contains("<h1>Hi</h1>"));
        assert!(!h.contains("<script") && !h.contains("<img src=x"));
        assert!(h.contains("&lt;script&gt;"));
        assert!(!h.contains("javascript:") && !h.contains("data:text"));
        assert!(h.contains("href=\"https://a.b\""));
    }

    #[test]
    fn workspace_paths_map_under_the_pane_cwd_only() {
        let cwd = if cfg!(windows) { r"C:\Code\lume" } else { "/home/k/lume" };
        let got = resolve("/workspace/lume/src/main.rs", Some(cwd)).unwrap();
        assert_eq!(got, PathBuf::from(cwd).join("src").join("main.rs"));
        assert!(resolve("/workspace/other/x.rs", Some(cwd)).is_none());
        assert!(resolve("/workspace/lume/../secrets", Some(cwd)).is_none());
        assert!(resolve("/workspace/lume/a.rs", None).is_none());
        assert!(resolve("relative/a.rs", Some(cwd)).is_none());
    }

    #[test]
    fn origin_must_match_host() {
        let mut h = HeaderMap::new();
        assert!(same_origin(&h));
        h.insert("host", "127.0.0.1:9800".parse().unwrap());
        h.insert("origin", "http://127.0.0.1:9800".parse().unwrap());
        assert!(same_origin(&h));
        h.insert("origin", "http://evil.example".parse().unwrap());
        assert!(!same_origin(&h));
    }
}
