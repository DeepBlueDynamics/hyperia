# Control Room v2: a flat screen with desks, simulated in the sidecar

The research run and the agreed 5-step plan for rebuilding the 3dterminal ops room as **one flat wall screen plus desks**, with the room simulated in Hyperia's Rust sidecar. Speed-first and fidelity-first. It was produced by an n8 swarm (Grok, Codex, Antigravity, opencode) working in the `research/3dterminal` project, and moved here so Hyperia's swarm can implement it.

| File | What it is |
|---|---|
| `PLAN.md` | **The plan.** 5 steps, 7 forced decisions, perf and fidelity gates, and the review log (revision 3: **AGREE 4/4** from Codex, Grok, Antigravity and opencode) |
| `SWARM.md` | The brief the research swarm worked from: goals, the speed mandate, the fidelity mandate |
| `AUDIT.md` | What survives from 3dterminal, what dies, and the bugs not to port (Grok) |
| `SIDECAR.md` | The sidecar architecture: room actor, event-driven damage, lock discipline (Codex) |
| `RENDER.md` | Rendering and transport, with measured microbenchmarks (Antigravity) |
| `ROOM.md` | The physical room: screen size, pixel density, legibility, desk layout per MIL-STD-1472H (opencode) |
| `ROSTER.md` | The agents' addresses during the run |
| `VOTE-opencode.md` | opencode's full ballot: the ROOM numbers that bind steps 1, 4 and 5 (4/4/4 desks, 7.2 m legibility pose, lease distances) |
| `bench/` | Benchmark sources and results cited by RENDER.md and PLAN.md (the `render-bench` Rust crate and the Node cell-wire bench); build output not included |

## Path notes
- The docs were written inside a container where the project was `/workspace/3dterminal`. References to `docs/control-room-v2/…` mean this folder. References to 3dterminal's own code (`frontend/src/...`, `backend/src/main.rs`, `main.ts:NNN`) point into the 3dterminal repo.
- `SWARM.md` mentions `hyperia-ref/`, a read-only copy of Hyperia sources given to the container. It's not included here; use the real `sidecar/src/stream.rs`, `screen.rs` and `snapshot_image.rs`.
- The measurements in RENDER.md are microbenchmarks from the research container. PLAN.md step 5 is where the end-to-end numbers get qualified. None are claimed as passing yet.
