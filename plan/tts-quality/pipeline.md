# Pipeline audit — opencode (Alleged Pigeon)

Audited `sidecar/src/tts.rs` end to end, plus the `kokoro-tts` 0.3.3 crate source
(`~/.cargo/registry/.../kokoro-tts-0.3.3/src/`), since several pipeline stages
delegate into the crate. Line refs are to `tts.rs` unless prefixed with the crate
file. Everything below is *verified* (read the file) or *inferred* (flagged).

## Severity ranking of what degrades audio

### S1. Numbers: first digit-string → Mandarin, every later digit-string is dropped
- `tts.rs:198` lowercases, then `synth_kokoro` calls the crate's `synth`, which
  runs `g2p()` → **`g2p.rs:185-209 num_repr()`**.
- `num_repr` compiles `\d+(\.\d+)?` and uses `Regex::replace`, which replaces the
  **first match only**. The replacement is `to_chinese(Traditional, Lower, Low)`
  (`g2p.rs:191,198`), so the *first* number becomes Mandarin ("219" → "二百一十九")
  and is then jieba-cut and pinyin→IPA'd (`g2p.rs:230-233`, `word2ipa_zh`).
  Every **subsequent** number is left as raw digits, which are not in `VOCAB_V10`
  and are dropped by `tokenizer.rs` — i.e. **silent**.
- **Effect:** in "42 items in PR 219 and 1000 lines", "42" is spoken in Mandarin
  and "219"/"1000" are silent. The most audible defect in the pipeline.
- Root cause is the crate's G2P (Grok's g2p.md). Fixing it means replacing the
  Chinese expansion with English number words (Rust-side normalization, per
  SWARM) or bypassing `num_repr` entirely via the direct-ort phoneme path.

### S2. R-colored vowel `ɝ` is emitted but not in the vocabulary, so it is dropped
- Crate `transcription/en.rs:127-131`: `arpa_to_ipa` maps ARPA stress `"0"` → `'\0'`
  (the `_ => '\0'` arm), so unstressed phones are prefixed with NUL; `tokenizer.rs`
  skips the NUL — that is a *stress-marker* artifact, **not** the lost vowel.
- The actual loss: `en.rs:73` maps `ER` → `ɝ` (U+025D) at every stress, but
  `VOCAB_V10` contains `ɚ` (id 85) and **not** `ɝ`. `get_token_ids`
  (`tokenizer.rs:316-318`) warns "Unknown phone, skipped" and drops `ɝ`, leaving a
  stray `ˈ`. So "over" (`OW1 V ER0`) reaches v1.0 as `ˈoʊv`, not because of
  clipping or a NUL, but because the r-colored vowel is removed *before* the model.
- This is the phoneme-level cause of the known "ove" for "over" quirk (SWARM:25)
  and why `tts.rs` had to hack "oh ver" as a respelling. Root cause is G2P
  (Grok's g2p.md), corrected here per R1.

### S3. Chunk concatenation — discontinuities are PLAUSIBLE but NOT YET MEASURED
- `tts.rs:205-215` chunks then `audio.extend_from_slice(&a)` — raw concatenation,
  no crossfade, no inter-chunk silence trimming. *(Fact, verified in tts.rs.)*
- Each Kokoro synth call indexes its style vector by phoneme count
  (`synthesizer.rs:30` `pack[phonemes.len()-1]`), so two adjacent chunks select
  *different* style references. *(Fact — mechanism exists.)*
- **Whether this produces an audible seam/gap is a HYPOTHESIS, not an established
  defect.** No boundary discontinuity has been measured (no ab/results.json at R1).
  The acoustic claim is unproven until Antigravity measures it. No tail-fade or
  crossfade is currently justified on evidence.

### S4. Clipping / normalization — HYPOTHESIS, no over-range evidence yet
- Kokoro output is f32 handed straight to rodio (`tts.rs:531` `SamplesBuffer`),
  with no `clamp`/normalization; the only clamp is the debug WAV writer
  (`tts.rs:509`), not the playback path. *(Fact — code structure verified.)*
- **That int8 actually emits >±1.0 samples, and that male voices are cleaner
  because of lower amplitude, are UNPROVEN.** No raw-f32 peak/over-range count
  exists at R1. R1 therefore does *not* add a limiter or normalization; a measured
  need would require a specific reviewed change (CONSENSUS R1 §D).

### S5. Phoneme ceiling is enforced in *characters*, but the crate indexes by *phonemes*
- `tts.rs:76` `MAX_SYNTH_CHARS = 250` is a character bound; the real ceiling is
  the voice pack length (indexed by phoneme count, `synthesizer.rs:30`), ~510.
- The comment (`tts.rs:70-75`) assumes phonemes ≈ chars. That holds for normal
  words but **not** for the letter-spelling fallback (`en.rs:139` `letters_to_ipa`
  emits 2–3 IPA chars per letter, i.e. ~2 phonemes/char). A 250-char OOV token
  (URL/base64, which `chunk_for_synth` deliberately hard-splits at exactly 250)
  letter-spells to ~500 phonemes — brushing the ceiling. A slightly different
  input can still overflow → OOB panic in the crate → request reset (the exact
  "TTS is down" crash this code was written to prevent).
- Fixing S1 (numbers) partially mitigates this by removing Chinese expansion,
  but the letter-spell inflation remains an independent risk.

## Minor / non-audio notes
- `tts.rs:198` lowercasing is a workaround for the crate's case-sensitive cmudict
  lookup (`g2p.rs:113` `get(word)` with no fold; `cmudict-fast` `get` is exact
  `map.get`). It is necessary **only** for the old dictionary path. When that path
  is replaced (misaki-rs is case-sensitive on purpose — acronyms, `I'm`), case must
  be preserved for G2P; lowercase only the legacy path. (R1 correction.)
- `g2p.rs:119` `rand::random_range(0..rules.len())` — for words with multiple
  CMUdict pronunciations ("the", "a", "either"), the pronunciation is chosen
  **non-deterministically per call**. Same text can sound different run to run.
- Speed plumbing is correct: `resolve_voice` folds into the `Voice(speed)` enum
  (`tts.rs:437-449`) and the crate passes it as a scalar `f32` tensor
  (`synthesizer.rs:36`). Clamp 0.5–2.0 (`tts.rs:140`) is sane.
- Sample rate is consistent 24 kHz f32 mono across synth, rodio (`tts.rs:36,530`)
  and ElevenLabs (`tts.rs:286,313`). WAV header math is correct (`tts.rs:502-507`).
- `lib.rs:28` registers a CUDA execution provider; host is CPU, ort falls back —
  perf only, not quality.

## Bottom line for CONSENSUS ranking
1. **Numbers → first Mandarin + later silent (S1)** is the top G2P content-loss
   defect the pipeline feeds; Grok's g2p.md owns the detail.
2. **R-colored vowel `ɝ` dropped from the vocabulary (S2)** is the top
   tail-degradation cause ("ove"); also G2P. The NUL is only the stress marker.
3. **Model precision (int8)** — background only (0.916 correlation, FINDINGS);
   R1 does not switch the model.
4. **Chunk seams + no fade (S3)** and **no peak normalization (S4)** are two
   *unmeasured hypotheses*, not established defects. Marked accordingly per R1.
5. **Character-vs-phoneme ceiling (S5)** is a latent crash risk, not a tone issue;
   R1 §B replaces the character bound with a token-count budget.
