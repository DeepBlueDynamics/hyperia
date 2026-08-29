# Solution: `hyws` — named workspace save/restore

Turns Hyperia's single anonymous `savedLayoutState` slot into a named,
versioned, multi-slot workspace library. Eight commands (save, list, preview,
restore, export, import, rename, delete), exposed as `hyperia hyws <cmd>` CLI
subcommands and MCP tools over one sidecar HTTP surface. Realizes epic #146
(and subsumes #82/#83).

## What already exists (reuse, don't rebuild)

- **Live layout mirror**: the sidecar already holds every window/tab/split/pane
  with bsp rects and web-pane URLs (`app/bridge.ts` `updateSessionLayout` →
  `SessionLayout`; `getWebPaneUrls` per window). A snapshot is a serialization
  of this, not new capture.
- **Legacy single-slot save/restore**: MCP `settings_flush_layout`
  (`mcp.rs:1346`) writes `config.savedLayoutState`; `app/ui/window.ts:507`
  restores it once on launch via the `restore-layout-state` rpc, then deletes
  it. `hyws import` migrates exactly this blob.
- **Single-window geometry restore**: `restoreFor` (`app/window-state.ts`).
- **Sticky persistence**: `~/.hyperia/stickys/notes.json` — snapshot references
  sticky ids + positions, not their content.
- **CLI dispatch + consent**: `cli/hyperia-mcp.ts` command pattern; sidecar
  `enforce_*` gates; persistent grants (`perms.json`, v0.17.47) — this is why
  the proposal's restore can say "instant now that you're granted."

## Data model

One file per workspace: `~/.hyperia/workspaces/<slug>.json`.

```jsonc
{
  "schema": 1,
  "name": "nemesis grid",
  "created": "<iso>", "updated": "<iso>",
  "windows": [{
    "bounds": {"x","y","width","height"}, "maximized": false,
    "tabs": [{
      "name": "...", "pinned": false, "order": 0,
      "layout": { /* BSP tree: direction, sizes, children */ },
      "panes": [{
        "kind": "shell" | "web",
        "splitLabel": "a",
        "profile": "PowerShell 7",        // shell: profile name (resolved at restore)
        "cwd": "C:\\...",                  // shell: best-effort
        "command": "n8 resume <id>",       // shell: optional startup command
        "url": "https://...",              // web: the page
        "name": "Witty Ostrich 🎈"         // display name to re-badge
      }]
    }]
  }],
  "stickies": [{"id","x","y","w","h","file?"}]  // references, content stays in stickys/
}
```

Versioned (`schema`), so `import` can migrate older shapes and the legacy
`savedLayoutState` blob (schema 0 → 1).

## The commands, mapped

| Command | Implementation |
|---|---|
| `save <name> [--overwrite]` | Read the live layout mirror + sticky index, serialize to `<slug>.json`. Refuse an existing name without `--overwrite`. |
| `list` | `readdir` the dir; parse each; a parse failure lists the row **flagged corrupt**, never hidden (matches the sidecar-log honesty principle). Newest-`updated` first. |
| `preview <name>` | Dry-run diff: resolve each pane's profile/cwd/sticky against the CURRENT host and report substitutions (missing dir → home, unknown profile → default, deleted sticky → skipped) **without opening anything**. |
| `restore <name>` | Open in **NEW windows only** — never mutate open windows. This is the whole trick: it sidesteps the multi-window last-writer-wins bug (parked) by not being a diff-and-apply. Reuses the per-pane create path (`open web pane req` for web, session spawn + optional startup command for shell), then re-badges panes to their saved names and re-pins pinned tabs. Consent-gated (`create` capability). |
| `export <name> <path>` | Copy the versioned JSON to an arbitrary path (share/backup). |
| `import <path> [--name n] [--overwrite]` | Validate + migrate schema (incl. legacy `savedLayoutState`), write into the library. |
| `rename <from> <to>` | Rename the file + update `name`. |
| `delete <name>` | Unlink one. Permanent (the proposal says so) — but print the path so it's recoverable from trash where the OS keeps it. |

## Architecture

- **Sidecar** owns the library (it already owns the layout mirror and the
  config dir). New module `sidecar/src/workspaces.rs`: CRUD over
  `~/.hyperia/workspaces/`, snapshot serialization from the live session map,
  and the preview-diff resolver. Routes: `GET /api/workspaces` (list),
  `GET /api/workspaces/{name}` (read/preview), `POST /api/workspaces/{name}`
  (save), `POST /api/workspaces/{name}/restore`, `DELETE`, plus export/import
  as read/write of the JSON.
- **Restore executor** lives app-side (only the renderer/main can open windows):
  a new bridge command `RestoreWorkspace` that walks the snapshot and drives the
  existing create paths. Reuses `newWindow`, the session spawn, and
  `open web pane req` — no new window machinery.
- **CLI**: add `hyws` to `MCP_COMMANDS`, a `cmdHyws` dispatcher in
  `cli/hyperia-mcp.ts` mapping the eight subcommands to the routes above, with
  a formatted table for `list`/`preview` (the screenshot's output).
- **MCP tools**: `workspace_save/list/preview/restore/delete` so agents can
  snapshot and restore too (create-gated).

## Consent

- `save`/`list`/`preview`/`export` are reads or config-dir writes — cheap,
  ungated for the human via CLI; agent MCP writes take the settings/create gate.
- `restore` opens surfaces → `enforce_create`. With the v0.17.47 persistent
  grant, a human who has approved once restores instantly (the proposal's
  "instant now that you're granted").
- `restore` **never steals focus of existing windows** and only ADDS windows —
  focus-never-steal holds.

## Gotchas (each already bit us this session)

- **Multi-window restore is add-only, never diff-and-apply.** The
  last-writer-wins bug that stranded multi-window quits came from trying to
  reconcile against open state. Restore-into-new-windows dodges it entirely.
- **Container/remote cwds don't resolve on the host** (`session.ts:361`) — a
  `/workspace/...` cwd from an n8 pane is meaningless on Windows. `preview`
  must flag these; `restore` falls back to home + still runs the startup
  command (which re-enters the container).
- **BSP rects are percentages, restored structurally** (the n-ary split walker,
  v0.17.40) — restore rebuilds the tree from `layout`, not from pixel rects.
- **Pinned tabs** (v0.17.52) — the snapshot carries `pinned`; restore re-pins
  after building the tab so the pinned block reforms.
- **Sticky content is not duplicated** — snapshot references ids; a deleted
  sticky is skipped with a preview note, never resurrected empty.

## Build order (each shippable alone)

1. `workspaces.rs` + routes + `hyws` CLI for **save/list/preview/export/import/
   rename/delete** (everything except restore — pure file + snapshot work).
2. `RestoreWorkspace` bridge executor + `restore` route/CLI — the window-opening
   half, reusing existing create paths.
3. MCP tools wrapping the routes (agent parity).
4. Migrate the legacy `savedLayoutState` launch-restore to read the default
   workspace, retiring the single-slot path.

Estimate: (1) ~1 day, (2) ~1–1.5 days (the executor is the real work), (3) ~half
day, (4) ~half day.
