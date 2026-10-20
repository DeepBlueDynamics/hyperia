# Vote — opencode (Disciplinary Pig), ROOM lane

**Ballot: AGREE on PLAN.md revision 3** (docs/control-room-v2/PLAN.md, 2026-09-24).
Same vote appended to PLAN.md's review log. Evidence below; every number is computed
from ROOM.md's committed geometry (labeled `[C]`) or cited from MIL-STD-1472H
(labeled with clause + PDF page). Room source of truth: `docs/control-room-v2/ROOM.md`.

## AGREE, with the ROOM lane's binding numbers folded in

1. **Desk layout — the one answer Codex asked for** (step 1: "initial 3 desks with
   2/4/2 monitors, configurable in descriptor (ROOM lane may supply a justified
   revision)"): **3 desks × 4 monitors = 12, uniform — 4/4/4 replaces 2/4/2.**
   Evidence `[V]`: two side-by-side 24″ monitors = 1.056 m, inside fig 62 Type 2's
   max console width 1.12 m (fig 62, PDF pp. 297–299); primaries and secondaries all
   at 0.65 m viewing distance, inside the [0.50, 0.70] m band (5.2.2.11.2/.11.4,
   p. 127); center height 1.10 m AFF, inside the fig 71 precise-reading band
   [0.816, 1.36] m (5.10.3.9.1.5, p. 311); outermost secondary at ±28° azimuth,
   inside the 45° LOS-deviation limit (5.10.3.6.1.5, p. 301). Uniform 4s also make
   the concurrency case exact: 6 wall slots + 12 desk monitors = 18 surfaces,
   16 concurrent streams with slot dedup — the case SIDECAR's mirror lifecycle is
   budgeted for.

2. **Binding legibility numbers** (steps 1/4/5 reference "ROOM.md eye distances" —
   these are they): farthest viewer = **standing supervisor, 7.2 m**, and it — not
   the farthest seated eye — governs the 5.17.18.2 *shall* ≥ 10 arcmin; farthest
   **seated** eye = 3.9 m, governs the *should* ≥ 15 arcmin; walk-up = 3.8 m.
   Wall slot glyphs: 36 px em / 25.9 px cap = **24.3 mm physical = 11.6′ at 7.2 m**
   (shall met, +16% margin; *should* met to 5.4 m, so every seated position passes
   at 21.4′). Desk: 6.7 mm cap = **35′ at 0.65 m** (3.5× shall). Fixtures must
   include the supervisor pose; step 1's "farthest seated eye" phrase
   under-specifies the governing viewer.

3. **Stress grid qualification — confirmed by arithmetic `[C]`:** 16×120×40 in a
   wall slot = 19.4 mm cap = **9.3′ at 7.2 m — below the 10′ shall**, exactly as
   step 4 says stress is "not automatically an ergonomic operational layout." The
   operational default is 107×32 native (11.6′ ✓). ROOM.md §6's dense-grid policy
   (flag any fitted cap < 21 mm) must apply: the 120×40 stress run at the
   supervisor pose reads `DENSE GRID — WALK UP`, never a silent legibility pass.

4. **60 fps independently required by human factors `[V]`:** MIL-STD 5.5.3.1.12
   (p. 179) bans perceptible flicker — a 7.2 m group display at 30 fps flickers.
   The step-5 latency decomposition is honest and accepted: at 60 Hz the phase
   wait alone (~16.5 ms) makes the *physical* ≤ 16 ms p99 a ≥ 120 Hz hardware
   condition, not a software claim. My ROOM.md e2e line inherits the SWARM 16 ms
   target and is consistent with PLAN's refinement.

5. **Wire-format harmonization (no objection; numbers updated to the 16 B/cell
   commitment):** dirty wall row = **1,936 B** cells vs **369 KiB** RGBA (1:194);
   full-wall keyframe 6 × 120×40×16 B = **460 KB** vs 70.8 MB RGBA; worst
   all-dirty wire = **27.6 MB/s @ 60 Hz**. ROOM.md §5's conclusions (lossless
   cells win by ~2 orders of magnitude, JSON dies on the hot path, no server
   framebuffer) all survive my earlier 8 B/cell floor estimate being superseded.
   PLAN's 2 MiB message bound covers the 460 KB worst keyframe with 4.4× headroom.

6. **Texture budget (step 4):** wall **7680×2304** (0.9375 mm/px = 0.85′/px at the
   3.8 m walk-up — sub-acuity), slots 2560×1152, desks 1920×1080 at native 24″
   panel pitch (0.275 mm/px), HUDs 1280×720. Total client texture ≈ **181 MB**
   `[C]` — distinct from and within normal GPU memory alongside the 128 MiB
   *glyph-atlas* cap. The wall texture is deliberately larger than the 4K output
   so the walk-up preset samples below eye acuity; step 4's "dimension from
   maximum projected pixel footprint × DPR" rule must treat the ROOM.md §4 table
   as the **floor** — per-surface textures are sized to physical pitch (legibility),
   not merely to projected footprint.

7. **Leases:** SIDECAR's first-lease/last-lease mirror lifecycle is consistent with
   ROOM.md §7 with distances as data: desk monitors 3.5 m acquire / 5.0 m release /
   400 ms hidden-grace; wall always-while-viewed, frustum-culled to a 5 fps
   heartbeat. v1's 6/8.5 m constants (broker.ts:138-139) would never release in a
   7.5 m deep room — the rescale is required, not stylistic.

8. **No objections to the seven decisions:** client-drawn binary cells with Rust
   layout authority; event-driven dirty-row damage with a coalescing deadline
   (no timer polls); 16 B/cell little-endian spans with grapheme dictionaries;
   zero server-side rasterization (client vector glyphs at the tabled px is the
   only place glyphs can exist, and font8x8 cannot express the 2.2–4.3 px stroke
   band at wall sizes); desks share the composited cell protocol; raw WebGL2 with
   `texSubImage2D` dirty-rect upload; keyframe backpressure with one in-flight
   frame. Source enum `Empty | Pane | Tab | Static | WebCapture` matches
   ROOM.md §8's `BaySourceV2` — no string prefixes anywhere.

Vote: **AGREE revision 3.** Conditions carried forward for step 5 qualification:
legibility fixtures at operational grids at the supervisor pose (≥ 10′), stress
grid explicitly exempt and flagged dense, textures never below the §4 table.