# Ferricula Memory

Ferricula is Hyperia's embedded memory engine. It runs inside the sidecar process and persists memories to `~/.hyperia/memory/`.

## How it works

Memories are stored as records with:
- **Text** — the memory content
- **Importance** (0–1) — how significant this memory is
- **Keystone** flag — marks foundational memories that always surface
- **Emotion** tag — affective label
- **Channel** — source context (e.g. `ghost-history`, `user`)
- **BM25 index** — for keyword search
- **Embedding vector** — for semantic similarity search (requires remote Shivvr instance)

## Recall

Ghost recall runs three stages:

1. **BM25 text search** — normalized scores against the query
2. **Vector scan** — cosine similarity across all embeddings (if vectors available)
3. **Keyword backfill** — fills remaining slots with keyword matches

Results are ranked by a combined score with importance and keystone boosts. Ghost-history memories are filtered by channel to avoid surfacing unrelated conversation history.

## Identity

On first launch, Ferricula casts an I Ching hexagram to derive the agent's identity. The hexagram seeds an ECC keypair and sets the agent's name and archetype. This identity is stored in `~/.hyperia/memory/identity.json` and persists across sessions.

## Memory tools

| Tool | Description |
|------|-------------|
| `memory_recall` | Search by query — returns ranked memory texts |
| `memory_remember` | Store a new memory |
| `memory_dream` | Consolidate recent memories, activate archetypes |
| `memory_connect` | Link two memory IDs semantically |
| `memory_status` | View identity, heat level, memory count |

## Remote mode (Shivvr)

For vector search, configure a remote Ferricula/Shivvr instance:

```json
{
  "config": {
    "ferricula": {
      "mode": "both",
      "url": "http://your-shivvr-host:8765"
    }
  }
}
```

In `both` mode, local BM25 always runs. Remote vectors augment the results when available. If the remote returns no vectors, a warning is logged and local-only results are used.

## Factory reset

Settings → Factory Reset deletes `~/.hyperia/memory/` entirely and resets agent state. Identity will be re-cast on next launch.
