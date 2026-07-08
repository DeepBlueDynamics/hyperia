# ORDERS — fix Kokoro TTS garbled English (G2P), repo `hyperia`, branch `canary`

## Bug (already diagnosed — do not re-diagnose)
`sidecar/Cargo.toml` has `kokoro-tts = "0.3"` with NO features. The crate's real
English G2P is gated behind the non-default `use-cmudict` feature (CMU Pronouncing
Dictionary via `cmudict_fast`). Without it, English is phonemized letter-by-letter
from spelling → speech sounds fluent but says the WRONG words. `grep -c cmudict
sidecar/Cargo.lock` = 0 proves the dictionary path never compiled.

## HARD RULES
- The user's Hyperia is RUNNING on port 9800. NEVER touch it, never kill Hyperia/
  sidecar processes, never bind 9800. Test on port 9801 only, kill only that PID.
- The working tree has UNCOMMITTED changes (frame flag in `src/main.rs` +
  `src/mcp.rs`, wav-dump in `src/tts.rs`). KEEP them. Revert nothing.
- Do not push, tag, or build the Electron installer. Sidecar only.

## Steps
1. `sidecar/Cargo.toml`: change the dep line to
   `kokoro-tts = { version = "0.3", features = ["use-cmudict"] }`
2. Verify the new dep tree is clean:
   `cargo tree -i cmudict-fast --manifest-path sidecar/Cargo.toml` and confirm NO
   bindgen / clang-sys / espeak / aws-lc-sys / openssl-sys appear anywhere new.
3. Check how the dict loads: read `~/.cargo/registry/src/*/kokoro-tts-0.3.3/src/g2p.rs`
   (`get_cmudict`, ~line 103) and the `cmudict-fast` crate source. If the dictionary
   is embedded in the crate → nothing to do. If it expects a runtime file →
   download/cache it under `~/.hyperia/kokoro/` following the exact
   `ensure_model()` pattern already in `sidecar/src/tts.rs`.
4. Build: `cargo build --release --manifest-path sidecar/Cargo.toml` → must exit 0.
5. Test (throwaway sidecar, NOT the live app):
   - `HYPERIA_SYSTEM_TOKEN=test ./sidecar/target/release/hyperia-sidecar.exe --port 9801`
   - `curl -s -X POST http://localhost:9801/api/tts -H "Content-Type: application/json" -d "{\"text\":\"The quick brown fox jumped over the lazy dog.\",\"voice\":\"af_heart\",\"frame\":false}"`
   - Expect `ok:true`, ~4s duration; audio plays on speakers AND dumps to
     `~/.hyperia/kokoro/last.wav`. The human listens and judges.
   - Kill ONLY the 9801 process afterwards.
6. Commit (version stays 0.16.0 — unreleased milestone; no bump):
   `git commit` all sidecar changes incl. the pre-existing uncommitted frame/wav-dump
   work, message: `fix(tts): enable use-cmudict — real English G2P (was letter-spelling fallback = garbled words); + frame:false raw mode + last.wav debug dump`
   (no --no-verify needed; hooks are gone).
7. Report: dep-tree verdict, dict-load mechanism, build exit, curl output, commit hash.
