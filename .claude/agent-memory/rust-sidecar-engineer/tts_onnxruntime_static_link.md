---
name: tts-onnxruntime-static-link
description: Kokoro TTS in the sidecar statically links onnxruntime into hyperia-sidecar.exe — no onnxruntime.dll to bundle
metadata:
  type: project
---

The local Kokoro TTS feature (`sidecar/src/tts.rs`, deps `kokoro-tts` + `rodio`) pulls in `ort` 2.0.0-rc.12 with its default `download-binaries` feature, which **statically links onnxruntime into `hyperia-sidecar.exe`**.

Evidence (Windows, release build): the exe jumps from ~11 MB to **~45 MB** once TTS is actually linked, and the exe has **zero dynamic import of `onnxruntime.dll`** (`grep -a "onnxruntime.dll" hyperia-sidecar.exe` → 0). No `onnxruntime.dll` is emitted anywhere under `sidecar/target/release/`. The only stray DLL there is a 147-byte `DirectML.dll` stub (a GPU provider, not functional, never referenced by `electron-builder.json`).

**Why:** ort's rc line static-links the downloaded onnxruntime by default rather than shipping a sidecar DLL.

**How to apply:** Do NOT add `onnxruntime.dll` (or DirectML/CUDA/TensorRT provider DLLs) to `electron-builder.json` `win.extraResources` for TTS — the self-contained exe already carries ONNX, and inference is CPU-only. The existing `win.extraResources` entry that copies `hyperia-sidecar.exe` to `resources/sidecar/` is sufficient. If a future ort bump switches to dynamic linking, the exe will shrink and gain an `onnxruntime.dll` import — only THEN bundle the DLL next to the exe. See [[build-exe-lock-workaround]] for building while a dev instance runs.
