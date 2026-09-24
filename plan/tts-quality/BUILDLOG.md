# TTS build/test log — opencode (build runner)

Toolchain: `cargo 1.97.1 (c980f4866 2026-06-30)`, `rustc 1.97.1 (8bab26f4f 2026-07-14)`
(`/opt/nemesis8/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin`).
`CARGO_TARGET_DIR=sidecar/target/opencode-linux`.

## Environment fixes needed before tests would build (recorded for reproducibility)

1. **OpenSSL dev headers missing** — `openssl-sys` (pulled by `ort` → `ureq`/`native-tls`) failed
   `pkg-config --libs --cflags openssl`. Fixed with `apt-get install -y pkg-config libssl-dev`.
2. **ALSA headers missing** — `alsa-sys` (pulled by `rodio`/`cpal`) failed `pkg-config … alsa`.
   Fixed with `apt-get install -y libasound2-dev`.
3. **glibc `__isoc23_*` link failure (the real blocker).** The prebuilt `libonnxruntime.a`
   shipped by `ort-sys` 2.0.0-rc.12 (`x86_64-unknown-linux-gnu`, dist hash
   `acc1cba79c337594ead1d88ca72516147aa60054c84217b53399a31caa5ba671`) is compiled against
   glibc ≥ 2.38 and references `__isoc23_strtol/strtoll/strtoull`. This container runs
   Debian 12 glibc **2.36**, which does not export those symbols, so the final link of the
   `hyperia-sidecar` test binary fails:

   ```
   rust-lld: error: undefined symbol: __isoc23_strtoll
   rust-lld: error: undefined symbol: __isoc23_strtoull
   rust-lld: error: undefined symbol: __isoc23_strtol
       >>> referenced by .../libort_sys-….rlib (parser.cc, allocation_planner.cc, cast_op.cc, …)
   collect2: error: ld returned 1 exit status
   ```

   This is an environment/toolchain mismatch (the shipped ONNX Runtime static lib needs a
   newer glibc than Debian 12 provides), **not** a defect in `tts.rs` or the R1 change set.
   Workaround used here (test-only, no product change): a 3-function shim object that maps
   the `__isoc23_*` names onto the real `strto*`:

   ```c
   #include <stdlib.h>
   long __isoc23_strtol(const char*n,char**e,int b){return strtol(n,e,b);}
   long long __isoc23_strtoll(const char*n,char**e,int b){return strtoll(n,e,b);}
   unsigned long long __isoc23_strtoull(const char*n,char**e,int b){return strtoull(n,e,b);}
   ```
   compiled with `gcc` and linked via `RUSTFLAGS=-C link-arg=/tmp/opencode/isoc23_shim.o`.
   **The product build on the release host (which must provide a matching glibc, or `ort`
   must ship a glibc-2.36-compatible ONNX Runtime) is the real fix — flagged to host-claude,
   not something Codex can resolve in `tts.rs`.**

## Feature-graph check: misaki-rs has no espeak / subprocess deps

```
$ cargo tree -e features -i misaki-rs
misaki-rs v0.6.0
└── hyperia-sidecar v0.20.12 (/workspace/hyperia/sidecar)
    ├── hyperia-sidecar feature "default" (command-line)
    └── hyperia-sidecar feature "tts"
        └── hyperia-sidecar feature "default" (command-line)
```

`cargo tree | grep -i "espeak|misaki|kokoro"` returns only:
```
├── kokoro-tts v0.3.3
├── misaki-rs v0.6.0
```
No `espeak-rs`, no `espeak-ng`, no `cc`-compiled `en_ipa.c` in the resolved graph.
`default-features = false` is honoured: the `espeak` feature of misaki-rs (which would pull
`espeak-rs`) is NOT active. ✓

## Test result (current tts.rs, R1 in progress)

Command: `cargo test tts` (after `cargo build --tests` linked cleanly with the shim).

```
running 8 tests
test tts::tests::tts_british_voice_uses_british_phones ... ok
test tts::tests::tts_english_numbers_are_complete ... FAILED
test tts::tests::tts_export_audio ... ignored, requires local model/voices and an explicit output directory
test tts::tests::tts_heteronyms_use_sentence_context ... FAILED
test tts::tests::tts_misaki_inventory_recovers_vowels ... FAILED
test tts::tests::tts_preserves_case_contractions_and_questions ... FAILED
test tts::tests::tts_token_budget_preserves_every_phone ... ok
test tts::tests::tts_unknown_phones_and_empty_speech_fail_explicitly ... ok

failures:
    tts::tests::tts_english_numbers_are_complete
    tts::tests::tts_heteronyms_use_sentence_context
    tts::tests::tts_misaki_inventory_recovers_vowels
    tts::tests::tts_preserves_case_contractions_and_questions

test result: FAILED. 3 passed; 4 failed; 1 ignored; 0 measured; 244 filtered out; finished in 2.33s
```

### Failure detail (exact)

1. `tts_english_numbers_are_complete` — `src/tts.rs:657`
   ```
   assertion `left == right` failed
     left:  "forty two items in PR two hundred nineteen and one thousand lines"
     right: "forty two items in PR two hundred and nineteen and one thousand lines"
   ```
   `219` is rendered "two hundred nineteen" (US style), the test asserts "two hundred **and** nineteen".

2. `tts_heteronyms_use_sentence_context` — `src/tts.rs:701`
   ```
   assertion `left != right` failed: ["ɹˈɛkɚd", "ɹˈɛkɚd"]
   ```
   Both "record" tokens (noun/verb) phonemize to `ɹˈɛkɚd`; the POS tagger did not distinguish them.

3. `tts_misaki_inventory_recovers_vowels` — `src/tts.rs:669`
   ```
   called `Result::unwrap()` on an `Err` value: unsupported Kokoro phone U+200D (‍)
   ```
   The zero-width-joiner `U+200D` is leaking out of misaki-rs and `checked_token_ids`
   correctly rejects it (a phone not in `VOCAB_V10`).

4. `tts_preserves_case_contractions_and_questions` — `src/tts.rs:684`
   ```
   called `Result::unwrap()` on an `Err` value: unsupported Kokoro phone U+200D (‍)
   ```
   Same U+200D root cause (this test covers `/workspace/example/src/tts.rs` and acronyms).

### Interpretation (for Codex)

- The token-budget test, the "no silent phone drop" test, and the British-voice test **pass**:
  chunking-by-token-count and explicit unknown-phone rejection are behaving as designed.
- `U+200D` (ZWJ) is emitted by misaki-rs for some inputs and is not in `VOCAB_V10`; the
  pipeline's strict rejection is the *correct* behaviour, but the phonemizer needs to strip
  or map ZWJ before `checked_token_ids` (or the test's expected strings need to reflect it).
- Number wording uses US "two hundred nineteen" (no "and"); the test assertion expects
  British "two hundred and nineteen" — either the normalizer or the test must pick one.
- Heteronym disambiguation is not yet producing distinct noun/verb phonemes in this build.

Status: **NOT green.** 3 pass, 4 fail, 1 ignored (the ignored `tts_export_audio` requires
local model/voice assets + output dir env vars, per its `#[ignore]`).

---

## Pass 2 (2026-09-24 ~18:44) — after Codex switched numbers to US style

`tts.rs` mtime advanced; re-ran `cargo test tts` (same toolchain + shim, same CARGO_TARGET_DIR).

```
running 8 tests
test tts::tests::tts_british_voice_uses_british_phones ... ok
test tts::tests::tts_english_numbers_are_complete ... ok      ← was FAILED, now PASS
test tts::tests::tts_export_audio ... ignored
test tts::tests::tts_heteronyms_use_sentence_context ... FAILED
test tts::tests::tts_misaki_inventory_recovers_vowels ... FAILED
test tts::tests::tts_preserves_case_contractions_and_questions ... FAILED
test tts::tests::tts_token_budget_preserves_every_phone ... ok
test tts::tests::tts_unknown_phones_and_empty_speech_fail_explicitly ... ok

test result: FAILED. 4 passed; 3 failed; 1 ignored; finished in 3.99s
```

Remaining 3 failures (exact):

1. `tts_misaki_inventory_recovers_vowels` — `src/tts.rs:692` `Err: unsupported Kokoro phone U+200D (‍)`.
2. `tts_preserves_case_contractions_and_questions` — `src/tts.rs:707` same `U+200D`.
3. `tts_heteronyms_use_sentence_context` — `src/tts.rs:724` `["ɹˈɛkɚd", "ɹˈɛkɚd"]`, not distinct.

The `U+200D` (ZWJ) leak and flattened heteronym POS are the **misaki-rs 0.6.0 bundled-data
defects** Grok identified; they persist until the approved pinned 0.9.4 lexicon swap lands.
Numbers now correctly use US "two hundred nineteen" and that test is green. `Oh ver` still
present (per director: keep until `over` matches `ˈOvəɹ` in audio).

---

## Pass 3 (2026-09-24 ~19:20) — pinned 0.9.4 lexicons wired via HYPERIA_MISAKI_DIR

PROVENANCE.md landed (`sidecar/resources/tts/PROVENANCE.md`). Downloaded the four pinned
files into `sidecar/target/opencode-linux/misaki/` from the Hugging Face revision
`b65a6b4398e053983b9c360f0682b720e362859d`. **All four sha256 match PROVENANCE.md exactly:**

| File | Bytes | sha256 match |
|---|---|---|
| us_gold.json | 3000469 | ✓ dc414872… |
| us_silver.json | 3099517 | ✓ de8f67be… |
| gb_gold.json | 2838552 | ✓ 29e62f4b… |
| gb_silver.json | 3663898 | ✓ 48131e2d… |

Ran with `HYPERIA_MISAKI_DIR=$PWD/target/opencode-linux/misaki` (Codex added sha256 verify
+ env-var loading; `sha2` dep added to Cargo.toml). Result:

```
running 10 tests
test tts::tests::tts_british_voice_uses_british_phones ... ok
test tts::tests::tts_english_numbers_are_complete ... ok
test tts::tests::tts_export_audio ... ignored
test tts::tests::tts_heteronyms_use_sentence_context ... ok        ← was FAILED, now PASS
test tts::tests::tts_lexicon_corruption_is_a_hard_error ... ok    ← NEW, PASS
test tts::tests::tts_matches_all_reference_vectors_exactly ... FAILED
test tts::tests::tts_misaki_inventory_recovers_vowels ... ok       ← was FAILED, now PASS
test tts::tests::tts_preserves_case_contractions_and_questions ... FAILED
test tts::tests::tts_token_budget_preserves_every_phone ... ok
test tts::tests::tts_unknown_phones_and_empty_speech_fail_explicitly ... ok

test result: FAILED. 7 passed; 2 failed; 1 ignored; finished in 3.41s
```

Feature graph re-checked: `cargo tree | grep -iE "espeak|misaki|kokoro"` → only
`kokoro-tts v0.3.3` and `misaki-rs v0.6.0`; no espeak/subprocess. ✓

Remaining 2 failures (exact) — both are OOV letter-spelling mismatches vs the reference:

1. `tts_matches_all_reference_vectors_exactly` (`src/tts.rs:977`) — 3 vector mismatches:
   - `paths_01`: `no English pronunciation for "tts"` (the `.rs` filename token `tts`).
   - `paths_02`: `no English pronunciation for "wav"`.
   - `long_01`: "Hyperia's" — expected `ˈAʧ … ˈI ˈA s` (the `s` spelled as **joined**
     `ˈɛs`→"s" in the reference uses the *word* "s"→`ˈɛs`? see below), actual emits
     `ˈI ɐ ˈɛs` where the possessive `s` is spelled `ˈɛs` but the reference uses a plain
     `s` letter-name run. Net: `Hyperia's` → expected `ˈAʧ wˈI pˈi ˈi ˈɑɹ ˈI ˈA s`
     vs actual `ˈAʧ wˈI pˈi ˈi ˈɑɹ ˈI ɐ ˈɛs`.

2. `tts_preserves_case_contractions_and_questions` (`src/tts.rs:868`) — the loop over
   `["sidecar", "runtime", "/workspace/example/src/tts.rs", "MCP HTTP IDE URL"]` hits
   `no English pronunciation for "tts"` on the `tts.rs` path.

Interpretation: the pinned-lexicon swap fixed U+200D, heteronyms, and vowels (3 of the 4
prior reds now green). The two remaining are **OOV letter-spelling fidelity** — the
reference `g2p_vectors.json` spells OOV sub-word tokens (`tts`, `wav`, and the possessive
`'s`) with a *joined* letter-name run, while the current phonemizer emits a per-letter
`ˈɛs`-style spelling for `s` and errors on `tts`/`wav` (they are not in gold/silver and the
fallback returns `❓` instead of letter-spelling). This is the "reference OOV fallback"
Codex requested from Grok in CONSENSUS.md ("exact reference OOV fallback implementation").

Status: **NOT green — 2 remain**, both OOV fallback. The pinned-lexicon path is correct
(sha256 verified, no network in tests); the gap is reproducing misaki 0.9.4's OOV
letter-spelling for sub-word/possessive tokens.
