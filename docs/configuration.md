# Configuration

Configuration lives at **`~/.hyperia/hyperia.json`**. All settings sit under a top-level `config` object; the file may also carry top-level `plugins`, `localPlugins`, and `keymaps` keys. The typed source of truth is `typings/config.d.ts` (schema: `app/config/schema.json`).

## How to change any setting (start here)

Three equivalent ways — pick by where you are:

1. **MCP tool** (agents inside or outside Hyperia):
   ```
   settings_set  {"path": "config.fontSize", "value": 14}
   settings_get  {"path": "config.fontSize"}        // read one value
   settings_get  {"path": ""}                        // dump the whole config
   ```
   Paths are dot-separated from the file root, so every setting below is `config.<key>` (nested: `config.colors.red`, `config.lockout.duration_secs`). Intermediate objects are created as needed; pass `null` to delete a key.

2. **CLI** (any terminal, after `hyperia login`):
   ```
   hyperia call settings_set '{"path":"config.cursorShape","value":"BLOCK"}'
   hyperia call settings_get '{"path":"config.colors"}'
   ```

3. **Edit the file** — change `~/.hyperia/hyperia.json` with any editor; the app watches it.

**When changes apply:** most settings — colors, fonts, cursor, padding, CSS — hot-reload into the running app within a couple of seconds; no restart. Settings that need a full app restart: `webGLRenderer`, `useConpty`, `webLinksActivationKey`, `useExternalSidecar`, `updateChannel`, and `shell`/`shellArgs` for *already-open* panes (new panes pick them up immediately).

**Consent:** `settings_set` is a state-changing, capability-gated call — an agent's first write may raise a consent prompt for the human. Reads never do.

## Changing colors

The terminal's 16-color ANSI palette is the `colors` map. Every key takes any CSS color (`#hex`, `rgb()`, `hsl()`, …):

```
black    red    green    yellow    blue    magenta    cyan    white
lightBlack  lightRed  lightGreen  lightYellow  lightBlue  lightMagenta  lightCyan  lightWhite
```

One color:

```
settings_set {"path": "config.colors.red", "value": "#ff5c57"}
```

Whole palette at once:

```
settings_set {"path": "config.colors", "value": {"black": "#000000", "red": "#ff5c57", "green": "#5af78e", "yellow": "#f3f99d", "blue": "#57c7ff", "magenta": "#ff6ac1", "cyan": "#9aedfe", "white": "#f1f1f0", "lightBlack": "#686868", "lightRed": "#ff5c57", "lightGreen": "#5af78e", "lightYellow": "#f3f99d", "lightBlue": "#57c7ff", "lightMagenta": "#ff6ac1", "lightCyan": "#9aedfe", "lightWhite": "#eff0eb"}}
```

The non-palette color settings:

| Key | What it colors |
|-----|----------------|
| `backgroundColor` | terminal background (opacity only on macOS) |
| `foregroundColor` | default text |
| `cursorColor` | cursor background |
| `cursorAccentColor` | text under a BLOCK cursor |
| `selectionColor` | selected text |
| `borderColor` | window + tab borders |

All hot-reload. Colors can also be overridden **per profile** (see below) so, e.g., an SSH profile can run red.

## Full settings reference

### Text & font

| Key | Type / values | Notes |
|-----|---------------|-------|
| `fontSize` | number (px) | all tabs |
| `fontFamily` | string | with fallbacks, e.g. `"Menlo, Consolas, monospace"` |
| `fontWeight` / `fontWeightBold` | `'normal'`/`'bold'`/`'100'..'900'` | normal vs bold glyphs |
| `lineHeight` / `letterSpacing` | number (relative) | |
| `disableLigatures` | boolean | `false` allows font ligatures |
| `uiFontFamily` | string | chrome/UI font (not terminal text) |
| `stickyFontSize` | number | sticky-note text size |

### Cursor

| Key | Type / values |
|-----|---------------|
| `cursorShape` | `'BEAM'` \| `'UNDERLINE'` \| `'BLOCK'` |
| `cursorBlink` | boolean |
| `cursorColor` / `cursorAccentColor` | CSS color |

### Terminal behavior

| Key | Type / values | Notes |
|-----|---------------|-------|
| `scrollback` | number | lines of history kept per pane |
| `copyOnSelect` | boolean | selection auto-copies |
| `quickEdit` | boolean | right-click copies/pastes (Windows default; disables context menu) |
| `macOptionSelectionMode` | `'vertical'` \| `'force'` | Option-drag column select vs forced selection |
| `disableMouseReporting` | boolean | kill mouse tracking entirely |
| `bell` | `'SOUND'` \| `false` | with `bellSound` (base64) / `bellSoundURL` (file path) overrides |
| `imageSupport` | boolean | Sixel + iTerm2 inline images |
| `screenReaderMode` | boolean | NVDA etc. |
| `webLinksActivationKey` | `'ctrl'`/`'alt'`/`'meta'`/`'shift'`/`''` | modifier to click links (restart needed) |
| `sessionLogging` | boolean | per-tab logs into `~/.hyperia/logs/` |
| `preserveCWD` | boolean | splits/tabs inherit the working directory |

### Shell & session

| Key | Type | Notes |
|-----|------|-------|
| `shell` | string (path) | root default; empty = login shell |
| `shellArgs` | string[] | default `['--login']`; drop it on Windows |
| `env` | object | extra environment variables |
| `workingDirectory` | string (absolute) | startup directory |
| `defaultProfile` | string | profile for first-ever picks — note the new-pane picker pre-fills your **last-used** shell, not this |
| `profiles` | array | see Shell profiles below |
| `shellIntegration` | boolean | OSC shell integration (prompt/command marks) |
| `useConpty` | boolean | Windows ConPTY (restart needed) |

### Window & UI

| Key | Type / values | Notes |
|-----|---------------|-------|
| `windowSize` | `[width, height]` | initial size in px |
| `padding` | string (CSS shorthand) | terminal padding |
| `showWindowControls` | `true`/`false`/`'left'`/`''` | min/max/close buttons (Win/Linux) |
| `showHamburgerMenu` | boolean/`''` | Linux menu button |
| `css` / `termCSS` | string | raw CSS injected into the window / the terminal |
| `webGLRenderer` | boolean | `false` = canvas (slower, supports transparency; restart needed) |
| `modifierKeys` | `{altIsMeta, cmdIsMeta}` | |
| `styleTheme` | object | saved pane-style theme (see `style_*` tools) |

### Web panes

| Key | Values | Notes |
|-----|--------|-------|
| `webPaneLinkTarget` | `'tab'` (default) \| `'split-right'` \| `'split-down'` | where `target="_blank"` links open (OAuth pop-ups always use the system browser) |
| `webPaneFocusOnNavigate` | boolean (default `false`) | `false` = an agent navigating a web pane never drags your view to it |

### Updates & platform

| Key | Values |
|-----|--------|
| `updateChannel` | `'stable'` \| `'canary'` |
| `disableAutoUpdates` | boolean |
| `autoUpdatePlugins` | boolean or interval string (`'1d'`, `'2h'`) |
| `defaultSSHApp` | boolean — register as ssh:// handler |
| `useExternalSidecar` | boolean — connect to an externally-managed sidecar on 9800 instead of spawning one (also `HYPERIA_USE_EXTERNAL_SIDECAR` env; see `deploy/`) |

### Hyperia-specific blocks

| Key | Shape | What it does |
|-----|-------|--------------|
| `agent` | `{provider, model}` | the built-in Ghost agent's brain — provider is `anthropic`/`openai`/`gemini`/`ollama` |
| `providers` | `{<name>: {token, endpoint?}}` | API keys per provider (`ollama` needs no token) |
| `lockout` | `{enabled?: bool, duration_secs?: number}` | how long after a human keystroke agent writes to that pane stay queued (default enabled, 15s; `enabled: false` disables the guard) |
| `maximus` | `{disabled: bool, ...}` | the local output-compression/extraction layer (`disabled: true` = raw passthrough; model override via `maximus_model` / `MAXIMUS_MODEL`) |
| `tts` | `{recipient?: string}` | callsign spoken summaries address (default `"base"`) |

## The agent (Ghost)

The built-in **Ghost** agent picks its model from the `agent` block plus a matching `providers` entry:

- `agent.provider` — one of `anthropic`, `openai`, `gemini`, `ollama`.
- `agent.model` — the model id for that provider (e.g. `claude-sonnet-4-6`).
- `providers.<name>.token` — the API key (`ollama` needs none).
- `providers.<name>.endpoint` — optional base-URL override.

With no usable frontier provider/token, the Ghost falls back to local Ollama (`gemma2:9b`). Legacy top-level `agentToken`/`agentModel` are still migrated, but `agent` + `providers` is the source of truth.

> **Ferricula** (optional external memory) is not configured here — it resolves from the `FERRICULA_URL` env var (default `http://localhost:8765`) and is a no-op when unreachable. See [memory.md](memory.md).

## Shell profiles

`profiles` are the shells/agents offered in the new-pane Chooser. They are **auto-detected** at startup (PowerShell, CMD, Git Bash, each WSL distro on Windows; zsh/bash/fish on Unix; plus Claude Code / Nemesis8 if present) and merged with yours. Each profile:

```json
{ "name": "Label", "kind": "shell" | "agent",
  "config": { "shell": "<path>", "shellArgs": ["..."], "command": "ssh somewhere", "env": {} } }
```

- `config` accepts **any appearance/behavior key from the reference above** as a per-profile override (colors, fontSize, padding, …) — root config is the default, the profile wins for its panes.
- `command` runs after the shell starts (e.g. `ssh nemesis`); `baseShell` records what it runs inside.
- `pathTranslate` (`{kind: 'identity'|'wsl'|'docker-mount', hostPrefix, containerPrefix}`) maps host paths for WSL/container shells.
- `kind` marks user-added custom profiles (`shell` or `agent`); custom agent profiles appear under "pick an agent" in the Chooser.
- `defaultProfile` names the fallback for first-ever picks; the picker otherwise remembers your last-used shell.

## Keyboard shortcuts

Two layers:

- **User overrides** — the top-level `keymaps` object in `hyperia.json`: `{"window:devtools": "cmd+alt+o"}`. This is the right place for personal rebinds.
- **Defaults** — per-platform in `app/keymaps/{darwin,linux,win32}.json` (authoritative list of bindable command names).

## Plugins (legacy)

Top-level `plugins` / `localPlugins` arrays install Hyper-ecosystem npm plugins (`hyperia plugins <cmd>` manages them). Largely inherited machinery — most Hyperia capability ships in the app itself.
