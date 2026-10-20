# Swarm order: Control Room v2, a flat screen with desks, simulated in Hyperia's Rust sidecar

Director: host-claude (bare metal, knows Hyperia's internals). This is a **RESEARCH RUN**: no product code changes, no commits. The deliverable is **`PLAN.md`: a 5-step plan** to build Control Room v2 inside Hyperia's Rust sidecar, optimized first for speed.

## The goal (Kord)
Upgrade the ops control room.
- **Before:** a curved three-arc wall (`Wall_Screen_1/2/3`), only the middle arc live, plus 3 desks rendered in a browser (three.js).
- **Now:** **one flat wall screen plus desks with monitors.**
- **Where:** simulate it **in the Hyperia Rust sidecar** so it is *fast*: the room state, which pane shows on which screen or desk, compositing, leases and frame pacing live in Rust. Any client should be a thin view.

Read first:
- `README.md`
- `docs/REPORT.md`: what works and what doesn't, including the known clobber bugs from the `"tab:"`/`"terminal:"` string prefixes
- `docs/RUST_PORT_SPEC.md` and `docs/PORT_SPEC_LANE_{A..D}.md`
- `docs/ROOM_DISPLAY_AND_CONTROL_SPEC.md`
- `docs/HYPERIA_EVENT_STREAM_API.md`
- `frontend/src/**` (about 7.3k lines of TypeScript)
- `backend/src/main.rs`

## What Hyperia's sidecar already has (from the director; sources in `hyperia-ref/`)
The sidecar is Rust (axum/tokio) on `:9800`, and every pane's PTY flows through it.
- **`/ws/wall`** (`stream.rs`): every pane at once. The **sidecar renders a colorized cell grid** and sends a JSON keyframe followed by row `delta`s.
  - Poll-based: a per-connection `tokio::time::interval` at `?fps=` dumps only the panes whose `SessionInfo.last_output_at` changed since the last tick.
  - Each connection diffs against its own cache.
  - It stays off the `bridge.rs` hot path.
- **`/ws/pane/{id}`:** full fidelity. It sends raw PTY bytes as binary frames, seeded with the current screen (for xterm.js or any vt100 parser). It rides `Bridge::subscribe_output` fan-out.
- **`/ws/pixels/{id}`:** Electron captures the pane at the client-requested w×h as a **JPEG** and ships it as binary, skipping byte-identical frames. It's pull-based (only while watched), but every frame is an Electron capture round trip.
- **`/ws/tab/{id}`:** a tab's composite.
- `screen.rs` holds the screen model. `snapshot_image.rs` is a pure-Rust PNG renderer (`png` plus `font8x8`, no heavy dependencies), which shows the sidecar can already rasterize.
- **Hard-won performance lessons from Hyperia, today:**
  - Never hold the session-table `tokio::Mutex` guard across an `.await`. Doing so caused a deadlock that stalled every pane operation.
  - Never do synchronous fsync or file writes on the request path. A per-request session-store fsync stalled every MCP call under disk load.
  - Keep work off `bridge.rs`'s output hot path.
  - JSON cell deltas and Electron JPEG captures are the obvious throughput ceilings. Measure them before and after.

## SPEED MANDATE: decide, don't survey (Kord: "as fast as fuck")
The job is not a list of options; it's **decisions**. `PLAN.md` must commit to one answer per question below, justified by numbers. "It depends" or an unresolved A/B is a failed plan. Where you lack a measurement, run a scratch benchmark in `/tmp`, or cite one, and label which it is.

**Targets PLAN.md must hit, or explicitly beat:**
| Metric | Target |
|---|---|
| Output latency: byte written to the PTY → pixel changed on the wall, p99 on localhost | **≤ 16 ms** (one frame at 60 Hz). Stretch: ≤ 8 ms. |
| Wall frame rate while panes stream (`cargo build`, `yes`, a TUI redraw storm) | **60 fps sustained**, no dropped frames at 4K wall resolution |
| Sidecar CPU for the room, per active streaming pane | **≤ 1% of one core**. Idle room ≈ 0% (event-driven: nothing is timer-polled when nothing changes). |
| Bandwidth to one viewer, 16 panes streaming | quote it; justify the encoding |
| Hot path | **zero** added work in `bridge.rs`'s PTY output path when no room viewer is attached; bounded work when one is |
| Sidecar session lock | never held across `.await` in room code; no sync fsync or file IO per frame |

### FIDELITY MANDATE (Kord): accurate renderings and hi-res fonts are preferred
Speed must be won **without** degrading what's on screen. When speed and fidelity conflict, fidelity wins: find a faster way, don't render worse.
- **Accurate:** every surface must look like the real terminal. That means truecolor (24-bit), bold/italic/dim/underline/strikethrough/inverse, a correct cursor, box-drawing and block elements, wide CJK cells, and emoji. `/ws/pane` + xterm is the accuracy reference; anything else must match it pixel-for-pixel on the same content, or say exactly where it differs.
- **Hi-res fonts:**
  - Real vector glyphs rasterized at the display's actual pixel density, with hinting and anti-aliasing.
  - No 8×8 bitmap fonts (`font8x8` is for Hyperia's schematic PNGs, not this), and no scaled-up low-res textures.
  - For surfaces seen at an angle or from a distance, pick a technique that stays sharp: MSDF/SDF glyph atlases, per-surface textures sized to on-screen pixels, or mipmaps with anisotropic filtering. Justify the choice against legibility at the viewing distances opencode derives.
- **No lossy text:** JPEG/WebP smears glyph edges, so text-bearing frames must be **lossless** (dirty-rect RGBA/QOI, cell deltas drawn client-side, or equivalent). A lossy codec is acceptable only for non-text video content, if any.
- Each PLAN.md step lists its fidelity check next to its speed target, e.g. a golden-image diff against the xterm reference, and a legibility test at the target distance.

**Forced decisions (answer each in PLAN.md with the winning choice plus numbers):**
1. **Where pixels are made:** server-side Rust compositing of the flat wall, client-side drawing from cell data, or a hybrid (say, cells for the wall, raw PTY for desks). One answer.
2. **Change detection:** today `/ws/wall` is *timer-polled* at `?fps=` and re-dumps changed panes. Replace it with **event-driven damage tracking** (dirty rows/rects from the screen model)? It must decide how to coalesce to the display refresh without a busy timer.
3. **Wire format:** JSON must die on the hot path. Pick the binary format (cell deltas vs dirty-rect pixels vs a video codec) and quote bytes per frame.
4. **Text rasterization,** if any is server-side: pick the crate and glyph-cache strategy (an atlas, with only dirty glyph cells re-blitted), CPU vs wgpu.
5. **Desks:** pick the stream per desk monitor (raw PTY `/ws/pane` into a client terminal vs composited).
6. **Client:** pick the renderer (three.js vs raw WebGL2/WebGPU texture updates) and how textures update (`texSubImage2D` on dirty rects only).
7. **Backpressure:** what happens when a viewer is slow (drop to a keyframe; never queue unbounded).

## Research questions
1. What exactly is "simulated" in the sidecar? Options include:
   - the room model: screens, desks, bays, which surface shows what, focus;
   - leases and visibility (only watched surfaces stream);
   - server-side compositing of the flat wall;
   - frame pacing;
   - optionally camera/presets.

   Where is the line between the sidecar and a thin client?
2. **Flat wall rendering:**
   - Composite N panes into ONE wall framebuffer in Rust (cell grids rasterized with fontdue/swash/cosmic-text plus tiny-skia, or wgpu headless), **or** send per-surface cell data and let the client draw?
   - Encoding: raw RGBA dirty-rects, QOI, WebP/JPEG, H.264 via the client's WebCodecs, or binary cell deltas.
   - Give numbers for latency, CPU per frame, bandwidth at 1080p/4K, and 30/60 fps.
3. **Desks:** how many monitors and at what resolution. Do desk monitors stream `/ws/pane`-style raw bytes (pixel-exact, cheap) or composited frames?
4. **Protocol:** binary framing (not JSON), keyframe/delta, backpressure, multiple viewers, reconnect.
5. **Human factors:** flat screen size, viewing distance and legible terminal text size; desk layout. See `scratch/MIL-STD-1472H.pdf` (control-station ergonomics).
6. **What carries over** from 3dterminal (descriptor, bays, leases, SATCOM sim), and what dies with the curved wall.

## Assignments (edit ONLY your own file; everyone reads everything)
| Agent | Research lane | Owns |
|---|---|---|
| **Grok** (Crooked Gull) | Audit of the existing 3dterminal code and docs: what carries over to flat-screen-plus-desks, what dies, and which known bugs must not be ported (e.g. the string-prefix clobbers) | `docs/control-room-v2/AUDIT.md` |
| **Codex** (Awful Camel) | Hyperia sidecar architecture: where a `room` module lives, how it taps panes without touching the hot path, locks and backpressure, and extending `stream.rs` vs a new endpoint. **Also owns `PLAN.md`** and drives consensus | `docs/control-room-v2/SIDECAR.md`, `PLAN.md` |
| **Antigravity** (Cool Ocelot) | Rendering and transport: CPU vs GPU compositing in Rust, text rasterization crates, encoding, and a binary protocol, **with benchmark numbers** or cited measurements | `docs/control-room-v2/RENDER.md` |
| **opencode** (Disciplinary Pig) | The physical room: flat-screen size and pixel budget, legible text at distance, number of panes on the wall, and the desk layout per MIL-STD-1472H. Also the new room descriptor shape | `docs/control-room-v2/ROOM.md` |

## Consensus protocol
- Share findings directly with `msg_send` (to_label below) and challenge each other with evidence.
  - Grok: `nemesis8/<its container name>`. Each agent: run `whoami` and post your address in `docs/control-room-v2/ROSTER.md` (append-only) first thing.
  - If mail misbehaves, use the files as the channel.
- Codex drafts `PLAN.md` as **exactly 5 steps**. Each step has:
  - a goal and deliverable;
  - the files/modules it touches (Hyperia sidecar vs 3dterminal client);
  - **a performance target with how it's measured** (fps, p99 frame latency, CPU %, bandwidth);
  - risks;
  - a test that proves it (the current project has no render test).
- Every agent appends `AGREE` or `OBJECT: <reason>` to `PLAN.md`'s review log, and Codex iterates until all four agree. Then Codex tells host-claude.

## Rules
- Research only: no product code edits, no commits, no builds of Hyperia. Small scratch benchmarks are fine under `/tmp`, reported with the machine/container caveat.
- **Never put a real username or home-directory path in anything you write.** This ships publicly; use `alice`/`~` in examples.
- If Hyperia misbehaves (a tool error, delivery, identity), report it to host-claude. The swarm fixes the Hyperia bugs it hits.
