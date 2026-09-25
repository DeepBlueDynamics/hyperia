# Fixed Sentence Set for TTS Quality A/B Benchmarking

This sentence suite is the standardized benchmark across the TTS quality swarm:
- **Antigravity**: A/B acoustic and spectral measurement (`plan/tts-quality/ab/`)
- **Grok**: G2P phoneme error audit against CMUdict vs misaki/espeak (`plan/tts-quality/g2p.md`)
- **opencode**: Text pipeline and audio chunking audit (`plan/tts-quality/pipeline.md`)
- **Codex**: Implementation targets and regression testing (`sidecar/src/tts.rs`)

Source file: [`sentences.json`](file:///workspace/hyperia/plan/tts-quality/ab/sentences.json)

---

## Sentence Categories & Evaluation Targets

| ID | Category | Sentence Text | Evaluation Target |
|---|---|---|---|
| `numbers_01` | Numbers | "There are 42 items in PR 219 and 1000 lines of code." | Cardinal numbers ("42", "1000"), alphanumeric identifier ("PR 219"), digit-letter tokenization. |
| `numbers_02` | Numbers | "The temperature dropped to -5 degrees at 3:45 PM on July 24th, 2026." | Negative signs ("-5"), clock time ("3:45 PM"), calendar ordinals ("24th"), year pronunciation ("2026"). |
| `acronyms_01` | Acronyms | "The MCP server returned HTTP 404 for the URL." | Standard uppercase acronyms (MCP, HTTP, URL) and three-digit status code (404). |
| `acronyms_02` | Acronyms | "Configure the CLI using JSON and YAML in the IDE via API." | Initialisms spelled out (CLI, IDE, API) vs acronyms pronounced as words (JSON, YAML). |
| `paths_01` | Paths | "Check the file at /workspace/hyperia/sidecar/src/tts.rs for errors." | Unix file paths, forward slashes, directory nesting, file extension (".rs"). |
| `paths_02` | Paths | "Navigate to C:\\Users\\alice\\.hyperia\\kokoro\\last.wav to inspect the audio dump." | Windows path backslashes, drive letter ("C:"), dotfile directory (".hyperia"), extension (".wav"). |
| `questions_01` | Questions | "Did the sidecar crash, or is it still responding to ping requests?" | Pitch contour, terminal rising intonation, comma pause. |
| `questions_02` | Questions | "Why does the synthesized voice sound muffled and distorted?" | Wh-question pitch drop, vocal fry / distortion at sentence terminus. |
| `plosives_01` | Plosives | "Please stop the clock, cut the rope, and grab the big red bag." | Final plosive consonant codas (/p/, /k/, /t/, /b/, /d/, /g/) testing clipping, truncation, and energy decay. |
| `plosives_02` | Plosives | "That quick dark cat sat on top of the black desk." | Dense voiceless stop clusters, transient attack preservation. |
| `plosives_03_over` | Plosives / Truncation | "The project is over and done, with clear crisp sound at the end." | Known Kokoro int8 regression: word-final clipping ("ove" for "over"), unvoiced stop release. |
| `long_01` | Long Sentences | "Hyperia's spoken summary feature enables autonomous agents to communicate critical state changes, status updates, and operation milestones directly to the operator using a compact neural text-to-speech engine embedded in the local sidecar runtime without external network dependencies." | 274 characters (exceeds default 250-character chunk boundary). Tests chunking boundary split, phase alignment, and silence insertion. |
| `long_02` | Long Sentences | "When processing a complex sequence of technical instructions, the speech synthesizer must maintain consistent prosody, natural pauses at punctuation boundaries, and smooth transitions between concatenated audio buffers across all active worker threads." | 258 characters. Tests phoneme ceiling margin, clause prosody continuity across chunks. |
| `baseline_01` | Baseline | "Station to base, transmission confirmed. All systems operational." | Standard radio frame transmission test, crisp delivery. |
| `heteronym_01` | Prosody / Stress | "Record the record, then present the present to the subject." | Grammatical category stress shift across heteronyms (VERB re-CORD vs NOUN RE-cord). |

---

## Instructions for Swarm Consumers

1. **Grok (G2P Audit)**:
   - For each sentence ID, feed `text` through CMUdict (pure-Rust `kokoro-tts`) and misaki/espeak (`kokoro-onnx`).
   - Flag dropped tokens (e.g. numbers read as empty or skipped digits), spelled-out words, and pronunciation errors.
2. **opencode (Pipeline Audit)**:
   - Verify chunking behavior on `long_01` and `long_02` (check where `chunk_for_synth` splits, whether trailing whitespace or punctuation is truncated).
   - Verify silence / padding on `plosives_01`, `plosives_02`, and `plosives_03_over`.
3. **Antigravity (A/B Measurement)**:
   - Synthesize all sentences across `Hyperia int8`, `q8f16`, `fp16`, and `Python reference`.
   - Measure duration, RMS, peak amplitude, trailing silence, spectral similarity (MCD / spectrogram correlation).
