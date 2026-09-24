# Kokoro Text-to-Speech (TTS) Findings & Models

This repository contains the findings from crawling and analyzing the **Kokoro TTS** model family using Grub Crawler, along with the smallest and best model weights (all sub-500MB), a complete collection of **103+ voice embeddings**, and an integrated speech synthesis CLI.

---

## 1. Overview: What is Kokoro TTS?

**Kokoro** (Japanese for *heart* or *spirit*) is a frontier open-weight text-to-speech model developed by `hexgrad` (`@rzvzn`):
- **Parameters**: 82 Million parameters (text in $\rightarrow$ audio out)
- **Architecture**: StyleTTS 2 + iSTFTNet vocoder (decoder-only, non-autoregressive, fast and lightweight)
- **License**: Apache 2.0 (permissive, commercial use allowed)
- **Audio Output**: 24kHz high-fidelity speech across 54+ core voices and 103+ extended voices across multiple accents and languages.
- **Performance**: Capable of ~4x faster-than-realtime synthesis on standard modern CPUs.

---

## 2. Model Comparison: Smallest vs. Best

All Kokoro models are natively compact (the uncompressed PyTorch/FP32 model is ~326 MB, comfortably under 500 MB). Quantization and precision tuning yield even smaller, faster variants:

| Variant | Precision / Quantization | File Size | Spectral Correlation (vs FP32) | Classification |
|---|---|---|---|---|
| **`kokoro-v1.0-q8f16.onnx`** | 8-bit matmul + FP16 weights | **86.0 MB** | High | **Smallest** high-performing model |
| **`kokoro-v1.0.int8.onnx`** | INT8 quantized | **114.0 MB** | 0.916 | Ultra-compact CPU deployment |
| **`kokoro-v1.0.fp16.onnx`** | FP16 (half-precision) | **163.5 MB** | **0.999** | **Best** overall quality-to-size sweet spot |
| **`kokoro-v1.0.onnx`** | FP32 (full precision) | **325.5 MB** | 1.000 (Reference) | Full reference precision |
| **`kokoro-v1_0.pth`** | PyTorch weights | **327.0 MB** | Reference | Original PyTorch checkpoint |

### The Smallest Model
- **`kokoro-v1.0-q8f16.onnx` (86 MB)**: Uses 8-bit quantized matrix multiplications with FP16 activations. It reduces memory and storage footprint to just ~86 MB while preserving natural prosody and voice timbre.

### The Best Model
- **`kokoro-v1.0.fp16.onnx` (163.5 MB)**: Achieves a **0.999 spectral correlation** against the 32-bit float model—meaning the synthesized output is virtually indistinguishable to human ears and acoustic analyzers, while halving memory consumption and accelerating GPU/NPU inference.
- **`kokoro-v1.0.onnx` (325.5 MB)**: Provides pristine full 32-bit floating point inference for platforms without FP16 hardware acceleration, well within the 500MB requirement.

---

## 3. Voice Assets & Organization

All voice embeddings have been grabbed and integrated into both bundled and individual formats:

- **[`voices-v1.0.bin`](file:///workspace/speechtotext/voices-v1.0.bin)** (28.2 MB): All 54 core v1.0 voices.
- **[`voices-v1.1-zh.bin`](file:///workspace/speechtotext/voices-v1.1-zh.bin)** (53.8 MB): Extended bundle containing 103 voices.
- **[`voices/`](file:///workspace/speechtotext/voices/)**: Directory containing individual extracted `.bin` files for every voice (e.g. `af_heart.bin`, `bf_emma.bin`, `am_adam.bin`, etc.).

### Voice Categories & Codes
- **American English (`en-us`)**:
  - *Female*: `af_heart` (Flagship), `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `af_sky`, `af_nova`, `af_river`, `af_jessica`, `af_alloy`
  - *Male*: `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa`
- **British English (`en-gb`)**:
  - *Female*: `bf_alice`, `bf_emma`, `bf_isabella`, `bf_lily`
  - *Male*: `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis`
- **European Spanish (`es`)**: `ef_dora`, `em_alex`, `em_santa`
- **French (`fr-fr`)**: `ff_siwis`
- **Hindi (`hi`)**: `hf_alpha`, `hf_beta`, `hm_omega`, `hm_psi`
- **Italian (`it`)**: `if_sara`, `im_nicola`
- **Japanese (`ja`)**: `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro`, `jm_kumo`
- **Brazilian Portuguese (`pt-br`)**: `pf_dora`, `pm_alex`, `pm_santa`
- **Mandarin Chinese (`zh`)**: `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi`, `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang`, and extended `zf_*` / `zm_*` models.

---

## 4. Integrated CLI: [`tts.py`](file:///workspace/speechtotext/tts.py)

A full-featured CLI is included for voice synthesis, blending, and immediate host playback.

### Commands

1. **List all voices**:
   ```powershell
   python tts.py --list
   ```

2. **Synthesize and play speech**:
   ```powershell
   python tts.py "Hello, this is Kokoro speaking." --voice af_heart --play
   ```

3. **Use a British or international voice**:
   ```powershell
   python tts.py "Splendid day for some audio synthesis!" --voice bf_emma --lang en-gb --play
   ```

4. **Voice Blending (Combine voices with custom weights)**:
   ```powershell
   python tts.py "This voice is a sixty-forty blend of Heart and Adam." --voice "af_heart:0.6,am_adam:0.4" --play
   ```

5. **Adjust speed or model precision**:
   ```powershell
   python tts.py "Testing faster speech rate." --speed 1.25 --model fp16 --play
   ```

---

## 5. Files Summary in [`/workspace/speechtotext/`](file:///workspace/speechtotext/)

| Path | Size | Description |
|---|---|---|
| [`kokoro-v1.0-q8f16.onnx`](file:///workspace/speechtotext/kokoro-v1.0-q8f16.onnx) | 86.0 MB | Smallest ONNX model (mixed precision) |
| [`kokoro-v1.0.fp16.onnx`](file:///workspace/speechtotext/kokoro-v1.0.fp16.onnx) | 163.5 MB | Best ONNX model (0.999 correlation with FP32) |
| [`kokoro-v1.0.onnx`](file:///workspace/speechtotext/kokoro-v1.0.onnx) | 325.5 MB | Full precision FP32 ONNX model |
| [`voices-v1.0.bin`](file:///workspace/speechtotext/voices-v1.0.bin) | 28.2 MB | 54 core voice pack |
| [`voices-v1.1-zh.bin`](file:///workspace/speechtotext/voices-v1.1-zh.bin) | 53.8 MB | 103 extended voice pack |
| [`voices/`](file:///workspace/speechtotext/voices/) | Directory | 103 individual `.bin` voice embedding files |
| [`tts.py`](file:///workspace/speechtotext/tts.py) | 4.9 KB | Integrated synthesis & playback CLI |
| [`voice_manager.py`](file:///workspace/speechtotext/voice_manager.py) | 7.2 KB | Voice metadata, extractor, and inventory tool |
| [`test_kokoro.py`](file:///workspace/speechtotext/test_kokoro.py) | 2.1 KB | Model benchmarks and verification script |
