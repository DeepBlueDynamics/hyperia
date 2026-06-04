# Configuration

Configuration lives at `~/.hyperia/hyperia.json`. Edit it directly, or let the app and agent write to it. All keys are under a top-level `config` object.

## Example

```json
{
  "config": {
    "agent": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
    "providers": {
      "anthropic": { "token": "sk-ant-...", "endpoint": "https://api.anthropic.com" },
      "openai":    { "token": "sk-...",      "endpoint": "https://api.openai.com" },
      "gemini":    { "token": "..." },
      "ollama":    { "endpoint": "http://localhost:11434", "token": "" }
    },
    "defaultProfile": "PowerShell 7.5.5",
    "profiles": [
      { "name": "My Agent", "kind": "agent",
        "config": { "shell": "cmd.exe", "shellArgs": ["/c", "claude"], "env": {} } }
    ],
    "stickyFontSize": 14,

    "fontSize": 16,
    "fontFamily": "Menlo, Consolas, monospace",
    "cursorShape": "BEAM"
  }
}
```

## The agent

The built-in **Ghost** agent picks its model from the `agent` block plus a matching `providers` entry:

- `agent.provider` — one of `anthropic`, `openai`, `gemini`, `ollama`.
- `agent.model` — the model id for that provider (e.g. `claude-sonnet-4-6`).
- `providers.<name>.token` — the API key for that provider (`ollama` needs none).
- `providers.<name>.endpoint` — optional override of the provider's base URL.

If no usable frontier provider/token is configured, the Ghost falls back to a local **Ollama** model (`gemma4:12b`). The legacy top-level keys `agentToken` / `agentModel` are still read and migrated, but the `agent` + `providers` shape above is the source of truth.

> **Ferricula** (optional external memory) is not configured here — it's resolved from the `FERRICULA_URL` environment variable (default `http://localhost:8765`) and is a no-op when unreachable. See [memory.md](memory.md).

## Shell profiles

`profiles` are the shells/agents offered in the new-pane Chooser. They are **auto-detected** at startup (PowerShell, CMD, Git Bash, and each installed WSL distro on Windows; zsh/bash/fish on Unix; plus Claude Code / Nemesis8 if present) and merged with any you add. Each profile:

```json
{ "name": "Label", "kind": "shell" | "agent",
  "config": { "shell": "<path>", "shellArgs": ["..."], "env": { } } }
```

- `kind` distinguishes user-added **custom** profiles (`shell` or `agent`) from auto-detected ones. Custom agent profiles appear under "pick an agent" in the Chooser; you can right-click a custom profile to delete it.
- `defaultProfile` names the profile used for new panes.

## Terminal appearance

Standard terminal keys are inherited from Hyper and still apply: `fontSize`, `fontFamily`, `cursorShape` (`BEAM` / `BLOCK` / `UNDERLINE`), colors, and `css` / `termCSS` overrides. `stickyFontSize` controls sticky-note text size.

## Keyboard shortcuts

Keymaps are defined per-platform in `app/keymaps/{darwin,linux,win32}.json` — edit those to rebind. Common defaults: new tab, close tab, next/previous tab, split pane, and the right-click menus on a tab (rename / close / change profile) and on the terminal (Ask Hyperia / copy / paste). Consult the keymap file for your platform for the authoritative list.
