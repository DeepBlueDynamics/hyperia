# Hint: Add ferricula MCP server

Hyperia should connect to the ferricula cognitive memory engine as an MCP server. This gives the terminal agent access to thermodynamic memory — remember, recall, dream, inspect, connect, and all the other cognitive tools.

## What to add to `.mcp.json`

Add a `"ferricula"` entry alongside the existing `"hyperia"` sidecar:

```json
{
  "mcpServers": {
    "hyperia": {
      "command": "C:\\Users\\kordl\\Code\\Gnosis\\hyperia\\sidecar\\target\\debug\\hyperia-sidecar.exe",
      "args": ["--mcp"]
    },
    "ferricula": {
      "type": "stdio",
      "command": "python",
      "args": [
        "C:/Users/kordl/Code/Gnosis/ferricula/tools/ferricula-mcp.py"
      ],
      "env": {
        "NO_COLOR": "1",
        "FERRICULA_SURFACE": "all",
        "CHONK_URL": "http://nemesis:8080",
        "FERRICULA_URL": "http://localhost:8773"
      }
    }
  }
}
```

## What this gives you

The ferricula MCP exposes these tool groups:

**Cognitive** (memory operations):
- `remember` — store text as a thermodynamic memory (auto-embedded via chonk)
- `recall` — semantic search over memories
- `reflect` — introspect on memory state
- `observe` — observe files/visuals (keystoned by default)
- `inspect` — examine a specific memory's fidelity, decay, graph connections
- `connect` / `disconnect` — create/remove semantic or causal edges between memories
- `neighbors` — traverse the memory graph from a node
- `status` — memory counts, graph stats
- `identity` — agent identity (hexagram, zodiac, emotional baseline)
- `health` — service health check

**System** (dream/clock operations):
- `dream` — trigger a manual dream cycle (decay, consolidation, pruning)
- `offer_entropy` — feed entropy bytes to the clock, triggers radio-modulated dream
- `clock` — read clock state (reservoir, dreams, radio status)
- `checkpoint` — force a durable checkpoint to disk
- `keystone` — promote a memory to keystone (immune to decay)
- `query` — raw SQL against the vector engine
- `terms` — list prime tree terms
- `discover` — scan ports for running ferricula instances
- `list_characters` — list all discovered agents with names and ports
- `inversion_check` — round-trip fidelity test on a memory vector

## Notes

- The MCP server is Python (`ferricula-mcp.py`) but the engine is Rust
- `FERRICULA_URL` points to the HTTP service (Steve Jobs on 8773, Trek on 8764)
- `CHONK_URL` is the embedding service on nemesis:8080
- Vectors never touch the LLM — text goes in, text comes out
- The `discover` tool can auto-find all running instances
