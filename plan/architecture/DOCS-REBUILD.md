# Docs Rebuild Plan

The docs are mostly April-vintage and have drifted hard from the code. A full audit (against current source) found two cross-cutting falsehoods repeated across five+ files, plus six major features with zero documentation. This plan fixes the canonical facts first, then rebuilds each doc, then adds the missing ones.

## Step 0 — Establish canonical facts (fix once, reuse everywhere)

Two wrong stories are repeated across many docs. Settle them and propagate verbatim.

**Memory.** The built-in, default, works-out-of-the-box memory is **lume** (`sidecar/src/lume_store.rs`, `lume = { path = "crates/lume" }`): local BM25 over per-shell logs + sticky notes, persisted to `~/.hyperia/lume/`. **Ferricula** (`sidecar/src/ghost/ferricula.rs`) is an **optional external HTTP service** (Docker/remote, `FERRICULA_URL`, default `http://localhost:8765`) that **degrades to a no-op when unreachable** — there is **no ferricula crate dependency** (`sidecar/Cargo.toml:67-69`). Every doc that calls Ferricula "embedded / path-linked / SQLite / the default memory" is wrong.

**MCP transport.** Streamable **HTTP** at `http://localhost:9800/mcp` (`main.rs:1611`). There is **no `--mcp` stdio flag**. Tool count = the number of `#[tool(` in `mcp.rs` (currently ~55 — recount at write time; README/docs say 30+/50+).

**Providers.** Ghost is multi-provider — **anthropic / openai / ollama** (+gemini referenced), config shape `agent.provider` + `agent.model` + `providers.<name>.{token,endpoint}`. `agentToken`/`agentModel` are legacy migrated keys.

Deliverable: a short `docs/_canonical.md` (or a section reused by reference) carrying these three blocks so docs stop contradicting each other.

## Step 1 — Rewrites, in priority order

### P0 — actively misleading / breaks a fresh build
- **docs/getting-started.md** → full rewrite. Kills the worst landmine: "clone Ferricula alongside / it's a path dependency" (false — the path crate is `lume`; this breaks a fresh `cargo build`). Also fix `--mcp` stdio → HTTP, tool count, Node 18 → **22**, and the broken `../BUILDING.md` link (it's `docs/building.md`).
- **docs/mcp-tools.md** → full rewrite. Highest-value doc and currently the most wrong: lists nonexistent `note_*` and `memory_*` tools, wrong transport, and misses ~18 real tools (web panes, `apply_text_edits`, `shell_log_search`, `tab_image`, `sticky_note_*` incl. code notes/search/schedule, `settings_*_profile`, `terminal_new_window`/`where_pane`/`ui_key`, plus the `focus=`/`raw=` Maximus params). **Generate it from the `#[tool(description=…)]` strings in `mcp.rs`** so it can't drift again.
- **docs/architecture.md** → full rewrite. Remove the flatly-false "Ferricula = external path-linked SQLite crate" section; document the real module map incl. `lume_store.rs`, `compressor.rs`, `ghost/*`, web panes, and the HTTP MCP transport.
- **docs/configuration.md** → full rewrite. Remove the fabricated `ferricula.mode = local/remote/both` table; document the real `agent`/`providers` block, `defaultProfile`, profiles, and verify the keyboard-shortcut table against `app/keymaps/*.json`.
- **docs/ferricula.md** → replace with **docs/memory.md**. Lead with lume (the working local memory); document Ferricula as the optional external service. Drop the nonexistent `memory_recall/remember/dream/connect/status` MCP-tool list.

### P1 — stale but not breaking
- **docs/ghost-agent.md** → rewrite. Multi-provider (not Claude-only), correct memory story, add **Maximus** context compression, mention `model_catalog`/`show_picker` model selection.
- **README.md** → mostly done. ✅ MCP-over-HTTP section, ✅ memory bullet + diagram corrected. Remaining: bump "50+" to the exact count; update the doc-table link `Ferricula Memory → docs/memory.md` once renamed.
- **docs/building.md** → light edit. The CI section is stale — `build.yml` now **does** sign+notarize macOS (CSC_LINK + `mac.notarize`); add the unsigned **nightly.yml** path.

### P2 — fine as-is
- **docs/signing-apple.md** → keep. Accurate; optionally add a line that CI now consumes these as repo secrets.
- **docs/design_specification.md** → keep / light edit. Aspirational UI spec, not factually wrong; label clearly as design intent and reconcile with the shipped Chooser; add web panes + stickies to the visual model.

## Step 2 — New docs for undocumented features

Currently documented nowhere:
1. **Memory** — covered by the new `docs/memory.md` (Step 1).
2. **Web panes** — `open_web_pane` + `web_pane_*` + `terminal_web_*` (`lib/components/web-pane.tsx`). New `docs/web-panes.md` or a section in a features doc.
3. **Sticky notes / code notes** — `sticky_note_*` incl. `sticky_note_create_code` (file-linked, syntax-highlighted), search, schedule, open. New `docs/stickies.md`.
4. **Maximus** — Ollama output filtering via `focus=`/`raw=` and context compression. Folded into ghost-agent.md or its own `docs/maximus.md`.
5. **Nightly builds** — into building.md.

## Step 3 — Verification

- Each rewritten doc re-audited against code the same way (cite `file:line` for every factual claim).
- `mcp-tools.md` regenerated from `mcp.rs` so it's mechanically correct.
- Grep guard: no doc may contain `--mcp`, "embedded memory engine", `ferricula.mode`, or `note_create`/`memory_recall`.

## Execution order (suggested)

1. Step 0 canonical facts.
2. getting-started + mcp-tools (the two that actively mislead).
3. memory.md (resolves the cross-cutting memory lie).
4. architecture + configuration.
5. ghost-agent + building (light) + README finish.
6. New feature docs (web-panes, stickies, maximus).
7. Re-audit + grep guard.
