# Hyperia — containerized deployment

Run the Hyperia **sidecar** (brain: HTTP API, MCP, Ghost agent, lume search,
notes, telemetry) and **Ferricula** (memory tier) as one Docker Compose stack.

Full design + security model: [`hyperia-docker-deployment-spec.md`](hyperia-docker-deployment-spec.md).
This README is the operator quickstart.

## Prerequisites

- Docker (Desktop on Win/macOS, or engine + compose on Linux)
- `../ferricula` checked out as a sibling of this repo (Compose builds it)
- Run everything **from the repo root** — the sidecar build context is the repo
  root (the Dockerfile copies `sidecar/`, which vendors its path-dep crates under
  `sidecar/crates/`)

## Pick a topology (spec §3)

| | A — local drop-in | B — headless server | C — remote brain |
|---|---|---|---|
| Sidecar runs | your workstation, in Docker | a server, no GUI | a server |
| Terminal tools work | **yes** (local Electron attaches) | no (no client) | yes (client attaches) |
| Publish port | `127.0.0.1` only | LAN behind TLS+auth proxy | LAN behind TLS+auth proxy |
| App code change | none | none | `bridge.ts` host (deferred) |

**Default is A.** B/C exposes the sidecar off-loopback — read the security
section before doing that.

## Quickstart (Topology A)

```bash
# from the repo root
cp .env.example .env          # fill ANTHROPIC_API_KEY (Ghost agent; optional)

docker compose build          # first sidecar build compiles Rust — minutes
docker compose up -d
docker compose ps             # both 'healthy'?
```

Verify (spec §9):
```bash
curl -s http://127.0.0.1:9800/health                              # -> ok
curl -s http://127.0.0.1:9800/api/status                          # -> {"version":"0.11.0",...}
docker compose exec sidecar wget -qO- http://ferricula:8765/status # sidecar -> ferricula
```

Register MCP with a local agent:
```bash
claude mcp add --transport http hyperia http://localhost:9800/mcp
```

## The one gotcha: stop fighting the desktop app for port 9800

The Hyperia desktop app **spawns its own embedded sidecar on 9800**. If it's
running, the container can't bind that port. Two ways to coexist:

1. **Use the external (container) sidecar** — tell the app to connect to the
   container instead of spawning its own:
   ```
   HYPERIA_USE_EXTERNAL_SIDECAR=1     # env, OR
   ```
   ```json
   // ~/.hyperia/hyperia.json
   { "useExternalSidecar": true }
   ```
   The app then skips its spawn and its bridge auto-connects to the container
   (reconnecting until it's up). This is the adoptable Topology A.
2. **Or** just quit the desktop app before `docker compose up` (container owns
   9800; no terminal tools until a client attaches).

Ferricula transition note: while you still run the *embedded* sidecar on the
host, that sidecar needs Ferricula's REST on the host — uncomment the
`127.0.0.1:8765:8765` line in `docker-compose.yml`. Once fully on the container
sidecar, leave it commented (REST stays internal to the Compose network).

## Security (read before B/C) — spec §7

The sidecar **does not authenticate inbound callers by bind address** — binding
`0.0.0.0` only *logs a warning*. So:

- **`HYPERIA_SYSTEM_TOKEN` is NOT an auth lock — it's the consent-*bypass*
  identity.** Never set it in the container or hand it to external agents; that
  grants them a skeleton key past the consent flow. Electron mints its own over
  loopback for Topology A.
- **Topology B/C security is an external reverse proxy** (Caddy/Traefik/nginx)
  terminating TLS and enforcing auth in front of `sidecar:9800`. Don't expose
  `/dashboard`, `/ws`, or `/api/*` to an untrusted network without it.
- **Headless (B) has no consent approver** — mutating calls that need approval
  sit at `202 Pending` forever (no renderer). B is viable only for the
  non-gated surface: MCP reads, memory recall/remember, search, telemetry.

## Publishing prebuilt images (skip the recompile on deploy)

```bash
docker build -f deploy/sidecar.Dockerfile -t deepbluedynamics/hyperia-sidecar:0.11.0 .
docker push deepbluedynamics/hyperia-sidecar:0.11.0
# then in docker-compose.yml swap the sidecar `build:` for:
#   image: deepbluedynamics/hyperia-sidecar:0.11.0
```

## Troubleshooting

- **Build slow / "hung" / weird Rust errors** → make sure `.dockerignore`
  exists at the repo root. Without it the build context streams gigabytes of
  `target/` + `node_modules`, and stale Linux/host target artifacts corrupt the
  in-container compile. (Resolved in this repo; the image builds to ~142 MB.)
- **`docker compose up` fails to bind 9800** → the desktop app's embedded
  sidecar owns it. See the port-9800 section above.
- **Ghost agent unauthenticated** → set `ANTHROPIC_API_KEY` in `.env`, or put
  the token in `~/.hyperia/hyperia.json` on the `hyperia-state` volume.
- **Memory calls return empty** → Ferricula unreachable; the sidecar degrades
  gracefully (never blocks). Check `docker compose ps` and the `FERRICULA_URL`.
