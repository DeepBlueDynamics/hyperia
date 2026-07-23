//! Agent-facing message catalog.
//!
//! Every long piece of agent-facing prose lives here, keyed by [`Msg`], so the
//! logic files stay logic. Call sites read as one line — `messages::render(
//! Msg::DriveSoftWall, &[..])` — instead of burying a screenful of copy inside a
//! match arm where it can't be reviewed, reused, or translated.
//!
//! # Locales
//!
//! Catalogs are per-locale modules exposing `get(Msg) -> Option<&'static str>`.
//! [`en`] is the source of truth: it must cover every key, and it is the fallback
//! whenever a translation is missing one. That means a partially-translated
//! locale is always safe to ship — untranslated keys degrade to English rather
//! than to an empty string or a panic.
//!
//! Adding a language is: write `messages/<tag>.rs` with a `get()` covering the
//! keys you've translated, declare the `mod`, and add one arm to [`catalog`].
//! Nothing at the call sites changes.
//!
//! # Placeholders
//!
//! Substitution uses `{{name}}`, NOT `{name}`. This is deliberate: several of
//! these messages contain literal shell/env expansions such as
//! `${HYPERIA_AGENT_TOKEN}`, and a single-brace syntax would try to substitute
//! the token name out of the very instruction telling the reader to type it.
//! Unknown placeholders are left in place rather than blanked, so a missed
//! variable shows up loudly in the output instead of silently vanishing.

mod en;

use std::sync::OnceLock;

/// Stable identifier for a piece of agent-facing prose.
///
/// Keys are behavioural, not lexical — `DriveSoftWall` names *the situation*, so
/// a translator (or a rewrite) can change every word without touching call sites.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Msg {
    // ── Received-facts preambles (what the server actually got) ──────────────
    /// No Authorization header arrived at all. No placeholders.
    AnonNoAuthHeader,
    /// A token arrived but resolves to nobody. `{{prefix}}`, `{{len}}`.
    AnonUnknownToken,

    // ── Recovery guidance, branched by where the caller runs ─────────────────
    /// Caller is on the host: fix your own MCP config. No placeholders.
    RecoveryHost,
    /// Caller is containerized: do NOT fix it in here. No placeholders.
    RecoveryContainer,

    // ── Refusals ─────────────────────────────────────────────────────────────
    /// Tried to drive its own pane. No placeholders.
    DriveRefuseHome,
    /// Drive refused for want of identity. `{{facts}}`, `{{recovery}}`.
    DriveSoftWall,
    /// Pane/tab creation refused for want of identity. `{{facts}}`, `{{recovery}}`.
    CreateSoftWall,
    /// A capability couldn't be authorized. `{{facts}}`, `{{cap}}`, `{{recovery}}`.
    CapabilitySoftWall,

    // ── Tool responses ───────────────────────────────────────────────────────
    /// request_token succeeded. `{{name}}`, `{{token}}`, `{{base}}`.
    RequestTokenMinted,
}

/// A locale catalog: resolves a key, or `None` if this locale hasn't translated it.
type Catalog = fn(Msg) -> Option<&'static str>;

/// Active locale tag, lowercased (e.g. `en`, `es`, `pt-br`). Set once at startup.
static LOCALE: OnceLock<String> = OnceLock::new();

/// Select the active locale. Called once during startup; later calls are ignored,
/// so a message's language can't change midway through a session.
pub fn set_locale(tag: &str) {
    let tag = tag.trim().to_ascii_lowercase();
    if !tag.is_empty() {
        let _ = LOCALE.set(tag);
    }
}

/// The active locale tag, defaulting to `en`.
pub fn locale() -> &'static str {
    LOCALE.get().map(String::as_str).unwrap_or("en")
}

/// Map a locale tag to its catalog, tolerating region suffixes (`pt-BR` → `pt`).
fn catalog(tag: &str) -> Option<Catalog> {
    let base = tag.split(['-', '_']).next().unwrap_or("");
    match base {
        "en" => Some(en::get as Catalog),
        _ => None,
    }
}

/// Resolve a key in the active locale, falling back to English.
///
/// English is exhaustive, so the `unwrap_or("")` is unreachable in practice; it
/// exists so a future key added to [`Msg`] but forgotten in the catalog degrades
/// to an empty message rather than panicking inside an error path.
pub fn text(key: Msg) -> &'static str {
    catalog(locale())
        .and_then(|get| get(key))
        .or_else(|| en::get(key))
        .unwrap_or("")
}

/// Resolve a key and substitute its `{{name}}` placeholders.
pub fn render(key: Msg, vars: &[(&str, &str)]) -> String {
    let mut out = text(key).to_string();
    for (name, value) in vars {
        let needle = ["{{", name, "}}"].concat();
        if out.contains(&needle) {
            out = out.replace(&needle, value);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every key must resolve in English — this is what makes fallback total.
    #[test]
    fn english_covers_every_key() {
        for key in [
            Msg::AnonNoAuthHeader,
            Msg::AnonUnknownToken,
            Msg::RecoveryHost,
            Msg::RecoveryContainer,
            Msg::DriveRefuseHome,
            Msg::DriveSoftWall,
            Msg::CreateSoftWall,
            Msg::CapabilitySoftWall,
            Msg::RequestTokenMinted,
        ] {
            assert!(en::get(key).is_some(), "en catalog missing {key:?}");
            assert!(!text(key).is_empty(), "empty text for {key:?}");
        }
    }

    #[test]
    fn render_substitutes_named_placeholders() {
        let out = render(Msg::AnonUnknownToken, &[("prefix", "hyp_agent_"), ("len", "36")]);
        assert!(out.contains("hyp_agent_"), "prefix not substituted: {out}");
        assert!(out.contains("36"), "len not substituted: {out}");
        assert!(!out.contains("{{"), "placeholder left unrendered: {out}");
    }

    /// The reason placeholders are doubled: `${HYPERIA_AGENT_TOKEN}` must survive
    /// rendering intact, or the instruction tells the reader to type the wrong thing.
    #[test]
    fn shell_expansions_survive_rendering() {
        let out = render(Msg::RecoveryHost, &[("HYPERIA_AGENT_TOKEN", "SHOULD-NOT-APPEAR")]);
        assert!(out.contains("${HYPERIA_AGENT_TOKEN}"), "env expansion was mangled");
        assert!(!out.contains("SHOULD-NOT-APPEAR"), "single-brace substitution leaked in");
    }

    #[test]
    fn unknown_locale_falls_back_to_english() {
        assert!(catalog("zz").is_none());
        assert_eq!(text(Msg::DriveRefuseHome), en::get(Msg::DriveRefuseHome).unwrap());
    }

    #[test]
    fn region_suffixes_resolve_to_base_language() {
        assert!(catalog("en-US").is_some());
        assert!(catalog("en_GB").is_some());
    }
}
