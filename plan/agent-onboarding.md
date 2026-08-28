# Hyperia — Agent Onboarding Prompt

You are joining work on **Hyperia**, an agent-native terminal at
`C:\Users\kordl\Code\DeepBlueDynamics\hyperia` (branch: `canary`). Adopt
everything below as standing instruction. The human is **kord** — terse,
fast-moving, allergic to ceremony. Act, don't ask; report outcomes honestly;
their eyes are ground truth over anything you read through a tool.

## What this is

- **Electron app** — renderer in `lib/` (React/Redux/seamless-immutable,
  xterm.js), main in `app/`. Frameless windows; custom tab header.
- **Rust sidecar** — `sidecar/src/`, axum HTTP on `:9800` + MCP
  (streamable-HTTP at `/mcp`). ~75 tools. The bridge (`app/bridge.ts` ↔
  `sidecar/src/bridge.rs`) mirrors sessions, screens, and layout to it.
- Agents live in panes (often n8/nemesis8 containers) and drive Hyperia via
  MCP or the `hyperia` CLI (`hyperia status|call|run|login|mcp`).

## Hard rules (violations have burned real sessions)

1. **NEVER kill the running installed Hyperia** for diagnostics. Dev runs are
   `yarn start` (never `electron .`), only in a user-granted debug window.
2. **Build only when kord says "build".** Every change = bump-or-share
   unbuilt version + commit. **Never build the same version twice with
   different code** — commits may share a version only while it's unbuilt.
3. **"deploy" / "push" / "release" / "kraken" = push canary + tag** →
   tag-triggered CI (`build.yml`) publishes. Release ritual when asked for a
   PR: `release/vX.Y.Z` branch with `release-notes.md` (root, replaced per
   release) → PR to canary → **kord merges** → you tag → CI publishes →
   `gh release edit` to attach notes + title (titles are named, flavorful:
   "the fleet keeps its memory 🧠").
4. **focus-never-steal**: nothing an agent does may move the human's active
   pane/tab/window. Surface passively (pulse, toast, bell).
5. Pushes use `--no-verify` (pre-push hook trips on unrelated debt). Commits
   end with the Claude co-author + session trailer.

## Build & verify ritual (Windows)

```
cd sidecar && cargo build --release && cd ..
yarn run build
set -a && source .signing.env && set +a && npx electron-builder --config.npmRebuild=false
```
- Verify signature via **PowerShell** signtool (`verify /pa`) — git-bash
  mangles `/pa` into a path.
- Before building: no dev electronmon leftovers holding
  `sidecar/target/release/hyperia-sidecar.exe`; the *installed* running app
  does not block builds.
- Disk fills up: `dist/` hoards old installers — delete old versions freely.

## CI truths

- `nodejs.yml` = PR/push gate (lint → unit → dist → E2E). **CI lint is the
  authority** — verify locally with an UNPIPED `npx eslint .` (a piped
  `| tail` eats the exit code; this caused three wasted CI rounds once).
- E2E launches the packaged app: linux needs `--no-sandbox`; mac must pick
  the **host-arch** dir (`mac-arm64` on CI) or Rosetta hangs the launch;
  Windows needs the bounded `app.close()` (tray keep-alive never exits).
- Flakes that are just flakes: `ESOCKETTIMEDOUT` in yarn install (all
  workflows now carry `--network-timeout 300000`), rare mac codesign hiccups,
  one-off `Napi::Error` under xvfb. Re-run once; twice = real bug.

## Consent & identity model

- Reads are anonymous; writes need identity. **Pane tokens** (`hyp_pane_…`)
  die with the pane; **agent tokens** (`hyp_agent_…`) persist
  (`~/.hyperia/agents.json`); CLI caches one via `hyperia login`
  (`~/.hyperia/cli.json`, identity "bob" here).
- Since v0.17.47, pane tokens/owners + durable grants persist across sidecar
  restarts (`~/.hyperia/perms.json`). Timed/one-shot grants and denials stay
  ephemeral; enforcement always boots ON.
- Gates: `enforce_drive` (per-pane, consent prompt), `enforce_create`
  (sentinel `__create__`, toast + held command), capability gates, audio
  (sentinel `__audio__`). **`hyperia_spoken_summary` is deliberately
  UNGATED** — do not "fix" that.
- Consent prompts never silently vanish: they collapse to a pending pill and
  re-raise on retry. A 202 "held" response means WAIT — the command fires on
  approval.

## Tools you'll actually use (via `hyperia call <tool> '<json>'`)

- `terminal_status {}` — windows/tabs/panes with names, paneIds, bsp rects.
- `terminal_screen {"pane":"<name|paneId>","raw":true}` — live screen.
  Maximus filtering is slow; `raw:true` avoids MCP timeouts.
- `terminal_keys {"pane":…,"keys":"…\n","attribute":true}` — message an
  agent pane (attribute adds a From: header). Write JSON to a temp file and
  `"$(cat file)"` it — inline quoting through bash mangles.
- `window_image {"window":N,"max_width":1200}` — real-pixels PNG of a whole
  window incl. native web panes. THE way to see what the human sees.
- Web panes: address by **paneId** (`open_web_pane` returns it — save it);
  names resolve globally since .43; no-address works only when exactly one
  web pane exists.
- `style_create` / `style_apply {"name":…,"pane":…}` — live per-pane themes;
  full 16-color palettes; overlay keys `scanlines`, `watermark`,
  `watermarkImage`.
- `audio_play` / `audio_stream_open` — consent-gated host audio (WAV/MP3/
  FLAC/OGG clips; raw-PCM ws stream).

## Known sharp edges

- **MCP stringification footgun**: untyped object/null params can arrive as
  strings; string `"null"` means "remove key" in `settings_set`.
- The sidecar's screen mirror CAN diverge from reality if the sidecar is
  degraded — when kord contradicts your screen read, kord is right.
- Renderer errors persist to `~/.hyperia/logs/renderer-errors.log`; main to
  `main-errors.log`; sidecar to `~/.hyperia/logs/sidecar.log.<date>`.
- Config `~/.hyperia/hyperia.json` hot-reloads; `settings_set` works even
  when other write paths are broken (file I/O, not HTTP).
- Update zombies are fixed (Windows handover v0.17.44, Linux postinst kill
  v0.17.49) — but only once the running version has the fix.

## Open threads (as of 2026-08-28, v0.17.49 released)

- kord's Windows box may lag the latest release (restart-to-apply pending is
  chronic). Check `hyperia call hyperia_version` before assuming features.
- Linux box: needs v0.17.49 .deb (icon fix + upgrade-kill); an unresolved
  **"painted over" web-pane artifact** awaits a `window_image` capture;
  Wayland capture may hit portal permissions — unverified.
- Parked epics: streamed-terminal-on-a-hash (plan + memory notes; dial-out
  relay design), KeyStore #103 (API keys are plaintext in config), audio
  mute UI, drive-consent silent-dedupe residual, `terminal_screen`
  Maximus-timeout fallback, multi-window restore last-writer-wins.
- nuts.services side: `nuts-auth` has an open `return_url` redirect;
  `nuts-tunnel` names are hijackable — known, unfixed, other repo.

## File map — what to read, in what order

Tier 1 — orient (read fully, ~30 min):
- `docs/architecture.md` — the system in one page.
- `docs/mcp-tools.md` — the agent-facing API surface (~75 tools).
- `docs/configuration.md` — every setting; written to be agent-usable.
- `docs/building.md` + `docs/developing.md` — build ritual, dev loop, hangs.
- `CLAUDE.md` (repo root, untracked) — pane-control escape hatches.
- `release-notes.md` — what shipped last and why.

Tier 2 — sidecar (where agent-facing behavior lives; GREP, don't scroll):
- `sidecar/src/mcp.rs` (~3.9k lines) — every `#[tool]` definition; grep the
  tool name you care about.
- `sidecar/src/main.rs` (~4.2k) — HTTP routes + the `enforce_*` consent
  gates; the route table near the bottom is the endpoint index.
- `sidecar/src/bridge.rs` (~2.4k) — session registry, `resolve_pane_uid`,
  `authorize_drive/create`, screen buffers, pulse machinery.
- `sidecar/src/perms.rs` — the consent store + perms.json persistence.
- `sidecar/src/identity.rs` — token minting/resolution.
- `sidecar/src/stream.rs` — `/ws/pane|pixels|wall` (Event Stream API;
  spec in `plan/specs/EVENT_STREAM_API.md`). NOTE: `/ws/pane` is
  unauthenticated read-WRITE — relevant to any exposure work.
- `sidecar/src/audio.rs` + `tts.rs` — audio channel, Kokoro/ElevenLabs.

Tier 3 — Electron main (the seam):
- `app/bridge.ts` (~1.7k) — the sidecar→app command dispatcher; every
  `case '<Cmd>'` is a capability. Layout sync (`updateSessionLayout`) here.
- `app/index.ts` — boot order, single-instance lock + stale handover,
  uncaught-exception guards, sidecar spawn.
- `app/ui/window.ts` (~1.2k) — window creation, per-window rpc, layout-sync
  intake, renderer-error logging.
- `app/web-pane-manager.ts` — native WebContentsView web panes: bounds,
  freeze-swap, zoom, auth toast, capture.

Tier 4 — renderer (only when touching UI; the two giants punish scrolling):
- `lib/index.tsx` — rpc handler registry, pane-style sanitizer, BSP layout
  calc + `session layout sync` emitter. Read this one fully.
- `lib/components/term.tsx` (~4.2k) — terminal component: xterm setup, link
  provider, busy detection, drag/drop, watermarks. Grep by feature.
- `lib/components/web-pane.tsx` (~3.5k) — web pane chrome: bounds reporting,
  overlays, find, history, credential toast. Grep by feature.
- `lib/components/term-group.tsx` — where per-pane styles merge into props.
- `lib/permissions-bus.ts` — consent prompt/pill/toast plumbing (well-commented).

Tier 5 — when relevant:
- `.github/workflows/nodejs.yml` (PR gate) + `build.yml` (tag release).
- `test/index.ts` — the E2E harness and its hard-won launch mechanics.
- `plan/*.md` — epics and specs; `plan/agent-onboarding.md` — this file.

Rule of thumb: docs first, then grep the tier-2/3 file that owns your
feature. Nobody reads term.tsx top to bottom and stays sane.

## Communication with kord

Lead with the outcome. Short sentences. No headers for simple answers. When
something breaks mid-flow, say what broke and what you did — never bury a
failure. Builds/releases get announced with what's IN them. When kord says
you're wrong about what's on screen, re-derive from their description, not
your cached reads.
