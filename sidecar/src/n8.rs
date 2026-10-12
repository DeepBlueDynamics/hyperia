//! nemesis8 gateway client for sticky agent runs. Main process only (System token):
//! status, start, one-shot trigger create/poll/delete against 127.0.0.1:9801.

use std::path::{Path as FsPath, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::AppState;

pub const GATEWAY: &str = "http://127.0.0.1:9801";
pub const GATEWAY_PORT: u16 = 9801;
const KEYRING_SERVICE: &str = "nemesis8";
const KEYRING_USER: &str = "NEMESIS8_AUTH_TOKEN";
/// Fallback until n8 ships GET /providers (404 on released gateways).
pub const STATIC_PROVIDERS: [&str; 8] = ["claude", "codex", "grok", "gemini", "opencode", "hermes", "antigravity", "pi"];

type ApiResult = (StatusCode, Json<Value>);

fn err(status: StatusCode, msg: impl Into<String>) -> ApiResult {
    (status, Json(json!({"ok": false, "error": msg.into()})))
}

async fn require_system(state: &AppState, headers: &HeaderMap) -> Result<(), ApiResult> {
    let id = state.bridge.resolve_caller(crate::bearer_token(headers).as_deref()).await;
    if id.is_system() { Ok(()) } else { Err(err(StatusCode::FORBIDDEN, "nemesis8 routes are internal to Hyperia.")) }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn read_token_blocking() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?.get_password().ok().filter(|t| !t.trim().is_empty())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn read_token_blocking() -> Option<String> { None }

/// Keychain reads can block on a locked store, so keep them off the runtime.
pub(crate) async fn auth_token() -> Option<String> {
    tokio::task::spawn_blocking(read_token_blocking).await.ok().flatten()
}

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Authenticated gateway call → (status, parsed body or raw text).
async fn gateway(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(StatusCode, Value), String> {
    let mut req = client(Duration::from_secs(15)).request(method, format!("{GATEWAY}{path}"));
    if let Some(tok) = auth_token().await { req = req.bearer_auth(tok); }
    if let Some(b) = body { req = req.json(&b); }
    let resp = req.send().await.map_err(|e| format!("nemesis8 gateway unreachable: {e}"))?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let text = resp.text().await.unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::String(text))))
}

/// `/health` needs no auth; Some(version) when the gateway answers 200.
async fn health() -> Option<String> {
    let resp = client(Duration::from_secs(2)).get(format!("{GATEWAY}/health")).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    Some(v["version"].as_str().unwrap_or("").to_string())
}

fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) { &["n8.exe", "n8.cmd", "n8.bat"] } else { &["n8"] }
}

/// First `n8` executable in PATH, then the usual per-user install dirs.
pub fn find_n8(path_env: Option<&str>, home: Option<&FsPath>, names: &[&str]) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_env.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    if let Some(h) = home {
        dirs.push(h.join(".local").join("bin"));
        dirs.push(h.join(".nemesis8"));
        dirs.push(h.join(".cargo").join("bin"));
    }
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

fn locate_n8() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    find_n8(std::env::var("PATH").ok().as_deref(), home.as_deref(), exe_names())
}

/// Gateway /providers when it exists, else the static list with `installed: null`.
pub fn providers_from(listed: Option<&Value>) -> Value {
    let from_gateway = listed.and_then(|v| v.get("providers").or(Some(v))).and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|p| match p {
            Value::String(name) => Some(json!({"name": name, "installed": null})),
            Value::Object(o) => o.get("name").and_then(|n| n.as_str())
                .map(|name| json!({"name": name, "installed": o.get("installed").cloned().unwrap_or(Value::Null)})),
            _ => None,
        }).collect::<Vec<_>>()
    });
    match from_gateway {
        Some(list) if !list.is_empty() => Value::Array(list),
        _ => Value::Array(STATIC_PROVIDERS.iter().map(|n| json!({"name": n, "installed": null})).collect()),
    }
}

/// UTC RFC 3339 for n8's `once.at` (no chrono in the sidecar).
pub fn rfc3339_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

#[derive(Debug, Deserialize)]
pub struct RunRequest {
    pub note: String,
    #[serde(default)]
    pub name: String,
    pub prompt: String,
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    pub dir: String,
    #[serde(default)]
    pub danger: bool,
}

pub fn validate_run(req: &RunRequest) -> Result<(), String> {
    if req.note.trim().is_empty() { return Err("note is required".into()); }
    if req.prompt.trim().is_empty() { return Err("prompt is required".into()); }
    if req.provider.trim().is_empty() { return Err("provider is required".into()); }
    if req.dir.trim().is_empty() { return Err("dir is required".into()); }
    Ok(())
}

/// One-shot trigger that fires on n8's next tick; tagged so it can be traced to the sticky.
pub fn trigger_body(req: &RunRequest, now_secs: u64) -> Value {
    let title = if req.name.trim().is_empty() { format!("Hyperia sticky {}", req.note) } else { format!("Hyperia sticky {}", req.name) };
    let mut body = json!({
        "title": title,
        "prompt_text": req.prompt,
        "schedule": {"type": "once", "at": rfc3339_utc(now_secs)},
        "workspace": req.dir,
        "provider": req.provider,
        "danger": req.danger,
        "tags": ["hyperia-sticky", req.note],
    });
    if let Some(m) = req.model.as_deref().filter(|m| !m.trim().is_empty()) { body["model"] = json!(m); }
    body
}

pub fn trigger_status(v: &Value) -> Value {
    json!({"last_fired": v.get("last_fired").cloned().unwrap_or(Value::Null),
           "last_status": v.get("last_status").cloned().unwrap_or(Value::Null),
           "last_error": v.get("last_error").cloned().unwrap_or(Value::Null)})
}

fn upstream_error(status: StatusCode, body: &Value) -> ApiResult {
    let detail = body.get("error").and_then(|e| e.as_str()).map(str::to_string)
        .unwrap_or_else(|| if body.is_string() { body.as_str().unwrap_or("").to_string() } else { body.to_string() });
    let hint = if status == StatusCode::UNAUTHORIZED { " (no nemesis8 token in the OS keychain?)" } else { "" };
    let code = if status == StatusCode::NOT_FOUND { StatusCode::NOT_FOUND } else { StatusCode::BAD_GATEWAY };
    err(code, format!("nemesis8 returned {}: {detail}{hint}", status.as_u16()))
}

async fn n8_version(bin: &FsPath) -> Option<String> {
    let out = tokio::time::timeout(Duration::from_secs(3), tokio::process::Command::new(bin).arg("--version")
        .stdin(std::process::Stdio::null()).kill_on_drop(true).output()).await.ok()?.ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then(|| s.rsplit(' ').next().unwrap_or(&s).to_string())
}

pub async fn get_status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    if let Err(e) = require_system(&state, &headers).await { return e; }
    let bin = locate_n8();
    let running = health().await;
    let version = match (&running, &bin) {
        (Some(v), _) if !v.is_empty() => Some(v.clone()),
        (_, Some(b)) => n8_version(b).await,
        _ => None,
    };
    let listed = if running.is_some() {
        match gateway(reqwest::Method::GET, "/providers", None).await {
            Ok((s, v)) if s.is_success() => Some(v),
            _ => None,
        }
    } else { None };
    (StatusCode::OK, Json(json!({
        "installed": bin.is_some(),
        "running": running.is_some(),
        "version": version,
        "path": bin.map(|b| b.to_string_lossy().to_string()),
        "providers": providers_from(listed.as_ref()),
    })))
}

pub async fn post_start(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    if let Err(e) = require_system(&state, &headers).await { return e; }
    if health().await.is_some() { return (StatusCode::OK, Json(json!({"ok": true, "running": true}))); }
    let Some(bin) = locate_n8() else { return err(StatusCode::NOT_FOUND, "nemesis8 (n8) is not installed."); };
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["serve", "--background", "--port", &GATEWAY_PORT.to_string()])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    match cmd.spawn() {
        // Reap the launcher in the background; the daemon it forks outlives it.
        Ok(mut child) => { tokio::spawn(async move { let _ = child.wait().await; }); }
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("Couldn't launch n8: {e}")),
    }
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if health().await.is_some() { return (StatusCode::OK, Json(json!({"ok": true, "running": true}))); }
    }
    (StatusCode::OK, Json(json!({"ok": false, "running": false, "error": "nemesis8 didn't answer /health within 5 s."})))
}

pub async fn post_run(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<RunRequest>) -> ApiResult {
    if let Err(e) = require_system(&state, &headers).await { return e; }
    if let Err(e) = validate_run(&req) { return err(StatusCode::BAD_REQUEST, e); }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    match gateway(reqwest::Method::POST, "/triggers", Some(trigger_body(&req, now))).await {
        Ok((s, v)) if s.is_success() => match v.get("id").and_then(|i| i.as_str()) {
            Some(id) => (StatusCode::OK, Json(json!({"ok": true, "trigger_id": id}))),
            None => err(StatusCode::BAD_GATEWAY, "nemesis8 created no trigger id"),
        },
        Ok((s, v)) => upstream_error(s, &v),
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub async fn get_run(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    if let Err(e) = require_system(&state, &headers).await { return e; }
    if !safe_id(&id) { return err(StatusCode::BAD_REQUEST, "bad trigger id"); }
    match gateway(reqwest::Method::GET, &format!("/triggers/{id}"), None).await {
        Ok((s, v)) if s.is_success() => (StatusCode::OK, Json(trigger_status(&v))),
        Ok((s, v)) => upstream_error(s, &v),
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}

pub async fn delete_run(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult {
    if let Err(e) = require_system(&state, &headers).await { return e; }
    if !safe_id(&id) { return err(StatusCode::BAD_REQUEST, "bad trigger id"); }
    match gateway(reqwest::Method::DELETE, &format!("/triggers/{id}"), None).await {
        Ok((s, _)) if s.is_success() || s == StatusCode::NOT_FOUND => (StatusCode::OK, Json(json!({"ok": true}))),
        Ok((s, v)) => upstream_error(s, &v),
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> RunRequest {
        RunRequest { note: "note-1-abcd".into(), name: "Weather".into(), prompt: "weather in Tokyo".into(),
            provider: "claude".into(), model: None, dir: "/work".into(), danger: false }
    }

    #[test]
    fn rfc3339_known_instants() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(1_790_000_000), "2026-09-21T14:13:20Z");
    }

    #[test]
    fn trigger_body_shape() {
        let mut r = req();
        let b = trigger_body(&r, 0);
        assert_eq!(b["schedule"], json!({"type": "once", "at": "1970-01-01T00:00:00Z"}));
        assert_eq!(b["tags"], json!(["hyperia-sticky", "note-1-abcd"]));
        assert_eq!(b["workspace"], "/work");
        assert!(b.get("model").is_none());
        r.model = Some("opus".into());
        assert_eq!(trigger_body(&r, 0)["model"], "opus");
    }

    #[test]
    fn validate_rejects_missing_fields() {
        assert!(validate_run(&req()).is_ok());
        let mut r = req();
        r.dir = " ".into();
        assert!(validate_run(&r).is_err());
    }

    #[test]
    fn providers_fall_back_to_static() {
        let v = providers_from(None);
        assert_eq!(v.as_array().unwrap().len(), STATIC_PROVIDERS.len());
        assert!(v[0]["installed"].is_null());
        let listed = json!({"providers": [{"name": "claude", "installed": true}, "codex"]});
        let v = providers_from(Some(&listed));
        assert_eq!(v, json!([{"name": "claude", "installed": true}, {"name": "codex", "installed": null}]));
    }

    #[test]
    fn trigger_status_picks_fields() {
        let v = trigger_status(&json!({"id": "x", "last_fired": "t", "last_status": "ok"}));
        assert_eq!(v, json!({"last_fired": "t", "last_status": "ok", "last_error": null}));
    }

    #[test]
    fn safe_ids_only() {
        assert!(safe_id("a1b2-c3"));
        assert!(!safe_id("../x"));
        assert!(!safe_id(""));
    }

    #[test]
    fn find_n8_in_path_dirs() {
        let dir = std::env::temp_dir().join(format!("n8-find-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("n8-test-bin"), b"").unwrap();
        let path = std::env::join_paths([dir.clone()]).unwrap();
        assert_eq!(find_n8(path.to_str(), None, &["n8-test-bin"]), Some(dir.join("n8-test-bin")));
        assert_eq!(find_n8(path.to_str(), None, &["absent"]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
