# Spec: Per-Pane Multi-Agent Code Editor

**Status:** input for a planner — this document fixes scope, inventory, and
constraints; the planner designs the implementation.

## Goal

A code editor that lives in a Hyperia **pane** (peer of terminal panes and web
panes), one instance per pane, where **multiple agents and the human edit files
in a shared workspace**. The workspace is managed by **nemesis8 (n8)** and
mounted into each agent's container; the editor shows multiple open files and
live status (dirty/saved/who-touched-it). Agents keep editing through the
existing tool; the pane is where the human sees, reviews, and edits the same
files.

## Current state — the editor we already have (inventory)

The "multi-line editor tool" today is **Aegis-Edit**, three layers deep:

| Layer | Where | What |
|---|---|---|
| Engine | **`./aegis-edit`** (crate at repo root; path dep in `sidecar/Cargo.toml:25`) | LOPT Document + `TextEdit`. Grapheme-cluster (line,col) coordinates — can never split a codepoint/emoji. Multiple DISJOINT edits validated up front (overlap → reject, file untouched), applied back-to-front, written atomically (temp + rename). `preview=true` returns result without writing. |
| HTTP | `POST /api/edit/apply` — `sidecar/src/main.rs` `post_edit_apply` (~:2534) | Body `{path, edits:[{start_line,start_col,end_line,end_col,text}], preview?}`. Gated on the **"files" capability** (`enforce_capability`). |
| MCP tool | `apply_text_edits` — `sidecar/src/mcp.rs:2134` | External-agent surface only, behind the **`editing` door** (`doors.rs:306`). NOT currently on the ghost surface. |

Adjacent prior art to reuse, not reinvent:
- **Code-mode stickies** (`app/sticky.ts`): `filePath` = read-only syntax-highlighted
  viewer (highlight.min.js); `source:{kind:'file',path}` = editable note bound to a
  file (load on open, debounced write-back). Proof that file-bound editing UI
  already works in this app.
- **Web panes** (WebContentsView) render sidecar-served pages (`/shell`, `/guide`,
  `/agent/config`) — a served `/editor` page is a viable UI vehicle.
- **Container path translation**: `translateContainerPath` in `app/sticky.ts`
  already maps n8 container paths → host paths. The editor needs the same
  mapping, centralized (see Requirements 6).

## Permanent home (migration plan for what exists)

1. **Engine stays a standalone crate** — promote `./aegis-edit` from an ad-hoc
   path dep to a declared member of a root `[workspace]` (create the workspace
   manifest; sidecar + aegis-edit as members). It is the single write path for
   ALL programmatic edits — editor UI included — so it must not get absorbed
   into sidecar internals. Add its own README + tests as the contract.
2. **API grows beside the engine**: `/api/edit/*` becomes a small family
   (`apply` today; planner adds `read`, `open`, `status` — see below) in a new
   `sidecar/src/edit_api.rs` module rather than accreting in `main.rs`.
3. **Tool surface**: `apply_text_edits` stays the agent verb, added to the
   **ghost surface** as well (new/existing `editing` door on Surface::Ghost) so
   the built-in agent can edit too.
4. **UI**: new pane type `editor` (planner chooses served-page vs native React —
   see Open Questions), launched from the picker, pane context menus, and an
   `editor_open` tool.

## Functional requirements

1. **Per-pane instances.** Each editor pane is independent (own open-file set,
   own scroll/cursor). Multiple editor panes may view the same file.
2. **Multiple open files** per pane — a file-tab strip inside the pane; a
   simple workspace file tree or quick-open (planner picks minimal v1).
3. **Status, per file and per pane:**
   - dirty / saved / external-change (file changed on disk under us)
   - last writer attribution: which AGENT (by identity label) or the human
     last modified the file — sourced from `/api/edit/apply` callers
   - a lightweight activity feed/badge when an agent edits a file that is open
     in the pane (flash the tab; never steal focus — hard rule).
4. **Human edits and agent edits converge on one write path.** The pane's
   saves go through the same Aegis-Edit transaction API (whole-buffer replace
   is expressible as one edit), with **optimistic concurrency**: every read
   returns a revision token (content hash); every write carries the token and
   is rejected on mismatch → pane shows a conflict state (reload/overwrite
   diff). No CRDTs in v1 — rev tokens + disjoint-edit validation is the model.
5. **Live refresh:** when `/api/edit/apply` mutates a file open in any editor
   pane, the pane refreshes (SSE or the existing rpc push pattern). File
   watcher on the workspace root is the fallback for out-of-band writes.
6. **Workspace = n8-managed.** The editor operates on a workspace ROOT
   registered by nemesis8. n8 owns the mount map: host path ↔ per-container
   path. Requirements:
   - a single sidecar-side path-translation module (move/absorb
     `translateContainerPath` logic; sticky.ts becomes a consumer)
   - agents inside containers pass container paths to `apply_text_edits`;
     the sidecar normalizes to host paths before Aegis-Edit
   - the editor pane displays workspace-relative paths.
7. **Syntax highlighting** (highlight.min.js is already vendored) + line
   numbers. No LSP, no autocomplete in v1.
8. **Security:** every mutating call keeps the "files" capability gate;
   editor-pane saves ride an authenticated/system-side path like other UI
   surfaces (cf. `/api/agent/config/edit` precedent for anonymous-page actions).

## Non-goals (v1)

- No CRDT/simultaneous character-level co-editing (rev-token conflicts only)
- No LSP/diagnostics/format-on-save
- No git integration beyond showing dirty state (git lives in the terminal)
- No remote (non-mounted) file systems

## Phase skeleton for the planner to elaborate

- **P1 — engine/API:** workspace manifest for the crate; `edit_api.rs`;
  `GET /api/edit/read` (content + rev), `POST /api/edit/apply` gains `rev`
  precondition; path-translation module; change events (SSE or rpc).
- **P2 — editor pane, single file:** pane type + picker/menu entry +
  `editor_open` tool; open/edit/save with rev conflict UX; highlighting.
- **P3 — multi-file:** tab strip, quick-open, per-file status chips.
- **P4 — multi-agent status:** last-writer attribution, open-file flash on
  agent edits, per-pane activity line.
- **P5 — n8 workspace integration:** workspace registration handshake with
  nemesis8, mount-map sync, container-path normalization end-to-end test with
  two agents + human editing the same workspace.

## Open questions (planner must answer or escalate)

1. UI vehicle: sidecar-served page in a web pane (fast, matches /shell; weaker
   keyboard/focus integration) vs native React pane (first-class focus/keys;
   more renderer work). Recommendation to evaluate first: served page v1.
2. Editor widget: hand-rolled textarea+overlay (like stickies) vs vendoring
   CodeMirror 6 (proper editing UX; ~300KB). Evaluate CM6 first — multi-file
   + status wants real editor infrastructure.
3. Does n8 need per-agent write scoping (agent A read-only on dir X) in v1,
   or is the "files" capability boundary enough?
4. Rev token granularity: per-file hash vs per-file monotonic counter held by
   the sidecar (survives external writes worse). Default: content hash.
