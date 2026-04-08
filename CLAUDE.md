# Hyperia — Agent Instructions

## Stopping or redirecting Hyperia

If Hyperia is stuck, running something unexpected, or you need to redirect it, **send Escape first**:

```
terminal_ui_key  key="Escape"
```

This cancels the current agent action or clears the active input. Use it before sending new commands to a tab that may be mid-execution.

To interrupt a running shell command (e.g. a hung process), send `Ctrl+C`:

```
terminal_keys  keys="\x03"
```

## Building

See `BUILDING.md` for the full release build process.
