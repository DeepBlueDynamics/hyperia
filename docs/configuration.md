# Configuration

User config lives at `~/.hyperia/hyperia.json`. Edit via Settings (`Ctrl+,`) or directly in your editor.

## Full config reference

```json
{
  "config": {
    "fontSize": 16,
    "fontFamily": "Menlo, Consolas, monospace",
    "backgroundColor": "#000000",
    "foregroundColor": "#ffffff",
    "cursorColor": "#ffffff",
    "cursorShape": "BEAM",
    "shell": "",
    "shellArgs": ["--login"],
    "defaultProfile": "PowerShell",
    "agentToken": "sk-ant-...",
    "agentModel": "claude-haiku-4-5-20251001",
    "ferricula": {
      "mode": "local",
      "url": "http://localhost:8765"
    },
    "profiles": [
      { "name": "PowerShell", "config": { "shell": "pwsh.exe" } },
      { "name": "CMD", "config": { "shell": "cmd.exe" } },
      { "name": "WSL", "config": { "shell": "wsl.exe" } },
      { "name": "Claude", "config": { "shell": "cmd.exe", "shellArgs": ["/c", "claude"] } }
    ]
  }
}
```

## Key settings

### agentModel

The Claude model ID used by the Ghost agent. Set via Settings without re-entering your token.

| Value | Model |
|-------|-------|
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 (default, fast) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-opus-4-6` | Claude Opus 4.6 |

### ferricula.mode

| Mode | Behavior |
|------|----------|
| `local` | Embedded Ferricula inside sidecar (default) |
| `remote` | HTTP to external Ferricula instance at `ferricula.url` |
| `both` | Local + remote; remote used for vector search if available |

### profiles

Shell profiles appear in the new-tab dropdown. Each profile can override `shell`, `shellArgs`, `env`, and any terminal config keys.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+,` | Open Settings |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| Right-click tab | Rename, close, change profile |
| Right-click terminal | Ask Hyperia, copy, paste |
