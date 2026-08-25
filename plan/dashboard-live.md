# Plan: Live-updatable /dashboard

**Goal:** Claude (or anyone) edits the dashboard *while the user is looking at it* — changes appear within ~1 s, no reinstall, no sidecar restart, ideally no manual refresh.

**Non-goal:** changing what data exists. New *data* still means new sidecar endpoints (a rebuild); this plan makes all *presentation and client logic* iteration rebuild-free.

## Today

`/dashboard` (sidecar `src/dashboard.rs`, ~1.4k lines) renders HTML from a Rust
function (`dashboard_html`) — **compiled into the binary**, like `/shell` /
`/guide` (`include_str!`). Every visual tweak = cargo build + electron-builder +
reinstall (~10 min round trip). Telemetry data already flows through clean JSON
APIs (`/api/telemetry/snapshot`, `dashboard_widgets`).

## Design: disk-first, embedded fallback, SSE hot-reload

1. **Disk-first serving.** `GET /dashboard` reads
   `~/.hyperia/dashboard/index.html` when present; falls back to the compiled-in
   page when absent (fresh installs still work). New route
   `GET /dashboard/assets/{file}` serves sibling files from that dir —
   extension-whitelisted (`.html .js .css .png .svg .woff2 .json`), no path
   traversal (reject `..` and separators in `{file}`).
2. **Hot reload.** `GET /dashboard/events` = SSE. A sidecar task polls the
   dashboard dir's max-mtime every 1 s (no new crate needed); on change it sends
   `reload`. The page runs
   `new EventSource('/dashboard/events').onmessage = () => location.reload()`.
   Result: a `Write` to the file lands on the user's screen ~1 s later.
3. **Seed bootstrap.** On startup, if `~/.hyperia/dashboard/index.html` is
   missing, the sidecar writes the current compiled-in page there. Disk copy
   starts pixel-identical to today's dashboard; iteration begins from parity.
4. **Pure-client data.** The seed page (and everything after) fetches data —
   `/api/telemetry/snapshot`, `/api/status`, widget JSON — on an interval or SSE
   later. The HTML carries no server-side interpolation, so the Rust side stops
   caring what the page looks like. (`dashboard_html(&widgets_json)`'s
   interpolation moves to a client-side fetch of the same JSON via a small new
   `GET /api/dashboard/widgets`.)
5. **Versioning note in the page.** Footer shows `served from disk (live)` vs
   `embedded` so it's always obvious which mode is active.

## Implementation steps (one sidecar rebuild, then never again)

1. `dashboard.rs`: `dashboard_dir()` (`~/.hyperia/dashboard`), disk-read in
   `get_dashboard` with embedded fallback; assets route; `GET
   /api/dashboard/widgets` returning the widgets JSON that `dashboard_html`
   interpolates today.
2. SSE `/dashboard/events` + 1 s mtime-poll task (tokio interval; skip while no
   subscribers).
3. Seed write on startup when missing (never overwrite an existing disk copy —
   user/Claude edits are authoritative; ship changes to the seed only affect
   fresh installs).
4. Batch into the same build: **Maximus fixes** — extraction client timeout
   20 s → 90 s (gemma4:e4b takes ~15 s per 25 KB call, ×2–3 pipeline calls) and
   honest passthrough annotations ("maximus disabled" / "extraction timed out" /
   "ollama unreachable" instead of blanket "Ollama unavailable").
5. Ship 0.17.11, install once. All subsequent dashboard work = editing
   `~/.hyperia/dashboard/*` live.

## Iteration workflow after 0.17.11

- User: keeps `/dashboard` open in a web pane.
- Claude: `Write`/`Edit` on `~/.hyperia/dashboard/index.html` (+ assets) —
  page reloads itself ~1 s later. Conversation-speed UI development, no build.
- Repo hygiene: the canonical dashboard source lives in the repo
  (`sidecar/static/dashboard/`) and is what the seed embeds; when disk
  iteration stabilizes, copy back into the repo + commit so fresh installs get
  the latest (a `bin/sync-dashboard.js` two-liner can do the copy).

## Later (not this pass)

- SSE data push (replace polling fetches) once the widget set stabilizes.
- Same disk-first treatment for `/shell` and `/guide`.
- Auth: `/dashboard` stays localhost-read like today; revisit if
  `config.stream.requireToken` lands globally.
