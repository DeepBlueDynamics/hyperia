# Pure-Rust Kokoro TTS: brief

**Branch:** `feat/tts-quality` (uncommitted, swarm working) · **Goal:** make Hyperia's voice sound right, then **publish the pure-Rust Kokoro** as a standalone crate.

## Where it stands
| | |
|---|---|
| Pipeline | misaki pronunciation (G2P) → token-budget chunking → direct ONNX Runtime inference, **all Rust**. No Python, no espeak, no subprocess (checked with `cargo tree`). |
| Lexicons | misaki **0.9.4** US/GB gold+silver, **downloaded on first use** from a pinned HF revision and sha256-verified (`sidecar/resources/tts/PROVENANCE.md`). Not bundled: the data license is unstated upstream. |
| Tests | ==**12 pass · 1 fail**== (host run, pinned lexicons). Letter-spelling for unknown words, all 28 voices, per-pane hash blends, stability across processes and unknown-voice errors are green. **Last diff:** a path dot (`tts.rs`, `.hyperia`) must be a standalone ` . ` token like misaki's, not glued on. Sent to Codex; then build. |
| Fixed | =={green}dropped ER vowel ("over" → "ov")==, stray U+200D chars, number reading, heteronyms (*record* noun vs verb) |
| Model A/B | Antigravity's Rust benchmark (int8 vs fp16 vs q8f16 on identical phonemes) is still compiling; no numbers yet |
| Crate | `CRATE.md` drafted by opencode: layout, `synthesize(text, voice, speed)` API, fetch/cache, license notice |

## Voices: not the full range yet
=={red}The new pipeline recognizes only 8 voice names==; any other name **silently falls back to `af_heart`**.

| Set | In the voice pack | Supported now |
|---|---|---|
| 🇺🇸 American female (`af_*`) | 11: heart, bella, nicole, aoede, kore, sarah, sky, nova, river, jessica, alloy | heart, bella, nicole |
| 🇺🇸 American male (`am_*`) | 9: adam, echo, eric, fenrir, liam, michael, onyx, puck, santa | michael, puck |
| 🇬🇧 British female (`bf_*`) | 4: alice, emma, isabella, lily | emma |
| 🇬🇧 British male (`bm_*`) | 4: daniel, fable, george, lewis | george, lewis |
| Other languages (es, fr, hi, it, ja, pt, zh) | 26 | none: needs non-English G2P |

**Ordered (Kord approved; Codex, after the letter-spelling fix):**
1. **All 28 English voices,** resolved from the voice pack itself. `a*` voices use US phonemes and `b*` voices use GB phonemes.
2. **No silent fallback:** an unknown voice returns an error that lists the valid names.
3. **Blends** like `af_heart:0.6,am_adam:0.4`: a weighted average of style vectors, as in the research demo. Phonemes follow the dominant voice.
4. =={green}**Every pane gets its own voice:**== with no voice given, the voice is a **stable FNV-1a hash of the requesting pane's display name**. It picks a same-accent pair plus a dominant weight in 0.55–0.85. The same pane sounds the same across restarts. The name comes from the authenticated identity (a pane can't claim another's voice). An explicit voice always wins, and the resolved blend is returned so you can pin one you like.
5. **Non-English voices:** a separate effort (misaki's other-language G2P in Rust). Out of scope for this release.

## Next
1. Codex lands the letter-spelling fallback → **all green**.
2. Add the full English voice set (the proposal above).
3. host-claude reviews and builds an installer → **Kord listens** (before/after, plus the model A/B).
4. Drop the `Oh ver` workaround once *over* sounds right.
5. Publish the crate (name and timing: Kord).
