# MCP Tools Reference

Hyperia exposes these tools via its MCP server (`hyperia-sidecar --mcp`) and HTTP API.

## Addressing

Sessions are organized as **windows > tabs > panes**. Most tools accept optional `window` (index), `tab` (name), and `pane` (label `"a"`, `"b"`, etc.) parameters. Omit all three to target the focused window's active pane.

---

## Terminal Control

| Tool | Description |
|------|-------------|
| `terminal_keys` | Type keystrokes into a pane (`\n` Enter, `\t` Tab, `\x03` Ctrl+C, `\x1b` Esc) |
| `terminal_run` | Run a shell command, wait for output, return screen content |
| `terminal_screen` | Read current screen content of a pane as text |
| `terminal_status` | List all windows/tabs/panes with IDs, dimensions, PIDs |
| `terminal_split` | Split the focused pane (horizontal/vertical) |
| `terminal_focus` | Switch focus to a pane by window/tab/pane address |
| `terminal_close` | Close the focused pane |
| `terminal_new_tab` | Open a new tab with optional startup command |
| `terminal_rename` | Rename a tab |
| `tab_snapshot` | Read all pane screens at once |
| `shell_state` | Detect pane state: idle, dialog, running, or empty |
| `shell_confirm` | Auto-handle common prompts (trust dialogs, y/n confirmations) |

---

## Agent

| Tool | Description |
|------|-------------|
| `agent_status` | Set status light on a tab (connected, working, label text, human %) |
| `auto_describe` | Use local Ollama to describe what a pane is doing |

---

## Notes (Stickys™)

| Tool | Description |
|------|-------------|
| `note_create` | Create a floating sticky note (`text`, optional `x`, `y`, `width`, `height`) |
| `note_list` | List all notes — returns id + first 80 chars of each |
| `note_close` | Hide a note without deleting it |
| `note_update` | Edit the text of an existing note (live-updates open window) |
| `note_delete` | Permanently delete a note |

---

## Memory (Ferricula)

| Tool | Description |
|------|-------------|
| `memory_recall` | Search memory by query (hybrid BM25 + vector + keyword) |
| `memory_remember` | Store a memory with importance (0–1), emotion tag, keystone flag |
| `memory_dream` | Trigger memory consolidation and archetype activation |
| `memory_connect` | Create a semantic edge between two memories |
| `memory_status` | View identity, hexagram, heat level, memory count |

---

## Meta-tools (Ghost agent only)

| Tool | Description |
|------|-------------|
| `tool_search` | Find available tools by keyword |
| `tool_create` | Create a new tool at runtime — shell script or inline command |

---

## Observability

| Tool | Description |
|------|-------------|
| `sidecar_logs` | Read recent sidecar log output |
| `hyperia_version` | Get sidecar and Electron app versions |
| `telemetry_toggle` | Enable/disable telemetry for a pane |
| `telemetry_snapshot` | Get current telemetry metrics |
| `telemetry_record` | Record a custom telemetry event |
| `telemetry_reset` | Clear telemetry counters |
| `dashboard_widgets` | Configure dashboard widget layout |
| `style_list` / `style_create` / `style_delete` | Manage visual themes |
