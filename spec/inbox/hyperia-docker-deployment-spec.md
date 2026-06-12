# Hyperia Container Deployment Spec — Sidecar + Ferricula

**Status:** Draft 2 · **Owner:** Deep Blue Dynamics · **Date:** 2026-06-12
**Scope:** Containerize `hyperia-sidecar` (the new container) and integrate it with the existing `ferricula` container under Docker Compose, as a single deployable unit.

> Draft 2 corrects the Draft 1 security model: `HYPERIA_SYSTEM_TOKEN` is a consent-*bypass* identity, not an auth lock; off-loopback bind only warns; B/C security must be proxy-enforced; headless B has no consent approver. See §2, §4.3, §6, §7, §11.6, §12.

---

## 1. Purpose

Today only Ferricula runs in Docker. The Rust sidecar (`hyperia-sidecar`, v0.11.0) runs as a child process spawned by the Electron desktop app. This spec defines a **new `hyperia-sidecar` container** and a **merged Compose stack** so the two services — the agent/MCP brain (sidecar) and the memory tier (Ferricula) — deploy and version together.

The driving constraint, established from the source, is in §2. Read it before anything else; it determines which of three topologies you are actually building.

---

## 2. Architecture finding that drives the design

Hyperia is a **brain/hands split**:

- **Sidecar = brain.** It owns the HTTP API, the MCP server (`/mcp`), the Ghost agent, `lume` BM25 search, the Ferricula client, telemetry, notes, and the dashboard. It binds `127.0.0.1:9800` by default.
- **Electron = hands.** The actual terminal PTYs live in the Electron desktop process. Electron connects *into* the sidecar over a WebSocket at `/ws` and streams session data.

Consequence: the sidecar's terminal-driving routes (`/api/type`, `/api/pane/*`, `/api/screen`, `tab_image`, etc.) are **inert unless an Electron client is connected to `/ws`.** A containerized sidecar with no client attached still serves MCP, Ghost, memory, search, notes, and telemetry — but it cannot drive a terminal, because there is no terminal in the container.

Related, and security-relevant: mutation approval also depends on Electron. The `/api/perms/*` consent/capability system gates mutating calls and **needs a renderer to display and answer approval prompts.** With no client attached (headless), gated calls return `202 Pending` and never resolve — there is no approver. See §7.

Second finding: `app/bridge.ts` currently connects to a **hardcoded** `ws://127.0.0.1:${sidecarPort}/ws` (default port 9800), with auto-reconnect. This is a feature, not a bug, for the simplest topology — see Topology A.

---

## 3. Topology decision

Pick one. The spec defaults to **A** because it is a true drop-in.

| | A. Local sidecar container | B. Headless server | C. Remote brain + thin clients |
|---|---|---|---|
| Sidecar runs | On the user's workstation, in Docker | On a server, no GUI | On a server |
| Terminal tools work? | **Yes** — local Electron connects to `/ws` | No (no client attached) | Yes, if a client connects |
| Electron connects to | `127.0.0.1:9800` (unchanged) | n/a | remote host:9800 (**code change needed**) |
| Publish port to | `127.0.0.1` only | LAN/private net | LAN behind TLS + auth |
| Code change to `bridge.ts` | None | None | **Required** (configurable host) |
| Use case | Replace the spawned process with a managed container | MCP/memory/agent service for remote agents | Multi-user shared brain |

**Topology A** swaps the locally-spawned sidecar binary for a locally-running container on the same loopback port. Because `bridge.ts` targets `127.0.0.1:9800`, publishing the container as `127.0.0.1:9800:9800` makes the desktop app connect to it with **zero app changes**. Stop spawning the embedded sidecar (or leave it disabled) and let the container own the port.

**Topology B** is the "MCP/memory service" deployment: remote agents hit `https://host/mcp`, Ghost + Ferricula + lume all work, terminal tools simply go unused. No `bridge.ts` change.

**Topology C** requires making the `/ws` target host/port configurable in `app/bridge.ts` (today it is a constant). Tracked as an open item in §11.

---

## 4. The new container: `hyperia-sidecar`

### 4.1 Build facts (from source)

- Pure Rust, edition 2021, crate `hyperia-sidecar` v0.11.0. Release profile already optimized (`lto`, `opt-level="z"`, `strip`).
- TLS is **rustls** (`reqwest` with `rustls-tls`, `default-features=false`) — **no OpenSSL/system SSL needed**. Runtime still needs `ca-certificates` for outbound HTTPS to the model API.
- `build.rs` only does work under `cfg(windows)` (PE VERSIONINFO). On Linux it is a no-op.
- **Path dependencies** to sibling crates: `lume`, `aegis-edit`, `grub-md` (all `../<name>` relative to `sidecar/`). The Docker **build context must be the repo root** so these resolve. `grub-md` has pyo3 stripped — no Python toolchain required.
- `[workspace]` in `sidecar/Cargo.toml` makes the sidecar its own workspace; build output lands at `sidecar/target/release/hyperia-sidecar`.

### 4.2 Runtime contract

| Item | Value | Notes |
|---|---|---|
| Binary | `hyperia-sidecar` | |
| Listen | `--port 9800`, bind via `HYPERIA_BIND` | In-container set `HYPERIA_BIND=0.0.0.0` |
| Health | `GET /health` → `ok` | Unauthenticated; ideal for healthcheck |
| MCP | `GET /mcp` (streamable HTTP) | What external agents point at |
| Dashboard | `GET /dashboard` | Telemetry UI |
| WS bridge | `GET /ws` | Electron connects here |
| State dir | `$HOME/.hyperia/` | config, `lume/` index, `stickys/`, `agents.json`, `logs/` — **must be a volume** |

### 4.3 Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `HYPERIA_BIND` | yes (container) | `127.0.0.1` | Set `0.0.0.0` so the listener is reachable across the container boundary |
| `FERRICULA_URL` | recommended | `http://localhost:8765` | Set to `http://ferricula:8765` (Compose service DNS) |
| `ANTHROPIC_API_KEY` | for Ghost | — | Ghost agent key. Source order: `~/.hyperia/hyperia.json` → env fallback (`ANTHROPIC_API_KEY`/`ANTHROPIC_TOKEN`, also `OPENAI_*`, `GEMINI_*`). Pass via secret, never bake into image |
| `HYPERIA_SYSTEM_TOKEN` | **no — usually leave unset** | — | **Not an auth lock — it is the consent-bypass identity.** Normally minted by Electron (`app/system-token.ts`) to mark a caller as "Hyperia itself," skipping the `/api/perms/*` consent flow. Setting it in a container and exposing it to external agents grants them full bypass — the opposite of protection. Leave unset for A/B/C; security for B/C is the external proxy (§7) |
| `HYPERIA_BASE_URL` | no | self loopback | Sidecar's self-referential base; default loopback works inside the container |
| `RUST_LOG` | no | `info` | `tracing` filter |

If `FERRICULA_URL` is unreachable, memory calls **degrade gracefully** (recall returns empty, remember is best-effort) — the sidecar never blocks. So the stack still comes up if Ferricula is down.

### 4.4 Dockerfile

Place at repo root as `deploy/sidecar.Dockerfile`. Build context = repo root.

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM rust:1-bookworm AS build
WORKDIR /build
# Sibling crates the sidecar depends on via path deps. Layout must match
# the `../lume`, `../aegis-edit`, `../grub-md` references in sidecar/Cargo.toml.
COPY lume        ./lume
COPY aegis-edit  ./aegis-edit
COPY grub-md     ./grub-md
COPY sidecar     ./sidecar
WORKDIR /build/sidecar
# --locked uses the committed Cargo.lock for reproducible builds.
RUN cargo build --release --locked
RUN strip target/release/hyperia-sidecar || true

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# Non-root runtime user with a real HOME for ~/.hyperia state.
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=build /build/sidecar/target/release/hyperia-sidecar /usr/local/bin/hyperia-sidecar
# sidecar/static + sidecar/assets are NOT copied — verified embedded at compile
# time (e.g. assets/hyperia-mcp.py via include_str!); nothing reads either dir
# from disk at runtime. ~/.hyperia/assets is runtime state and lives on the volume.
USER app
ENV HOME=/home/app \
    HYPERIA_BIND=0.0.0.0 \
    FERRICULA_URL=http://ferricula:8765 \
    RUST_LOG=info
EXPOSE 9800
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:9800/health || exit 1
ENTRYPOINT ["hyperia-sidecar"]
CMD ["--port", "9800"]
```

Build notes:
- First build is slow (full Rust compile). Add a `cargo`/registry cache mount (`--mount=type=cache`) once the layout is verified to cut rebuilds.
- Multi-arch (`linux/amd64` + `linux/arm64`) via `docker buildx` if any target host is ARM (Apple silicon servers, Graviton).
- `static`/`assets` are embedded at compile time (`include_str!`), so the image does not copy them — confirmed against the source, not defensive guesswork.

---

## 5. Merged `docker-compose.yml`

Replaces the current single-service file. Ferricula keeps its build/volume; its REST port is no longer published to the host (the sidecar reaches it over the internal network). Sidecar is published to **loopback only** for Topology A.

```yaml
services:
  ferricula:
    build:
      context: ../ferricula
      dockerfile: Dockerfile
    # Once published: image: deepbluedynamics/ferricula:0.9.7
    container_name: hyperia-ferricula
    expose:
      - "8765"            # REST — internal only, reached by the sidecar
    ports:
      - "127.0.0.1:8766:8766"  # MCP — optional, external agents; drop if unused
    volumes:
      - ferricula-data:/data
    environment:
      - PORT=8765
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8765/status"]
      interval: 10s
      timeout: 3s
      retries: 3

  sidecar:
    build:
      context: .
      dockerfile: deploy/sidecar.Dockerfile
    container_name: hyperia-sidecar
    depends_on:
      ferricula:
        condition: service_healthy
    ports:
      - "127.0.0.1:9800:9800"  # Topology A: local Electron connects here unchanged.
                               # Topology B/C: change to "9800:9800" ONLY behind an external TLS+auth proxy (§7).
    environment:
      - HYPERIA_BIND=0.0.0.0
      - FERRICULA_URL=http://ferricula:8765
      - RUST_LOG=info
      # Secret comes from .env (gitignored) or `docker compose --env-file`.
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      # NOTE: do NOT set HYPERIA_SYSTEM_TOKEN here — it is a consent-bypass
      # identity, not an auth lock (§4.3/§6). Leave it unset.
    volumes:
      - hyperia-state:/home/app/.hyperia
    restart: unless-stopped

volumes:
  ferricula-data:
    name: hyperia-ferricula-data
  hyperia-state:
    name: hyperia-sidecar-state
```

Service-to-service: the sidecar resolves `ferricula` by Compose DNS on the default network. No host networking needed.

---

## 6. Secrets

- **Never** bake `ANTHROPIC_API_KEY` into the image. Pass at runtime.
- Local/dev: a gitignored `.env` next to the compose file; `docker compose up` reads it.
- Prod: Docker/Swarm secrets or the host orchestrator's secret store; mount as env or file. If you prefer file-based, mount a config volume containing `~/.hyperia/hyperia.json` with `providers.anthropic.token` set, and the env var becomes optional.
- **Do not set `HYPERIA_SYSTEM_TOKEN` in the container.** It is the consent-bypass system identity (§4.3), not a protective credential. Exposing it to a network-reachable sidecar or to external agents hands them a skeleton key past the `/api/perms/*` consent flow. For Topology A, Electron mints its own token locally over loopback — the container needs none.

---

## 7. Networking & security

**The sidecar does not authenticate inbound callers based on bind address.** Binding `0.0.0.0` only *logs a warning* (main.rs:2180) — it does not gate anything. The mutation gate is the separate `/api/perms/*` consent/capability system (the 401s at main.rs:795/869/933), which is independent of the bind and **requires a connected Electron renderer to surface and answer approval prompts.** Two consequences:

- **The sidecar will not protect itself on an exposed port.** For Topology B/C the real security boundary is an **external reverse proxy** (Caddy/Traefik/nginx) terminating TLS and enforcing auth in front of `sidecar:9800`. Do not expose `/dashboard`, `/ws`, or `/api/*` to an untrusted network without it.
- **Headless (B) has no approver.** With no Electron renderer attached, any mutating call that triggers consent sits at `202 Pending` indefinitely — nothing can approve it. B is therefore only viable for the non-gated surface (MCP reads, memory recall/remember, search, telemetry). Anything requiring approval needs a client (Topology C) or a separate headless-approval design (out of scope — see §11).

Other rules:
- Host exposure is controlled by the `ports` mapping, not the in-container bind. Keep `127.0.0.1:9800:9800` for Topology A so nothing is reachable off-box.
- `/health` returns `ok` unauthenticated and is safe to hand to a load balancer. `/ws` carries the Electron bridge and must sit behind the same TLS/auth boundary as the rest.
- Ferricula's REST (8765) is internal-only in this spec. Publish 8766 (its MCP) only if external agents need direct memory access.

---

## 8. Build & deploy

```bash
# from the hyperia repo root, with ../ferricula checked out as a sibling
cp .env.example .env            # then fill ANTHROPIC_API_KEY (+ HYPERIA_SYSTEM_TOKEN for B/C)

docker compose build            # first sidecar build compiles Rust — expect minutes
docker compose up -d

docker compose ps               # both healthy?
docker compose logs -f sidecar  # watch for the bind line / Ferricula reachability
```

Publishing the sidecar image to a registry (so deploys don't recompile):

```bash
docker build -f deploy/sidecar.Dockerfile -t deepbluedynamics/hyperia-sidecar:0.11.0 .
docker push deepbluedynamics/hyperia-sidecar:0.11.0
# then in compose: replace sidecar `build:` with `image: deepbluedynamics/hyperia-sidecar:0.11.0`
```

---

## 9. Verification checklist

1. `docker compose ps` → `hyperia-ferricula` and `hyperia-sidecar` both `healthy`.
2. `curl -s http://127.0.0.1:9800/health` → `ok`.
3. `curl -s http://127.0.0.1:9800/api/status` → JSON (no client attached yet is fine).
4. Ferricula reachable from the sidecar: `docker compose exec sidecar wget -qO- http://ferricula:8765/status`.
5. MCP registration (Topology A/local): `claude mcp add --transport http hyperia http://localhost:9800/mcp` → `claude mcp list` shows it.
6. **Topology A**: launch the desktop app; confirm `app/bridge.ts` connects (sidecar logs a `/ws` upgrade) and terminal tools drive panes.
7. State persists: restart the stack, confirm `~/.hyperia/lume` index and notes survive (volume working).

---

## 10. Operational notes

- `restart: unless-stopped` on both; the sidecar tolerates Ferricula being down (graceful degradation), so ordering is best-effort via `depends_on: condition: service_healthy`.
- Resource limits: add `deploy.resources.limits` (e.g. sidecar `memory: 512M`) once you've observed steady-state usage; lume holds its index in memory.
- Logs go to stdout (`tracing`) plus `~/.hyperia/logs/` on the volume; ship stdout to your log stack.
- The existing `deploy/operations/release-build.md` covers desktop installers — unrelated to this server stack but keep both in `deploy/`.

---

## 11. Open questions / assumptions

1. **Topology choice.** Spec assumes **A** (local drop-in). If the goal is a remote/shared brain (**C**), `app/bridge.ts` must take a configurable host/port (env or `~/.hyperia/hyperia.json`) instead of the hardcoded `127.0.0.1:9800`. Small change; flag if needed and I'll spec it.
2. **Disabling the embedded sidecar.** For Topology A, the app should *not* also spawn its own sidecar on 9800 (port clash). Confirm where the spawn happens (app startup) and gate it behind a "use external sidecar" setting.
3. **Ferricula source.** Compose builds from `../ferricula`. Confirm that checkout is present in CI/deploy environments, or switch to the published `deepbluedynamics/ferricula:0.9.7` image.
4. **static/assets at runtime.** ✅ Resolved — verified embedded at compile time (`include_str!`); the Dockerfile does not copy them. (No longer open.)
5. **Multi-arch.** Are any target hosts ARM? If so, add a buildx matrix.
6. **Headless approval (B only).** A headless sidecar has no consent approver, so gated mutating calls stall at `202 Pending`. If B must perform gated operations, a headless-approval path is needed (e.g. an auto-approve policy for a trusted agent identity, or a minimal approver service) — out of scope here; flag if you need it designed.

---

## 12. Risks

- **Silent terminal no-op.** Deploying the sidecar headless (B) and expecting terminal tools to work — they won't without an attached client. Documented in §2/§3.
- **Stalled approvals (B).** Headless means no renderer to answer `/api/perms/*`; gated mutating calls hang at `202 Pending`. §2/§7.
- **Exposed port with no proxy.** The sidecar does **not** self-authenticate by bind address — binding `0.0.0.0` only logs a warning. Publishing 9800 to a routable interface without an external TLS+auth proxy exposes `/dashboard`, `/ws`, and `/api/*`. §7.
- **Skeleton-key leak.** Setting `HYPERIA_SYSTEM_TOKEN` in the container or sharing it with external agents grants full consent bypass — the opposite of protection. Leave it unset. §4.3/§6.
- **Build context mistake.** Building with `sidecar/` as context breaks the `../lume` path deps. Context must be repo root. §4.1.
