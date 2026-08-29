# Workspace file format

A **workspace** is a named, versioned JSON snapshot of the whole Hyperia app:
every window's geometry plus its tabs, splits, terminal panes, and web panes.
Saved workspaces live one file per workspace at
`~/.hyperia/workspaces/<name>.json`; an **export** is the same format written
to a path of your choosing, and **import** brings such a file (or a legacy
layout blob, see [Migration](#migration)) back into the library. All writes
are atomic (temp file + rename).

Produced and consumed by the `workspace_*` MCP tools and
`hyperia workspace <save|list|preview|restore|export|import|delete|rename>`.
The Rust source of truth is `sidecar/src/workspace.rs`.

## Top level

```jsonc
{
  "kind": "hyperia-workspace",   // required discriminator, always this string
  "schemaVersion": 1,            // integer; see Versioning
  "name": "deploy-day",          // the workspace's display/library name
  "savedAt": "2026-08-28T21:04:11Z", // RFC3339 UTC save timestamp
  "appVersion": "0.17.50",       // optional; Hyperia version that wrote it
  "windows": [ /* WorkspaceWindow, one per OS window; at least one */ ],
  "stickys": [ /* optional StickyRef list; reserved, populated from chunk #170 */ ]
}
```

## `windows[]` — WorkspaceWindow

| Field | Type | Meaning |
|---|---|---|
| `geometry` | Geometry | The OS window's bounds and chrome state at save time. |
| `layout` | object | The renderer layout blob (below). |

### Geometry

```jsonc
{
  "x": 10, "y": 20,              // screen position (px)
  "width": 1400, "height": 800,  // content size (px)
  "displayId": 60,               // optional; Electron display id at save time
  "isMaximized": false,
  "isFullScreen": false
}
```

On restore the position is honored only if the rect is still visible on an
attached display; otherwise Hyperia picks a sane position. Maximize /
fullscreen are re-applied.

### `layout` — the renderer blob

```jsonc
{
  "activeUid": "<sessionUid>",        // focused session
  "activeRootGroup": "<groupUid>",    // focused tab (root term group)
  "activeTermGroup": "<groupUid>",    // focused pane within that tab
  "activeSessions": { "<rootGroupUid>": "<sessionUid>" },
  "termGroups": { "<uid>": TermGroup },
  "sessions":   { "<uid>": Session }
}
```

**TermGroup** — one node of the BSP split tree. Root groups (null `parentUid`)
are tabs, in object-key order; leaves hold a session (terminal) or a `webUrl`
(web pane).

| Field | Type | Meaning |
|---|---|---|
| `uid` | string | Node id (remapped to fresh uuids on every restore). |
| `parentUid` | string\|null | null ⇒ this group is a tab. |
| `sessionUid` | string\|null | Leaf terminal's session; null for splits/web panes. |
| `direction` | "HORIZONTAL"\|"VERTICAL"\|null | Split axis for non-leaves. |
| `sizes` | number[]\|null | Split proportions, parallel to `children`. |
| `children` | string[] | Child group uids, in order. |
| `webUrl` / `webName` | string\|null | Web pane URL/title (page reloads on restore). |
| `tabName` | string\|null | User/agent-set tab name (null ⇒ auto name). |
| `manualTabName` | boolean | True only for a human-typed rename. |

**Session** — one terminal pane's respawn recipe. A restored PTY is a brand-new
process: workspace files deliberately carry **no `pid`** (validation rejects
files that do).

| Field | Type | Meaning |
|---|---|---|
| `uid` | string | Session id (remapped on restore). |
| `profile` | string | Shell profile to respawn with; a missing profile falls back to the default shell, loudly. |
| `cwd` | string | Working directory; a missing directory falls back to home, loudly (pane banner + preview issue). |
| `shell`, `cols`, `rows` | string, number, number | Informational; the fresh spawn overrides them. |
| `title`, `tabName`, `description`, `shellName` | string | Display names. |
| `manualTitle` | boolean | True only for a human-typed rename. |
| `annotations` | object? | Display-only metadata, see below. |

### `annotations` — display-only, never executed

`annotations.lastCommand` is a best-effort scrape of the command line visible
in the pane at save time. **Restore never runs it.** It shows in previews and
the restored pane's banner; re-typing it (not executing) into the fresh shell
requires the `typeRestoredCommand` config flag, which is **off by default** —
a shared or imported workspace must not put text into your shell. Treat the
whole `annotations` object as untrusted display data; future keys (e.g.
container reattach hints, #172) follow the same rule.

## Versioning

`schemaVersion` is a single integer, currently **1**.

- A file with `schemaVersion` **greater** than the running Hyperia supports is
  refused with a clear "newer than supported" error — never guessed at.
- Older shapes are migrated forward on import (see below). Migration happens
  on **import only**; files in the library are already current.
- Additive optional fields (like `stickys`) do NOT bump the version. The
  version bumps only when a consumer must change behavior to read the file.

## Migration

`workspace_import` accepts, besides current files:

- **v0 — the legacy `savedLayoutState` blob** (pre-workspace Hyperia kept one
  anonymous layout under this key in `hyperia.json`): a bare blob, or a whole
  `hyperia.json` still containing the key. It becomes a v1 file with a single
  window (geometry from `window-state.json` when available), `pid`s stripped,
  and bare `lastCommand` demoted to `annotations.lastCommand`.

## Failure behavior

- Corrupt, wrong-kind, or newer-versioned files produce typed errors; the
  source file is **never modified or deleted**.
- The library `list` shows unparseable files flagged `valid: false` with the
  reason instead of hiding them.
- Import/export refuse to overwrite an existing target without an explicit
  `overwrite`.
