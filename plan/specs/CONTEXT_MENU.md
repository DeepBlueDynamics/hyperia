# Context Menu Redesign — Plan (Issue #13)

## Goal

Replace the current patchwork context menu (three menus concatenated, duplicates, rarely-used items)
with a clean, purpose-built menu that surfaces what's actually useful in a terminal context.

## Target Layout

```
Copy            ← only shown when there is a text selection
Paste
─────────────
Split Down
Split Right
Close Pane
─────────────
New Tab
New Window
─────────────
New Note
Ask Hyperia
─────────────
Clear Buffer
Search
─────────────
Preferences     ← Windows / Linux only (on macOS this lives in the app menu)
```

## What Gets Removed

| Item | Why |
|------|-----|
| New Terminal (top) | Duplicate of New Window |
| Select All | Not useful in terminal; no text to select-all like a doc |
| Move to… submenu | Edge case; keyboard shortcuts cover it |
| Delete… submenu | Same — keyboard shortcuts cover it |
| Undo / Redo | Disabled anyway (always `enabled: false`) |
| Duplicate New Tab / New Window | Shell menu was appended wholesale after edit menu |
| Close Window / Quit | Too destructive for a right-click; menu bar / tray covers this |

## Implementation

### Single file change: `app/ui/contextmenu.ts`

Rewrite `contextMenuTemplate` to build the menu directly from `execCommand` and `ipcMain.emit`
calls — no longer importing and concatenating `editMenu` and `shellMenu`. This removes all the
accidental baggage those menus carry.

```
contextMenuTemplate(createWindow, selection, commandKeys)
  → MenuItemConstructorOptions[]
```

- Copy: `role: 'copy'` — conditionally included when `selection` is non-empty (existing logic, keep it)
- Paste: `role: 'paste'`
- Split Down: `execCommand('pane:splitDown')`
- Split Right: `execCommand('pane:splitRight')`
- Close Pane: `execCommand('pane:close')`
- New Tab: `execCommand('tab:new')`
- New Window: `execCommand('window:new')` or `createWindow()`
- New Note: `ipcMain.emit('new-sticky', {})`
- Ask Hyperia: `ipcMain.emit('open-ghost')`
- Clear Buffer: `execCommand('editor:clearBuffer')`
- Search: `execCommand('editor:search')`
- Preferences: `execCommand('window:preferences')` — skip on macOS

### Callers of `contextMenuTemplate`

Check `app/ui/window.ts` — it calls `contextMenuTemplate` and passes `createWindow` + `selection`.
The signature gains `commandKeys` so accelerator hints can be shown next to Split/New items.

### `editMenu` and `shellMenu`

These are still used by the main menu bar — do not modify them.
The context menu just stops importing them.

## Accelerators to Show

| Item | Key |
|------|-----|
| Split Down | `commandKeys['pane:splitDown']` |
| Split Right | `commandKeys['pane:splitRight']` |
| Close Pane | `commandKeys['pane:close']` |
| New Tab | `commandKeys['tab:new']` |
| Clear Buffer | `commandKeys['editor:clearBuffer']` |
| Search | `commandKeys['editor:search']` |

## Future Hook (Issue #12)

After web panes land, add between Close Pane and New Tab:
```
Open as Web Pane…
Close Web Pane      ← only when pane is already a web view
─────────────
```

## Files Touched

- `app/ui/contextmenu.ts` — full rewrite of `contextMenuTemplate`
- `app/ui/window.ts` — pass `commandKeys` to `contextMenuTemplate` if not already passed
