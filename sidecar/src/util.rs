//! Small shared helpers.

use std::path::PathBuf;

/// Truncate a string to at most `max_bytes`, snapping DOWN to the nearest UTF-8
/// char boundary. Plain `&s[..n]` panics with "byte index N is not a char
/// boundary" when `n` lands in the middle of a multi-byte character — and
/// terminal output / agent text is full of those (emoji, box-drawing, accents).
/// Use this anywhere a byte-bounded prefix is taken for a log line, summary, or
/// classifier snippet, so a stray Unicode char can never panic (and crash the
/// whole sidecar).
pub fn safe_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Resolve the shared Hyperia config file (`hyperia.json`).
///
/// Electron owns the authoritative path because it supports XDG config dirs
/// and a dev-only repo-local override. When Electron spawns the sidecar it
/// injects that resolved path as `HYPERIA_CONFIG_PATH`; use it first so config
/// writes hit the file Electron watches.
///
/// `~/.hyperia` remains correct for sidecar-private data such as logs, assets,
/// agents, snapshots, and tool scripts. This helper is only for the shared
/// `hyperia.json`.
pub fn shared_config_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("HYPERIA_CONFIG_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    if let Ok(mock_home) = std::env::var("HYPERIA_MOCK_HOME") {
        return Some(
            PathBuf::from(mock_home)
                .join(".hyperia")
                .join("hyperia.json"),
        );
    }

    if cfg!(test) {
        return None;
    }

    if cfg!(windows) {
        let home = std::env::var("USERPROFILE").ok()?;
        return Some(PathBuf::from(home).join(".hyperia").join("hyperia.json"));
    }

    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join("Hyperia").join("hyperia.json"));
        }
    }

    let home = std::env::var("HOME").ok()?;
    let electron_path = PathBuf::from(&home)
        .join(".config")
        .join("Hyperia")
        .join("hyperia.json");
    let legacy_path = PathBuf::from(&home).join(".hyperia").join("hyperia.json");
    if !electron_path.exists() && legacy_path.exists() {
        return Some(legacy_path);
    }

    Some(electron_path)
}

pub fn read_shared_config() -> std::io::Result<serde_json::Value> {
    let path = shared_config_path().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "could not resolve config path",
        )
    })?;
    let content = std::fs::read_to_string(path)?;
    serde_json::from_str(&content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

pub fn write_shared_config_atomic(cfg: &serde_json::Value) -> std::io::Result<()> {
    let path = shared_config_path().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "could not resolve config path",
        )
    })?;
    write_json_file_atomic(&path, cfg)
}

pub fn write_json_file_atomic(
    path: &std::path::Path,
    cfg: &serde_json::Value,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let data = serde_json::to_string_pretty(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!(
        "{}.tmp.{}.{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("json"),
        std::process::id(),
        stamp
    ));

    std::fs::write(&tmp, data.as_bytes())?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(first_err) => {
            if path.exists() {
                let _ = std::fs::remove_file(path);
                match std::fs::rename(&tmp, path) {
                    Ok(()) => Ok(()),
                    Err(second_err) => {
                        let _ = std::fs::remove_file(&tmp);
                        Err(second_err)
                    }
                }
            } else {
                let _ = std::fs::remove_file(&tmp);
                Err(first_err)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Access-token randomness.
//
// Tokens gate pane/agent control, so they must be unguessable. The OS CSPRNG
// (`getrandom`) is the reliable, cryptographically-strong base — always
// available. On top of that we XOR-mix best-effort true-random entropy from the
// sdrrand relay (https://sdrrand.nuts.services). XOR-mixing two independent
// sources can only strengthen the result: if either source is unpredictable the
// token is unpredictable, so a drained/unreachable relay never weakens us.
// ---------------------------------------------------------------------------

/// Generate a hex-encoded random token of `n_bytes` of entropy (2*n_bytes
/// chars). CSPRNG base + best-effort sdrrand mix.
pub async fn random_token(n_bytes: usize) -> String {
    let mut buf = vec![0u8; n_bytes];
    if getrandom::getrandom(&mut buf).is_err() {
        // getrandom failing is near-impossible on a real OS; degrade to a
        // time-seeded fill rather than panic so token minting never aborts.
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((t >> ((i % 16) * 8)) as u8) ^ (i as u8).wrapping_mul(31);
        }
    }
    if let Some(sdr) = fetch_sdrrand(n_bytes).await {
        for (b, s) in buf.iter_mut().zip(sdr.iter()) {
            *b ^= *s;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve the sdrrand relay base URL. Precedence:
///   1. `HYPERIA_SDRRAND_URL` env var (quick override)
///   2. `config.sdrrand.url` in the shared Hyperia config (point at a local box
///      running your own radio, e.g. "http://192.168.1.50:8088")
///   3. the public relay default
/// Set it to "off" / "none" / "disabled" to skip the relay and use the OS
/// CSPRNG alone.
fn sdrrand_base_url() -> String {
    if let Ok(u) = std::env::var("HYPERIA_SDRRAND_URL") {
        let u = u.trim();
        if !u.is_empty() {
            return u.trim_end_matches('/').to_string();
        }
    }
    if let Some(u) = read_config_str(&["config", "sdrrand", "url"]) {
        let u = u.trim();
        if !u.is_empty() {
            return u.trim_end_matches('/').to_string();
        }
    }
    "https://sdrrand.nuts.services".to_string()
}

/// Read a string value from the shared Hyperia config by dot-path keys.
fn read_config_str(path: &[&str]) -> Option<String> {
    let v = read_shared_config().ok()?;
    let mut cur = &v;
    for k in path {
        cur = cur.get(*k)?;
    }
    cur.as_str().map(|s| s.to_string())
}

/// Best-effort fetch of `n` true-random bytes from the sdrrand relay (local or
/// public, per config). Short timeout; returns None on any failure (disabled,
/// unreachable, drained pool, bad body) so the caller falls back to the CSPRNG
/// base alone.
async fn fetch_sdrrand(n: usize) -> Option<Vec<u8>> {
    let base = sdrrand_base_url();
    if base.eq_ignore_ascii_case("off")
        || base.eq_ignore_ascii_case("none")
        || base.eq_ignore_ascii_case("disabled")
    {
        return None;
    }
    let url = format!("{base}/api/entropy?bytes={n}&format=hex");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;
    let hex = client.get(&url).send().await.ok()?.text().await.ok()?;
    let hex = hex.trim();
    if hex.len() < n * 2 {
        return None; // pool couldn't fulfil the request
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let pair = std::str::from_utf8(&bytes[i * 2..i * 2 + 2]).ok()?;
        out.push(u8::from_str_radix(pair, 16).ok()?);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn restore_env(key: &str, value: Option<String>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn shared_config_path_prefers_explicit_env() {
        let _guard = env_lock().lock().unwrap();
        let old_path = std::env::var("HYPERIA_CONFIG_PATH").ok();
        let old_mock = std::env::var("HYPERIA_MOCK_HOME").ok();
        let explicit = std::env::temp_dir().join("hyperia-explicit-config.json");

        std::env::set_var("HYPERIA_CONFIG_PATH", &explicit);
        std::env::set_var("HYPERIA_MOCK_HOME", "/tmp/ignored-mock-home");

        assert_eq!(shared_config_path().as_deref(), Some(explicit.as_path()));

        restore_env("HYPERIA_CONFIG_PATH", old_path);
        restore_env("HYPERIA_MOCK_HOME", old_mock);
    }

    #[test]
    fn shared_config_writer_creates_parent_and_round_trips_json() {
        let _guard = env_lock().lock().unwrap();
        let old_path = std::env::var("HYPERIA_CONFIG_PATH").ok();
        let old_mock = std::env::var("HYPERIA_MOCK_HOME").ok();
        let dir = std::env::temp_dir().join(format!(
            "hyperia-config-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("nested").join("hyperia.json");
        let value = serde_json::json!({"config": {"fontSize": 18}});

        std::env::set_var("HYPERIA_CONFIG_PATH", &path);
        std::env::remove_var("HYPERIA_MOCK_HOME");

        write_shared_config_atomic(&value).expect("write should succeed");
        assert_eq!(read_shared_config().expect("read should succeed"), value);

        let _ = std::fs::remove_dir_all(&dir);
        restore_env("HYPERIA_CONFIG_PATH", old_path);
        restore_env("HYPERIA_MOCK_HOME", old_mock);
    }
}
