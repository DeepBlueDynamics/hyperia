# Ghost Agent

The Ghost is Hyperia's built-in AI — accessible via the chat window (right-click menu → "Ask Hyperia" or the ghost icon). She runs on Claude and has full access to your terminal sessions, memory, and notes.

## Capabilities

- **Streaming chat** with tool use — she can type commands, read screens, create notes, and search memory while responding
- **Ferricula memory** — persistent across sessions; she recalls past work, projects, and context using hybrid BM25 + vector search
- **Tool loop** — she runs tools in sequence, reads results, and continues until the task is done or she signals completion
- **Stop / continue** — press Escape or click Stop to interrupt; click Continue to resume

## Tools available to Ghost

Ghost has access to all tools in the [MCP Tools Reference](mcp-tools.md), plus:

- `tool_search` — discover tools by keyword
- `tool_create` — define new tools at runtime (shell scripts, Python, Node)
- `file_read` / `file_write` — direct file system access
- `web_fetch` — HTTP requests

## Model

Default: **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`)

Change model in Settings (`Ctrl+,`) without re-entering your API key. Available models:
- Claude Haiku 4.5 (fast, default)
- Claude Sonnet 4.6
- Claude Opus 4.6

Model takes effect on the next message.

## Memory

Ghost uses [Ferricula](ferricula.md) for persistent memory. On each message, she:

1. Searches memory for relevant context (BM25 + vector + keyword)
2. Injects recalled memories into her system prompt
3. Can explicitly remember, connect, or dream via memory tools

## Window behavior

- Closing the ghost window sends a signal to the agent — she finishes her current tool call and stops
- The window can be reopened and the conversation continues from where it left off

## Factory reset

Settings → Factory Reset clears all local Ferricula memory and resets the agent state. This is irreversible.
