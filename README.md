![Hyperia](assets/hyperia.png)

Hyperia is an agent-native terminal emulator. Forked from [Hyper](https://github.com/vercel/hyper) and extended with a Rust sidecar, it turns the terminal into a first-class platform for AI orchestration. Agents connect over the Model Context Protocol (MCP) and operate terminal sessions as peers — opening tabs, splitting panes, running commands, reading screens, and reporting status — while the human stays in control at all times.

Built by [Deep Blue Dynamics](https://deepbluedynamics.com).

---

## Highlights

- **Agent-native MCP server**
- **Built-in agent harness**
- **Markdown document rendering**
- **Shell integration**
- **Shell profiles**
- **Pane Pulse (agent watchdog)**
- **Human-in-control by design**
- **Telemetry dashboard**
- **Stickys (notes)**

### Screenshot

![Hyperia Screenshot](assets/two.png)

---

## Connect an agent (MCP over HTTP)

While Hyperia is running, the sidecar exposes its MCP server over **streamable HTTP**:

- **Default Endpoint**: `${HYPERIA_MCP_URL:-http://localhost:9800/mcp}` (`http://host.docker.internal:9800/mcp` for Docker, `http://host.containers.internal:9800/mcp` for Podman).
- **Authentication Scope**: Read operations (`status`, `screen`, etc.) work **anonymously**. Write/mutation operations require authorization via `HYPERIA_AGENT_TOKEN` (automatically injected inside Hyperia panes).
- **Token Management**: Run `hyperia login [name]` (or `hyperia doctor` / `hyperia mcp`) to check, mint, or set `HYPERIA_AGENT_TOKEN` for agents running outside Hyperia.

### Claude Code

```bash
claude mcp add --transport http hyperia "${HYPERIA_MCP_URL:-http://localhost:9800/mcp}" --header "Authorization: Bearer ${HYPERIA_AGENT_TOKEN}"
```

### OpenAI Codex

```bash
codex mcp add hyperia --url "${HYPERIA_MCP_URL:-http://localhost:9800/mcp}" --bearer-token-env-var HYPERIA_AGENT_TOKEN
```

### Grok

```bash
grok mcp add --transport http hyperia "${HYPERIA_MCP_URL:-http://localhost:9800/mcp}" --header "Authorization: Bearer ${HYPERIA_AGENT_TOKEN}"
```

### Google Antigravity

```bash
agy mcp add --header "Authorization: Bearer ${HYPERIA_AGENT_TOKEN}" hyperia "${HYPERIA_MCP_URL:-http://localhost:9800/mcp}"
```

### Other clients

Any client supporting MCP streamable-HTTP can connect to `${HYPERIA_MCP_URL:-http://localhost:9800/mcp}` with an `Authorization: Bearer ${HYPERIA_AGENT_TOKEN}` header for write access. See [docs/mcp-tools.md](docs/mcp-tools.md) for the full tool catalog.

---

## Quick start

### Install prebuilt binaries

**macOS / Linux:**
```bash
curl -fsSL https://hyperia.nuts.services/install.sh | sh
```

**Windows (PowerShell):**
```powershell
powershell -c "irm https://hyperia.nuts.services/install.ps1 | iex"
```

*Prebuilt, signed release installers and nightly builds are also available on the [Releases](https://github.com/DeepBlueDynamics/hyperia/releases) page.*

### Build from source

```bash
git clone https://github.com/DeepBlueDynamics/hyperia.git
cd hyperia
yarn install

cd sidecar && cargo build && cd ..

yarn start
```

See [docs/developing.md](docs/developing.md) for prerequisites and full build instructions.

---

## Customization

Hyperia can be customized manually via `~/.hyperia/hyperia.json` or programmatically by any connected agent.

Through Hyperia's MCP tools (such as `settings_set` and `settings_get`), any connected agent (Claude, Codex, Antigravity, Grok, etc.) can inspect and modify terminal settings in real time:

- **Colors & Themes**: Change background/foreground colors, cursor styles, and color palettes (`config.backgroundColor`, `config.foregroundColor`, `config.cursorColor`).
- **Typography & Profiles**: Adjust font sizes (`config.fontSize`), change font families, or switch default shell profiles on the fly.
- **Custom Styling & Rendering**: Create custom UI styles (`style_create`), floating notes (`sticky_note_create`), and render rich markdown documents with live-reloading highlights (`render`).

See [docs/configuration.md](docs/configuration.md) for full configuration schema details.

---

## Architecture

```
Electron (UI + PTY sessions)
    │
    │── WebSocket bridge ──▶ hyperia-sidecar (Rust, :9800)
                                  │
                                  ├── HTTP API (terminal, agent, notes, telemetry)
                                  ├── MCP server (streamable HTTP at /mcp, 63 tools)
                                  ├── Built-in agent harness (streaming, tool loop)
                                  ├── lume — local BM25 over shell logs + notes
                                  │     └── ~/.hyperia/lume/
                                  ├── Ferricula client (optional external memory service)
                                  └── Telemetry + dashboard
```

---

## Troubleshooting

### Authentication & Token Principles
1. **Inside Hyperia**: Every terminal pane spawned inside Hyperia automatically inherits `HYPERIA_AGENT_TOKEN` in its environment. Simply launch your CLI tool inside a Hyperia pane, and the environment token is passed automatically.
2. **Outside Hyperia (Bare-Metal / External Shell)**: Mint a persistent identity using `hyperia login <name>` or the `request_token` MCP tool (no credentials required), then export `HYPERIA_AGENT_TOKEN` in your shell profile (`~/.bashrc`, `~/.zshrc`). **Never bake literal token strings into configuration files.**

### Client Caveats
- **Claude Code**:
  - **Project Scope Overrides Global**: Project-scoped entries (`.mcp.json`) take precedence over user/global configurations. If a `.mcp.json` file exists in your working directory, global config changes will not apply.
  - **Header Lifecycle**: MCP headers are evaluated only when the session starts. Running `/mcp` reconnect inside an active session will not reload updated headers — restart the `claude` CLI process instead.
  - **Unset Variable Fallback**: Claude Code expands `${HYPERIA_AGENT_TOKEN}` in headers. If `HYPERIA_AGENT_TOKEN` is unset, it sends the literal string `${HYPERIA_AGENT_TOKEN}`.
- **OpenAI Codex**: Uses `bearer_token_env_var` in `--url` HTTP mode to read the token at runtime. TOML files do not expand arbitrary environment variables in string literals.
- **Grok**: Add `--scope project` to write config to `./.grok/config.toml` instead of global `~/.grok/config.toml`.

### Manual Configuration File Snippets

**Claude Code (`.mcp.json`):**
```json
{
  "mcpServers": {
    "hyperia": {
      "type": "http",
      "url": "${HYPERIA_MCP_URL:-http://localhost:9800/mcp}",
      "headers": {
        "Authorization": "Bearer ${HYPERIA_AGENT_TOKEN}"
      }
    }
  }
}
```

**OpenAI Codex (`~/.codex/config.toml`):**
```toml
[mcp_servers.hyperia]
url = "http://localhost:9800/mcp"
bearer_token_env_var = "HYPERIA_AGENT_TOKEN"
```

**Google Antigravity & Grok (`mcpServers` object in settings):**
```json
{
  "mcpServers": {
    "hyperia": {
      "serverUrl": "${HYPERIA_MCP_URL:-http://localhost:9800/mcp}",
      "headers": {
        "Authorization": "Bearer ${HYPERIA_AGENT_TOKEN}"
      }
    }
  }
}
```

### macOS File-Access Prompts

The first time an agent or CLI tool accesses protected directories (such as Documents, Desktop, or Downloads), macOS may display a system privacy prompt requesting permission. This is triggered by macOS's Transparency, Consent & Control (TCC) system, which prompts per application and per directory.

The prompt references the parent terminal application (e.g., Hyperia or Terminal.app) rather than the individual agent process. Granting permission allows access to files in that location; permissions can be managed or revoked at any time in **System Settings → Privacy & Security → Files and Folders**.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Developing Hyperia](docs/developing.md) | Build from source, prerequisites, and dev environment |
| [MCP Tools](docs/mcp-tools.md) | Complete tool reference |
| [Built-in Agent Harness](docs/ghost-agent.md) | Built-in assistant — models, memory, behavior |
| [Configuration](docs/configuration.md) | Config file reference and keyboard shortcuts |
| [Memory & Search](docs/memory.md) | Local search (lume) + optional external recall (Ferricula) |
| [Architecture](docs/architecture.md) | Codebase structure and component overview |
| [Building](docs/building.md) | Release builds — Windows (Azure Trusted Signing) and macOS |
| [Apple Signing](docs/signing-apple.md) | macOS code signing and notarization |

---

## License

BSD 2-Clause — see [LICENSE](LICENSE).

Based on [Hyper](https://github.com/vercel/hyper) by Vercel.
