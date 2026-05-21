# v0.10.9 — DRAFT (do not publish yet)

> ⚠️ Draft. Antigravity is implementing the OllamaProvider structured + parallel candidate upgrade per `../implementation_plan.md`. When that lands and tests pass, replace the `[in flight]` block below with the final feature description, then ship.

## Highlights

### Local model reliability — structured JSON + parallel candidates  *[in flight, Antigravity]*

`OllamaProvider::stream` now constrains Ollama's output to a strict JSON schema (`thought` + optional `tool_call` + optional `reply`) via Ollama's `format` field, and runs **N=3 parallel candidate generations** at different temperatures (0.2 / 0.7 / 0.9). The first stream whose JSON validates against the active tool schema wins; the rest are aborted via `tokio::select!` to free GPU memory.

Why it matters: in v0.10.8, small local models (gemma4:e2b, etc.) routinely freelanced — inventing `google:search`, refusing to acknowledge prior conversation context, or just emitting tool-call-shaped prose without firing a real call. Schema-constrained decoding eliminates the freelance path. Parallel sampling at varied temperatures gives at least one candidate room to thread the needle on hard prompts.

Implementation scope is contained to `provider.rs`. `agent.rs` and `api.rs` are unchanged — the structured response is translated back into the same `ProviderEvent` stream (`TextDelta` / `ToolCallStart` / `ToolCallDelta` / `ToolCallEnd` / `MessageStop`) the agent loop already consumes.

### Other fixes since v0.10.8

- **`--bind <ip>` flag + `HYPERIA_BIND` env var** (`5ae64a2a`) — sidecar can now listen on `0.0.0.0` (or any specific IP) for LAN-reachable MCP. Default stays `127.0.0.1`. Replaces the userland Python forwarder workaround that was needed to expose the sidecar across machines. When bound to a non-loopback address, the sidecar emits a startup WARN — Hyperia's tools are full RCE, so the operator is told they're now exposed.

- **Legacy ghost.ts BrowserWindow deleted** (`acba2a2d`, 1289 → 53 lines) — the agentic chat surface is fully unified on the shell pane (sidecar-served HTML at `/shell`, hosted in a Hyperia `webUrl` pane). The legacy IPC channel still routes — `Ask Hyperia` menu entries open the shell pane in the focused window. Reset/continue/auto-reset/window.onerror ported to the shell before deletion so no regressions vs the old window.

- **Stateless MCP transport** (`3ee2f446`) — `rmcp::StreamableHttpServerConfig::stateful_mode = false`. Sidecar restarts (hot-swap, crash + respawn, fresh install) no longer break Claude Code's MCP client. Previously every restart returned HTTP 404 on every call until the user manually `/mcp` → Reconnect; now restarts are invisible.

- **Slow MCP calls fixed** (`0a043c79`) — `get_screen` 404 was emitting WARN through the shared tracing pipeline; a background poller asking for a long-closed tab generated 858/1000 log entries and serialized real MCP calls behind log I/O. Demoted to `debug!`. Throughput restored.

- **`.deb` postinst sets chrome-sandbox setuid** (`7782331e`) — fresh Ubuntu 24.04 installs of v0.10.8 crashed immediately with `FATAL setuid_sandbox_host.cc:166`. Electron-builder doesn't apply the setuid bit by default; the .deb's `after-install` script now runs `chown root:root && chmod 4755 /opt/Hyperia/chrome-sandbox`. Also fixed the broken `/usr/local/bin/hyperia` symlink that pointed at a non-existent path.

- **`install.sh` Linux branch** (`6e723b18`) — `site/install.sh` now detects dpkg-based systems and downloads + installs the `.deb` (with apt-get fallback), or falls back to the universal `.AppImage`. Previously the Linux branch was a hardcoded "Linux builds are not yet available" message dating to v0.5.x. **NOTE:** the script in this repo is fixed; the public copy at `hyperia.nuts.services/install.sh` still needs to be redeployed (task #48).

## Migration notes

- **Conversation memory** is now reset on shell-pane reopen if the sidecar still thinks a prior agent run is in flight. This prevents stuck sessions but means a planned "leave it running in the background then come back" workflow won't survive a refresh — by design, since the in-flight run is from a previous pane lifecycle.
- **`Ask Hyperia` menu entries** now open the shell pane instead of the legacy 520×700 popup window. Visual change; functional parity confirmed.
- **`/opt/Hyperia/chrome-sandbox` permission fix** is applied automatically on `.deb` install. Existing v0.10.8 installs that already worked around the bug manually can leave their `4755` chmod in place — no conflict.

## Signing status

- **Windows `.exe`** — Signed via Azure Trusted Signing (publisher: DeepBlue Dynamics LLC). Built locally.
- **macOS `.dmg` / `.zip` (x64 + arm64)** — Developer ID Application signed + notarized.
- **Linux `.deb` + `.AppImage`** — Unsigned (typical for these formats).

## Known issues / open follow-ups

- Task #48 — `site/install.sh` deploy to `hyperia.nuts.services` still pending.
- `OPEN` issues #62-66 (Maximus stack: Streamable HTTP proxy, tool-interception list, status tool, settings UI) — not part of this release; tracked separately.

🤖 Drafted with [Claude Code](https://claude.com/claude-code), co-developed with Antigravity (Gemini 3.5 Flash) over shared workspace pane c.
