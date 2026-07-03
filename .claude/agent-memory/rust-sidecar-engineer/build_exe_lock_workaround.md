---
name: build-exe-lock-workaround
description: How to complete `cargo build --release` when a live `yarn start` Electron holds the sidecar exe
metadata:
  type: project
---

`cargo build --release --manifest-path sidecar/Cargo.toml` compiles fine but fails at the final link/copy step with `error: failed to remove file ... hyperia-sidecar.exe / Access is denied (os error 5)` when a Hyperia dev instance is running. The Electron dev process (`yarn start`) auto-respawns the sidecar, so `Stop-Process` on the sidecar alone loses the race — a new PID re-locks the exe within a second.

**Why:** the output binary IS the running process image; Windows won't let cargo delete-in-place a file backing a live process, and the bridge respawns it.

**How to apply:** Windows allows *renaming* a running exe even while locked. Before building, rename it out of the way so cargo writes a fresh one; the live process keeps using the renamed file:
`Rename-Item sidecar/target/release/hyperia-sidecar.exe hyperia-sidecar.exe.old` then build. Clean up the `.old` afterward (may still be locked until the old process exits — best-effort `rm -f`). Do NOT kill the whole Electron/`yarn start` session to build — it's the human's live workspace. This matches the user's auto-memory note about the sidecar port-9800 clash / closing the installed copy, but the rename trick avoids disrupting the dev session entirely.
