# ROOM.md — Control Room v2: the physical room, its pixel budget, and the legibility math that binds the renderer

Owner: opencode (Disciplinary Pig). Lane per `SWARM.md`: flat-screen size and pixel budget, legible terminal text at distance, panes on the wall, desk layout per `scratch/MIL-STD-1472H.pdf`, and the new room descriptor shape.

Method note (per the SPEED MANDATE): every number below is **computed** (labeled `[C]`, arithmetic reproducible from the given inputs), **verified from a source** (`[V]` — MIL-STD-1472H clause with PDF page, live `terminal_status`, or a repo file), or **assumed** (`[A]`, with the check that would confirm it). The MIL-STD page numbers are the PDF's own page indices.

---

## 0. Decisions (the short version)

| Question | Decision | Key number |
|---|---|---|
| Flat wall size | **7.2 m × 2.16 m**, bottom edge 0.30 m AFF, in a 9.0 × 7.5 × 3.0 m room | 2.4 m wide slots |
| Panes on the wall | **6** (3 columns × 2 rows of 2.40 × 1.08 m slots) | 107×32 native per slot |
| Wall texture | **7680 × 2304 px** (0.9375 mm/px) — the pixel budget the renderer must hit | 70.8 MB full-frame RGBA |
| Wall glyph size | **24.3 mm cap height** (36 px cell line, 23.9 px advance) | 11.6′ of arc at the farthest viewer — meets the 10′ *shall*; 15′ *should* met within 5.4 m |
| Desk layout | **3 consoles** (MIL-STD fig 62 Type 2), eye 3.9 m from wall, centers 2.2 m apart | free floor 3.3 m ≥ 1.22 m required |
| Desk monitors | **4 per desk × 3 desks = 12**, 24″-class 16:9 (528 × 297 mm glass), 1920 × 1080 textures, **0.65 m viewing distance** | glyph 6.7 mm = 35′ of arc — 3.5× the *shall* |
| Surfaces streaming at once | 6 wall + 12 desk = 18 max; **16 concurrent** is the SWARM's measured case | see §5 bandwidth |
| Wall stream | binary cell deltas + client-side raster, 60 fps | 856 B per dirty pane row (vs 369 KiB RGBA) |
| Desk stream | raw PTY (`/ws/pane`-style) → client-side terminal at native grid | 0.275 mm/px native pitch |
| Lease distances (rescaled from v1's 6/8.5 m) | desk monitor focused ≤ 3.5 m acquire / 5.0 m release / 400 ms grace; wall always-on-while-viewed, frustum-cull drop to 5 fps | room is only 7.5 m deep |
| Dense-grid policy | a pane denser than ~128 cols in a slot is flagged, never silently illegible; walk-up preset (3.8 m) restores legibility to ~14′ | §6 |

---

## 1. Who looks at what, from where (the distances that drive everything)

`[C]` The room has three viewer classes. Distances are measured eye-to-glass.

| Viewer | Eye height (AFF) | Eye-to-wall distance | Reads | Duty |
|---|---|---|---|---|
| Seated operator (×3) | 1.24 m `[C]` (seat 0.46 m + eye 0.78 m) | **3.9 m** | own desk monitors (0.65 m); wall slots = shared status | sustained reading — must meet the 15′ *should* |
| Walk-up (any) | 1.40 m | **3.8 m** (preset) | one wall slot up close | inspection |
| Standing supervisor | 1.65 m `[A]` (5th–95th percentile standing eye; check against the anthropometry table in §5.8) | **7.2 m** (0.3 m off the back wall) | whole wall | gross monitoring — must meet the 10′ *shall* |

Why 3.9 m and 7.2 m `[C]`: consoles front edge at 3.3 m from the wall (0.9 m console depth + fig 62 dimension K, eye 0.55 m behind the front edge → eye ≈ 3.85 m); room depth 7.5 m, supervisor stands ~0.3 m from the back wall.

Greatest anticipated viewing distance per MIL-STD 5.17.18.2 `[V]` = **7.2 m** (the supervisor). All character-size floors are evaluated there.

---

## 2. Wall sizing — derived, not guessed

Inputs: farthest viewer 7.2 m; seated readers 3.9 m; live Hyperia panes at their **native grids** (fidelity mandate: no resampling of content). The panes in this deployment are **107 cols × 32 rows** `[V]` (live `terminal_status`, all four research panes) with 80×24 shells also present `[V]`; 120×32 is the widest common case `[A]` (check: pane resize events in a long capture).

MIL-STD 5.17.18.2 `[V]` (PDF p. 399): characters shall subtend ≥ 2.9 mrad (**10 arcmin**) and should subtend ≥ 4.5 mrad (**15 arcmin**) at the greatest anticipated viewing distance.

Sizing chain `[C]`:

1. Glyph cap height at the back wall: 2.9 mrad × 7.2 m = **20.9 mm minimum**; design target 24.3 mm (+16% margin over the *shall*).
2. Terminal line height at 0.72 cap fill: 24.3 / 0.72 = **33.75 mm** → 32 rows = **1.08 m slot height**.
3. Cell advance at 0.55 line aspect (typical monospace cell) `[A]`: 33.75 × 0.55 = 18.6 mm → 107 cols = **1.99 m pane width**; slot width rounded up for gutters: **2.40 m**.
4. Slots: **3 columns × 2 rows** = 6 panes. Wall = 3 × 2.40 = **7.2 m wide**, 2 × 1.08 = **2.16 m tall**.

Legibility results `[C]` (arcmin = (cap_mm / 1000) / D_m × 3437.75):

| Viewer | Glyph 24.3 mm subtends | Verdict |
|---|---|---|
| Supervisor, 7.2 m | 3.375 mrad = **11.6′** | ≥ 10′ *shall* ✓ (+16%) |
| Seated operator, 3.9 m | 6.23 mrad = **21.3′** | ≥ 15′ *should* ✓ |
| Walk-up, 3.8 m | 6.40 mrad = **22.0′** | ✓ |
| 15′ *should* met up to | 24.3 mm / 4.5 mrad = **5.4 m** | — |
| 10′ *shall* met up to | 24.3 mm / 2.9 mrad = **8.4 m** | — |
| 80×24 panes (48 px lines → 32.4 mm glyph) | **15.0′ at 7.2 m** | *should* met even at the back |

Vertical geometry `[C]`: wall bottom 0.30 m, top 2.46 m AFF. Seated eye to wall top: 17.4° above horizontal → 32.4° off the normal line of sight (15° below horizontal, MIL-STD 5.2.2.16.1 analogy `[V]` p. 132) — within the 45° limit of 5.10.3.6.1.5 `[V]` p. 301. Supervisor: top 6.4°, bottom 10.6° — ✓ (both within the 15°-below-LOS comfort band, trivially inside the 45° limit).

Large-screen clauses, reconciled per slot `[V]` (pp. 127–129): 5.2.2.12.1.e says a multiple-viewer display may consist of multiple individual displays — each **slot** (diagonal 2.63 m) is the display unit. Viewing-distance:diagonal (5.2.2.12.3, 2–10 acceptable): supervisor 7.2/2.63 = **2.73 ✓**; seated 3.9/2.63 = 1.48 — *under* 2.0, which is fine because a seated operator reads their slot the way 5.2.2.11 governs an individual display, not a group screen. Minimum distance (5.2.2.12.5): half the display width — whole wall 3.6 m, so the walk-up preset sits at **3.8 m** ✓; per-slot 1.2 m ✓ trivially. Traffic (5.2.2.12.6): the supervisor lane runs behind the consoles, never through the sightlines — §3 clearances enforce it.

---

## 3. Room envelope and desk layout per MIL-STD-1472H

Room: **9.0 m wide × 7.5 m deep × 3.0 m tall** `[C]`. Wall display centered on the z=0 wall.

**Consoles** (5.10.3.2.1, fig 62 Type 2 "Sit, without vision over top" `[V]` pp. 297–299): total height 1.31–1.47 m, panel vertical 0.66 m, writing surface 0.65–0.81 m AFF, max console width **1.12 m**, dimension K (eye line to console front) 0.40 m, writing-surface depth 0.40 m (5.10.3.9.2.1 `[V]` p. 311: ≥ 76 cm wide × 40 cm deep workspace).

- 3 consoles at x = −2.2, 0, +2.2 m, front edge z = 3.3 m, all facing the wall (+z faces wall).
- Free floor in front of each console: **3.3 m** ≥ 1.22 m required (5.10.2.9.1 `[V]` p. 296). ✓
- Walk-behind lane behind a seated operator: chair zone to back wall = **2.1 m** ≥ 1.37 m (5.10.2.6.5.1–.2: 122 cm + 15.2 cm `[V]` p. 296). ✓
- Lateral gap between consoles: centers 2.2 m − 1.12 m width = **1.08 m** `[A]` acceptable as a side passing lane (figure 59's walkway widths are an image I could not extract; check against fig 59 before fabrication).
- Seat: 0.46 m mid-range (fig 62 D band 0.43–0.69 m), adjustability 0.15 m (fig 62 G) `[V]`.

**Desk monitors** (individual displays, 5.2.2.11 `[V]` p. 127): 4 per desk — 1 primary at 0° azimuth + 3 secondary arranged ±28°/±14° `[C]`, all:

- Viewing distance **0.65 m** ≤ 0.70 m max (5.2.2.11.2) ✓, ≥ 0.50 m preferred minimum (5.2.2.11.4) ✓.
- 24″-class 16:9 glass **528 × 297 mm**, diagonal 60.6 cm ≤ 81.28 cm cap (5.2.2.11.2) ✓.
- Center height **1.10 m AFF** — inside the fig 71 precise-reading band [0.816, 1.36] m (dimensions D=35.6 cm and B=90 cm above the 0.46 m seat reference, 5.10.3.9.1.5 `[V]` p. 311). Primary top edge 1.25 m AFF ≈ seated eye height: reading happens within ±24° of the line of sight ✓ (≤ 45°, 5.10.3.6.1.5).
- Angular deviation for the outermost secondary at ±28° azimuth: ≤ 45° ✓; mounted perpendicular-ish to the sightline per 5.10.3.6.1.4 (rotate each secondary ~14° toward the operator).

**Illumination** (table XXI `[V]` p. 177): computer work **300 lux** preferred and minimum; passageways 150–215 lux. Luminance ratios ≤ 5:1 between any two sources in the field of view (5.5.3.1.5 `[V]` p. 179); surfaces adjacent to displays matte (5.5.3.1.7); ambient light contributes ≤ 25% of total display luminance (5.5.3.1.9) → **dim the room to 300 lux, wall at terminal luminance**; direct-view large-screen contrast ≥ 1.5:1 (5.2.2.12.8) — standard terminal palettes are 4.5:1+ ✓. No perceptible flicker (5.5.3.1.12) → **the wall must composite at 60 fps**, not 30; this independently second's the SWARM's 60 fps target. Dark-on-light vs light-on-dark: 5.2.2.12.8.1 prefers dark characters on light unless the background flickers; ops terminals keep light-on-dark under the flicker/dark-adaptation exceptions (5.5.3.6), which the room's dim mode invokes — documented, not silent.

Colors: no colored markings on comparable-brightness colored backgrounds (5.2.2.13.9.4.4) — the terminal palette validation should assert ANSI pairs keep a luminance delta.

---

## 4. Pixel budget (what the renderer must hit)

Pitch rule `[C]`: texture pitch must be finer than 1 arcmin of eye acuity at the **closest** viewer, or the texture itself becomes the blur.

| Surface | Count | Physical | Texture px | Pitch | Closest viewer / pitch subtends |
|---|---|---|---|---|---|
| Wall | 1 | 7200 × 2160 mm | **7680 × 2304** | **0.9375 mm/px** | walk-up 3.8 m → 0.85′/px ✓ sub-acuity |
| Wall slot | 6 | 2400 × 1080 mm | **2560 × 1152** | 0.9375 mm/px | (same texture, slot bounds) |
| Desk monitor | 12 | 528 × 297 mm | **1920 × 1080** | **0.275 mm/px** (= real 24″ 1080p panel pitch) | 0.65 m → 1.46′/px — native panel density; fidelity reference |
| Desk HUD | 3 | 308 × 173 mm | **1280 × 720** | 0.239 mm/px | 0.5 m → 1.64′/px ✓ |

Client texture memory (RGBA): wall 70.8 MB + 12 × 8.3 MB + 3 × 3.7 MB ≈ **181 MB** `[C]` — trivial for any GPU, but the full-frame RGBA *upload* is what's forbidden: one wall frame at 60 fps = **4.25 GB/s** memcpy `[C]`. That number is the entire argument for the cell/dirty-rect paths (Antigravity's lane, but it is a wall-geometry consequence, so it binds here).

**Glyph metrics** `[C]` (from slot px ÷ native grid):

| Surface | Pane grid | Cell (adv × line) | Font em | Cap height | Physical cap | Stroke px (MIL 5.17.18.4 band = 0.0834–0.1667 × cap) |
|---|---|---|---|---|---|---|
| Wall slot | 107 × 32 | 23.9 × 36 px | 36 px | 25.9 px | **24.3 mm** | band 2.2–4.3 px; typical terminal stem ~3.6 px ✓ |
| Wall slot | 120 × 32 | 21.3 × 36 px | 36 px | 25.9 px | 24.3 mm (line-limited) | ✓ |
| Wall slot | 80 × 24 | 32 × 48 px | 48 px | 34.6 px | 32.4 mm → 15′ even at 7.2 m | band 2.9–5.8 px ✓ |
| Desk monitor | 107 × 32 | 17.94 × 33.75 px | 33.75 px | 24.3 px | 6.68 mm → **35′ at 0.65 m** | ✓ |
| Desk monitor | 120 × 32 | 16 × 33.8 px | 33.8 px | 24.3 px | 6.7 mm → **35′ at 0.65 m** (line-limited, same as 107×32) | ✓ |
| Desk HUD | — | — | 24 px min text | 17 px | 5.7 mm → 39′ at 0.5 m | ✓ |

All grids letterbox to the next-larger axis (e.g., a 107×32 pane on a desk monitor occupies 1920 × 1043 with 18 px bars); scaling is **fit-only, never stretch**.

**Renderer obligations that fall out of the FIDELITY MANDATE, with my numbers:**

1. Vector glyphs rasterized at the *tabled* px sizes, hinting + AA. `font8x8` is banned on every surface above (its 8 px cell cannot express the 2.2–4.3 px stroke band at any of these sizes).
2. Wall texel density is 0.85′/px at the closest viewer — under the 1′ acuity limit — so a **conventional AA'd glyph atlas + mipmaps + anisotropic ×8** meets the acuity argument at the spec'd texture size; MSDF/SDF becomes necessary **only if** the texture is shrunk below this budget (then it's the only way to stay sharp). View angles are mild (worst LOS deviation 32.4° per §2, and glass-normal incidence ≤ 17.4°), which is why mipmaps suffice at spec size. `[C]`
3. Lossless-only for text-bearing frames: my asymmetry numbers — one dirty wall pane-row is **856 B** as binary cells vs **369 KiB** as RGBA (2560 × 36 px) — a 1:431 ratio; lossy codecs additionally violate the fidelity mandate on glyph edges.

---

## 5. fps / latency / bandwidth budget

| Metric | Budget | Derivation |
|---|---|---|
| Wall composite rate | **60 fps** | flicker clause 5.5.3.1.12 + SWARM target; 30 fps is a visible flicker risk on a 7 m display `[C]` |
| End-to-end p99 | **≤ 16 ms** | SWARM; wall path: PTY byte → screen-model dirty row (event-driven) → coalesced into next 16.67 ms frame → client raster ≤ 2 ms (§ below) |
| Full-wall repaint (worst frame) | **20,544 glyph blits** (6 × 107 × 32) at ≤ 25.9 px cap | the raster cost ceiling Antigravity must design the atlas for `[C]` |
| Typical frame | 60–300 glyph blits | TUI redraws touch 1–5% of rows `[A]` (check: count dirty rows in a `cargo build` capture) |
| Wall keyframe (all 6 slots, binary cells @ 8 B/cell) | **164 KB** (27.4 KB per slot) | vs 70.8 MB as RGBA — 1:430 again `[C]` |
| Wall bandwidth, 16 panes streaming | **worst ≈ 12 MB/s, typical ≈ 1–3 MB/s** `[C]` `[A]` | worst: 6 wall slots × 32 rows × 856 B × 60 fps = 9.9 MB/s + 12 desk raw-PTY at build-storm burst (~200 KB/s each) = 2.4 MB/s. Typical TUI duty is 1–5% of that. Label: computed ceiling, assumed duty cycle. |
| Idle room | **0 CPU** | wall slots stream only while a viewer is attached and the wall is in the viewer's frustum (5 fps heartbeat when culled); desk monitors leased by camera distance |
| Hot path | zero added work in `bridge.rs` when no room viewer attached | SWARM; the room module taps the existing screen-model events, never the PTY hot path |

---

## 6. Legibility floors and the dense-grid policy (binding rules)

1. **Floor:** every pane on the wall must subtend ≥ 10 arcmin cap height at its farthest *actual* viewer (7.2 m) — met at 24.3 mm. The 15′ *should* must hold at all **seated** positions — met at 3.9 m.
2. **Dense grids:** a pane denser than the slot's reference (e.g., 200 cols → 12.8 px cells → cap 15.7 mm → 14.2′ only at walk-up) must **never silently render illegibly**. Policy: fitted cap < 21 mm (the 2.9 mrad floor at 7.2 m) → the slot flags `DENSE GRID — WALK UP`, and the 3.8 m walk-up preset restores ≥ 14′ for up to ~200-col panes. At 3.8 m the floor is cap ≥ 10.9 mm. `[C]`
3. **No scaled-up low-res textures** (fidelity mandate): each surface's texture px is fixed by this doc; content is rasterized at those px, never upsampled from smaller.
4. **Cursor** must render at 1/2 cell blink at ≥ 30 Hz effective (no dropped blink during streaming — visibility of state, 5.2.2.12.7's spirit: critical info cannot be inadvertently lost).

---

## 7. Camera presets (they define the lease distances)

`[C]` Presets are part of the descriptor, not code:

| Preset | Eye (x, y, z) | Look at | Serves |
|---|---|---|---|
| `overview` | (0, 1.6, 6.8) | wall center (0, 1.2, 0) | room state |
| `supervisor` | (0, 1.65, 7.2) | wall center | the 7.2 m legibility case |
| `walk-up-wall` | (±slot_x, 1.4, 3.8) | slot center | dense-grid policy, §6 |
| `desk-{i}` | (desk_x, 1.3, 4.8) | desk monitors | seated operator POV |
| `monitor-{i}-{j}` | desk monitor glass + 0.5 m along its normal | monitor center | full-fidelity read |

Lease model (carried from v1, rescaled to this room `[C]` — the old 6 m/8.5 m bands were for a 16 m theater and would never release here):

- Wall: streams whenever any viewer is attached; frustum-culled viewers drop it to a 5 fps heartbeat (group display, 5.2.2.12's "all critical users have visual access").
- Desk monitors: focused (raw-PTY) lease when camera ≤ **3.5 m** from that desk; release at **5.0 m**; 400 ms hidden-grace (hysteresis band 1.5 m — same 1.25:1 acquire:release ratio as v1).
- Off monitors keep their binding, suspend the lease (power ⊥ source carries over, `ROOM_DISPLAY_AND_CONTROL_SPEC.md` §4).

---

## 8. The new room descriptor (shape, v2)

Replaces `panoramic-theater.ts`'s `presentationScreen` + polar `stationLayout`. Everything a renderer or sidecar needs to place surfaces and validate legibility is data. Versioned `ops-room/room@2`:

```ts
type RoomDescriptorV2 = {
  schema: 'ops-room/room@2';
  id: string;                          // 'ops-flat-room'
  shell: { asset: string; scale: 1 };  // GLB carries geometry only
  envelope: { widthM: 9.0, depthM: 7.5, heightM: 3.0 };

  wall: {                             // ONE flat wall display (was Wall_Screen_1..3)
    id: 'wall-display-1';
    glass: { widthM: 7.2, heightM: 2.16, bottomAffM: 0.30 };
    texture: { widthPx: 7680, heightPx: 2304 };   // pitch derived & validated ≥ §4 table
    grid: { columns: 3, rows: 2 };                 // 6 slots
    slot: {
      widthM: 2.40, heightM: 1.08, widthPx: 2560, heightPx: 1152;
      referenceGrid: { cols: 107, rows: 32 };      // native pane grid: no resample
      minCapHeightMm: 21;                          // §6 floor at 7.2 m
    };
    mesh: string;                                   // planar UVs — cylindrical unwrap dies
  };

  desks: Array<{
    id: string; label: string;
    position: { x: number, z: 3.3 }; yawDeg: 0;     // all face +z toward wall
    console: { kind: 'fig62-type2', widthM: 1.12, depthM: 0.9,
                writingSurfaceAffM: 0.74, seatAffM: 0.46 };   // fig 62 band values
    monitors: Array<{
      id: string; role: 'primary' | 'secondary';
      glass: { widthMm: 528, heightMm: 297 };
      texture: { widthPx: 1920, heightPx: 1080 };
      viewingDistanceMm: 650;                        // 5.2.2.11 band [500, 700]
      centerAffM: 1.10;                              // fig 71 band [0.816, 1.36]
      azimuthDeg: number; rollTowardOperatorDeg: number;
      source: BaySourceV2;                           // tagged union — string prefixes die
    }>;
    hud: { widthPx: 1280, heightPx: 720, glassMm: { w: 308, h: 173 }, tiltDeg: 15 };
  }>;

  camera: { presets: Array<{ id: string, eye: [number, number, number],
                            target: [number, number, number] }> };

  legibility: {                                     // derived-check data, §2/§4/§6
    farthestViewerM: 7.2; seatedViewerM: 3.9; walkUpM: 3.8;
    shallArcmin: 10; shouldArcmin: 15;
  };

  leases: { wall: 'always-while-viewed', deskAcquireM: 3.5, deskReleaseM: 5.0,
            hiddenGraceMs: 400, culledWallFps: 5 };
};
```

Validation the loader must run (each is a bug from v1, now structural):
- `texture.widthPx / glass.widthMm * 1000` matches `pitch` and `slot.widthM × 1000 / slot.widthPx` matches to ±1% `[C]` (v1's hardcoded 1024×512 HUD desync, REPORT §6.15).
- Cap height at `farthestViewerM` ≥ `minCapHeightMm` (§6 floor).
- Monitor `centerAffM` within fig 71 band; `viewingDistanceMm` within [500, 700] (5.2.2.11).
- `BaySourceV2` is a tagged union (`{kind:'pane'|'tab'|'catalog'|'empty', id}`) — the `"tab:"`/`"terminal:"` string prefixes from v1 are dead on arrival (REPORT §5.1, four bugs).
- Free floor / walk-behind clearances vs envelope (§3) — geometry is load-bearing, not decoration.

What dies with the curved wall: `Wall_Screen_1..3` and their frames, cylindrical UV unwrap (`display/surface.ts`'s atan2 mean-relative machinery), the 3-arc name contract in the README scene table, polar `stationLayout` (3 desks in a line now), and `hyperia-overview` as an implicit wall mode. What carries: the lease engine (rescaled, §7), keyframe/resync semantics, power ⊥ source, cell-grid codec (now binary), `RoomDisplayConfiguration` layout model, the MCP control-plane contract, `terminal:nav.*` catalog identity.

---

## 9. MIL-STD-1472H traceability

| Decision | Clause | PDF page | Verdict |
|---|---|---|---|
| Char ≥ 10′ shall / 15′ should at farthest viewer | 5.17.18.2 | 399 | 11.6′ @ 7.2 m / 21.3′ @ 3.9 m ✓ |
| Stroke 0.0834–0.1667 of height | 5.17.18.4 | 399 | 3.6 px in 2.2–4.3 band ✓ |
| Char width ≈ 0.9 of height (cell aspect adjusted for monospace) | 5.17.18.5 | 399 | 0.55 cell, glyph ~0.9 within cell `[A]` |
| Individual display ≤ 0.70 m, ≥ 0.50 m preferred | 5.2.2.11.2 / .11.4 | 127 | 0.65 m ✓ |
| Individual display ≤ 81.28 cm diagonal | 5.2.2.11.2 | 127 | 60.6 cm ✓ |
| Large screen: slots as individual units | 5.2.2.12.1.e | 128 | per-slot analysis |
| Viewing:diagonal 2–10 | 5.2.2.12.3 | 128 | 2.73 standing ✓ |
| Min distance = half display width | 5.2.2.12.5 | 128 | walk-up 3.8 ≥ 3.6 ✓ |
| No traffic through sightlines | 5.2.2.12.6 | 128 | supervisor lane behind consoles |
| Group-display changes by designated users | 5.2.2.12.7 | 128 | the lease/assignment model |
| Direct-view contrast ≥ 1.5:1 | 5.2.2.12.8 | 128 | palettes ≥ 4.5:1 ✓ |
| Dot-matrix ≥ 5×7, 7×9 preferred | 5.2.2.20.3 | 134 | vector fonts ≫ ✓ (context clause) |
| Line of sight deviation ≤ 45° | 5.10.3.6.1.5 | 301 | worst 32.4° ✓ |
| Displays perpendicular to LOS | 5.10.3.6.1.4 | 301 | secondaries rolled toward operator |
| Console type & dims | 5.10.3.2.1, fig 62 | 297–299 | Type 2 values in descriptor |
| Seated display mounting band | 5.10.3.9.1.5, fig 71 | 311 | 1.10 m in [0.816, 1.36] ✓ |
| Seated eye height (seat-pan ref) | 5.10.3.9.1.4 | 310 | 0.78 m mid-band → 1.24 m AFF |
| Free floor ≥ 122 cm | 5.10.2.9.1 | 296 | 3.3 m ✓ |
| Walk-behind seated ≥ 137 cm | 5.10.2.6.5.1–.2 | 296 | 2.1 m ✓ |
| Computer work 300 lux | table XXI | 177 | room lighting spec |
| Luminance ratio ≤ 5:1; matte adjacent; ≤25% ambient | 5.5.3.1.5/.7/.9 | 179 | dim room, matte bezels |
| No perceptible flicker | 5.5.3.1.12 | 179 | **60 fps, not 30** |

---

## 10. Challenges to the other lanes (evidence, per the consensus protocol)

1. **Antigravity (RENDER.md):** your texture/atlas decision is bounded by §4 — wall tex 7680×2304 at 0.9375 mm/px, glyphs at 36 px em / 25.9 px cap, stroke band 2.2–4.3 px, worst frame 20,544 blits. At that pitch a plain AA atlas + mipmap + aniso×8 meets the 0.85′/px acuity argument; MSDF is only required if you shrink the texture — if you do, show the acuity math, don't hand-wave "sharp". And the 856 B vs 369 KiB row asymmetry is the wire-format constraint: lossy on text is banned by mandate *and* by arithmetic.
2. **Codex (SIDECAR.md / PLAN.md):** the room model's concurrency case is 18 surfaces / 16 streaming (§0); the lease distances must be the §7 numbers, not v1's 6/8.5 m (they never release in a 7.5 m room); wall keyframe = 164 KB binary cells, dirty row = 856 B; and the descriptor in §8 is the shape the sidecar must validate — including the legibility floors, which are *runtime-checkable* (cap height at distance), so a test exists: place camera at `supervisor`, screenshot, measure the glyph's subtended angle.
3. **Grok (AUDIT.md):** confirm the carry list in §8 against the code — especially that `BaySourceV2` (tagged union) lands in the *sidecar's* room model, since the string-prefix clobbers were all binding-layer bugs and v2 moves the binding layer into Rust. Also: the README scene-contract table dies with `Wall_Screen_1..3` — flag every consumer of those names.

Open item for host-claude: none blocking. Assumptions to close when convenient: standing eye 1.65 m and side-lane 1.08 m (anthropometry/fig 59), TUI duty cycle 1–5%, widest common pane 120 cols.