# G2P audit — kokoro-tts CMUdict vs misaki

Grok, read-only. Shared set: `plan/tts-quality/ab/sentences.json` (15 sentences). Product path lowercases first (`sidecar/src/tts.rs`, `synth_kokoro`), then `kokoro-tts` 0.3.3 `g2p(text, false)` because `af_heart` is a v1.0 voice.

## Verdict

The CMUdict front end does not feed Kokoro the phones it was trained on. Misaki's US inventory is 46 symbols, and all 46 are already in `VOCAB_V10`. The crate's ARPAbet map misses that inventory in two ways that show up on the shared set: it deletes every r-colored vowel, and it rewrites the vowels and affricates that remain. Numbers are a separate break: the first number in a string is spoken as Mandarin, and every later number is silent.

On `plosives_03_over`, "over" is the token sequence `ˈoʊv`. That is the "ove" quirk. The final vowel is not clipped by the audio path. It is removed before the model runs.

## How this was measured

| Claim | Kind |
|---|---|
| `kokoro-tts` 0.3.3 sources `src/g2p.rs`, `src/transcription/en.rs`, `src/tokenizer.rs`, `dict/cmudict.dict` | Read from the cargo registry copy locked by `sidecar/Cargo.lock` |
| Chinese numerals | Executed `chinese-number` 0.7.8 with the crate's features (`number-to-chinese`, Traditional, Lower, Low). `219` → 二百一十九, `3.14` → 三一角四分, `0.6` → 六角, `42` → 四十二, `404` → 四百零四 |
| IPA and v1.0 token ids | Executed the crate's own `arpa_to_ipa` and `get_token_ids` (those two files, rustc 1.98.1). `over` (`OW1 V ER0`) → ids `[0, 156, 57, 135, 64, 0]` = BOS `ˈ o ʊ v` EOS. `ɝ` is absent from the id list |
| Sentence assembly | Line-for-line Python of `g2p`: `Regex::replace` (first number only), the CJK / Latin-1 sentence split, `\w+\|\W+` tokenization, then `get_token_ids`'s skip of unknown chars. Variant 0 is shown. The crate picks `rand::random_range` when a word has several pronunciations |
| Misaki reference | Lookup in misaki 0.9.4 `us_gold.json` (90,201 entries) and `us_silver.json` (93,361). These are the lexicons `misaki.en.G2P` loads. Tag maps are quoted whole. espeak-ng is not installed here, so the espeak fallback kokoro_onnx uses for out-of-lexicon words was not run. The spaCy tagger was not run; function-word rules for *the* / *a* / *to* are from reading `misaki/en.py` |

`cmudict-fast` 0.8.0 on the same dict file: 125,929 headwords, 8,417 with more than one pronunciation, 26,280 containing `ER`.

## Failure classes

### 1. R-colored vowel deletion

`transcription/en.rs` maps every `ER` to `ɝ` (U+025D), at every stress. `VOCAB_V10` contains `ɚ` (id 85) and does not contain `ɝ`. `get_token_ids` warns and skips the unknown char. The stress mark in front of a stressed `ER` stays, so the vowel is gone and a stray `ˈ` often remains.

Executed token ids:

| Word | ARPAbet | Tokens that reach v1.0 | Misaki gold |
|---|---|---|---|
| over | `OW1 V ER0` | `ˈoʊv` | `ˈOvəɹ` |
| world | `W ER1 L D` | `wˈld` | `wˈɜɹld` |
| her | `HH ER1` | `hˈ` | `hɜɹ` |
| water | `W AO1 T ER0` | `wˈɔt` | `wˈɔɾəɹ` |
| church | `CH ER1 CH` | `tʃˈtʃ` | `ʧˈɜɹʧ` |
| performance | `P ER0 F AO1 R M AH0 N S` | `pfˈɔɹməns` | `pəɹfˈɔɹməns` |

Same deletion on the shared set (variant 0, after lowercasing):

| Sentence | What is left |
|---|---|
| `acronyms_01` | server → `sˈv`; returned → `ɹɪtˈnd` |
| `paths_01` | workspace → `wˈkspˌeɪs`; errors → `ˈɛɹz` |
| `paths_02` | users → `jˈuzz` |
| `acronyms_02` | configure → `kənfˈɪɡj` |
| `numbers_02` | temperature loses the `ɝ` in the last syllable |
| `plosives_03_over` | over → `ˈoʊv` |
| `baseline_01` | confirmed → `kənfˈmd`; operational → `ˌɑpˈeɪʃənəl` |
| `long_01` | summary → `sˈəmi`; feature → `fˈitʃ`; directly → `dˈɛktli`; operator → `ˈɑpˌeɪt`; operation → `ˌɑpˈeɪʃən`; external and network lose `ɝ` |
| `long_02` | worker → `wˈk`; natural, synthesizer, buffers, boundaries lose `ɝ` |

### 2. Numbers become Mandarin, then disappear

`g2p.rs` `num_repr` compiles `\d+(\.\d+)?` and calls `Regex::replace`, which replaces the first match only. The replacement is `f64::to_chinese(Traditional, Lower, Low)`. The `i64` branch is unreachable: every digit string parses as `f64`. The Chinese span then takes the Mandarin jieba + pinyin path (`word2ipa_zh`), not English. Digit characters are not in `VOCAB_V10`, so a number that survives `num_repr` is deleted by the tokenizer.

| Sentence | First number | The rest |
|---|---|---|
| `numbers_01` | 42 → 四十二 | `219` and `1000` are silent. "PR" survives as P-R (`pr` is in the dict) |
| `numbers_02` | the 5 in `-5` → 五 | `-` is U+002D, not in the vocab, so the minus is silent too. `3:45` drops both numbers and keeps `:` (id 2). `24th` keeps the letters `t` `h`. `2026` is silent |
| `acronyms_01` | 404 → 四百零四 | MCP is spelled. HTTP is in the dict as H-T-T-P |

Decimals, executed on the same `to_chinese` and not in the shared set: `3.14` → 三一角四分 and `0.6` → 六角. The fraction is read as jiǎo/fēn, not "point".

`$250` (probed) becomes a silent `$` plus 二百五十. `50%` becomes 五十 plus a silent `%`. Misaki's `en.py` maps `$` / `£` / `€` to currency words and `%` `+` `&` `@` to percent/plus/and/at.

### 3. Surviving words use a different phone set

For a word the dict does contain, the map in `en.rs` still disagrees with misaki:

- `EY AY OW AW OY` become `eɪ aɪ oʊ aʊ ɔɪ` (two tokens). Misaki uses one token: `A I O W Y`. Executed: `say` (`S EY1`) → ids for `s ˈ e ɪ`, not `sˈA`.
- `AH` is `ə` at every stress. `ʌ` is in the vocab (id 138) and is never emitted. `love` → `lˈəv` vs misaki `lˈʌv`. On the shared set: of, cut, done, does, dump, must, muffled, a (schwa reading).
- `CH` → `tʃ`, `JH` → `dʒ`. `ʧ` (id 133) and `ʤ` (id 82) are never emitted by the dict path. Executed: `speech` → `spˈitʃ` vs misaki `spˈiʧ`; `just` → `dʒˈəst` vs `ʤˈʌst`. Shared set: check, project, july, changes, engine.
- No flap `ɾ` (id 125 is in the vocab). Misaki `water` is `wˈɔɾəɹ`, `items` is `ˈIɾəmz`, `critical` is `kɹˈɪɾəkᵊl`, `distorted` is `dəstˈɔɹɾᵻd`.

Primary and secondary stress marks are kept (`ˈ` id 156, `ˌ` id 157). Unstressed phones are prefixed with NUL and the NUL is skipped, which leaves "no stress mark" and matches misaki's unstressed convention. The NUL is not the deleted vowel. Because `synth_v10` indexes the style pack by token-id length, a two-phone diphthong also selects a different style vector than misaki's one-phone diphthong.

Letter spelling accidentally uses the misaki alphabet (`h` → `ˈAʧ`, `o` → `ˈO`). The dictionary path is the one that leaves it.

### 4. Apostrophes split words the dictionary already has

`\w` does not include `'`, so `don't` is looked up as `don` plus a spelled `t`, even though cmudict has `don't` (2 pronunciations: `D OW1 N T`, `D OW1 N`) and misaki gold has `dˈOnt`. Same split for `it's`, `I'm`, `can't`.

`long_01` "Hyperia's" is the spelled name plus the letter `s` (`ˈɛs`). The possessive never reaches a lexicon.

### 5. Hyphen, slash, and backslash glue the neighbors

`-`, `/`, and `\` are not v1.0 phones. The splitter consumes them and inserts no space, so the surrounding IPA is concatenated.

- `long_01` text-to-speech → `tˈɛksttˈuspˈitʃ`
- `paths_01` drops every `/`. `workspace/hyperia/sidecar/src/tts.rs` is one spelled run, and the dot in `.rs` is a period phone (a prosodic break) before spelled `rs`
- `paths_02` drops every `\`. The dot in `.hyperia` is a period phone. `kokoro` and `last` are glued

`?` `.` `,` `!` `:` `—` are in `VOCAB_V10` and are passed through. `questions_01` and `questions_02` keep the question mark. ASCII `...` stays three periods; the single ellipsis character `…` is a different token (id 10).

### 6. Homographs are a coin flip

`g2p.rs` uses `rand::random_range(0..rules.len())`. There is no tagger. 8,417 headwords are affected. Variant 0 below is just the first dict line, which is what a deterministic reader would show; a real synth call may emit any of them.

`heteronym_01`, "Record the record, then present the present to the subject.":

| Word | CMUdict choices (ARPAbet) | Misaki gold |
|---|---|---|
| record | `R AH0 K AO1 R D`, `R EH1 K ER0 D`, `R IH0 K AO1 R D` | noun `ɹˈɛkəɹd`, verb `ɹəkˈɔɹd` |
| present | 3 entries, first is `P R EH1 Z AH0 N T` | noun `pɹˈɛzᵊnt`, verb `pɹizˈɛnt` |
| subject | 2 entries, first is verb-stress `S AH0 B JH EH1 K T` | noun `sˈʌbʤɛkt`, verb `səbʤˈɛkt` |

Both copies of "record" draw from the same pool, independently. The noun/verb contrast the sentence is there to test cannot be produced on purpose.

Other high-frequency coin flips: `the` (3: `DH AH0`, `DH AH1`, `DH IY0`), `a` (2), `to` (3: `T UW1`, `T IH0`, `T AH0`), `read`, `live`, `close`, `on`, `are`, `of`'s neighbors, `url` (one reading is `UH1 R L`, "earl").

Misaki's gold string for `the` is `ði`, and `en.py` then picks `ði` before a vowel and `ðə` before a consonant. The crate cannot make that choice.

### 7. Acronyms and unknown words are spelled, or they hit the wrong word

Out of dictionary, `letters_to_ipa` spells. After the sidecar lowercases:

| Token | Crate | Misaki lexicon |
|---|---|---|
| MCP, CLI | spelled M-C-P, C-L-I | absent (espeak fallback, not run) |
| JSON, YAML | spelled J-S-O-N, Y-A-M-L | absent (espeak fallback, not run). The shared-set note wants these as words |
| HTTP, PR, PM, API | in cmudict as letter names | absent |
| IDE | dict word `ˈaɪd` | absent. This is "I'd", not I-D-E |
| URL | `Y UW2 AA2 R EH1 L` or `UH1 R L` | absent. Second reading is "earl" |
| sidecar | spelled S-I-D-E-C-A-R | gold `sˈIdkˌɑɹ` |
| runtime | spelled | gold `ɹˈʌntIm` |
| hyperia, kokoro, src, tts, rs, wav | spelled | absent |

Case is part of this class. `Cmudict::get` is exact. Probed without the sidecar lowercase: `The` and `Over` miss the dict and are spelled (`tˈiˈAʧˈi`, `ˈOvˈiˈiˈɑɹ`); `US` and `AI` are spelled as letters. The sidecar lowercase makes `The` and `Over` hit the dict, and makes `AI` a coin flip between `ˈaɪ` ("eye") and `ˈeɪˈaɪ`, and `US` a coin flip between `ˈəs` and the spelled form.

## What is not a G2P failure

Final plosives on `plosives_01` and `plosives_02` are present and match misaki's consonants: stop `stˈɑp`, clock `klˈɑk`, cat `kˈæt`, desk `dˈɛsk`, bag `bˈæɡ`, grab `ɡɹˈæb`, rope's `p`. The "ove" result on `plosives_03_over` is class 1.

Question marks survive, so a flat question is not a missing `?` token.

## Pure-Rust replacement

Use misaki phones. They already fit `get_token_ids(..., false)`.

**Use `misaki-rs` 0.6.0 with `default-features = false`.** Published 2026-09-02, MIT, edition 2024 (rustc 1.85+; stable here is 1.98.1). It embeds the US/GB gold and silver lexicons, an averaged-perceptron tagger, number-to-words, and `-s` / `-ed` / `-ing` stemming. No espeak. The default `espeak` feature pulls `espeak-rs`, which links espeak-ng (GPL-3.0). Leave it off. Unknown words then letter-spell, which is what the crate does today, but only after the lexicon misses, so `sidecar` and `runtime` stop being spelled. This crate was not executed in this audit. The check worth adding is: `over` contains `əɹ`, `42` is English words, and the two `record`s in `heteronym_01` differ by tag.

Do not:

- Disable `use-cmudict`. That path compiles `src/transcription/en_ipa.c` (`cc` in the crate). Its unit test expects British `həlˈəʊ` for "hello", not misaki `həlˈO`.
- Depend on `voice-g2p` 0.2.2 or `crustytts-phonemize`. They shell out to `espeak-ng`, and voice-g2p optionally shells out to `uv` for spaCy.
- Replace the sidecar with `kokoro-en` 0.1.5 as the G2P fix. `--no-default-features` avoids the `g2p-espeak` feature, and `misaki-lean` is an empty marker, but `build.rs` always `cc`s `en_ipa.c`, the crate pins `misaki-rs` 0.3.0, and it still vendors ort.
- Keep `cmudict-fast` and only fix the ARPAbet table. That does not add POS, English numbers, or the misaki entries this dict lacks (`sidecar`, `runtime`).

Porting `misaki/en.py` plus `us_gold.json` / `us_silver.json` (Apache-2.0) is the same job `misaki-rs` already did. Own that port only if a fidelity check against the table above fails.

## Integration constraint for Codex

`KokoroTts::synth` always calls `g2p` inside private `synthesizer::synth`. There is no phoneme argument. Feeding a misaki string back in as text does not work: the sentence regex keeps only CJK, a CJK punctuation class, and U+0000–U+00FF, so `ə`, `ˈ`, and `ɹ` are skipped.

`get_token_ids` is public. The ort session inside `KokoroTts` is not. The change is a phoneme entry point (a small fork, or a local copy of the ~40-line `synth_v10` call) that runs `get_token_ids(misaki_phones, false)` and does not call `g2p`. `tts.rs` would lowercase only for the old path; misaki is case-sensitive on purpose (acronyms, `I'm`).

## Shared-set coverage

All 15 ids in `plan/tts-quality/ab/sentences.json` were run through the lowercased product path. Classes hit:

| Id | Classes |
|---|---|
| numbers_01 | 2 (42 Mandarin; 219 and 1000 silent), 3 (items, lines, code, of) |
| numbers_02 | 2 (minus, clock, ordinal, year), 1 (temperature), 3 (july) |
| acronyms_01 | 1 (server, returned), 2 (404), 7 (MCP spelled, URL coin flip) |
| acronyms_02 | 1 (configure), 7 (CLI/JSON/YAML spelled, IDE = "I'd") |
| paths_01 | 1 (workspace, errors), 5 (slashes), 7 (hyperia, sidecar, src, tts, rs) |
| paths_02 | 1 (users), 5 (backslashes, dotfile), 7 (hyperia, kokoro, wav) |
| questions_01 | 7 (sidecar spelled), 3 (responding has 4 readings) |
| questions_02 | 3 (does, voice, sound, muffled, distorted) |
| plosives_01, plosives_02 | plosive codas intact; class 3 on cut/of/rope/on |
| plosives_03_over | 1 (over → `ˈoʊv`), 3 (done, project) |
| long_01 | 1 (summary, feature, directly, operator, …), 4 (Hyperia's), 5 (text-to-speech), 7 (runtime, sidecar) |
| long_02 | 1 (worker → `wˈk`, and the other `-er` words), 3 |
| baseline_01 | 1 (confirmed, operational) |
| heteronym_01 | 6 (record, present, subject) |

## R1 vectors and Codex G2P check

Correction: the recommendation above to adopt misaki-rs 0.6.0 phones was written before that crate was executed. It is withdrawn. The crate was executed for this section.

Expected phones are in `plan/tts-quality/g2p_vectors.json` (15 sentences). They were produced by executing misaki 0.9.4 `en.G2P(trf=False, british=False)` with spaCy `en_core_web_sm` 3.7.1, no espeak and no neural fallback. Out-of-lexicon alphabetic pieces are letter-spelled from misaki `us_gold` letter names. Flaps are the ASCII `T` misaki emits when its version is not 2.0. Token IDs are `kokoro-tts` 0.3.3 `get_token_ids` on `VOCAB_V10`, including the leading and trailing 0. For every sentence, `len(token_ids) == len(phonemes) + 2` and `unknown_chars` is empty. The style row in `kokoro-tts` `synth_v10` is `token_ids.len() - 1` (the ID vector already includes BOS and EOS). That is the same convention Codex's chunker comment describes. An unpadded length would not match the old crate.

Checks that passed on the reference strings: `plosives_03_over` contains `ˈOvəɹ`; `numbers_01` contains `fˈɔɹTi tˈu`, `hˈʌndɹəd`, and `θˈWzᵊnd` and no Han digits; `heteronym_01` is `ɹəkˈɔɹd` then `ɹˈɛkəɹd`, and `pɹizˈɛnt` then `pɹˈɛzᵊnt`; `long_02` contains `wˈɜɹkəɹ`; `acronyms_01` contains `sˈɜɹvəɹ`.

misaki-rs 0.6.0 `data/us_gold.json` has the same 90,201 keys as misaki 0.9.4 and different values on 64,566 of them. `over` there is `ˌo‍ʊvɚɹ` (U+200D between `o` and `ʊ`). `record` is one string, not a part-of-speech map.

Codex's product path is `phonemize` in `sidecar/src/tts.rs`: `normalize_english`, then `misaki_rs::G2P` US, then `checked_token_ids`, which errors if any character is missing from `VOCAB_V10`. `Cargo.toml` pins `misaki-rs = "=0.6.0"` with default features off. `radio_wrap` still says `Oh ver`. No `BUILDLOG.md` and no `cargo test` of the sidecar was run here (that build pulls ort).

The comparison below is a replay of that function: the same `normalize_english` body, num2words 0.4.1 (the locked version), and misaki-rs 0.6.0 `G2P::new(EnglishUS)`, then the same unknown-phone test. It is not a sidecar test binary.

All 15 sentences mismatch `g2p_vectors.json`, and all 15 contain U+200D. `checked_token_ids` therefore rejects every one of them, so `phonemize` does not return phones for the shared set. Stripping the joiner would still leave the wrong inventory. Examples:

| Id | Codex replay | Reference |
|---|---|---|
| plosives_03_over | `ˌo‍ʊvɚɹ` inside the sentence | `ˈOvəɹ` |
| heteronym_01 | both `record`s are `ɹˈɛkɚd`; both `present`s are `pɹˈɛzənt` | `ɹəkˈɔɹd` then `ɹˈɛkəɹd`; `pɹizˈɛnt` then `pɹˈɛzᵊnt` |
| numbers_01 | `fˈɔː‍ɹɾi`, length marks, flap `ɾ`, U+200D | `fˈɔɹTi tˈu` |
| numbers_02 | `mˈa‍ɪnəs`, no colon phone | `mˈInəs` and a `:` between three and forty-five |
| long_02 | `wˈɜːkɚ` shape with `ː` and U+200D | `wˈɜɹkəɹ` |

`Num2Words::new(219).to_words()` on num2words 0.4.1 returns `two hundred nineteen`. `tts_english_numbers_are_complete` expects `two hundred and nineteen`. That assertion fails against the locked crate. It was not run through `cargo test`.
