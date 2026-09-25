//! Local, offline text-to-speech via Kokoro-82M (ort/ONNX + pure-Rust G2P).
//!
//! Backs the `hyperia_spoken_summary` MCP tool and the `POST /api/tts` route.
//! Everything runs in-process in the sidecar — no cloud call, no telemetry. The
//! ~90 MB int8 ONNX model + voice pack are downloaded to `~/.hyperia/kokoro/` on
//! first synthesis and cached thereafter.
//!
//! Loading the ONNX session is expensive (hundreds of ms), so ONE [`KokoroEngine`]
//! is built lazily and reused across every call via a [`tokio::sync::OnceCell`].

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use tokio::sync::{Mutex, OnceCell};

/// Kokoro V1.0 model assets. CPU inference only; ~120 MB total across the two
/// files. Each is fetched from OUR CDN first (hyperia.nuts.services, served off
/// our own Cloud Run site) and only falls back to the crate's upstream GitHub
/// release if that fails — first URL that succeeds wins.
const ONNX_URLS: &[&str] = &[
    "https://hyperia.nuts.services/models/kokoro-v1.0.int8.onnx",
    "https://github.com/mzdk100/kokoro/releases/download/V1.0/kokoro-v1.0.int8.onnx",
];
const VOICES_URLS: &[&str] = &[
    "https://hyperia.nuts.services/models/voices.bin",
    "https://github.com/mzdk100/kokoro/releases/download/V1.0/voices.bin",
];

const ONNX_FILE: &str = "kokoro-v1.0.int8.onnx";
const VOICES_FILE: &str = "voices.bin";

/// Native output format of Kokoro: 24 kHz mono `f32`.
const SAMPLE_RATE: u32 = 24_000;

/// Process-wide, lazily-loaded engine. Reused across calls — building it loads
/// the ONNX session, which is the expensive part. A failed init leaves the cell
/// empty so the next call retries (a transient download/load error is not fatal).
static ENGINE: OnceCell<Arc<KokoroEngine>> = OnceCell::const_new();

/// Process-wide serialization lock for audio playback. Spoken summaries
/// synthesize in parallel, but playback is serialized process-wide so concurrent
/// summaries never overlap or cut each other off (epic #162 bug M).
static PLAYBACK_MUTEX: Mutex<()> = Mutex::const_new(());

/// Number of spoken summaries currently in flight (synthesizing or waiting to play).
static PLAYBACK_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Sane bounds on the playback queue: max concurrent summaries in flight and max wait.
pub const DEFAULT_MAX_PLAYBACK_QUEUE: usize = 8;
pub const DEFAULT_PLAYBACK_TIMEOUT_SECS: u64 = 120;

fn max_playback_queue() -> usize {
    crate::ghost::api::read_shared_config()["config"]["tts"]["maxQueue"]
        .as_u64()
        .map(|n| n.clamp(1, 32) as usize)
        .unwrap_or(DEFAULT_MAX_PLAYBACK_QUEUE)
}

fn playback_timeout() -> std::time::Duration {
    let secs = crate::ghost::api::read_shared_config()["config"]["tts"]["timeoutSecs"]
        .as_u64()
        .map(|n| n.clamp(5, 600))
        .unwrap_or(DEFAULT_PLAYBACK_TIMEOUT_SECS);
    std::time::Duration::from_secs(secs)
}

// This module is independent of Hyperia: lift it with its verified lexicon loader into
// a standalone crate. Downloads, radio framing and playback stay outside it.
mod kokoro {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use anyhow::{anyhow, Context, Result};
    use tokio::sync::Mutex;

    /// Kokoro v1.0 accepts at most 512 IDs, including boundary tokens.
    const MAX_MODEL_TOKENS: usize = 512;
    pub(super) type VoicePacks = std::collections::HashMap<String, Vec<Vec<Vec<f32>>>>;

    pub(super) struct KokoroEngine {
        pub(super) model: Mutex<ort::session::Session>,
        pub(super) voices: VoicePacks,
        g2p: [Arc<misaki_rs::G2P>; 2],
    }

    /// Decode verified reference maps; no Python or bundled lexicon data.
    fn g2p_from_lexicons(language: misaki_rs::Language, gold: &str, silver: &str) -> Result<misaki_rs::G2P> {
        let mut g2p = misaki_rs::G2P::new(language);
        g2p.lexicon.golds = serde_json::from_str(gold).context("decode reference gold lexicon")?;
        g2p.lexicon.silvers = serde_json::from_str(silver).context("decode reference silver lexicon")?;
        anyhow::ensure!(!g2p.lexicon.golds.is_empty() && !g2p.lexicon.silvers.is_empty(),
            "reference lexicons must not be empty");
        Ok(g2p)
    }

    /// Pins and digests from resources/tts/PROVENANCE.md (Misaki 0.9.4).
    pub(super) const LEXICONS: [(&str, usize, &str); 4] = [
        ("us_gold.json", 3000469, "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f"),
        ("us_silver.json", 3099517, "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475"),
        ("gb_gold.json", 2838552, "29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71"),
        ("gb_silver.json", 3663898, "48131e2d92ccc41655f4543e87e0f938e71463eb5a54be7f0693bb712ebb6bce"),
    ];
    pub(super) const LEXICON_BASE: &str =
        "https://huggingface.co/datasets/hexgrad/misaki/resolve/b65a6b4398e053983b9c360f0682b720e362859d";

    pub(super) fn verify_lexicon(bytes: &[u8], asset: &(&str, usize, &str)) -> Result<()> {
        use sha2::{Digest, Sha256};
        let digest = format!("{:x}", Sha256::digest(bytes));
        anyhow::ensure!(digest == asset.2, "{} sha256 mismatch: expected {}, got {}",
            asset.0, asset.2, digest);
        anyhow::ensure!(bytes.len() == asset.1, "{} byte size mismatch", asset.0);
        Ok(())
    }

    fn load_g2p(dir: &Path) -> Result<[Arc<misaki_rs::G2P>; 2]> {
        let mut maps = Vec::new();
        for asset in &LEXICONS {
            let bytes = std::fs::read(dir.join(asset.0))
                .with_context(|| format!("read {}", asset.0))?;
            verify_lexicon(&bytes, asset)?;
            maps.push(String::from_utf8(bytes).context("lexicon is not UTF-8")?);
        }
        Ok([
            Arc::new(g2p_from_lexicons(misaki_rs::Language::EnglishUS, &maps[0], &maps[1])?),
            Arc::new(g2p_from_lexicons(misaki_rs::Language::EnglishGB, &maps[2], &maps[3])?),
        ])
    }

    #[cfg(test)]
    pub(super) fn phonemize(text: &str, british: bool) -> Result<String> {
        static MAPS: std::sync::LazyLock<Result<[Arc<misaki_rs::G2P>; 2]>> =
            std::sync::LazyLock::new(|| {
                let dir = std::env::var_os("HYPERIA_MISAKI_DIR")
                    .context("set HYPERIA_MISAKI_DIR to the pinned local lexicons; tests never download")?;
                load_g2p(Path::new(&dir))
            });
        let maps = MAPS.as_ref().map_err(|e| anyhow!("{e:#}"))?;
        phonemize_with(text, &maps[usize::from(british)])
    }

    /// Normalize English numbers before G2P; avoid float rounding and silent digits.
    pub(super) fn normalize_english(text: &str) -> Result<String> {
        use std::sync::LazyLock;
        static NUMBERS: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?(?:st|nd|rd|th)?").unwrap()
        });
        let mut expanded = String::new();
        let mut last = 0;
        for mat in NUMBERS.find_iter(text) {
            let prefix = &text[last..mat.start()];
            let signed = prefix.strip_suffix('-').or_else(|| prefix.strip_suffix('−'));
            if let Some(before) = signed.filter(|s| s.chars().last().is_none_or(|c| !c.is_alphanumeric())) {
                expanded.push_str(before);
                expanded.push_str(" minus ");
            } else {
                expanded.push_str(prefix);
            }
            let raw = mat.as_str().replace(',', "");
            let ordinal = ["st", "nd", "rd", "th"].iter().any(|s| raw.ends_with(s));
            let number = if ordinal { &raw[..raw.len() - 2] } else { &raw };
            let (whole, fraction) = number.split_once('.').map_or((number, None), |(a, b)| (a, Some(b)));
            let value: i64 = whole.parse().context("English number exceeds supported integer range")?;
            let builder = num2words::Num2Words::new(value);
            let words = if ordinal { builder.ordinal().to_words() }
                else if whole.len() == 4 && fraction.is_none() && signed.is_none() { builder.year().to_words() }
                else { builder.to_words() }
                .map_err(|e| anyhow!("English number normalization failed: {e:?}"))?;
            if expanded.chars().last().is_some_and(char::is_alphanumeric) {
                expanded.push(' ');
            }
            // Number hyphens separate spoken words; lexical compounds retain
            // their original hyphens for the reference's joined pronunciation.
            expanded.push_str(&words.replace('-', " "));
            if let Some(fraction) = fraction {
                expanded.push_str(" point");
                const DIGITS: [&str; 10] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
                for digit in fraction.bytes() {
                    expanded.push(' ');
                    expanded.push_str(DIGITS[(digit - b'0') as usize]);
                }
            }
            if text[mat.end()..].chars().next().is_some_and(char::is_alphanumeric) {
                expanded.push(' ');
            }
            last = mat.end();
        }
        expanded.push_str(&text[last..]);
        let mut out = String::new();
        let chars: Vec<char> = expanded.chars().collect();
        for c in chars {
            match c {
                '/' | '\\' | '_' | '−' => out.push(' '),
                '’' | '‘' => out.push('\''),
                ':' => out.push_str(" : "),
                '%' => out.push_str(" percent "),
                '&' => out.push_str(" and "),
                '@' => out.push_str(" at "),
                _ => out.push(c),
            }
        }
        Ok(out.split_whitespace().collect::<Vec<_>>().join(" "))
    }

    /// Reference fallback uses gold letter names. Initialisms join the names,
    /// demote their stresses, and retain primary stress on the final letter.
    fn spell_letters(lexicon: &misaki_rs::lexicon::Lexicon, word: &str, joined: bool) -> Result<String> {
        use misaki_rs::lexicon::PhonemeEntry;
        let mut letters = Vec::new();
        for letter in word.chars().filter(|c| c.is_alphabetic()) {
            match lexicon.golds.get(&letter.to_uppercase().to_string()) {
                Some(PhonemeEntry::Simple(phones)) => letters.push(phones.clone()),
                _ => return Err(anyhow!("no English letter pronunciation for {letter:?}")),
            }
        }
        anyhow::ensure!(!letters.is_empty(), "no letters to pronounce");
        if !joined { return Ok(letters.join(" ")); }
        let mut phones = lexicon.apply_stress(&letters.join(""), Some(0.0));
        if let Some(at) = phones.rfind('ˌ') {
            phones.replace_range(at..at + 'ˌ'.len_utf8(), "ˈ");
        }
        Ok(phones)
    }

    fn phonemize_with(text: &str, g2p: &misaki_rs::G2P) -> Result<String> {
        use misaki_rs::lexicon::{PhonemeEntry, TokenContext};
        let normalized = normalize_english(text)?;
        let (normalized, _) = g2p.preprocess_links(&normalized);
        let (_, mut tokens) = g2p.g2p(&normalized)
            .map_err(|e| anyhow!("English G2P failed: {e}"))?;
        let spans = g2p.tokenize_with_offsets(&normalized);
        anyhow::ensure!(spans.len() == tokens.len(), "G2P token alignment changed");

        // Restore noun/verb distinctions where the command grammar is explicit.
        // Apply to tagged lexicon entries, not to a list of benchmark sentences.
        for i in 0..tokens.len() {
            let word = tokens[i].text.to_lowercase();
            let tagged = matches!(g2p.lexicon.golds.get(&word), Some(PhonemeEntry::Tagged(map))
                if map.contains_key("VERB") && (map.contains_key("NOUN") || map.contains_key("DEFAULT")));
            if !tagged { continue; }
            let previous = i.checked_sub(1).map(|j| tokens[j].text.to_lowercase()).unwrap_or_default();
            let next = tokens.get(i + 1).map(|t| t.text.to_lowercase()).unwrap_or_default();
            let determiner = |word: &str| matches!(word, "the" | "a" | "an" | "this" | "that" | "my" | "your");
            if determiner(&previous) {
                tokens[i].tag = "NN".into();
            } else if determiner(&next) && (i == 0 || matches!(previous.as_str(), "then" | "please" | "and" | "." | "!" | "?" | ";")) {
                tokens[i].tag = "VB".into();
            }
        }

        // Unlike the crate's immediate-next-word heuristic, punctuation resets
        // vowel context and silent separators do not replace it.
        let mut ctx = TokenContext::default();
        for i in (0..tokens.len()).rev() {
            let token = &tokens[i];
            let word = &token.text;
            let stress = if *word == word.to_lowercase() { None }
                else if *word == word.to_uppercase() { Some(2.0) } else { Some(0.5) };
            // In upstream Misaki a selected null POS entry requests letter
            // spelling. misaki-rs incorrectly falls through to DEFAULT instead.
            let spell_tagged = match g2p.lexicon.golds.get(word) {
                Some(PhonemeEntry::Tagged(map)) => {
                    let tag = if ctx.future_vowel.is_none() && map.contains_key("None") {
                        "None"
                    } else if map.contains_key(token.tag.as_str()) {
                        token.tag.as_str()
                    } else {
                        misaki_rs::lexicon::Lexicon::get_parent_tag(&token.tag)
                    };
                    matches!(map.get(tag).or_else(|| map.get("DEFAULT")), Some(None))
                }
                _ => false,
            };
            let lexical = if spell_tagged { None } else {
                g2p.lexicon.get_word(word, &token.tag, stress, Some(&ctx)).map(|(p, _)| p)
            };
            let mut phones = if spell_tagged {
                spell_letters(&g2p.lexicon, word, true)?
            } else if let Some(phones) = lexical {
                phones
            } else if let Some(stem) = word.strip_suffix("'s").filter(|stem| stem.chars().all(|c| c.is_ascii_alphabetic())) {
                // Reference subtoken fallback separates an unknown possessive
                // stem from the unvoiced possessive suffix.
                format!("{} s", spell_letters(&g2p.lexicon, stem, false)?)
            } else if word.chars().all(|c| c.is_ascii_alphabetic()) {
                spell_letters(&g2p.lexicon, word, word.len() > 1 && *word == word.to_uppercase())?
            } else {
                token.phonemes.clone().unwrap_or_default()
            };
            if phones.contains('❓') {
                return Err(anyhow!("no English pronunciation for {word:?}"));
            }
            // A ZWJ is a notation joiner, not a Kokoro phone. Reference v1.0
            // uses T for the flap and t for the glottal stop.
            phones = phones.replace('\u{200d}', "").replace('ɾ', "T").replace('ʔ', "t");
            if word.chars().all(|c| c == '-' || c == '_') { phones.clear(); }
            for ch in phones.chars() {
                if ";:,.!?—…".contains(ch) {
                    ctx.future_vowel = None;
                    break;
                }
                if "AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ".contains(ch) {
                    ctx.future_vowel = Some(true);
                    break;
                }
                if "bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθT".contains(ch) {
                    ctx.future_vowel = Some(false);
                    break;
                }
            }
            ctx.future_to = word.eq_ignore_ascii_case("to");
            tokens[i].phonemes = Some(phones);
        }
        let mut phones = String::new();
        for (i, token) in tokens.iter().enumerate() {
            let end = spans[i].1.end;
            let next = spans.get(i + 1).map_or(normalized.len(), |(_, span)| span.start);
            // A dot immediately followed by a name is a filename/dotfile
            // separator in the reference. Sentence-final periods stay attached.
            let filename_dot = token.text == "." && end == next
                && tokens.get(i + 1).is_some_and(|next_token|
                    next_token.text.chars().next().is_some_and(char::is_alphanumeric));
            if filename_dot { phones.push(' '); }
            phones.push_str(token.phonemes.as_deref().unwrap_or(""));
            if filename_dot || normalized[end..next].chars().any(char::is_whitespace) {
                phones.push(' ');
            }
        }
        let phones = phones.split_whitespace().collect::<Vec<_>>().join(" ");
        checked_token_ids(&phones)?;
        if !phones.chars().any(|c| c.is_alphabetic()) {
            return Err(anyhow!("text contains no pronounceable English speech"));
        }
        Ok(phones)
    }

    /// The upstream tokenizer otherwise logs and silently skips unknown phones.
    pub(super) fn checked_token_ids(phones: &str) -> Result<Vec<i64>> {
        for ch in phones.chars() {
            if kokoro_tts::get_token_ids(&ch.to_string(), false).len() != 3 {
                return Err(anyhow!("unsupported Kokoro phone U+{:04X} ({ch})", ch as u32));
            }
        }
        Ok(kokoro_tts::get_token_ids(phones, false))
    }

    /// Budget by validated token count, with sentence/word boundaries preferred.
    /// A pathological single word is split by phone; no phone is discarded.
    pub(super) fn chunk_phonemes(phones: &str, pack_len: usize) -> Result<Vec<Vec<i64>>> {
        let ids = checked_token_ids(phones)?;
        // Preserve the existing v1.0 voice-pack convention: row = IDs.len() - 1.
        let max_ids = MAX_MODEL_TOKENS.min(pack_len.saturating_add(1));
        anyhow::ensure!(max_ids > 2, "voice pack has no usable styles");
        let budget = max_ids - 2;
        let body = &ids[1..ids.len() - 1];
        let mut chunks = Vec::new();
        let mut start = 0;
        while start < body.len() {
            let mut end = (start + budget).min(body.len());
            if end < body.len() {
                let range = &body[start..end];
                let boundary = range.iter().rposition(|id| matches!(id, 1..=6))
                    .or_else(|| range.iter().rposition(|id| *id == 16));
                if let Some(at) = boundary {
                    end = start + at + 1;
                }
            }
            let mut chunk = Vec::with_capacity(end - start + 2);
            chunk.push(0);
            chunk.extend_from_slice(&body[start..end]);
            chunk.push(0);
            chunks.push(chunk);
            start = end;
        }
        Ok(chunks)
    }

    #[derive(Clone, Debug, PartialEq)]
    pub(super) struct VoiceBlend {
        pub(super) parts: Vec<(String, f64)>,
    }

    impl VoiceBlend {
        pub(super) fn british(&self) -> bool {
            // Equal weights use the first explicitly supplied voice.
            let mut dominant = &self.parts[0];
            for part in &self.parts[1..] {
                if part.1 > dominant.1 { dominant = part; }
            }
            dominant.0.starts_with('b')
        }

        pub(super) fn description(&self) -> String {
            if self.parts.len() == 1 { return self.parts[0].0.clone(); }
            self.parts.iter().map(|(name, weight)| format!("{name}:{weight}"))
                .collect::<Vec<_>>().join(",")
        }

        fn pack_len(&self, packs: &VoicePacks) -> Result<usize> {
            self.parts.iter().map(|(name, _)| {
                packs.get(name).map(Vec::len).with_context(|| format!("missing voice {name}"))
            }).collect::<Result<Vec<_>>>()?.into_iter().min().context("empty voice blend")
        }

        pub(super) fn style(&self, packs: &VoicePacks, row: usize) -> Result<Vec<f32>> {
            let mut mixed = vec![0.0f64; 256];
            for (name, weight) in &self.parts {
                let style = packs.get(name).and_then(|pack| pack.get(row)).and_then(|r| r.first())
                    .with_context(|| format!("missing voice style {row} for {name}"))?;
                anyhow::ensure!(style.len() == 256 && style.iter().all(|x| x.is_finite()),
                    "invalid voice style for {name}");
                for (sum, value) in mixed.iter_mut().zip(style) {
                    *sum += f64::from(*value) * weight;
                }
            }
            Ok(mixed.into_iter().map(|x| x as f32).collect())
        }
    }

    pub(super) fn fnv1a(name: &str) -> u64 {
        name.as_bytes().iter().fold(0xcbf29ce484222325u64,
            |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3))
    }

    pub(super) fn english_names(packs: &VoicePacks) -> Vec<String> {
        let mut names: Vec<_> = packs.keys().filter(|name|
            ["af_", "am_", "bf_", "bm_"].iter().any(|prefix| name.starts_with(prefix)))
            .cloned().collect();
        names.sort();
        names
    }

    pub(super) fn resolve_voice(names: &[String], explicit: Option<&str>, requester: Option<&str>) -> Result<VoiceBlend> {
        let mut names = names.to_vec();
        names.sort();
        names.dedup();
        let check = |name: &str| -> Result<String> {
            let name = name.trim().to_ascii_lowercase();
            anyhow::ensure!(names.binary_search(&name).is_ok(),
                "unknown English voice {name:?}; valid voices: {}", names.join(", "));
            Ok(name)
        };
        if let Some(explicit) = explicit {
            if !explicit.contains(',') && !explicit.contains(':') {
                return Ok(VoiceBlend { parts: vec![(check(explicit)?, 1.0)] });
            }
            let mut parts = Vec::new();
            for part in explicit.split(',') {
                let (name, weight) = part.split_once(':').context("blend requires name:weight for each voice")?;
                let name = check(name)?;
                let weight: f64 = weight.trim().parse().context("invalid voice weight")?;
                anyhow::ensure!(weight.is_finite() && weight > 0.0, "voice weights must be finite and positive");
                anyhow::ensure!(!parts.iter().any(|(existing, _)| existing == &name), "duplicate voice {name}");
                parts.push((name, weight));
            }
            anyhow::ensure!(parts.len() >= 2, "a blend needs at least two distinct voices");
            let total: f64 = parts.iter().map(|(_, w)| *w).sum();
            // Preserve simple ratios exactly where possible; scale only when
            // the sum of otherwise finite weights overflows.
            let scale = if total.is_finite() { 1.0 } else {
                parts.iter().map(|(_, w)| *w).fold(0.0f64, f64::max)
            };
            let sum: f64 = parts.iter().map(|(_, w)| w / scale).sum();
            for (_, weight) in &mut parts {
                *weight = (*weight / scale) / sum;
                anyhow::ensure!(*weight > 0.0, "voice weight is too small to normalize");
            }
            return Ok(VoiceBlend { parts });
        }
        let Some(requester) = requester.filter(|s| !s.is_empty()) else {
            return Ok(VoiceBlend { parts: vec![(check("af_heart")?, 1.0)] });
        };
        // Defined integer arithmetic over UTF-8 and sorted names: portable across
        // processes, platforms and HashMap iteration orders. Versioned by tests.
        let mut hash = fnv1a(requester);
        let accent = if hash % 2 == 0 { 'a' } else { 'b' };
        hash /= 2;
        let family: Vec<_> = names.iter().filter(|name| name.starts_with(accent)).collect();
        anyhow::ensure!(family.len() >= 2, "voice pack needs two voices in accent {accent}");
        let first = (hash % family.len() as u64) as usize;
        hash /= family.len() as u64;
        let mut second = (hash % (family.len() - 1) as u64) as usize;
        hash /= (family.len() - 1) as u64;
        if second >= first { second += 1; }
        let milli = 550 + hash % 301;
        Ok(VoiceBlend { parts: vec![
            (family[first].to_string(), milli as f64 / 1000.0),
            (family[second].to_string(), (1000 - milli) as f64 / 1000.0),
        ] })
    }

    impl KokoroEngine {
        /// Load local assets. Asset acquisition and playback belong to the caller.
        pub async fn from_paths(model_path: PathBuf, voices_path: PathBuf, lexicon_dir: PathBuf) -> Result<Self> {
            tokio::task::spawn_blocking(move || {
                let bytes = std::fs::read(voices_path).context("read Kokoro voices")?;
                let (voices, consumed): (VoicePacks, usize) =
                    bincode::decode_from_slice(&bytes, bincode::config::standard())
                        .context("decode Kokoro voice pack")?;
                anyhow::ensure!(consumed == bytes.len(), "trailing data in Kokoro voice pack");
                let model = ort::session::Session::builder()?.commit_from_file(model_path)?;
                Ok(Self { model: Mutex::new(model), voices, g2p: load_g2p(&lexicon_dir)? })
            }).await.context("model loader task failed")?
        }

        /// Synthesize 24 kHz mono f32 audio, with no playback, config or network access.
        pub async fn synthesize(&self, text: &str, voice: &str, speed: f32) -> Result<Vec<f32>> {
            anyhow::ensure!(speed.is_finite() && (0.5..=2.0).contains(&speed), "invalid synthesis speed");
            let blend = resolve_voice(&english_names(&self.voices), Some(voice), None)?;
            let pack_len = blend.pack_len(&self.voices)?;
            let british = blend.british();
            let spoken = text.to_owned();
            let g2p = self.g2p[usize::from(british)].clone();
            let phones = tokio::task::spawn_blocking(move || phonemize_with(&spoken, &g2p))
                .await.context("English G2P task failed")??;
            let chunks = chunk_phonemes(&phones, pack_len)?;
            let mut audio = Vec::new();
            for chunk in chunks {
                audio.extend(self.synth_blend(chunk, &blend, speed).await?);
            }
            Ok(audio)
        }

        #[cfg(test)]
        pub(super) async fn synth(&self, tokens: Vec<i64>, voice: &str, speed: f32) -> Result<Vec<f32>> {
            let blend = resolve_voice(&english_names(&self.voices), Some(voice), None)?;
            self.synth_blend(tokens, &blend, speed).await
        }

        async fn synth_blend(&self, tokens: Vec<i64>, blend: &VoiceBlend, speed: f32) -> Result<Vec<f32>> {
            use ndarray::Array;
            use ort::{inputs, session::RunOptions, value::TensorRef};
            anyhow::ensure!(speed.is_finite() && (0.5..=2.0).contains(&speed), "invalid synthesis speed");
            anyhow::ensure!((3..=MAX_MODEL_TOKENS).contains(&tokens.len()), "invalid token count");
            let style = blend.style(&self.voices, tokens.len() - 1)?;
            let tokens = Array::from_shape_vec((1, tokens.len()), tokens)?;
            let style = Array::from_shape_vec((1, 256), style)?;
            let speed = Array::from_vec(vec![speed]);
            let options = RunOptions::new()?;
            let mut model = self.model.lock().await;
            let outputs = model.run_async(inputs![
                "tokens" => TensorRef::from_array_view(&tokens)?,
                "style" => TensorRef::from_array_view(&style)?,
                "speed" => TensorRef::from_array_view(&speed)?,
            ], &options)?.await?;
            let (_, samples) = outputs["audio"].try_extract_tensor::<f32>()?;
            anyhow::ensure!(!samples.is_empty() && samples.iter().all(|x| x.is_finite()),
                "Kokoro returned empty or non-finite audio");
            Ok(samples.to_vec())
        }
    }
}

use kokoro::KokoroEngine;

pub struct SpokenResult {
    pub duration_secs: f64,
    pub voice: String,
    pub engine: &'static str,
}

/// Speak `text` aloud on the host machine, blocking until playback finishes.
///
/// Voice is a pack name or weighted blend. Without one, the authenticated
/// requester's display name selects a stable blend; anonymous uses af_heart.
/// The caller must obtain requester from authentication, never the request body.
pub async fn speak(text: &str, voice: Option<&str>, speed: Option<f32>, requester: Option<&str>) -> Result<SpokenResult> {
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("text is empty"));
    }
    let speed = speed.unwrap_or(1.0);
    anyhow::ensure!(speed.is_finite(), "speed must be finite");
    let speed = speed.clamp(0.5, 2.0);

    // Queue depth bounding (epic #162 bug M): reject immediately if too many
    // spoken summaries are in flight (synthesizing or waiting to play) so a
    // flood of calls cannot queue forever or consume unbounded resources.
    let max_q = max_playback_queue();
    let in_flight = PLAYBACK_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    if in_flight >= max_q {
        PLAYBACK_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        return Err(anyhow!(
            "spoken summary playback queue is full ({max_q} summaries in flight) — try again when playback finishes"
        ));
    }
    struct InFlightGuard;
    impl Drop for InFlightGuard {
        fn drop(&mut self) {
            PLAYBACK_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let _in_flight = InFlightGuard;
    let tts = engine().await?;
    let resolved = kokoro::resolve_voice(&kokoro::english_names(&tts.voices), voice, requester)?;
    let resolved_voice = resolved.description();
    let mut used_engine = "kokoro";

    // Second engine: ElevenLabs, when a token is around (config.tts.elevenlabs
    // .token or ELEVENLABS_API_KEY). Synthesizes in the cloud, plays through
    // the SAME host playback path (pcm_24000 matches our SAMPLE_RATE exactly).
    // Kokoro stays the offline default and the fallback when the cloud call
    // fails — spoken summaries must never go silent over a network blip.
    // config.tts.engine forces it: "kokoro" | "elevenlabs" | "auto" (default).
    let audio = if let Some(cfg) = eleven_cfg() {
        match synth_eleven(&cfg, text, speed).await {
            Ok(a) => { used_engine = "elevenlabs"; a },
            Err(e) => {
                tracing::warn!(target: "tts", "ElevenLabs failed ({e}) — falling back to Kokoro");
                synth_kokoro(text, &resolved_voice, speed).await?
            }
        }
    } else {
        synth_kokoro(text, &resolved_voice, speed).await?
    };

    let secs = audio.len() as f64 / SAMPLE_RATE as f64;

    // Playback is serialized process-wide: rodio drives a cpal stream on its own
    // thread and we sleep until the buffer drains. Summaries synthesize in
    // parallel, but play sequentially to completion in arrival order.
    play_samples_serialized(audio).await?;

    Ok(SpokenResult { duration_secs: secs, voice: resolved_voice, engine: used_engine })
}

/// Synthesize audio via Kokoro ONNX model.
async fn synth_kokoro(text: &str, voice: &str, speed: f32) -> Result<Vec<f32>> {
    let tts = engine().await?;
    let started = std::time::Instant::now();
    let audio = tts.synthesize(text, voice, speed).await?;
    let took = started.elapsed();
    let secs = audio.len() as f64 / SAMPLE_RATE as f64;
    tracing::info!(
        target: "tts",
        "synth {} chars, {:?} -> {:.1}s audio ({} samples @ {} Hz)",
        text.len(),
        took,
        secs,
        audio.len(),
        SAMPLE_RATE
    );

    // Debug dump: write the raw synthesized audio to ~/.hyperia/kokoro/last.wav
    // so it can be inspected / played directly — isolating synth from playback.
    let dump = crate::fsnav::home_dir().join(".hyperia").join("kokoro").join("last.wav");
    match write_wav_16(&dump, &audio) {
        Ok(()) => tracing::info!(target: "tts", "dumped {} samples -> {}", audio.len(), dump.display()),
        Err(e) => tracing::warn!(target: "tts", "wav dump failed: {e}"),
    }

    Ok(audio)
}

/// ElevenLabs settings, resolved per call (config hot-reloads). Token from
/// `config.tts.elevenlabs.token` (or `.apiKey`) or the ELEVENLABS_API_KEY env
/// var. `config.tts.engine = "kokoro"` opts out even with a token present.
struct ElevenCfg {
    token: String,
    voice_id: String,
    model_id: String,
}

fn eleven_cfg() -> Option<ElevenCfg> {
    let cfg = crate::ghost::api::read_shared_config();
    let t = &cfg["config"]["tts"];
    let engine = t["engine"].as_str().unwrap_or("auto");
    if engine == "kokoro" {
        return None;
    }
    let token = t["elevenlabs"]["token"]
        .as_str()
        .or_else(|| t["elevenlabs"]["apiKey"].as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("ELEVENLABS_API_KEY").ok().filter(|s| !s.trim().is_empty()));
    let token = match token {
        Some(t) => t,
        None => {
            if engine == "elevenlabs" {
                tracing::warn!(
                    target: "tts",
                    "config.tts.engine=elevenlabs but no token (config.tts.elevenlabs.token or ELEVENLABS_API_KEY) — using Kokoro"
                );
            }
            return None;
        }
    };
    Some(ElevenCfg {
        token,
        // Default voice: "Rachel", ElevenLabs' stock narrator.
        voice_id: t["elevenlabs"]["voice"].as_str().unwrap_or("21m00Tcm4TlvDq8ikWAM").to_string(),
        model_id: t["elevenlabs"]["model"].as_str().unwrap_or("eleven_turbo_v2_5").to_string(),
    })
}

/// Synthesize via ElevenLabs. Requests `pcm_24000` — raw s16le mono at exactly
/// our SAMPLE_RATE, so the bytes go straight into the same `play_samples` path
/// Kokoro (and agent audio) uses. Errors bubble so the caller can fall back to Kokoro.
async fn synth_eleven(cfg: &ElevenCfg, text: &str, speed: f32) -> Result<Vec<f32>> {
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{}?output_format=pcm_24000",
        cfg.voice_id
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("build reqwest client")?;
    let mut body = serde_json::json!({"text": text, "model_id": cfg.model_id});
    if (speed - 1.0).abs() > f32::EPSILON {
        // ElevenLabs supports a narrower speed band than Kokoro.
        body["voice_settings"] = serde_json::json!({"speed": speed.clamp(0.7, 1.2)});
    }
    let resp = client
        .post(&url)
        .header("xi-api-key", &cfg.token)
        .json(&body)
        .send()
        .await
        .context("ElevenLabs request failed")?;
    if !resp.status().is_success() {
        let code = resp.status();
        let msg = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ElevenLabs HTTP {code}: {}", msg.chars().take(300).collect::<String>()));
    }
    let bytes = resp.bytes().await.context("ElevenLabs body read failed")?;
    let audio: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    if audio.is_empty() {
        return Err(anyhow!("ElevenLabs returned no audio"));
    }
    let secs = audio.len() as f64 / SAMPLE_RATE as f64;
    tracing::info!(target: "tts", "elevenlabs synth {} chars -> {:.1}s audio", text.len(), secs);
    Ok(audio)
}

/// Get (or lazily build) the shared engine.
async fn engine() -> Result<Arc<KokoroEngine>> {
    let arc = ENGINE
        .get_or_try_init(|| async {
            let (onnx, voices) = ensure_model().await?;
            tracing::info!(target: "tts", "loading Kokoro model {}", onnx.display());
            let lexicons = onnx.parent().context("model directory missing")?.join("misaki");
            ensure_lexicons(&lexicons).await?;
            let tts = KokoroEngine::from_paths(onnx, voices, lexicons).await?;
            Ok::<_, anyhow::Error>(Arc::new(tts))
        })
        .await?;
    Ok(arc.clone())
}

/// Download only absent lexicons; corrupt cached or fetched bytes are hard errors.
async fn ensure_lexicons(dir: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dir).await.context("create Misaki cache")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120)).build()?;
    for asset in &kokoro::LEXICONS {
        let path = dir.join(asset.0);
        match tokio::fs::read(&path).await {
            Ok(bytes) => { kokoro::verify_lexicon(&bytes, asset)?; }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let url = format!("{}/{}", kokoro::LEXICON_BASE, asset.0);
                let bytes = client.get(&url).send().await
                    .with_context(|| format!("download {}", asset.0))?
                    .error_for_status()?.bytes().await?;
                kokoro::verify_lexicon(&bytes, asset)?;
                // Verification precedes persistence; the final path is never partial.
                let temp = dir.join(format!("{}.{}.part", asset.0, std::process::id()));
                tokio::fs::write(&temp, &bytes).await?;
                tokio::fs::rename(&temp, &path).await?;
            }
            Err(e) => return Err(e).with_context(|| format!("read {}", asset.0)),
        }
    }
    Ok(())
}

/// Ensure the ONNX model + voice pack exist under `~/.hyperia/kokoro/`,
/// downloading them on first use. Returns `(onnx_path, voices_path)`.
pub async fn ensure_model() -> Result<(PathBuf, PathBuf)> {
    let dir = crate::fsnav::home_dir().join(".hyperia").join("kokoro");
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("create kokoro dir {}", dir.display()))?;

    let onnx = dir.join(ONNX_FILE);
    let voices = dir.join(VOICES_FILE);
    download_if_missing(&onnx, ONNX_URLS).await?;
    download_if_missing(&voices, VOICES_URLS).await?;
    Ok((onnx, voices))
}

/// Ensure `path` exists and is non-empty, downloading from the first working URL
/// in `urls` (our CDN first, upstream GitHub fallback). A file already present
/// is left untouched. Each candidate is tried in order; the first success wins,
/// and only the last error surfaces if every URL fails.
async fn download_if_missing(path: &Path, urls: &[&str]) -> Result<()> {
    if let Ok(meta) = tokio::fs::metadata(path).await {
        if meta.len() > 0 {
            tracing::debug!(
                target: "tts",
                "kokoro asset present: {} ({} bytes)",
                path.display(),
                meta.len()
            );
            return Ok(());
        }
    }

    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        match fetch_url(path, url).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::warn!(target: "tts", "download from {url} failed, trying next: {e:#}");
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no download URLs configured for {}", path.display())))
}

/// Stream one `url` to `path`. Writes to a `.part` sibling and renames on
/// completion, so an interrupted download never leaves a truncated file that the
/// "non-empty" check would later accept.
async fn fetch_url(path: &Path, url: &str) -> Result<()> {
    tracing::info!(target: "tts", "downloading kokoro asset {} -> {}", url, path.display());

    // Uses rustls (reqwest is built with rustls-tls, default-features off).
    let client = reqwest::Client::builder()
        .build()
        .context("build reqwest client")?;
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url} returned an error status"))?;
    let total = resp.content_length();

    let tmp = path.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {}", tmp.display()))?;

    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_log: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("streaming {url}"))?;
        file.write_all(&chunk).await.context("write chunk")?;
        downloaded += chunk.len() as u64;
        // Log roughly every 8 MB so a slow ~90 MB pull shows progress.
        if downloaded - last_log >= 8 * 1024 * 1024 {
            last_log = downloaded;
            match total {
                Some(t) => tracing::info!(target: "tts", "  {} / {} bytes", downloaded, t),
                None => tracing::info!(target: "tts", "  {} bytes", downloaded),
            }
        }
    }
    file.flush().await.context("flush download")?;
    drop(file);

    tokio::fs::rename(&tmp, path)
        .await
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    tracing::info!(target: "tts", "downloaded {} ({} bytes)", path.display(), downloaded);
    Ok(())
}

/// Reduce a pane/agent display name to a short *spokenable* callsign: the part
/// before any " | <process>" suffix, letters + apostrophes only (drops emoji,
/// digits, punctuation), whitespace-collapsed.
/// `"Severe Booby 🥐 | Nemesis8 Danger"` → `"Severe Booby"`;
/// `"Prior Sloth 🦥"` → `"Prior Sloth"`.
pub fn spokenable_name(raw: &str) -> String {
    let head = raw.split('|').next().unwrap_or(raw);
    let cleaned: String = head
        .chars()
        .map(|c| if c.is_alphabetic() || c == '\'' { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// An agent identity label as a callsign, when the agent has no pane to speak
/// as: drop the namespace (`nemesis8/`), a per-session suffix (`·cdf123`) and
/// the `n8-` container prefix. `"nemesis8/n8-quiet-wren·cdf123"` → `"quiet wren"`.
pub fn agent_callsign(label: &str) -> String {
    let base = label.split('·').next().unwrap_or(label);
    let base = base.rsplit('/').next().unwrap_or(base);
    let base = base.strip_prefix("n8-").unwrap_or(base);
    spokenable_name(base)
}

/// Wrap `text` in a radio-transmission frame addressed from `caller` to
/// `recipient`:
/// `"{recipient}, {recipient}, this is {caller} transmitting. {text}. This is
/// {caller}. Over and out."`
///
/// (It used to say "Oh ver" to dodge the old CMUdict G2P dropping over's ER
/// vowel; the misaki G2P pronounces "over" correctly, and the respelling was
/// heard literally.)
pub fn radio_wrap(recipient: &str, caller: &str, text: &str) -> String {
    // Strip trailing sentence punctuation from the body so the frame reads
    // cleanly ("… transmitting. <text>. This is …").
    let body = text.trim().trim_end_matches(['.', ',', '!', '?', ';', ':', ' ']);
    format!(
        "{recipient}, {recipient}, this is {caller} transmitting. {body}. This is {caller}. Over and out."
    )
}

/// Write mono `f32` samples as a 16-bit PCM WAV at [`SAMPLE_RATE`] (no deps —
/// hand-rolled 44-byte header + LE i16 samples). Used to dump synthesized audio
/// for inspection / direct playback.
fn write_wav_16(path: &Path, samples: &[f32]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data_len = (samples.len() as u32) * 2; // 16-bit mono
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?; // PCM fmt chunk size
    f.write_all(&1u16.to_le_bytes())?; // audio format = PCM
    f.write_all(&1u16.to_le_bytes())?; // channels = mono
    f.write_all(&SAMPLE_RATE.to_le_bytes())?; // sample rate
    f.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?; // byte rate = rate * blockalign
    f.write_all(&2u16.to_le_bytes())?; // block align = channels * (bits/8)
    f.write_all(&16u16.to_le_bytes())?; // bits per sample
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

/// Play a mono `f32` buffer at [`SAMPLE_RATE`] on the default output device.
/// Blocking — call from `spawn_blocking`.
fn play_samples(audio: Vec<f32>) -> Result<()> {
    use rodio::buffer::SamplesBuffer;
    use rodio::{DeviceSinkBuilder, Player};
    use std::num::NonZero;

    // The device handle owns the underlying cpal stream; it MUST stay alive
    // until playback finishes or the device closes mid-sound.
    let handle = DeviceSinkBuilder::open_default_sink()
        .map_err(|e| anyhow!("open default audio output: {e}"))?;
    let player = Player::connect_new(handle.mixer());

    let channels = NonZero::new(1u16).expect("1 channel is non-zero");
    let rate = NonZero::new(SAMPLE_RATE).expect("sample rate is non-zero");
    let buffer = SamplesBuffer::new(channels, rate, audio);

    player.append(buffer);
    player.sleep_until_end(); // blocks until the buffer has fully played
    drop(handle);
    Ok(())
}

/// Play audio samples through rodio on the host machine, serialized process-wide.
///
/// Ensures only one spoken summary plays at a time so concurrent calls never
/// overlap or cut each other off (epic #162 bug M). Calls line up in FIFO order
/// and wait up to `playback_timeout()` to acquire the playback mutex.
async fn play_samples_serialized(audio: Vec<f32>) -> Result<()> {
    let timeout = playback_timeout();
    let lock_res = tokio::time::timeout(timeout, PLAYBACK_MUTEX.lock()).await;
    let _guard = lock_res.map_err(|_| {
        anyhow!(
            "timed out waiting for previous spoken summary playback after {}s",
            timeout.as_secs()
        )
    })?;

    tokio::task::spawn_blocking(move || play_samples(audio))
        .await
        .context("playback task join failed")??;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::kokoro::*;

    #[test]
    fn agent_callsign_drops_namespace_session_suffix_and_n8_prefix() {
        assert_eq!(agent_callsign("nemesis8/n8-quiet-wren·cdf123"), "quiet wren");
        assert_eq!(agent_callsign("nemesis8/n8-jade-lemur"), "jade lemur");
        assert_eq!(agent_callsign("host-claude"), "host claude");
        assert_eq!(agent_callsign("host-claude·a1b2c3"), "host claude");
    }

    #[test]
    fn radio_frame_signs_off_with_plain_over() {
        let spoken = radio_wrap("base", "Continued Alpaca", "Antigravity online.");
        assert!(spoken.ends_with("This is Continued Alpaca. Over and out."), "{spoken}");
        assert!(!spoken.to_lowercase().contains("oh ver"));
    }

    fn test_voice_names() -> Vec<String> {
        ["af_bella", "af_heart", "am_adam", "bf_emma", "bm_george", "bm_lewis"]
            .into_iter().map(str::to_string).collect()
    }

    #[test]
    fn tts_default_voice_is_stable_across_processes() {
        assert_eq!(fnv1a("hello"), 0xa430d84680aabd0b);
        let names = test_voice_names();
        let voice = resolve_voice(&names, None, Some("Clear Bee")).unwrap();
        assert_eq!(voice.description(), "af_bella:0.763,am_adam:0.237");
        assert_eq!(voice, resolve_voice(&names, None, Some("Clear Bee")).unwrap());
        let mut reversed = names.clone();
        reversed.reverse();
        assert_eq!(voice, resolve_voice(&reversed, None, Some("Clear Bee")).unwrap());
        assert_eq!(resolve_voice(&names, None, Some("alice")).unwrap().description(),
            "bm_lewis:0.702,bm_george:0.298");
        if std::env::var_os("HYPERIA_TTS_HASH_CHILD").is_none() {
            // Invoke this test in fresh processes: no asset download or inference.
            for _ in 0..2 {
                let result = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "tts::tests::tts_default_voice_is_stable_across_processes"])
                    .env("HYPERIA_TTS_HASH_CHILD", "1").output().unwrap();
                assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            }
        }
    }

    #[test]
    fn tts_default_blends_have_spread_and_same_accent() {
        let names = test_voice_names();
        let mut distinct = std::collections::HashSet::new();
        for i in 0..64 {
            let blend = resolve_voice(&names, None, Some(&format!("Sample pane {i}"))).unwrap();
            assert_eq!(blend.parts.len(), 2);
            assert_ne!(blend.parts[0].0, blend.parts[1].0);
            assert_eq!(blend.parts[0].0.as_bytes()[0], blend.parts[1].0.as_bytes()[0]);
            assert!((0.55..=0.85).contains(&blend.parts[0].1));
            assert!((blend.parts.iter().map(|p| p.1).sum::<f64>() - 1.0).abs() < 1e-12);
            assert_eq!(blend.british(), blend.parts[0].0.starts_with('b'));
            distinct.insert(blend.description());
        }
        assert!(distinct.len() >= 50, "only {} distinct blends", distinct.len());
    }

    #[test]
    fn tts_explicit_voice_overrides_and_validates() {
        let names = test_voice_names();
        let blend = resolve_voice(&names, Some("af_heart:6,bf_emma:4"), Some("alice")).unwrap();
        assert_eq!(blend.description(), "af_heart:0.6,bf_emma:0.4");
        assert!(!blend.british());
        assert!(resolve_voice(&names, Some("af_heart:1,bf_emma:3"), None).unwrap().british());
        assert_eq!(resolve_voice(&names, Some("BF_EMMA"), Some("Clear Bee")).unwrap().description(), "bf_emma");
        assert_eq!(resolve_voice(&names, None, None).unwrap().description(), "af_heart");
        let error = resolve_voice(&names, Some("missing"), None).unwrap_err().to_string();
        for name in &names { assert!(error.contains(name)); }
        for invalid in ["", "af_heart:1", "af_heart:NaN,bf_emma:1", "af_heart:inf,bf_emma:1",
            "af_heart:-1,bf_emma:2", "af_heart:0,bf_emma:1", "af_heart:1,af_heart:1",
            "af_heart:1,missing:1", "af_heart,bf_emma"] {
            assert!(resolve_voice(&names, Some(invalid), None).is_err(), "{invalid}");
        }
        let three = resolve_voice(&names, Some("af_heart:2,bf_emma:3,am_adam:5"), None).unwrap();
        assert_eq!(three.parts.len(), 3);
        assert!((three.parts.iter().map(|p| p.1).sum::<f64>() - 1.0).abs() < 1e-12);
        assert!(!three.british());
        let pinned = resolve_voice(&names, Some(&blend.description()), None).unwrap();
        assert_eq!(pinned, blend);
    }

    #[test]
    fn tts_discovers_all_english_pack_voices_and_mixes_styles() {
        let mut packs = VoicePacks::new();
        for (prefix, count) in [("af", 11), ("am", 9), ("bf", 4), ("bm", 4)] {
            for i in 0..count { packs.insert(format!("{prefix}_sample{i}"), vec![vec![vec![1.0; 256]]]); }
        }
        packs.insert("jf_other".into(), vec![]);
        let names = english_names(&packs);
        assert_eq!(names.len(), 28);
        for name in &names {
            assert_eq!(resolve_voice(&names, Some(name), None).unwrap().description(), *name);
        }
        packs.insert("af_heart".into(), vec![vec![vec![2.0; 256]]]);
        packs.insert("am_adam".into(), vec![vec![vec![6.0; 256]]]);
        let blend = resolve_voice(&english_names(&packs), Some("af_heart:3,am_adam:1"), None).unwrap();
        assert_eq!(blend.style(&packs, 0).unwrap(), vec![3.0; 256]);
        assert!(blend.style(&packs, 1).is_err());
        packs.get_mut("am_adam").unwrap()[0][0].pop();
        assert!(blend.style(&packs, 0).is_err());
    }

    #[test]
    fn tts_lexicon_corruption_is_a_hard_error() {
        use sha2::{Digest, Sha256};
        let good = b"verified bytes";
        let digest = format!("{:x}", Sha256::digest(good));
        let asset = ("fixture.json", good.len(), digest.as_str());
        verify_lexicon(good, &asset).unwrap();
        let mut corrupt = good.to_vec();
        corrupt[0] ^= 1;
        assert!(verify_lexicon(&corrupt, &asset).unwrap_err().to_string().contains("sha256 mismatch"));
        assert!(verify_lexicon(&good[..good.len()-1], &asset).is_err());
    }

    #[test]
    fn tts_english_numbers_are_complete() {
        let text = normalize_english("42 items in PR 219 and 1000 lines").unwrap();
        assert_eq!(text, "forty two items in PR two hundred nineteen and one thousand lines");
        let text = normalize_english("-5 at 3:45 PM on July 24th, 2026; 3.014").unwrap();
        assert!(text.starts_with("minus five at three : forty five PM"));
        assert!(text.contains("twenty fourth"));
        assert!(text.ends_with("three point zero one four"));
        assert!(!text.chars().any(|c| c.is_ascii_digit()));
    }

    #[test]
    fn tts_misaki_inventory_recovers_vowels() {
        for (word, expected) in [("over", "əɹ"), ("world", "ɜɹ"), ("love", "ʌ"),
            ("say", "A"), ("speech", "ʧ"), ("just", "ʤ")] {
            let phones = phonemize(word, false).unwrap();
            assert!(phones.contains(expected), "{word}: {phones}");
            assert!(!phones.contains('ɝ'));
        }
    }

    #[test]
    fn tts_preserves_case_contractions_and_questions() {
        assert_eq!(normalize_english("I'm using the API. Is it ready?").unwrap(),
            "I'm using the API. Is it ready?");
        let phones = phonemize("don't", false).unwrap();
        assert!(phones.contains("dˈOnt"), "{phones}");
        assert!(phonemize("Is it ready?", false).unwrap().contains('?'));
        assert_ne!(phonemize("US", false).unwrap(), phonemize("us", false).unwrap());
        for text in ["sidecar", "runtime", "/workspace/example/src/tts.rs", "MCP HTTP IDE URL"] {
            let phones = phonemize(text, false).unwrap();
            assert!(!phones.contains('❓'), "{text}: {phones}");
        }
    }

    #[test]
    fn tts_british_voice_uses_british_phones() {
        let names = vec!["bf_emma".to_string()];
        assert!(resolve_voice(&names, Some("BF_EMMA"), None).unwrap().british());
        assert_ne!(phonemize("water", false).unwrap(), phonemize("water", true).unwrap());
    }

    #[test]
    fn tts_heteronyms_use_sentence_context() {
        let phones = phonemize("Record the record, then present the present to the subject.", false).unwrap();
        assert!(phones.starts_with("ɹəkˈɔɹd"), "{phones}");
        assert!(phones.contains("ɹˈɛkəɹd"), "{phones}");
        assert!(phones.contains("pɹizˈɛnt"), "{phones}");
        assert!(phones.contains("pɹˈɛzᵊnt"), "{phones}");
    }

    #[test]
    fn tts_unknown_phones_and_empty_speech_fail_explicitly() {
        assert!(checked_token_ids("ɝ").is_err());
        assert!(checked_token_ids("hello❓").is_err());
        assert!(phonemize("", false).is_err());
        assert!(phonemize("...?!", false).is_err());
    }

    #[test]
    fn tts_token_budget_preserves_every_phone() {
        for phones in ["a".repeat(2000), "həlˈO wˈɜɹld. ".repeat(150)] {
            let original = checked_token_ids(&phones).unwrap();
            let chunks = chunk_phonemes(&phones, 512).unwrap();
            assert!(chunks.len() > 1);
            let flattened: Vec<_> = chunks.iter().flat_map(|c| c[1..c.len()-1].iter().copied()).collect();
            assert_eq!(flattened, original[1..original.len()-1]);
            assert!(chunks.iter().all(|c| c.len() <= 512 && c[0] == 0 && c[c.len()-1] == 0));
        }
        assert!(chunk_phonemes("hello", 1).is_err());
        assert!(chunk_phonemes("hello", 4).unwrap().iter().all(|c| c.len() <= 5));
    }

    fn chunk_for_synth(text: &str, max_chars: usize) -> Vec<String> {
        let text = text.trim();
        if text.chars().count() <= max_chars {
            return vec![text.to_string()];
        }
        let is_sentence_end = |c: char| matches!(c, '.' | '!' | '?' | ';' | ':');
        let mut chunks: Vec<String> = Vec::new();
        let mut cur = String::new();
        for word in text.split_whitespace() {
            // Hard-split a pathologically long single "word" (URL, base64, etc.).
            if word.chars().count() > max_chars {
                let t = cur.trim();
                if !t.is_empty() {
                    chunks.push(t.to_string());
                }
                cur.clear();
                let mut buf = String::new();
                for ch in word.chars() {
                    if buf.chars().count() >= max_chars {
                        chunks.push(std::mem::take(&mut buf));
                    }
                    buf.push(ch);
                }
                cur = buf;
                continue;
            }
            if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > max_chars {
                chunks.push(std::mem::take(&mut cur));
            }
            if !cur.is_empty() {
                cur.push(' ');
            }
            cur.push_str(word);
            // Break on a natural boundary once the chunk is reasonably full.
            if cur.chars().count() >= max_chars * 3 / 5 && word.ends_with(is_sentence_end) {
                chunks.push(std::mem::take(&mut cur));
            }
        }
        let t = cur.trim();
        if !t.is_empty() {
            chunks.push(t.to_string());
        }
        if chunks.is_empty() {
            chunks.push(text.to_string());
        }
        chunks
    }

    #[test]
    fn tts_matches_all_reference_vectors_exactly() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plan/tts-quality/g2p_vectors.json");
        let vectors: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mut failures = Vec::new();
        for row in vectors["sentences"].as_array().unwrap() {
            let id = row["id"].as_str().unwrap();
            let text = row["text"].as_str().unwrap();
            let expected = row["phonemes"].as_str().unwrap();
            let ids: Vec<i64> = serde_json::from_value(row["token_ids"].clone()).unwrap();
            assert_eq!(checked_token_ids(expected).unwrap(), ids, "reference IDs: {id}");
            match phonemize(text, false) {
                Ok(actual) if actual == expected => {
                    assert_eq!(checked_token_ids(&actual).unwrap(), ids, "{id}");
                }
                Ok(actual) => failures.push(format!("{id}\nexpected: {expected}\nactual:   {actual}")),
                Err(error) => failures.push(format!("{id}: {error:#}")),
            }
        }
        assert!(failures.is_empty(), "{} vector mismatches:\n{}", failures.len(), failures.join("\n\n"));
    }

    /// Offline A/B runner: explicit local assets only, never downloads or plays.
    /// TTS_AB_MODEL, TTS_AB_VOICES, TTS_AB_SENTENCES, TTS_AB_OUTPUT are required.
    /// TTS_AB_FRONTEND=old selects the old crate's G2P; default is misaki.
    #[tokio::test]
    #[ignore = "requires local model/voices and an explicit output directory"]
    async fn tts_export_audio() -> Result<()> {
        let model_path = PathBuf::from(std::env::var("TTS_AB_MODEL")?);
        let voices_path = PathBuf::from(std::env::var("TTS_AB_VOICES")?);
        let sentences_path = PathBuf::from(std::env::var("TTS_AB_SENTENCES")?);
        let output = PathBuf::from(std::env::var("TTS_AB_OUTPUT")?);
        let old = std::env::var("TTS_AB_FRONTEND").as_deref() == Ok("old");
        let rows: serde_json::Value = serde_json::from_slice(&std::fs::read(sentences_path)?)?;
        std::fs::create_dir_all(&output)?;
        let legacy = if old { Some(kokoro_tts::KokoroTts::new(&model_path, &voices_path).await?) } else { None };
        let lexicons = PathBuf::from(std::env::var("HYPERIA_MISAKI_DIR")?);
        let engine = KokoroEngine::from_paths(model_path.clone(), voices_path, lexicons).await?;
        let pack = engine.voices.get("af_heart").context("missing af_heart")?;
        for row in rows.as_array().context("sentence array required")? {
            let id = row["id"].as_str().context("sentence id required")?;
            anyhow::ensure!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "unsafe sentence id");
            let text = row["text"].as_str().context("sentence text required")?;
            let phones = if old { kokoro_tts::g2p(&text.to_lowercase(), false)? } else { phonemize(text, false)? };
            let started = std::time::Instant::now();
            let (audio, chunk_tokens) = if let Some(ref legacy) = legacy {
                // Old front-end comparison uses the original character chunks.
                let mut audio = Vec::new();
                let text = text.to_lowercase();
                let chunks = chunk_for_synth(&text, 250);
                for chunk in &chunks {
                    anyhow::ensure!(chunk.chars().count() <= 250, "old-path oversized word");
                    audio.extend(legacy.synth(chunk, kokoro_tts::Voice::AfHeart(1.0)).await?.0);
                }
                // The old crate randomizes pronunciations internally; its exact
                // synthesis tokens are private, so do not pretend to capture them.
                (audio, vec![Vec::<i64>::new(); chunks.len()])
            } else {
                let chunks = chunk_phonemes(&phones, pack.len())?;
                let mut audio = Vec::new();
                for chunk in &chunks {
                    audio.extend(engine.synth(chunk.clone(), "af_heart", 1.0).await?);
                }
                (audio, chunks)
            };
            let elapsed = started.elapsed().as_secs_f64();
            let raw: Vec<u8> = audio.iter().flat_map(|sample| sample.to_le_bytes()).collect();
            std::fs::write(output.join(format!("{id}.f32le")), raw)?;
            write_wav_16(&output.join(format!("{id}.wav")), &audio)?;
            let peak = audio.iter().map(|x| x.abs()).fold(0.0f32, f32::max);
            let metadata = serde_json::json!({
                "id": id, "text": text, "frontend": if old { "kokoro-cmudict" } else { "misaki-rs" },
                "phonemes": if old { None } else { Some(&phones) },
                "token_ids": if old { None } else { Some(kokoro_tts::get_token_ids(&phones, false)) },
                "chunk_token_ids": if old { None } else { Some(&chunk_tokens) },
                "legacy_tokens_unavailable": old,
                "sample_rate": SAMPLE_RATE, "voice": "af_heart", "speed": 1.0,
                "model": model_path.file_name().and_then(|n| n.to_str()),
                "chunks": chunk_tokens.len(), "samples": audio.len(), "duration_s": audio.len() as f64 / SAMPLE_RATE as f64,
                "elapsed_s": elapsed, "raw_peak": peak,
                "over_range_samples": audio.iter().filter(|x| x.abs() > 1.0).count(),
                "rms": (audio.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / audio.len() as f64).sqrt()
            });
            std::fs::write(output.join(format!("{id}.json")), serde_json::to_vec_pretty(&metadata)?)?;
        }
        Ok(())
    }
}
