# Memory Index

- [Build exe-lock workaround](build_exe_lock_workaround.md) — rename the running sidecar exe (don't kill Electron) so `cargo build --release` can write the binary while `yarn start` holds it
- [TTS onnxruntime static link](tts_onnxruntime_static_link.md) — Kokoro TTS statically links onnxruntime into the exe (~45MB, no dynamic import); do NOT bundle onnxruntime.dll in electron-builder.json
