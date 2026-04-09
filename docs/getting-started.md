# Getting Started

## Prerequisites

**All platforms:**
- Node.js >= 18
- Yarn (`npm install -g yarn`)
- Rust stable (`rustup` — https://rustup.rs)

**Windows:** Visual Studio Build Tools with C++ workload

**macOS:** `xcode-select --install`

**Linux (Debian/Ubuntu):**
```bash
sudo apt install build-essential libx11-dev libxkbfile-dev python3
```

Hyperia has a path dependency on **Ferricula** (the memory engine). Clone it alongside:
```
C:/Code/Gnosis/ferricula/   ← or update sidecar/Cargo.toml path
C:/Code/Gnosis/hyperia/
```

---

## Development

```bash
git clone https://github.com/DeepBlueDynamics/hyperia.git
cd hyperia
yarn install

cd sidecar
cargo build
cd ..

yarn run dev
```

The sidecar starts automatically with the Electron app on port 9800.

---

## Release Build (Windows)

See [BUILDING.md](../BUILDING.md) for the full release process including signing.

Quick version:
```bat
cd sidecar && cargo build --release && cd ..
set AZURE_CLIENT_SECRET=<your secret>
yarn run dist
```

Output: `dist/Hyperia-X.Y.Z-x64.exe`

---

## First Launch

1. Open Hyperia
2. Press `Ctrl+,` to open Settings
3. Enter your Anthropic API key and select a model (Claude Haiku 4.5 is the default)
4. Right-click any tab or press the ghost icon to open the agent chat

---

## MCP Server (for Claude Code, Codex, etc.)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hyperia": {
      "command": "path/to/hyperia-sidecar.exe",
      "args": ["--mcp"]
    }
  }
}
```

The sidecar exposes 30+ tools for terminal control, agent status, telemetry, notes, and memory.
