//! `open_in_browser`: an agent asks to open a web page in the human's default
//! browser. Every call asks; an approval opens that one page and grants nothing.
//!
//! Pure bookkeeping + URL checks. The consent request lives in `perms`, the
//! prompt and the open itself in `main.rs`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Consent action (also the denial-cooldown key).
pub const ACTION: &str = crate::perms::OPEN_BROWSER_ACTION;

/// Longest URL accepted. Browsers take more, but a prompt can't show it.
pub const URL_MAX: usize = 2048;

/// Longest `purpose` shown on the prompt.
pub const PURPOSE_MAX: usize = 200;

/// How long an unclaimed result is kept for the caller's follow-up call.
const OUTCOME_TTL: Duration = Duration::from_secs(600);

/// A checked page to open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// Normalised URL (IDN hosts as punycode), exactly what the OS is handed.
    pub url: String,
    /// Host (plus a non-default port) for the prompt.
    pub host: String,
}

/// Accept only a plain http(s) page. Anything else the OS would hand to another
/// program (file:, ms-settings:, a registered app's scheme), so it is refused.
pub fn parse_target(raw: &str) -> Result<Target, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("url is required".into());
    }
    if raw.len() > URL_MAX {
        return Err(format!("url is too long ({} bytes; the limit is {URL_MAX})", raw.len()));
    }
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("url must not contain spaces or control characters".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|e| format!("not a valid URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "only http:// and https:// pages can be opened (got {}:)",
            url.scheme()
        ));
    }
    // "https://bank.com@evil.example/" reads as bank.com but opens evil.example.
    if !url.username().is_empty() || url.password().is_some() {
        return Err("url must not contain a username or password".into());
    }
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return Err("url has no host".into());
    };
    let host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    Ok(Target { url: url.to_string(), host })
}

/// What an agent-supplied web-pane URL would load.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaneUrl {
    /// http(s), or scheme-less input the renderer turns into https or a search.
    Web,
    /// A local file: loading it is reading it.
    File,
    /// Any other scheme (chrome:, ms-settings:, an app's own).
    Other(String),
}

/// Classify a web-pane URL by the renderer's own rule (toNavigableUrl): only a
/// leading "scheme://" is loaded as given.
pub fn pane_url_kind(raw: &str) -> PaneUrl {
    let Some((scheme, _)) = raw.trim().split_once("://") else {
        return PaneUrl::Web;
    };
    let mut chars = scheme.chars();
    let is_scheme = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !is_scheme {
        return PaneUrl::Web;
    }
    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" => PaneUrl::Web,
        "file" => PaneUrl::File,
        other => PaneUrl::Other(other.to_string()),
    }
}

/// The agent's reason, made safe for one prompt line.
pub fn clean_purpose(raw: &str) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PURPOSE_MAX {
        return flat;
    }
    let mut out: String = flat.chars().take(PURPOSE_MAX - 1).collect();
    out.push('…');
    out
}

/// How a request ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Opened,
    Denied,
    /// Approved, but the OS could not open it.
    Failed(String),
    /// Replaced by a newer request from the same agent.
    Superseded,
}

struct Parked {
    requester: String,
    target: Target,
}

struct Done {
    requester: String,
    url: String,
    outcome: Outcome,
    at: Instant,
}

#[derive(Default)]
struct Store {
    /// perm id → the page waiting on the human.
    parked: HashMap<String, Parked>,
    /// perm id → result not yet read by the caller.
    done: HashMap<String, Done>,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));

fn store() -> std::sync::MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Hold `target` until the human answers prompt `perm_id`.
pub fn park(perm_id: &str, requester: &str, target: Target) {
    store().parked.insert(perm_id.to_string(), Parked { requester: requester.to_string(), target });
}

/// The requester's waiting prompt, if any: (perm id, page).
pub fn pending_for(requester: &str) -> Option<(String, Target)> {
    store()
        .parked
        .iter()
        .find(|(_, p)| p.requester == requester)
        .map(|(id, p)| (id.clone(), p.target.clone()))
}

/// Take the page for an answered prompt. None when it was already resolved.
pub fn take(perm_id: &str) -> Option<Target> {
    store().parked.remove(perm_id).map(|p| p.target)
}

/// Forget a waiting prompt without a result (replaced, or its pane closed).
pub fn forget(perm_id: &str) {
    store().parked.remove(perm_id);
}

/// Record how `perm_id` ended, for the waiting (or a later) call to read.
pub fn finish(perm_id: &str, requester: &str, url: &str, outcome: Outcome) {
    let mut s = store();
    let now = Instant::now();
    s.done.retain(|_, d| now.duration_since(d.at) < OUTCOME_TTL);
    s.done.insert(
        perm_id.to_string(),
        Done { requester: requester.to_string(), url: url.to_string(), outcome, at: now },
    );
}

/// Read (once) how `perm_id` ended.
pub fn take_outcome(perm_id: &str) -> Option<Outcome> {
    store().done.remove(perm_id).map(|d| d.outcome)
}

/// Read (once) an unread result for the same agent and page: the answer to a
/// call that returned "pending", so the follow-up neither re-asks nor re-opens.
pub fn take_outcome_for(requester: &str, url: &str) -> Option<Outcome> {
    let mut s = store();
    let now = Instant::now();
    s.done.retain(|_, d| now.duration_since(d.at) < OUTCOME_TTL);
    let id = s
        .done
        .iter()
        // A superseded request has no answer to report; asking again re-prompts.
        .find(|(_, d)| d.requester == requester && d.url == url && d.outcome != Outcome::Superseded)
        .map(|(id, _)| id.clone())?;
    s.done.remove(&id).map(|d| d.outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_web_pages_pass_and_are_normalised() {
        let t = parse_target("  https://Example.com/a?b=1#c ").unwrap();
        assert_eq!(t.url, "https://example.com/a?b=1#c");
        assert_eq!(t.host, "example.com");
        assert_eq!(parse_target("http://localhost:3000").unwrap().host, "localhost:3000");
        // Default ports are not shown.
        assert_eq!(parse_target("https://example.com:443/").unwrap().host, "example.com");
    }

    #[test]
    fn lookalike_hosts_are_shown_as_punycode() {
        // Cyrillic "а" in "аpple.com".
        let t = parse_target("https://\u{430}pple.com/login").unwrap();
        assert!(t.host.starts_with("xn--"), "host must be punycode, got {}", t.host);
        assert!(t.url.starts_with("https://xn--"));
    }

    #[test]
    fn anything_the_os_would_hand_to_another_program_is_refused() {
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "ms-settings:privacy",
            "mailto:a@b.c",
            "ftp://example.com/x",
            "chrome://settings",
            "\\\\server\\share\\x.exe",
            "C:\\Windows\\System32\\calc.exe",
            "example.com",
            "",
            "   ",
        ] {
            assert!(parse_target(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn credentials_spaces_and_oversize_are_refused() {
        assert!(parse_target("https://bank.com@evil.example/").is_err());
        assert!(parse_target("https://user:pw@example.com/").is_err());
        assert!(parse_target("https://example.com/a b").is_err());
        assert!(parse_target("https://example.com/\u{7}").is_err());
        assert!(parse_target("https://example.com/\nhttps://evil.example").is_err());
        let long = format!("https://example.com/{}", "a".repeat(URL_MAX));
        assert!(parse_target(&long).is_err());
    }

    #[test]
    fn web_pane_urls_are_classified_like_the_renderer_loads_them() {
        for web in ["https://example.com", "HTTP://localhost:3000/x", "example.com", "localhost:3000", "how do i exit vim"] {
            assert_eq!(pane_url_kind(web), PaneUrl::Web, "{web}");
        }
        // No "scheme://" at the start: the renderer searches for these, it doesn't load them.
        assert_eq!(pane_url_kind("javascript:alert(1)"), PaneUrl::Web);
        assert_eq!(pane_url_kind("view-source:https://example.com"), PaneUrl::Web);
        assert_eq!(pane_url_kind("file:///C:/Users/x/.hyperia/agents.json"), PaneUrl::File);
        assert_eq!(pane_url_kind(" FILE:///etc/passwd"), PaneUrl::File);
        assert_eq!(pane_url_kind("chrome://settings"), PaneUrl::Other("chrome".into()));
        assert_eq!(pane_url_kind("ms-settings://privacy"), PaneUrl::Other("ms-settings".into()));
    }

    #[test]
    fn purpose_is_one_bounded_line() {
        assert_eq!(clean_purpose("  sign in\n to\tGitHub "), "sign in to GitHub");
        let long = clean_purpose(&"x".repeat(PURPOSE_MAX * 2));
        assert_eq!(long.chars().count(), PURPOSE_MAX);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn a_parked_page_is_taken_once_and_its_result_read_once() {
        let target = parse_target("https://example.com/once").unwrap();
        park("perm-t1", "agent:t1", target.clone());
        assert_eq!(pending_for("agent:t1"), Some(("perm-t1".to_string(), target.clone())));
        assert_eq!(take("perm-t1"), Some(target.clone()));
        assert_eq!(take("perm-t1"), None);
        assert_eq!(pending_for("agent:t1"), None);

        finish("perm-t1", "agent:t1", &target.url, Outcome::Opened);
        assert_eq!(take_outcome("perm-t1"), Some(Outcome::Opened));
        assert_eq!(take_outcome("perm-t1"), None);
    }

    #[test]
    fn a_follow_up_call_reads_the_held_result_for_its_own_page_only() {
        finish("perm-t2", "agent:t2", "https://example.com/held", Outcome::Opened);
        assert_eq!(take_outcome_for("agent:other", "https://example.com/held"), None);
        assert_eq!(take_outcome_for("agent:t2", "https://example.com/else"), None);
        assert_eq!(take_outcome_for("agent:t2", "https://example.com/held"), Some(Outcome::Opened));
        assert_eq!(take_outcome_for("agent:t2", "https://example.com/held"), None);
        finish("perm-t2b", "agent:t2", "https://example.com/old", Outcome::Superseded);
        assert_eq!(take_outcome_for("agent:t2", "https://example.com/old"), None);
        assert_eq!(take_outcome("perm-t2b"), Some(Outcome::Superseded));
    }

    #[test]
    fn forgetting_a_prompt_leaves_no_result() {
        park("perm-t3", "agent:t3", parse_target("https://example.com/gone").unwrap());
        forget("perm-t3");
        assert_eq!(take("perm-t3"), None);
        assert_eq!(take_outcome("perm-t3"), None);
    }
}
