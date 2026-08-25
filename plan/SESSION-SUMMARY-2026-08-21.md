# Hyperia Session Summary — 2026-08-21

## Current build

**0.17.23** — built, signed (`CN=DeepBlue Dynamics LLC`, Valid), and waiting to install:
`dist\Hyperia-0.17.23-x64.exe`

The running app during most of this session was still **0.17.15**, which is why the newest dashboard features (File Ops matrix data, Maximus toggle, VRAM usage, shell hint bar) appeared inert — the page hot-reloads from disk, but the sidecar features they depend on ship in the binary. Installing 0.17.23 activates everything below in one step.

All builds this session are **local installers only** (per the standing dev-workflow rule). Nothing was pushed to canary or tagged as a GitHub release. The unreleased stack now runs from v0.17.8 → 0.17.23.

---

## The live-dashboard system (the core enabler)

The central win of this session: `/dashboard` is now **disk-served and self-reloading**, so UI iteration needs no rebuild.

- `GET /dashboard` serves `~/.hyperia/dashboard/index.html`, seeded on first run from the embedded `sidecar/static/dashboard.html`. Disk wins thereafter.
- The page polls `GET /api/dashboard/version` (file mtime) every 1.5s and reloads itself when it changes.
- **Result:** editing `~/.hyperia/dashboard/index.html` shows up on screen in ~1.5s. The repo seed is kept in sync by copying the live file back to `sidecar/static/dashboard.html` before each version bump.

Relevant code: `sidecar/src/dashboard.rs` (`DASHBOARD_SEED`, `get_dashboard`, `get_dashboard_version`, `dashboard_disk_path`).

---

## Telemetry pipeline

**Store** — `sidecar/src/telemetry.rs`: per-pane in-memory metrics keyed by `pane_uid`.
- `POST /api/telemetry/event` with a flattened envelope `{pane_uid, kind, ...fields}`.
- `kind` = `Tokens | Network | FileOp`; liberal serde aliases (lowercase/short forms like `net`, `file`, `in`, `rx`, `write`) so a producer that sends non-canonical casing parses instead of 400ing.
- **Two event rings** feed the dashboard:
  - `recent` (cap 200) — cross-pane live-stream ring, emitted as `events[]` in the window snapshot (each event stamped with `ts` + `pane_uid`).
  - `recent_files` (cap 300, FileOp-only) — emitted as `file_events[]`. Added because the 200-slot mixed ring floods with Network ticks and evicts rare FileOps within ~2 minutes, structurally starving the File Ops matrix.
- Window snapshot also merges `net_hosts` across panes (previously never merged).

**Producer** (the n8 side, an external dev not visible in this session): pushes Network every ~3s, Tokens on provider-call completion, FileOps on writes.

### Telemetry diagnosis — where it currently stands

Verified end-to-end from the Hyperia side: a hand-POSTed synthetic event renders on the deck in ~2s, so the **receiver is proven**. A driven wire test (a pane wrote three files, then edited two) confirmed the remaining gaps are **all producer-side**:

1. **Network** flows fine — hundreds of 200s, no rejects; uid re-resolution is working (events land on live uids).
2. **FileOps never leave one container** — one container's watcher delivers FileOps; the other's does not (watcher not running or not scoped to its workspace path). Events that do arrive have sometimes been stamped with stale/dead pane uids.
3. **Tokens** — not one Tokens event has ever arrived from any container; the token hook doesn't fire on provider calls.

These three are the outstanding items for the producer dev. The dashboard shows honest "no producer reporting …" states until they land, then lights up with zero further work on our side.

---

## Dashboard — current layout & features (all live)

**Header services strip** (own line under the title): status-light-only indicators for Ollama, Ferricula, Kokoro, Sailfish, Whisper — detail on hover. Plus a **Maximus ON/OFF toggle pill** backed by `POST /api/maximus/toggle` (flips `config.maximus.disabled` atomically in the shared config).

**Telemetry Overview cards:**
- **Tokens** — three stacked lines: `now` (current in/out rate), `max` (range-peak in/out), `all-time` total. Honest "no data" state until a Tokens event exists.
- **File Ops**, **Network**, **Active Panes** (with a history sparkline), **VRAM** (with a usage bar — `nvidia-smi memory.used` exposed as `vram_used_gb`).

**Charts & tables:** Token Flow area chart, Tokens-by-Pane donut, Pane Activity leaderboard, and a **Live Event Stream** with full UTC timestamps (`YYYY-MM-DD HH:MM:SSZ`) and text-width kind badges.

**Right rails** (both slim, arrow-only collapse toggles, state persisted):
- **File Ops** matrix — per-file aggregation (op-count chips C/W/D/Rn/Rd, bytes + panes on hover, relative last-touch, row flash on change), fed by the server's FileOp ring so it survives page reloads. Closed until first data, then auto-opens once.
- **Agent Chat** — lazy-loaded `/shell` iframe.

**Quality-of-life fixes:**
- **No focus steal on reload:** the chat iframe loads `/shell` via a fetched `srcdoc` with the textarea's `autofocus` stripped. The autofocus was firing on every live-edit reload and yanking Electron's focus out of whatever pane you were typing in.
- **Chart history persists** across reloads (localStorage, 2h window) so sparklines don't reset on every edit.
- All sparkline/flow baselines pinned to the bottom edge with fixed headroom; curves autoscale to their own max.
- Removed the old left column entirely; VRAM moved to a card, sidecar version to the footer pill, and the misleading "LOCAL" agent-mode banner deleted (the active model is remote; only Maximus is local).

---

## Version-by-version (this session)

| Ver | Change |
|-----|--------|
| 0.17.15 | Live event stream fix: cross-pane RecordedEvent ring, events carry ts + pane_uid, host rollup merged, closed-pane row labels |
| 0.17.16 | Single honest Tokens card (no-data state) + client-side accumulating event stream |
| 0.17.17 | File Ops Matrix rail added; "Agents" nav link removed |
| 0.17.18 | Services status-light strip in header; Maximus toggle (`POST /api/maximus/toggle`); left rail removed |
| 0.17.19 | Dedicated FileOp-only ring (300) → matrix actually holds data & survives reloads; file-ops rail collapses like chat |
| 0.17.20 | Full UTC timestamps + snug event badges (chat quick-key buttons later removed) |
| 0.17.21 | VRAM usage bar (`nvidia-smi memory.used`), pane-count history sparkline, persistent charts, **no-focus-steal** fix, shell key hints moved to their own line below the input |
| 0.17.22 | **Ink TUI extra-linefeed fix** (see below) |
| 0.17.23 | Tokens card split into now / max / all-time lines |

---

## Terminal fix — Ink TUI "extra line feed" (0.17.22)

**Symptom:** a stray blank/border row appeared under the input box in inline TUIs (Codex, and "most TUIs"); grok was immune; a manual window resize temporarily cleared it.

**Root cause** (`lib/components/term.tsx`, `forceReflow()`): the "repaint" helper did a `term.resize(cols+1)` then `resize(cols)` jiggle. That was a *real* grid resize — every `resize()` fires `onResize → props.onResize → pty.resize`, so it shipped **two PTY size changes of different widths in one tick** (double SIGWINCH) and ran two lossy xterm buffer reflows. Reflow is asymmetric (`_reflowSmaller` skips the cursor line; `_reflowLargerAdjustViewport` pushes blank lines at the bottom), so widen-then-narrow shifts the frame by a row. Inline Ink renderers erase their last frame with a relative cursor-up of N lines, so the shift orphans a row. It fired on every **pane focus, window drag, and DPR change**, not just resizes — which is why it felt random and returned after clearing.

**Fix:** replaced the jiggle with `clearTextureAtlas()` + fit + refresh (repaint without touching the grid or PTY); collapsed the 100ms+300ms double settle to a single 150ms trailing call; `windowsMode` now applies only as the legacy fallback when `windowsPty` is absent (both being set biased `Buffer.resize` toward inserting blank bottom lines).

Diagnosis by the `terminal-shell-master` agent; type-check clean.

---

## Other work this session

- **`render` tool** (`sidecar/src/render.rs`): takes a markdown file and renders it into a new Hyperia tab, with highlight markup on top of standard markdown — `==text==`, `=={color}text==`, `=={#hex}text==` — for joint analysis. Live file reload via `/api/render/{id}/version`. Wired through MCP (`render` tool in the web door) with create-consent gating.
- **Maximus/tokenmax** proven live (`[tokenmax type=… src=ollama/2i]` headers). Extraction timeout raised 20s → 90s to stop strangling gemma-class calls; passthrough annotations made honest.
- **Reddit (browser automation):** navigated to hide the user's comments/posts — `reddit.com/settings/profile` → **Content and activity → Hide all** (auto-saves; verified persisted after reload). Caveat surfaced: this curates the profile only; comments remain visible in-thread and to mods — there's no Reddit setting that hides comments in-thread.

---

## Outstanding / next

- **Install 0.17.23** to activate the current sidecar features on the running app.
- **Producer-side (external dev):** fix the non-reporting container's file watcher; stop stamping events with stale pane uids; wire the Tokens hook so token events actually emit.
- Not yet started but mentioned: telemetry persistence across sidecar restarts; config-page ↔ dashboard unification phase 2; pixel-perfect window mirror stream.

---

## Key constraints (standing)

- **Dev-workflow rule:** every change = bump version (`package.json`, `app/package.json`, `sidecar/Cargo.toml`, `sidecar/Cargo.lock`) + commit + build signed local installer. Only an explicit "deploy/push/release" pushes canary + tags a GitHub release. Never rebuild the same version with new code.
- **Focus-never-steal:** agent/bridge actions must never move the human's active pane/tab.
- **Sidecar bind policy:** Windows/macOS default `127.0.0.1`; Linux default `0.0.0.0` (containers); `HYPERIA_BIND` overrides.
