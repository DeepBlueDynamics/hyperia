# Swarm order: make Hyperia's spoken voice sound good

Director: host-claude (bare metal). Report to host-claude with `msg_send` (to_label `host-claude`). Kord's verdict on the current voice: "sounds like shit".

## Hard constraint: inference stays in Rust
Hyperia's TTS runs in the Rust sidecar (ort / ONNX Runtime). **The Python `kokoro_onnx` research is a reference to measure against, NOT a design to copy.** No Python, no Python runtime, no shelling out to espeak or any external binary in the product.

Every fix lands in Rust:
- a different ONNX model file;
- a better pure-Rust G2P, either a crate or our own port of misaki's rules and lexicon;
- Rust-side text normalization for numbers, acronyms and punctuation;
- Rust audio post-processing.

Python may only be used offline, inside the container, to produce reference audio or phonemes for comparison.

## What exists
- Hyperia TTS lives in `sidecar/src/tts.rs`. It backs `hyperia_spoken_summary` and `/api/tts`.
  - Crate: `kokoro-tts` 0.3 (ort / ONNX Runtime) with feature `use-cmudict`. G2P is pure Rust: CMUdict lookup, no espeak, no misaki.
  - Model: **`kokoro-v1.0.int8.onnx`**, downloaded to `~/.hyperia/kokoro/` from `https://hyperia.nuts.services/models/…`, falling back to github mzdk100/kokoro.
  - Text is lowercased before synthesis, chunked under a phoneme ceiling, then played at 24 kHz mono f32 via rodio.
- Research, with reference audio, is in `plan/tts-quality/reference/`. Read `FINDINGS.md` first.
  - That work used Python `kokoro_onnx` with the **fp16** model and espeak-based phonemes, and it sounds good.
  - Its model comparison: int8 has spectral correlation **0.916** vs FP32. fp16 is **0.999** (163.5 MB). q8f16 is 86 MB, "high".
  - Reference wavs: `test_kokoro-v1.0.fp16.wav`, `test_kokoro-v1.0.wav`, `kokoro_bf_emma.wav`, `kokoro_af_heart_0.6_am_adam_0.4.wav`.
- Known quirk (earlier): int8 `af_heart` clips word endings ("ove" for "over"). Male voices are cleaner.

## Hypotheses (find which ones actually matter; measure, don't guess)
1. **Model precision:** int8 is the worst variant. Try q8f16 and fp16.
2. **G2P:** the CMUdict-only lookup mispronounces or drops out-of-dictionary words, numbers, acronyms and punctuation-driven prosody. Compare with espeak/misaki phonemes.
3. **Text pipeline:** lowercasing, chunk boundaries, and stripped punctuation flatten the prosody.
4. **Audio pipeline:** clipping, no normalization, missing tail/fade, a wrong sample rate or format in rodio, and truncated chunk ends.

## Assignments (edit ONLY the files you own; everyone else is read-only)
- **Codex (Clear Bee)** — implementer. **Sole writer** of `sidecar/src/tts.rs` and the tts-related lines of `sidecar/Cargo.toml`. Wait for the findings from the others, propose the change set to host-claude, then implement it. Add unit tests where possible.
- **Antigravity (Continued Alpaca)** — A/B measurement. Build a repeatable comparison in `plan/tts-quality/ab/`:
  - a fixed sentence set (numbers, acronyms like "MCP" and "PR 219", paths, questions, long sentences, and words ending in plosives);
  - reference output from the research Python tool (fp16), and Hyperia's output via the sidecar (`/api/tts`, or the `~/.hyperia/kokoro/last.wav` debug dump, or a test that writes a wav);
  - objective metrics: duration, peak/clipping, RMS, trailing silence, and spectral similarity.
  - Owns `plan/tts-quality/ab/**` only.
- **Grok (Prior Basilisk)** — G2P audit. For the same sentence set, compare the phonemes produced by the `kokoro-tts` crate's G2P against misaki/espeak (what kokoro_onnx uses). List every mispronunciation or dropped token, and report which class of text breaks: numbers, acronyms, OOV words, punctuation. Read-only; write findings to `plan/tts-quality/g2p.md`.
- **opencode (Alleged Pigeon)** — pipeline audit. Read `tts.rs` end to end: lowercasing, chunking, the phoneme ceiling, speed, sample conversion, rodio playback, and tail handling. Find anything that degrades audio (clipping, truncated endings, gaps between chunks). Read-only; write findings to `plan/tts-quality/pipeline.md`.

## GO: implement CONSENSUS.md R1 (host-claude, on Kord's order)
Kord said implement. R1 (sections A–D) is authorized as written. Grok, Antigravity and opencode: still append your R1 vote with any objections, and Codex folds them in as it goes, but don't block on votes.

| Agent | Implementation role | Owns |
|---|---|---|
| **Codex** | Implements A (misaki-rs pure-Rust G2P, direct ort inference in tts.rs), B (token-budget chunking, no silent phone drops, regression tests) and C (drop the `Oh ver` workaround after validation) | `sidecar/src/tts.rs`, tts lines of `sidecar/Cargo.toml` |
| **opencode** | **Build/test runner for Codex**, since Codex's container has no Rust toolchain. Whenever tts.rs changes: `cargo test tts` and `cargo tree -e features -i misaki-rs` (prove no espeak/subprocess deps) with `CARGO_TARGET_DIR=sidecar/target/opencode-linux`. Paste the exact errors and results into BUILDLOG.md. Also fix pipeline.md per the R1 corrections. | `plan/tts-quality/BUILDLOG.md`, `pipeline.md` |
| **Grok** | Phoneme ground truth: for all 15 sentences, write the expected misaki phonemes and token IDs (from the misaki reference) as test vectors Codex's tests can load, and check Codex's G2P output against them. | `plan/tts-quality/g2p_vectors.json`, `g2p.md` |
| **Antigravity** | Fix the harness per the R1 corrections (label the Python-simulated branch honestly, no hard-coded conclusions, keep raw-f32 metrics). Then, for section D, measure old vs new G2P on int8, then int8/fp16/q8f16 on identical phonemes, using the Rust build's output. | `plan/tts-quality/ab/**` |

Loop: Codex edits → opencode builds/tests → BUILDLOG.md → Codex fixes → … until green. Codex's mailbox is broken until the next Hyperia build (pane-token deadlock, fixed in PR #227), so **use the files as the channel**. Still no commits. When tests are green and the D measurements are in, Codex tells host-claude in CONSENSUS.md and host-claude reviews and builds.

## Director decision (host-claude): Codex's scope request APPROVED, gated on license
- **Grok** adds the pinned Misaki **0.9.4** `us_gold.json`, `us_silver.json`, `gb_gold.json` and `gb_silver.json` under `sidecar/resources/tts/`, with `LICENSE` and `PROVENANCE.md` (the exact upstream URL, the commit or tag, sha256 per file).
- **The license gate comes first:** before adding any data, Grok confirms in `PROVENANCE.md` that the misaki code (Apache-2.0) *and the lexicon data's own sources* allow redistribution in a public binary and repo. If any file's license is unclear or restrictive, stop and report it to host-claude instead of adding it.
- **Codex** deserializes the lexicons into the G2P maps in Rust. No Python and no runtime network.
  - Fix the U+200D leak (strip or map it in the phonemizer, never in the test) and the heteronym POS handling.
  - Pick ONE number style, US misaki: "two hundred nineteen". Make the test match misaki 0.9.4's output, since the vectors are the ground truth.
- **Acceptance: exact match to `g2p_vectors.json` on all 15 sentences**, plus the existing tests green in opencode's runner. Keep `Oh ver` until `over` matches `ˈOvəɹ` in audio.

## Director decision 2 (Kord: "pull the trigger"): lexicons are FETCHED on first use, never bundled
Grok's license gate held: the misaki gold/silver data has no stated data license, so **nothing is committed or rehosted.** Instead:
- **Grok:** write `sidecar/resources/tts/PROVENANCE.md` with the exact upstream URLs pinned to the Hugging Face dataset revision (`hexgrad/misaki` @ `e820629…`, full commit hash) for `us_gold.json`, `us_silver.json`, `gb_gold.json` and `gb_silver.json`. Give each file's **sha256 and byte size** (download them to compute this; do NOT add the files). Add the license uncertainty note, and add no data.
- **Codex:** in `tts.rs`, fetch the four lexicons on first synthesis, next to the existing model/voices download (`ensure_model` pattern):
  - cache them in `~/.hyperia/kokoro/misaki/`;
  - **verify sha256 before use** (mismatch = hard error, never used);
  - use the pinned revision URLs only.
  - Loading stays pure Rust (serde).
  - Tests must not hit the network. They take a lexicon directory from an env var such as `HYPERIA_MISAKI_DIR`, and the runner provides it.
  - Then load the lexicons into the G2P maps, fix U+200D and heteronym POS, and **match g2p_vectors.json exactly**.
- **opencode (runner):** download the four pinned files once into `sidecar/target/opencode-linux/misaki/`, point `HYPERIA_MISAKI_DIR` at them, and keep reporting in BUILDLOG.md.
- **Publishing later:** the standalone crate does the same fetch-with-checksum and states the upstream license status in its README. host-claude will ask hexgrad upstream to state the data license (drafted for Kord's OK).

## Director decision 3 (Kord): every pane gets its own voice, a hashed blend
The research demo blends voices (a weighted average of style vectors; see `reference/tts.py` `load_voice`). Build it in Rust:
1. **All 28 English voices,** resolved from the voice pack itself (`af_*` 11, `am_*` 9, `bf_*` 4, `bm_*` 4), not a hardcoded list.
   - **An unknown name is an error** listing the valid names. There's no silent `af_heart` fallback.
2. **Explicit blends:** `voice: "af_heart:0.6,am_adam:0.4"` (weights normalized, 2 or more voices). Phonemes follow the **dominant** voice's accent (b* → GB, a* → US).
3. **Default voice = a hash of the requesting pane's display name,** when the caller passes no `voice`:
   - Use a **stable, seedless** hash (FNV-1a 64 or similar, NOT `std`'s randomly seeded `DefaultHasher`), so the same pane name sounds the same across restarts and machines.
   - The hash picks an accent family (US or GB), then two **distinct voices from that family**, then a dominant weight in **[0.55, 0.85]**. That keeps phonemes consistent and blends natural.
   - A caller with no pane (a bare-metal MCP client) hashes its agent label instead. An anonymous caller gets `af_heart`.
   - An explicit `voice` (single or blend) always overrides the hash.
4. **Plumbing:** `/api/tts` and `hyperia_spoken_summary` already know the caller. Pass the requester's pane display name, or label, into `tts::speak`.
   - Resolve it from the authenticated identity: never from a caller-supplied field, so a pane can't claim another pane's voice.
   - Codex owns `tts.rs` plus the minimal call-site change in `main.rs`/`mcp.rs` for this.
5. **Tests:**
   - determinism (same name → identical blend, twice and across fresh processes, pinned expected values);
   - spread (a few dozen sample pane names map to many distinct blends);
   - weights sum to 1;
   - explicit override wins;
   - unknown voice → error;
   - the blend's accent matches its dominant voice.
- Expose the resolved blend in the response (e.g. `"voice": "am_michael:0.7,am_adam:0.3"`) so a user can pin a voice they like.

## The goal beyond Hyperia (Kord): publish it
Kord: "a pure rust inferencer for this is huge." When it's green, it gets **published and tested in public**, not just merged. Design for that now:
- Keep the Kokoro pipeline (G2P, lexicon loading, tokenization and chunking, ort inference, voices) **cleanly separable from Hyperia-specific code** (radio_wrap, playback queue, the ElevenLabs fallback). It should be liftable into a standalone crate with a small public API: `synthesize(text, voice, speed) -> Vec<f32>`.
- Antigravity's section-D A/B (old vs new G2P, then int8/fp16/q8f16) becomes the **published evidence**: numbers plus audio samples.
- Nothing is published yet. host-claude and Kord decide the crate name and when.

## Consensus protocol: talk to each other directly
Roster (use `msg_send`; address agents by `to_label`, Codex by pane):
| Agent | Role | Address |
|---|---|---|
| Grok | G2P audit | `to_label: nemesis8/n8-jade-lemur` |
| Antigravity | A/B measurement | `to_label: nemesis8/n8-rosy-raven` |
| opencode | pipeline audit | `to_label: nemesis8/n8-fuzzy-bison` |
| Codex | implementer | `pane: 11e87950` (its agent binding is being fixed; the pane address works) |
| host-claude | director | `to_label: host-claude` |

1. **Share findings with everyone:** send each finding to the other three agents, not only to host-claude. Keep messages short, and point to your .md file for detail.
2. **Challenge and confirm:** check the others' claims against your own evidence, and reply agree/disagree with a reason. Antigravity's measurements settle disputes about audio quality.
3. **Converge:** Codex drafts `plan/tts-quality/CONSENSUS.md` (Codex owns it), which lists the ranked causes and the change set. Each agent replies `AGREE` or `OBJECT: <reason>`. Iterate until all four agree.
4. **Then** Codex sends the agreed change set to host-claude, and implements it only after host-claude says go.
- First contact between two agents may need Kord's approval. If a send says it's waiting for consent, keep working and retry later; don't spam.
- Check your mail with `msg_check` whenever you finish a step.

## Rules
- **Never put a real username or home-directory path in anything you write** (code, tests, fixtures, sentence sets, docs). This project ships publicly. Use `C:\Users\alice\…`, `/home/alice/…` or `~/…` in examples.
- No commit, stash, reset or branch switch. Only edit files you own.
- Cargo builds go in `sidecar/target/<you>-linux`, never the repo-root `target/`. Typecheck with `tsc --noEmit` only.
- Models are large, so download them once into `/tmp` or `sidecar/target/<you>-linux`, not the repo.
- If Hyperia itself misbehaves (a tool error, delivery, identity), report it to host-claude. The swarm fixes Hyperia bugs it hits.
