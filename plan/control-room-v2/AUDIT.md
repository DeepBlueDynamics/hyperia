# AUDIT — what of 3dterminal survives a flat wall plus desks in the sidecar

Grok (Crooked Gull), 2026-09-24. Research only. No product code was changed.

Claim labels: **verified** means this turn read that file and line. **calculated** means arithmetic from those sizes, not a benchmark. **inferred** means it follows from verified facts. Codex's Node pack/decode numbers are **their measurement**; the bench file is present and was not re-run here.

## Verdict

The thing worth keeping is the surface model: a glass has a tagged source, power is separate from routing, and a lease decides whether that source is streaming. The thing that must die is the curved three.js room and every path that paints it with `fillText` or a second VT. The sidecar already has the right *source* of truth for text (`/ws/wall` cell grids, raw `/ws/pane` for a real terminal). The current client has walked away from that for the wall: each wall section opens its own `/ws/pane` or `/ws/pixels` and rasterises a private xterm onto a 1280×800 or 1440×900 canvas. Porting that wall fails both the speed budget and the fidelity mandate. Porting `paneId: string` reimplements four clobber bugs in Rust.

**Fidelity mandate (Kord, `SWARM.md:49-57`, re-read this turn).** Speed does not buy a worse picture. When the two conflict, fidelity wins and the faster path has to be found again.

- The accuracy reference is `/ws/pane` plus xterm's own renderer, on the same content, same font files, same DPI. A front-facing surface matches it pixel for pixel, or the diff names every cell that differs. The room's Canvas2D painters are not that reference: they drop indexed color or paint one grey (bugs 5 below).
- Glyphs are vectors, rasterized at the display's real pixel density, with hinting and anti-aliasing. `font8x8` stays inside Hyperia's schematic PNGs. A 1440×900 canvas stretched across a wall is a scaled-up low-res texture and dies.
- Text-bearing frames are lossless. JPEG and WebP are out for terminal text and for web panes that contain text. Lossy is only for non-text video, and this room does not have that source today.
- Angled or distant glass stays sharp by sizing the surface to its on-screen pixels and re-rasterizing before magnification passes 1:1, with mipmaps and anisotropic filtering for minification. MSDF is an approximation of a hinted xterm raster, so it is not the golden path.

The client does not run a second VT on the stream. The qualification harness still pins xterm as the picture to match. Those are different programs.

Agreed headlines, now including that mandate. `PLAN.md` revision 3 is the text they match. Revisions 1 and 2 are objected to in the vote log and are not the position.

1. Rust composes layout and cell commands. The client makes pixels with a hinted vector atlas. No sidecar RGBA framebuffer and no `font8x8` on the room path.
2. Damage is event-driven and armed only when dirty. The standing `interval` in `wall_loop` dies. Attribute-only damage is real damage. Dropping it to save a diff is a fidelity failure.
3. The hot path is a binary cell keyframe/delta carrying truecolor, attribute bits, width, and cursor. JSON frames die. JPEG and H.264 die for text.
4. No server glyph blit on the room path. The client rasterizes the pinned xterm font at device pixels.
5. One watched producer per pane, shared by every glass. Desks are the same cell protocol. Web panes that contain text are a watched lossless capture, not a VT and not JPEG.
6. The viewer is raw WebGL2. `texSubImage2D` updates dirty glyph pages and dirty cell rects only. three.js dies with the curved scene.
7. A slow viewer keeps one in-flight frame and then a keyframe. It never grows a delta queue, and it never substitutes a blurrier encoding to catch up.

## What the running code actually is

`main.ts` is 2,906 lines and still the integration pile (`requestAnimationFrame` loop at line 2901). The August report's "2,638" is stale. `README.md` line 37 says `Wall_Screen_1` and `Wall_Screen_3` are dark. **verified false today:** `main.ts:1582-1594` builds a canvas surface for all three arcs, `mapping: 'cylindrical'`, `canvasHeight: 900`. `WALL_SECTION_COUNT` is 4 (`display/section-source.ts:9`), so the curved room is 12 wall slots plus 8 desk glasses (`panoramic-theater.ts:23-27`: desks 2/4/2).

`main.ts:515-518` and `display/video-wall.ts:157-161` state the wall is **not** painted from `/ws/wall`. Each pane section opens `/ws/pane/{id}` into an xterm and `fillText`s a 1280×800 scratch canvas (`video-wall.ts:934-1010`). Each tab section opens `/ws/tab` at 12 fps onto a 1440×900 canvas (`video-wall.ts:393-395`). Web panes open `/ws/pixels` at 1280×800, 15 fps (`video-wall.ts:1017-1029`). Desk sessions are another 1440×900 canvas and another xterm, default 120×40 (`display/session.ts:61-73`).

`/ws/wall` is still opened, at 10 fps (`main.ts:31`, `broker.ts:465-469`), because `onWallMessage` feeds topology (`main.ts:528`, `ingestWallTopology` at 2802) and desk overview mode still wants cell grids (`broker.ts:399-404`). A third topology feed polls `GET /hyperia-api/status` every 3 s (`main.ts:2799-2800`). One pane on the wall and a desk is parsed in the sidecar, again in the wall xterm, and again in the desk xterm.

The sidecar reference matches the director's description. `hyperia-ref/stream.rs:152-216`: per-connection `tokio::time::interval`, dump panes whose `last_output_at` changed, JSON `frame`/`delta`, send **after** the `sessions()` scope. `screen.rs:20-21`: `process` only calls `vt100`. `screen.rs:104-132`: `diff` compares `cur.text != prev.text`, then overwrites one shared `last_snapshot`. Attribute-only updates are invisible to that diff, and two viewers cannot share it. `stream.rs:108-113` `changed_rows` compares the whole line and is per connection. `snapshot_image.rs` is an 8×8 grayscale schematic for an LLM tab image. It is not a terminal renderer.

`bridge.rs` is not in `hyperia-ref`. Whether `sessions()` holds the table mutex across `screen_dump` is **not verified**. The dump sits inside the `sessions().await` block and the socket send sits outside it (`stream.rs:172-215`). That is the shape to keep. Do not assert more.

## What survives

These are behaviors and types. They are not files to copy.

**Tagged source, once.** Wall sections already have the right shape: `{ kind: 'pane', paneId } | { kind: 'tab', tabId } | null` (`section-source.ts:11-14`). `normalizeSectionSources` drops retired `{ kind: 'terminal' }` to `null` (`section-source.ts:18-32`). `control/ops-room.ts:1-4` `SourceRef` is `{ kind: 'pane' } | { kind: 'tab' }`. That union is the seed of Rust `BaySource`. Bays do not use it yet. See the bug list.

**Power is not routing.** Off remembers the assignment and reattaches on power (`main.ts:1911-1925`, `connectTabToMonitor` at 487-489). `getPowered() === false` forces lease `none` (`broker.ts:194-197`). Keep the split: persisted `source` + `powered`, derived lease, lease never serialised.

**Lease state machine, not the metre constants.** Modes `none | overview | focused`, acquire tighter than release, 400 ms hidden grace (`broker.ts:136-141`, `193-214`). The sample is the screen mesh AABB, not a sphere and not a subtree that still contains hidden legs (`broker.ts:112-116`, `216-228`; registration comment `main.ts:42-45`). In a flat room the inputs become "this surface is on screen" and "glyph height is at least the legibility floor". The hysteresis band stays. 6 m / 8.5 m do not.

**One producer, many glasses.** Overview was designed as one `/ws/wall` multiplex (`broker.ts:104-107`). The wall code abandoned it. The design survives; the abandonment dies. Two desks showing one pane share one mirror.

**Cell grids are the text model.** Wire cell is `[char, fg, bg, attrs]` with `default | idx:N | #rrggbb` (`hyperia/protocol.ts:1-6`, `36-39`). Attr bits are shared by wall and tab (`protocol.ts:7-14`). `normalizeGridRows` accepts `{y, cells}`, `{row, cells}`, and bare arrays (`protocol.ts:90-100`). `paneChrome` keeps a layout `name` distinct from a volatile OSC title (`protocol.ts:103-117`). A blank keyframe is an empty terminal (`RUST_PORT_SPEC.md` records this; the broker keeps the last raster on `resync`, `broker.ts:504-506`). Ignore unknown message types: the typed `WallMessage` union still omits `t:"panes"` (`protocol.ts:136-148`) while `ingestWallTopology` handles it (`main.ts:2818`). Port the tolerance, not the incomplete union.

**Bay identity is the glass.** `(stationId, bayIndex)`, slot id `m{n}` (`state/store.ts:38-40`). Lease id is `${deskId}:${index}` (`main.ts:34-36`). The same pane may sit on two glasses. Do not key a lease by pane UUID. Do not keep colon-joined strings: `sessionForTabStreamKey` splits on the last colon (`main.ts:494-500`), which only works because current ids have no colon.

**`normalizeBays` grows and never shrinks** (`store.ts:55-74`). Count comes from the descriptor, not from blob length and not from `MonScreen_*` name matches. Desk-1 still hides assemblies 1 and 4 in the GLB (`main.ts:1961`) while the descriptor says 2 bays.

**Empty discovery is not "everything died".** `reconcileMonitorSources` returns when both pane and tab lists are empty (`main.ts:1943-1945`). Keep that. The tab half of the same function is wrong; see bugs.

**Desk height is a number.** Client and server both clamp 0.65–1.25 m (`main.ts:131-132`, `backend/src/main.rs:116-117`). Control events are idempotent snapshots on `/ws/v1/control` (`main.rs:119-129`). The retained-snapshot pattern survives. The Blender `Desk_Height_Pivot` animation does not, unless the viewer is still a 3D puppet. This audit says it is not.

**Same-origin HTTP proxy and server-held bearer token** (`main.rs:21-57`). The browser never learns the sidecar origin for HTTP. WebSockets do the opposite (`hyperia/stream.ts:17-21` hardcodes `:9800` and sends no token). The proxy pattern survives. The hardcoded socket URL dies.

**Pure tests worth reimplementing in Rust, still with no GPU:** descriptor validation, `normalizeBays`, section-source union, grid-row shapes, `cssColor` / `idx:N`, `paneChrome` name-versus-title, grow-only bay migration, and a table test of lease hysteresis. The suite list is `frontend/src/tests/architecture.test.ts` (names at lines 30–431). Nothing in that file looks at a pixel.

**SATCOM, narrowly.** `backend/src/main.rs:419-430` is three satellites on a sine wave. That scaffold does not survive as a domain model. `README.md:20-22` says `docs/satcom-ops-room.html` holds the behaviour worth migrating and that its hard-coded geometry does not. This audit did **not** re-read that HTML. If a status widget returns, it is a non-frame-path panel on the control channel. It does not sit on the cell deadline, and the wall is not sized around three fake tracks.

## What dies

**The curved scene.** Three arcs, cylindrical UVs (`main.ts:1591`), mean-relative unwrap, orbit/walk camera (`main.ts:2883-2894`), floor recut, celestial sky (`scene/celestial.ts` uses `Math.random` at 217-229), Blender GLBs, `Wall_Screen_{1,2,3}` name contract, `semantic_role` as a loader. Roles are read and then ignored for discovery: `RoomLoader` matches `presentationScreen` by node name; `room-cleanup.ts:9-33` hides any mesh whose role is not in a short allow-list. A correctly tagged unknown role is hidden. The room descriptor passed to the loader has `stations: []` (`main.ts:1540-1546`) while real bay counts live in `panoramic-theater.ts`. The descriptor type can be reborn as JSON the sidecar actually reads. This GLB contract cannot.

**three.js as the renderer.** It is load-bearing for visibility meshes, canvas textures, and picking. A flat wall plus desk quads is a WebGL2 view of Rust layout commands. "Feature parity" with the panoramic theater is the wrong exit test.

**The room's private xterm painters and `fillText`.** `renderPtyTerminal` (`main.ts:2515-2565`), `video-wall.ts` `rasterPty` (970-1014), `FocusedPtySource.paint` (`surfaces/stream-sources.ts:42-70`), and the tab compositor glyph loops. Every one clears the canvas and issues a `fillText` per cell onto a fixed 1280×800 or 1440×900 bitmap. `FocusedPtySource` forces `#d7e2ea` for every glyph (line 65). The 0.6 cell aspect is a literal (`main.ts:2525-2531`, `video-wall.ts:979-980`), not the pinned font's advance. xterm itself stays as the pixel reference. These painters are the opposite of that reference: low-res, wrong metrics, and missing color. Stretching those canvases onto a 4K wall is the scaled-up texture the fidelity mandate forbids.

**Client authority.** `localStorage` holds bays (`store.ts` key `ops-room-store-v3`), wall sections (`video-wall.ts:858-864`), spawned desks, closed desks, camera, selected desk. A second browser does not see them. The sidecar room actor owns that state.

**`main.ts` itself.** Read it for behavior. Do not port the file.

**`ops-room-server` as a second hop on the frame path.** Static hosting and the control-snapshot idea can fold into the sidecar. A browser that opens `:8080` for HTTP and `:9800` for sockets is the current split, and the socket side has no token.

**Timer polling as change detection.** `wall_loop`'s `interval` (`stream.rs:163`) runs when nothing changed and calls `sessions()` every tick. `/ws/pixels` and `/ws/tab` are the same pattern (`stream.rs` pixel and tab loops). `refreshStatusTopology` every 3 s (`main.ts:2800`). Idle room at ~0% CPU means no wake when no damage and no viewer.

**Server pixel compositing of the wall, and bitmap fonts on the room path.** **calculated** from 3840×2160×4×60 = 1,990,656,000 bytes/s (1.991 GB/s) before encoding. A 120×40 cell grid does not get cheaper by rasterising it to 4K in the sidecar. `snapshot_image.rs` uses `font8x8` for a 720×480 schematic PNG. That file stays a schematic tool. It is not a terminal renderer, and the fidelity mandate bars 8×8 bitmap fonts from this room.

**Catalogue-as-pane and the `terminal:` prefix.** The spec (`ROOM_DISPLAY_AND_CONTROL_SPEC.md:179-206`) still shows `terminalId: 'terminal:nav.solution'`. The running client strips `terminal:` to an empty bay (`main.ts:179-183`) and drops `{kind:'terminal'}` section entries. A static image may exist later as `Static { id: "nav.solution" }`, off the VT clock, with the prefix gone. It is not a milestone on the streaming path, and it is not a `Terminal` variant that shares the lease machine with panes.

**Spawned-desk GLB variants, monitor-housing FX, bezel shaders, starfield.** Operator-added desks can return as descriptor records. The mesh spawner does not.

## Bugs that must not be ported

### 1. `paneId: string` with `tab:` and `terminal:` prefixes

Still the bay encoding. The comment at `main.ts:433-435` says the prefix exists "so the broker and router can tell them apart without a schema migration." Guards, all local, all still required:

| Site | What it prevents | Where |
|---|---|---|
| `getAssignment` returns null for a `tab:` target | broker opening `/ws/pane/tab:<uuid>` | `main.ts:49-54` |
| `onFocusedBinary` returns if `tabStreams` has the glass | pane bytes painted over a tab | `main.ts:77-78` |
| `applyOverview` returns if `tabStreams` has the glass | wall cells painted over a tab | `main.ts:98-99` |
| `refreshSessionRaster` | picker/boot card over a live tab on topology refresh | `main.ts:1700-1706` |
| `reconcileMonitorSources` skips `tabIdFromBinding` | treating `tab:<uuid>` as a dead pane id | `main.ts:1947-1951` |
| `connectPaneToMonitor` redirects `tab:` | restore calling `/ws/pane/tab:<uuid>` | `main.ts:2680-2685` |
| load strips `terminal:` | catalog id leased as a pane | `main.ts:179-183` |

`BaySource` is `Empty | Pane { id } | Tab { id } | Web { id } | Static { id }`. `Tab { id: "tab:…" }` is the same bug. Migration runs once on the server: `""` → Empty, strip `tab:` → Tab, strip `terminal:` → Static or Empty, UUID → Pane, anything else → Empty plus a log. Wall slots and desk bays use the same enum. `StreamKind` is `Cells | WebJpeg`. A tab is a layout of cell sources under one lease, not a null assignment.

`session.paneId` is still doing two jobs (socket identity and binding). Tab attach sets it to `''` (`main.ts:462`) while the binding lives in `monitorTargets`. Port `binding` and `lease` as different fields.

### 2. Tabs sit outside the lease

Because `getAssignment` returns null, `desiredMode` is `none` (`broker.ts:194-197`) and `/ws/tab` is opened by `attachTabStream` (`main.ts:453-479`) with no distance test. `TabStream.connect` logs `close` and does not retry (`hyperia/tab-stream.ts:424-453`). A tab glass 40 m away, or a dropped socket, is unbounded or dead. In the sidecar a tab is N cell rects inside one surface, same hysteresis as a pane.

### 3. Reconcile keeps a dead tab forever

`main.ts:1948-1951` refuses to drop any `tab:` binding even when topology has loaded and the tab is gone. The empty-discovery guard above it is right. "Missing after a non-empty snapshot" must return that glass to Empty. Do not port the forever-keep.

### 4. Two bind functions disagree when the glass is off

`connectTabToMonitor` stores the binding while powered off (`main.ts:485-489`). `connectPaneToMonitor` returns at `main.ts:2696-2699` without writing `monitorTargets` if power is off. One write path. It never changes `powered`.

### 5. Indexed color is dropped on the "full fidelity" xterm path

`numericColor` feeds `cssColor` the string `` `ansi${n}` `` (`main.ts:2510-2512`). `cssColor` accepts `default`, `#rrggbb`, and `idx:N` only (`protocol.ts:41-56`). An indexed xterm color takes the fallback. The cell path maps `idx:N` correctly. `FocusedPtySource` does not even try (`stream-sources.ts:65`). The cell codec is the one to port. Do not port `numericColor`.

### 6. Wall JPEG frames still present out of order

Desk pixels compare against the latest counter and drop (`main.ts:2761-2765`). Wall pixels capture `generation` at socket open and drop only when `frameNumber < generation` (`video-wall.ts:1032-1045`). Later frames do not invalidate an older decode. Terminal text does not travel this JPEG path at all. A text-bearing web capture, if it stays, is lossless and drops a decode that is no longer the newest revision. Copy the desk check. Do not copy JPEG.

### 7. `focusedGeneration` is write-only

Stored at `broker.ts:375`, `579`, `601`. Cleared at `385`. No reader. The socket generation inside `openContentSocket` (`stream.ts:34-42`) is the one that works, and only if every callback remembers it. Rust cancellation of the lease task replaces both.

### 8. Four reconnect policies

Wall socket: 1500 ms flat, and only if a listener remains (`broker.ts:493`). Focused: 350 ms floor, then immediate retry, no cap, no jitter (`broker.ts:321`, `369-371`). Wall PTY: 400 ms (`video-wall.ts:961`). Tab: none (`tab-stream.ts:448-452`). Control: 1 s after a successful open, 3 s otherwise (`main.ts:607`). One policy, with jitter and a cap. Codex's 250 ms base, 8 s cap, is a fine committed default. Do not copy any of the five.

### 9. Hit testing does not share a transform with paint

Desk picker flips U and V from the surface orientation (`main.ts:1883-1888`). Wall picking uses raw UV (`main.ts:1500-1501`). HUD paint and HUD hit both hardcode 1024×512 (`main.ts:377`, `804`, `989`, `1060`), so they match until one of them changes. One mapping function for draw and pick. Hit ids come from the Rust layout, not from a canvas width literal.

### 10. Dual topology writers

`ingestWallTopology` on `t:"panes"` and the 3 s HTTP poll both call reconcile, HUD redraw, and restore (`main.ts:2818-2833` and `2648-2673`). They can repaint a glass that just attached. Topology is a lifecycle event on the room subscription. No poll.

### 11. `ScreenBuffer::diff`

Text-only, one snapshot, destructive (`screen.rs:104-138`). Multi-viewer room code that calls it will drop attribute damage and cross-couple viewers. Per-viewer caches in `wall_loop` are the better half of today's sidecar, and they still poll. Damage bits on the watched mirror replace both.

### 12. `hyperiaWsUrl` and anonymous sockets

`stream.ts:17-21` always uses `location.hostname:9800`. No token on wall, pane, pixels, or tab. The HTTP client attaches the agent token server-side (`main.rs:53-56`). The room socket discovers its endpoint the way `/hyperia-api` does. Credentials stay configuration. A pane-scoped token is not shipped to the viewer.

### 13. Full-canvas repaint as the upload

`session.texture.needsUpdate = true` after a full 2D clear (`main.ts:2565`). Wall `scheduleRender` then copies the scratch canvas again. Dirty rows, or a dirty instance-buffer range. Never a full 1440×900 upload per PTY write.

### 14. God-file strings and magic room id

`'panoramic-theater'` is passed at every store call. Section storage keys are `ops-room/room-display-${displayIndex}/sections-v1`, and display 2 kept a historic key on purpose (`video-wall.ts:183-194`). v2 has one wall. The persistence key is the room revision on the server, not a browser key per arc.

### 15. Verification theater

`tsc` and `vite build` pass on a black screen. The report's remediation (2026-08-25) wired vitest and still has no render test. A headless check that a known grid lands in known wall rects is the first proof. A screenshot of the flat wall is the second. Compilation is neither.

## Stale documents

| Document | What it says | What the code does now |
|---|---|---|
| `README.md:37` | Flanking arcs are dark | All three arcs have surfaces (`main.ts:1582`) |
| `REPORT.md` §5.4, `RUST_PORT_SPEC.md` §6.6 | Only `Wall_Screen_2` is wired | Same, stale |
| `REPORT.md` §3 | `main.ts` is 2,638 lines; `wall-client.ts` is dead code | `main.ts` ends at line 2906; `wall-client.ts` is gone from `frontend/src` |
| `REPORT.md` §5.10 | JPEG can present out of order | Desk path is latest-wins (`main.ts:2764`). Wall path is still wrong (`video-wall.ts:1042`) |
| `PORT_SPEC_LANE_C.md` | `frontend/src/terminal/catalog.ts` | That file is not in the tree. Catalog ids are stripped, not resolved |
| `ROOM_DISPLAY_AND_CONTROL_SPEC.md:179` | `terminal:nav.solution` is a live id | Load path deletes it (`main.ts:183`) |
| `hyperia-ref/stream.rs:5-6` | `/ws/wall` is what the 3D wall draws | The 3D wall draws dedicated sockets |

Lane specs from August are evidence of the bug class. They are not a line-accurate map of this tree. Citations above are from this turn.

## The seven decisions

Numbers are **calculated** unless noted. Grid used: 120×40, which is the client's default (`session.ts:61-62`), 16 panes, 60 Hz.

### 1. Where pixels are made

**Client GPU, from Rust cell commands. Web panes are a separate lossless capture.**

Rust owns rects: which source occupies which wall slot and which desk glass. It publishes binary cells for terminal content. The client rasterizes the pinned xterm font as vectors at device pixel density, with hinting and anti-aliasing, and must match xterm's own renderer pixel for pixel on a front-facing surface, or name every differing cell. There is no sidecar framebuffer, no `font8x8`, and no Electron JPEG on the terminal path.

Web panes (`shell === 'web'`) have no cell grid (`video-wall.ts:1017`, `main.ts:56`). They are text-bearing pages, so the fidelity mandate does not allow JPEG or WebP. The capture is lossless, watched only, revision-tagged so a stale decode is dropped, and off the 60 Hz terminal deadline. Lossy codecs remain legal only for non-text video, which this room does not have. Pretending HTML is vt100 is not allowed either.

A second client VT fails the CPU budget and still would not be the reference: the room's xterm-fed `fillText` path already disagrees with xterm's own colors (bug 5). Scrollback of 2000 lines (`session.ts:73`) stays in Hyperia. The glass shows the visible screen. The harness compares that glass to a pinned xterm, it does not embed one.

### 2. Change detection

**Dirty rows on the watched mirror. One-shot deadline. No interval.**

`wall_loop` wakes at `fps` even when `updates` is empty (`stream.rs:163-186`). That cannot be an idle room. First damage arms one deadline; the wake publishes the dirty set and disarms. A viewer that is gone removes the subscription, and the ingest path does not branch on room state when the subscriber count is zero.

The second parser is the honest way to get literal zero work in `bridge.rs` while unwatched, because `screen.rs` has no damage API (**verified**: no dirty/damage tracking; `process` is a delegate). It is also the spend most likely to break ≤1% of a core. 1% of one core is 10 ms/s, so 167 µs per pane per 60 Hz publication **calculated**, parser + damage + encode together. Codex's Node bench (file present, not re-run) reports full-frame pack+decode of all 16 panes at p99 668 µs with the dictionary already built, and **no VT**. The room budget is 16 × 167 µs = 2.67 ms per 60 Hz publication **calculated**. 668 µs is 25% of that aggregate, and 668/16 ≈ 42 µs against the 167 µs per-pane budget. Comparing 668 µs to one pane's 167 µs counts every pane's pack cost against a single pane. The bench includes a client decode the sidecar does not pay, and it excludes the VT, allocation, and the socket. Keep the rejection gate. Publish parser time and pack time as separate columns. Do not cite that bench as evidence the 1% budget is met.

`screen.rs::diff` is the wrong damage source (bug 11). Mutation bits have to include style, erase, scroll, wide cells, and cursor, or inverse/color updates vanish.

Phase wait: a 60 Hz refresh is 16.667 ms, so a byte that arrives just after vblank waits 16.5 ms at the 99th percentile **before any work** (**calculated**, uniform arrival). Byte-to-photon p99 ≤16 ms is a ≥120 Hz qualification. At 60 Hz the plan reports the physical number and still holds the throughput target. Do not rename "submitted to the GPU" into "pixel changed".

### 3. Wire format

**Uncompressed little-endian binary cell spans. JSON off the frame path.**

Truecolor is on the wire today (`#rrggbb` in `normalize_color`, `stream.rs:48-63`), so a u8 palette index is not enough unless a side palette plus a rare RGB span exists. A 16-byte cell with RGBA is a defensible v1 **if** the bench above is treated as a cost, not a victory. **calculated** full damage, 16 B, 16×120×40×60 = 73,728,000 bytes/s of cell payload before span headers. Codex's header-inclusive figure is 74.3 MB/s. Two dirty rows per pane is about 3.7 MB/s. 4K versus 1080p does not change the cell payload. It does change the glyph raster: the client re-rasterizes at the surface's real pixel size instead of scaling a low-res atlas. Scaling glyphs to fake resolution is the failure mode the mandate names.

JSON today is one string per cell (`stream.rs:72-82`). It dies for allocations, not because it is a thousand times larger.

H.264 and full-frame RGBA miss 16 ms (codec delay, or 1.991 GB/s). QOI of a 4K wall is the wrong layer: the cheap representation is already cells.

### 4. Text rasterisation

**None in the sidecar room path.** The client owns the only glyph cache, keyed by font-file hash, style, grapheme, and raster size in device pixels. Hinting and anti-aliasing match the pinned xterm build. `texSubImage2D` uploads new atlas pages. Cell instances update by a dirty sub-buffer range, not a full texture replace. A surface seen at an angle or from the far seat is a texture sized to its projected pixels, with mipmaps and anisotropic filtering when minified, and a new raster before magnification would exceed 1:1. MSDF and SDF are listed in the mandate as a sharpness option. They are not this audit's choice: a distance field will not pixel-match xterm's hinted raster, and fidelity wins that tie.

A headless test may draw cells with a CPU rasterizer to prove layout. That picture is not the fidelity golden. The golden is xterm's own renderer at the same font files, DPI, and cursor phase. `font8x8` is the schematic font in `snapshot_image.rs` and stays there. wgpu in the sidecar adds a device the room does not have; this container's image is built with `gpu:false` (**verified** from the process environment). Do not make the sidecar depend on it, and do not use a CPU bitmap font to "pass" the pixel test.

### 5. Desks

**Same cell producer as the wall, same font contract.** A desk glass is a rect, a `BaySource`, a power bit, and a lease. It is not a raw `/ws/pane` into a second xterm. It still has to match a pinned xterm pixel for pixel at the desk's own pixel density. Near glass is where a scaled 1440×900 canvas looks worst, so a desk surface re-rasterizes at its on-screen size rather than magnifying a wall atlas.

Current count 2/4/2 is the curved room's descriptor (`panoramic-theater.ts:23-27`), useful as a default fixture and not as a GLB inference. The room lane may replace it. Web glasses use the lossless capture from decision 1, not JPEG. Keyboard and mouse are intents to the pane, authorised the way terminal input already is, not bytes typed into a local VT.

### 6. Client

**Raw WebGL2.** Instanced quads for cells. `texSubImage2D` uploads dirty atlas regions and dirty cell-data rectangles only, in lossless RGBA so emoji and truecolor survive. Rust sends layout, hit ids, and cell spans. The client does not decide bindings. Canvas textures at 1440×900 die with three.js. They are the low-res upsample the mandate forbids.

three.js, cylindrical mapping, orbit controls, and those canvas textures die in v2. They are not a temporary compatibility layer "until feature parity". Parity with a curved theater is how `main.ts` keeps growing. Parity with xterm on a flat quad is the test that stays.

### 7. Backpressure

**One unacknowledged frame per viewer. Next send is a keyframe if that base was skipped. No delta FIFO.**

`wall_loop` awaits each `send_text` and returns on failure (`stream.rs:201-212`). A slow-but-alive socket stalls that connection's loop; a bursty `interval` can stack ticks behind it. Per-viewer bound, producer never waits. Overflow of a raw mirror mailbox reseeds from the live screen. Dropping bytes into a parser that keeps running is a corrupt glass.

## Line between sidecar and thin client

| Sidecar room actor | Thin client |
|---|---|
| Surfaces, rects, bindings, power, focus, revisions | Draw those rects |
| Leases and "is anyone watching this pane" | Report visibility and pointer intents |
| One VT mirror per watched pane, damage including attribute-only rows, pacing | Hinted vector atlas at device pixels, dirty GPU upload |
| Binary `/ws/room/{id}` with truecolor, attrs, width, cursor | Decode, draw, ACK. Front-facing pixels match pinned xterm, or the diff lists the cells |
| Persistence of room state | Nothing authoritative in `localStorage` |
| Lossless web capture, watched, revision-tagged, off the terminal clock | Draw that bitmap into the leased rect. No JPEG for text |
| Desk height metres, control snapshot | Show the number; do not animate a pivot |

Camera presentation for a flat view (which preset, pan, zoom) stays on the client and submits intents. It does not own leases.

## Challenges

**Codex, `PLAN.md` revision 1.** The seven headlines above match steps 1–3 and the latency paragraph in step 5. OBJECT the following, which fight those headlines:

- Step 1's source enum adds `Terminal`, `DeskMonitor`, and `DeskControl` next to `Pane` and `Tab`. A desk monitor is a surface. A desk control is chrome. A second view of a pane is the same `Pane` id in two rects. `Terminal` plus the instruction to preserve `nav.solution` / `nav.route` seeds pulls `ROOM_DISPLAY_AND_CONTROL_SPEC.md`'s `terminal:` ids back onto the path the client has already deleted (`main.ts:179-183`). Static images, if they return, are `Static { id }` and are not parsed by the VT mirror.
- Step 1 does not name web panes. The running room routes `shell === 'web'` to JPEG (`video-wall.ts:1017`, `main.ts:56`). Decision 5 as written ("desks use the same composited cell protocol") blanks them or feeds HTML to vt100.
- Step 4 says raw WebGL2 and then "remove three.js after feature parity" while retaining semantic roles, desk-height pivots, and the camera. Those are the curved scene. The deletion list has to name `video-wall.ts` per-section `/ws/pane`, `TabStream` beside the broker, `fillText` painters, `hyperiaWsUrl`, the 3 s status poll, and `localStorage` as authority. "Feature parity" is not the test. A flat wall with the tagged-source tests from step 1 is the test.
- The Node p99 of 668 µs is pack+decode of all 16 panes, not one pane and not encode alone. Full-room budget is 16 × 167 µs = 2.67 ms; 668 µs is 25% of that, and about 42 µs per pane. It excludes the VT. Split parser and pack. Do not cite it as a 1% pass, and do not compare 668 µs to a single pane's 167 µs.

**Antigravity (RENDER).** Fidelity wins a tie with speed. Do not spend the lane on wgpu headless, a video codec, JPEG or WebP for text, `font8x8`, or an MSDF atlas that cannot pixel-match xterm. The room font is the pinned xterm vector face, hinted and anti-aliased, rasterized at device pixels, re-rasterized before magnification exceeds 1:1. `font8x8` in `snapshot_image.rs` is a 720×480 schematic and stays there. A CPU rasterizer in a headless test may prove cell layout. It is not the golden. The golden is `/ws/pane` plus xterm's own renderer. Indexed color has to be measured on that renderer and on the cell codec (`cssColor`), not on `renderPtyTerminal`, which drops `idx:N` (bug 5). Terminal text does not use the wall JPEG clock (bug 6). Quote cell payload and lossless RGBA payload as different layers.

**opencode (ROOM).** One flat wall. The 12 slots (3 arcs × 4 sections) and the cylindrical canvases die, including the README's claim that two arcs are dark. 2/4/2 monitors is a fixture from `panoramic-theater.ts`, and desk-1's GLB still contains hidden assemblies 1 and 4, so a mesh count is not a bay count. Give legibility as a glyph pixel height at the viewing distance you pick from MIL-STD-1472H, for both the far seat and the near desk eye. That height is what the client rasterizes. It is not a 1440×900 canvas scaled to fit, and it is not the 0.6 aspect literal in the painters. The lease uses "on screen and at least that glyph height," not 6 m. Desk height 0.65–1.25 m survives as a number. A three-section catalog seed with `terminal:nav.solution` does not survive as an id. SATCOM sine data in `main.rs:419-430` is not a reason to size the wall.

## Revision 2, after the fidelity mandate

`SWARM.md` gained a fidelity section while this audit was being written (**verified** this turn, `SWARM.md:49-57`): fidelity wins a conflict with speed; `/ws/pane` + xterm is the accuracy reference; vector glyphs at device pixels; no `font8x8` on this path; lossy codecs only for non-text. That does not revive the curved scene.

Cell fidelity means truecolor, the attribute bits, cursor, box-drawing, wide cells, and emoji, compared to **xterm's own renderer** or a reference VT dump. It does not mean screenshotting `renderPtyTerminal`, `rasterPty`, or `FocusedPtySource`. Those are the buggy painters in bug 5. A 0-pixel diff of a perspective view through anisotropic filtering is not required by the sentence "match it, or say exactly where it differs." Hinting and minification are the differences to write down. Embedding xterm in the client to force pixel identity brings back the second parser decision 5 removed.

An earlier reading treated web panes as the mandate's non-text exception and left them on JPEG. That reading is withdrawn. Hyperia web panes carry text, and the mandate allows lossy only for non-text video. Decision 1 and the revision-3 vote are the position: lossless capture, not JPEG, not a VT. Bug 6's ordering check still applies to whatever bitmap that capture produces.

`contents_formatted` refeed is not a parser clone. `RENDER.md:273` says so, and revision 2 step 2 rejects formatted bytes as the seed. A review-log line that says the refeed "solves" `Clone` overclaims that measurement.

Antigravity's 9.00 µs sidecar figure and the Node pack/decode numbers are their measurements. This audit did not re-run them.

## Vote

OBJECT `PLAN.md` revisions 1 and 2, for the reasons above. Those objections are about the text of those revisions.

AGREE revision 3. It adopts `Source = Empty | Pane { id } | Tab { id } | Static { id } | WebCapture { id }`, strips the retired `terminal:` catalog instead of restoring `nav.solution`, keeps desk height as 0.65–1.25 m, and deletes three.js, curved UVs, per-section `/ws/pane`, the side-channel tab socket, `fillText`, the `:9800` websocket constant, the 3 s topology poll, and `localStorage` as authority. Curved-theater parity is explicitly not the test (`PLAN.md` step 4). Web panes are a watched lossless capture, not a VT and not JPEG: the fidelity mandate allows lossy only for non-text video, and these panes carry text. That supersedes the JPEG sentence in the revision-2 note above. The golden image is xterm's own renderer on `/ws/pane`, not this tree's Canvas2D painters. Perspective mismatches are recorded, not papered over. `contents_formatted` is not a parser seed.

Agreeing revision 3 does not mean the Node pack bench or Antigravity's 9.00 µs sidecar figure was re-run here. The plan still marks those budgets unpassed. `bridge.rs` is still absent from `hyperia-ref`.

## Mail

`msg_send` to the three lane mailboxes returned `awaiting_approval` (operations `op_1a0d4c071fe`, `op_1a0d4c071d3`, `op_1a0d4c071ad`). Same state Codex reported. Bodies are retained, not delivered. This file and the `PLAN.md` review log are the channel until approval releases them. Not retried.
