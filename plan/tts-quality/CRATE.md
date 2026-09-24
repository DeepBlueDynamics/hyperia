# CRATE.md — publishing the pure-Rust Kokoro as a standalone crate

Draft design. Not yet published; host-claude and Kord decide the crate name and
when. This documents *how* the separable core in `sidecar/src/tts.rs` (`mod kokoro`)
lifts into a public crate, so we design for it now rather than retrofitting later.

The liftable core is already isolated in `tts.rs:71-328` (`mod kokoro`): it uses only
`ort`, `misaki-rs`, `kokoro-tts` (for `get_token_ids` + the v1.0 vocabulary), `ndarray`,
`bincode`, `regex`, `num2words`, `anyhow`, `tokio`. It has no Hyperia dependency —
everything Hyperia-specific (radio_wrap, playback queue, ElevenLabs fallback, config
reads, WAV debug dump) lives *outside* that module. This is the boundary the crate
mirrors.

---

## 1. Crate name (placeholder)

Working name **`kokoro-rs`** (pending host-claude/Kord). Crate name must not collide
with the existing `kokoro-tts` 0.3 on crates.io (that is the broken-CMUdict crate we are
replacing). Final name is a director decision; every reference below uses the placeholder.

## 2. Module layout

```
src/
├── lib.rs               // public API re-exports, feature-gated
├── engine.rs            // KokoroEngine: ort Session + voice packs, from_paths/from_bytes
├── synth.rs             // synthesize(text, voice, speed) -> Vec<f32>; chunk loop, style indexing
├── phonemes.rs          // checked_token_ids, chunk_phonemes (token-budget, no silent drops)
├── g2p/
│   ├── mod.rs           // phonemize(): normalize -> misaki g2p -> context fixups -> IPA string
│   ├── normalize.rs     // normalize_english(): numbers, ordinals, years, symbols (pure Rust)
│   └── lexicon.rs       // load pinned gold/silver maps (US/GB) into the tagger's lexicon
├── vocab.rs             // v1.0 token vocabulary + get_token_ids (or re-export from kokoro-tts)
└── assets/
    ├── mod.rs           // fetch + cache + sha256 verify
    └── manifest.rs      // pinned asset URLs + sha256 + sizes (compile-time table)
```

Mapping from today's `tts.rs`:
- `mod kokoro::KokoroEngine` (tts.rs:80,272) → `engine.rs`
- `KokoroEngine::synth` (tts.rs:303) + `synthesize` (tts.rs:287) → `synth.rs`
- `phonemize` (tts.rs:151) → `g2p/mod.rs`
- `normalize_english` (tts.rs:91) → `g2p/normalize.rs`
- `checked_token_ids` (tts.rs:229) + `chunk_phonemes` (tts.rs:240) → `phonemes.rs`
- asset download from `tts.rs` `ensure_model`/`download_if_missing`/`fetch_url` (kept in the
  sidecar, *not* in the core) → new `assets/` with pinned hashes (below).

## 3. Public API (small)

```rust
// The entire public surface. Everything else is crate-private.
pub const SAMPLE_RATE: u32 = 24_000;

pub struct Kokoro { engine: KokoroEngine }

impl Kokoro {
    /// Load from already-downloaded local files (no network). Caller owns acquisition.
    pub async fn from_paths(model: impl AsRef<Path>, voices: impl AsRef<Path>) -> Result<Self>;
    /// Load from in-memory bytes (embedded / already-cached assets).
    pub async fn from_bytes(model: &[u8], voices: &[u8]) -> Result<Self>;

    /// Synthesize 24 kHz mono f32 audio. No playback, no config, no network.
    pub async fn synthesize(&self, text: &str, voice: &str, speed: f32) -> Result<Vec<f32>>;
}

// Convenience: fetch (pinned) + synthesize in one call for the common path.
#[cfg(feature = "download")]
pub async fn synthesize(text: &str, voice: &str, speed: f32) -> Result<Vec<f32>>;
```

- `voice`: `"af_heart"`, `"bf_emma"`, … — a `'b'` prefix selects the GB lexicon/G2P.
- `speed`: finite, clamped to `0.5..=2.0` (reject non-finite, clamp the rest — matching
  today's `tts.rs:288,343`).
- `Result`: `anyhow::Error`-backed crate error type (or a thin `pub enum Error` wrapping
  anyhow; keep it simple, expose `anyhow` for the first release).
- Deliberately **no** playback, no radio framing, no cloud fallback, no config. Those are
  the Hyperia layer. A separate optional `playback` feature may add rodio later if the
  director wants it, but it is not core.

## 4. Feature flags

```toml
[features]
default = ["download"]

# Fetch + cache the model/voices/lexicons at runtime over HTTPS (reqwest, rustls).
# OFF lets the embedder ship the assets itself and call from_paths/from_bytes only.
download = ["dep:reqwest"]

# Compile the pinned misaki gold/silver lexicons INTO the binary via include_bytes!,
# removing any runtime lexicon fetch. Trades ~4 MB of .rlib/binary for zero network
# on the G2P path. Mutually exclusive with `download`-fetched lexicons at runtime
# (embedded wins when both are on).
embedded-lexicons = []

# CPU-only inference is the default. No CUDA feature: the current build registers a
# CUDA execution provider that silently falls back on CPU (perf noise only). Keep
# the crate CPU-only to avoid the prebuilt-ort CUDA dependency in downstream builds.
# (future) cuda = ["ort/cuda"]

# Optional playback via rodio/cpal (NOT in default). Pulls ALSA/CoreAudio/WASAPI
# platform libs, which is exactly the burden a library crate should not impose by
# default on embedders that already have their own audio path (Hyperia does).
playback = ["dep:rodio"]
```

Notes / constraints carried from the current build:
- `ort = 2.0.0-rc.12` is a pre-release. The published crate should pin the **exact**
  version it was validated against and document that downstream must provide a glibc
  whose `libc` matches the prebuilt `libonnxruntime.a` (see BUILDLOG.md: the shipped
  static lib needs glibc ≥2.38's `__isoc23_*`; Debian 12's 2.36 fails to link). This
  glibc coupling is a *publication blocker* to resolve before release — either document
  a minimum glibc, or ship a 2.36-compatible ONNX Runtime.
- `misaki-rs` data: the bundled 0.6.0 gold data is defective (U+200D leak, flattened POS —
  see g2p.md). The crate must load the **pinned Misaki 0.9.4** gold/silver maps (the
  `sidecar/resources/tts/` files Grok is adding) rather than trust misaki-rs' bundled data.

## 5. Model / voices / lexicon acquisition and caching (pinned sha256)

All runtime-fetched assets are **pinned by sha256**, not by mutable URL. The manifest is a
compile-time table in `src/assets/manifest.rs`:

```rust
pub struct Asset { pub kind: AssetKind, pub url: &'static str,
                   pub sha256: &'static str, pub size: u64 }
pub enum AssetKind { Model, Voices, LexiconUsGold, LexiconUsSilver, LexiconGbGold, LexiconGbSilver }
```

- **URL**: our CDN first (`https://hyperia.nuts.services/models/…`), upstream fallback
  (`https://github.com/mzdk100/kokoro/releases/download/V1.0/…`), first success wins —
  mirroring `tts.rs:23-33`.
- **Cache dir**: `~/.cache/kokoro-rs/<sha256-prefix>-<filename>` (or, on the host, the
  platform cache dir via a `dirs`-style lookup). Keyed by sha256 so a re-upload of the
  same name at a different hash never silently swaps content under an existing cache.
- **Integrity**: stream to `<path>.part`, sha256-verify while streaming, atomic-rename to
  the final cache path on match (same `.part`-then-rename pattern as `tts.rs:402-428`).
  On mismatch: delete the `.part`, hard error — never cache unverified bytes.
- **Lexicons** are small (tens of MB combined) and are *also* sha256-pinned; they may
  additionally be embedded via the `embedded-lexicons` feature to remove runtime fetch.
- **Offline guarantee**: with `embedded-lexicons` and model/voices already cached (or
  provided via `from_paths`/`from_bytes`), synthesis makes **no network call**. The
  `download` feature is the only code path that touches the network.
- **Model variants** (int8 default; fp16/q8f16 as documented alternates): each variant is a
  separate pinned `Asset` row with its own sha256, selected by a public enum or by the URL
  the embedder chooses. R1 ships int8; fp16/q8f16 are follow-up (CONSENSUS §D).

## 6. License and NOTICE (misaki data)

The misaki *code* is Apache-2.0; the *lexicon data* has its own provenance that must be
cleared **before any public release** (this is the director's license gate in SWARM:56-57).

- **`NOTICE`** (root of the crate, and reproduced in the binary's license blurb) must state:
  - Kokoro model weights and `voices.bin`: from hexgrad/mzdk100, Apache-2.0 (confirm exact
    license on the release tag).
  - Misaki lexicon data: source (github.com/thewh1teagle/misaki or the misaki 0.9.4 tag),
    the four files (`us_gold.json`, `us_silver.json`, `gb_gold.json`, `gb_silver.json`),
    each with its sha256, and the license under which redistribution is permitted.
  - A `PROVENANCE.md` mirror of `sidecar/resources/tts/PROVENANCE.md` (Grok is authoring):
    exact upstream URL, tag/commit, per-file sha256, and the redistribution conclusion.
- **Gate**: if any lexicon file's license is unclear or restrictive, stop and report to
  host-claude; do not ship it. The Apache-2.0 code license does **not** by itself cover the
  data. This must be resolved before `cargo publish`, and is tracked in the sidecar
  `resources/tts/` work first (SWARM:55-61).
- **Third-party crate licenses** (ort, misaki-rs, kokoro-tts, num2words, etc.) are handled
  by the normal `cargo` license metadata + a generated `THIRD_PARTY` listing; nothing
  extra for the lexicons beyond NOTICE.

## 7. README outline

1. **What**: local offline Kokoro-82M TTS, 24 kHz mono f32 out, pure Rust, no espeak, no
   subprocess, no Python.
2. **Quick start**: `Kokoro::from_paths(model, voices).await?.synthesize("hello", "af_heart", 1.0).await?`
   — or the `download` convenience one-liner.
3. **Voices**: table of `af_*` (US) / `bf_*` (GB) names; note the `b`-prefix selects GB G2P.
4. **Feature flags**: the table from §4.
5. **Asset acquisition & caching**: the §5 sha256-pinned model; cache location; offline mode.
6. **Model variants**: int8 (default) vs fp16/q8f16, sizes, spectral-correlation table
   (0.916 int8 / 0.999 fp16 — reference/FINDINGS.md), and the §D evidence link.
7. **Limitations**: heteronym/POS, OOV letter-spelling, number style (US), the `Oh ver`
   workaround status — be honest, link the ab/ evidence.
8. **License & NOTICE**: §6, with the data-provenance statement.
9. **Building**: the glibc ≥2.38 requirement for the prebuilt ONNX Runtime (BUILDLOG.md).

## 8. Publication checklist (blockers before `cargo publish`)

- [ ] Director picks the crate name; confirm no crates.io collision.
- [ ] License gate cleared: misaki lexicon data redistribution confirmed (Grok's
      PROVENANCE.md), NOTICE written.
- [ ] Pinned 0.9.4 lexicons land; `phonemize` matches `g2p_vectors.json` on all 15 sentences.
- [ ] All `tts` tests green in the runner; no U+200D leak; heteronyms distinct.
- [ ] glibc coupling resolved or documented (min glibc ≥2.38, or a 2.36-compatible ort).
- [ ] `cargo doc` clean; public surface is exactly §3 (no Hyperia types leak).
- [ ] Section-D A/B evidence published alongside (numbers + audio samples), per SWARM:66.

---

*Status: design draft only. opencode owns this file; implementation ownership of the
crate itself (when authorized) is a separate director decision.*
