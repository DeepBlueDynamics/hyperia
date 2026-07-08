# hyperia CLI — full MCP stack as shell commands, usable by a dumb agent

**Status:** design / breakdown. Supersedes & subsumes #117 (thin client) — same goal, wider scope.
**Goal:** a `hyperia` command that exposes the **entire** Hyperia tool surface as plain shell subcommands, so a weak model (or a human) with **zero MCP/JSON-RPC knowledge** can drive Hyperia: `hyperia run "..."`, `hyperia web open <url>`, `hyperia status`, `hyperia cd <dir>`. Works inside an n8 container and locally.

## Design principle: mirror the live tool list, don't hand-write 60 commands

The sidecar already publishes the whole catalog (MCP `tools/list` over streamable-http at `/mcp`, and the same operations as plain `/api/*` routes). The CLI should **generate** its command surface from that catalog so it's **complete and never goes stale** as tools are added — with a thin curated layer for ergonomics on top.

Three layers:
1. **Generic (auto-generated, complete):** `hyperia tools` lists every tool + one-line description; `hyperia call <tool> --field value …` (or `--json '{...}'`) invokes any tool; `hyperia call <tool> --help` prints the tool's input schema. This alone "implements the full MCP stack" with minimal code and zero drift.
2. **Curated aliases (the dumb-agent surface):** friendly verbs with positional args for the high-traffic tools — `status`, `run`, `keys`, `split`, `open`, `close`, `cd`, `screen`, `focus`, `rename`, `request-access`, `whoami`/`login`. Each just maps friendly args → the underlying tool call.
3. **Guidance:** `hyperia` (no args) and `hyperia help` print the command groups + the window→tab→pane model + common recipes (ties to #120). Every error tells the agent the next command to run.

## Transport & auth (handled transparently — the agent never thinks about it)
- **Endpoint:** read `HYPERIA_MCP_URL` (default `http://localhost:9800`); inside a container that's the container, so fall back to / allow the **host gateway** (`host.docker.internal:9800`). `hyperia doctor` reports reachability.
- **Identity bootstrap:** on first use, if no token, mint one via `POST /api/identity/agent {name}` (→ `hyp_agent_…`), cache it (e.g. `~/.hyperia/cli.json` or `$HYPERIA_CLI_TOKEN`), and attach `Authorization: Bearer …` on **every** call. `hyperia login`/`whoami` make this explicit. (Ties to identity model + nemesis8#68.)
- **Consent:** `request-access` raises the prompt and **waits**; mutating commands that hit a soft-wall surface a clear "run `hyperia request-access <pane>`" message rather than a raw 4xx.
- **Calls:** curated verbs hit `/api/*` (simplest); the generic layer uses MCP `tools/list` + `tools/call` against `/mcp`. Stateless (no session handshake) — one POST per call.

## Dumb-agent ergonomics (the actual point)
- `--json` on everything → stable machine output; human-readable default. Exit codes: `0` ok, non-zero with a one-line stderr reason (`refused` / `queued` / `consent-required` / `not-identified` / `unreachable`).
- Errors are **actionable**: "not identified → run `hyperia login`"; "consent required → run `hyperia request-access <pane>`"; "that's your own pane → pass `--force`" (echoes the self-close guard #118).
- `--help` text mirrors the MCP tool descriptions verbatim (single source of truth).
- Addressing matches the tools: `--window/--tab/--pane` by name or id; omit → focused.

## Phases (epic checklist)
- **C1 — Client core:** endpoint resolution (+ container host-gateway), identity mint/cache/Bearer, MCP `tools/call`+`tools/list` and `/api` HTTP, error→actionable-message mapping, `--json` + exit codes.
- **C2 — Generic generated layer:** `hyperia tools`, `hyperia call <tool> [--field … | --json]`, per-tool `--help` from input schema. *Delivers the full stack on its own.*
- **C3 — Curated verbs:** status / run / keys / split / open / close / cd / screen / focus / rename / request-access / whoami / login, with positional args.
- **C4 — Identity & consent UX:** `login`, `whoami`, `request-access` (drive + wait), clear consent/queued/refused messaging.
- **C5 — Container support:** host-gateway resolution + `hyperia doctor` (reachable? identified? my pane?); document the n8 wiring (nemesis8#68).
- **C6 — Discoverability/help:** top-level + per-command help, `hyperia guide` (window→tab→pane model + recipes), ties to #120.
- **C7 — Packaging:** ship via electron-builder `extraResources` (`bin/cli.js` + `build/${os}/hyperia` wrapper), keep legacy plugin subcommands working.

## Open questions
- Implement in `cli/index.ts` (the existing entry — currently the inherited Hyper plugin manager) alongside the legacy plugin verbs, or a new `cli/hyperia.ts` entry. Recommend: keep one binary, add the new groups, leave plugin verbs.
- Generic layer over MCP `tools/call` vs `/api/*` only: MCP gives the full self-describing catalog (schemas → auto `--help`), so use MCP for generic and `/api` for the hand-tuned hot verbs.
- Arg mapping for the generic layer: `--field value` flag-per-schema-property vs a single `--json`. Ship `--json` first (trivial, complete), add flag-per-property as sugar.

## Code touch-points
- `cli/index.ts`, `cli/api.ts` — add the client + command groups.
- Sidecar (already implemented, just consumed): `POST /api/identity/agent`, `GET /api/identity/whoami`, `/mcp` (tools/list, tools/call), `/api/*` route mirror.
- `electron-builder.json` `extraResources` + `build/${os}/hyperia` wrapper (packaging).
