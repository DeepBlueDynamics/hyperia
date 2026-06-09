//! Small shared helpers.

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
///   2. `config.sdrrand.url` in ~/.hyperia/hyperia.json (point at a local box
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

/// Read a string value from ~/.hyperia/hyperia.json by dot-path keys.
fn read_config_str(path: &[&str]) -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())?;
    let p = std::path::PathBuf::from(home).join(".hyperia").join("hyperia.json");
    let txt = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
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
