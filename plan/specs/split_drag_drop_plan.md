# Feature plan: Move / split panes (drag-drop + context menu)

> Status: design / architecture only — no code yet.
> Goal: let the user **drag a pane by its name/icon** and drop it into a split
> location (top / bottom / left / right) of another pane, **or** use a right-click
> **"Move / Split pane into…"** menu — without affecting existing layouts or functions.

---

## 1. How panes & splits work today

**Three per-window Redux slices** (each BrowserWindow = its own renderer + its own store):

- **`termGroups`** (`lib/reducers/term-groups.ts`) — a **tree**.
  - Root nodes (`parentUid === null`) are **tabs**.
  - Internal nodes are **split containers** (`direction: VERTICAL | HORIZONTAL`, `children[]`, `sizes[]`).
  - Leaf nodes are **panes** (`sessionUid` for a shell, or `webUrl` for a web pane).
  - Plus `activeRootGroup`, `activeTermGroup`, `activeSessions{ rootUid → sessionUid }`.
- **`sessions`** (`lib/reducers/sessions.ts`) — `sessionUid → { title, pid, cwd, … }`. The
  actual **PTY (node-pty) lives in the main process**, keyed by `sessionUid`.
- **`ui`** — window chrome state.

**Existing tree surgery** (reducer — already battle-tested):

- `splitGroup` — inserts a **new** session beside the active pane: reuses the parent if the
  same direction, else promotes the active leaf into a new split container; `insertRebalance`
  redistributes `sizes`; obeys the `countPathHorizontalStacks` ≥ 11 limit.
- `removeGroup` + `replaceParent` — detach a leaf and **collapse** the parent when one child
  remains; `removalRebalance` fixes sizes; active-pointer integrity hardened recently.
- `TERM_GROUP_POP_OUT_PANE` — **detaches a pane into a brand-new root group (tab)**. This is the
  closest existing primitive to "move."
- `TERM_GROUP_REORDER` — reorders **tabs**, already driven by HTML5 drag-and-drop in
  `tabs.tsx` / `tab.tsx`.

**Creating a split today is a main-process round-trip** (because it spawns a PTY):
UI → `requestVerticalSplit` / `requestHorizontalSplit` → `rpc.emit('new', { splitDirection, activeUid, cwd, profile })`
→ `window.ts:createSession` → `SESSION_ADD { splitDirection }` → `splitGroup`.
Agents do the same via the `terminal_split` MCP tool.

**Bridge / sidecar sync:** `trackedSessions` (main process) holds each session's
`bspX/Y/W/H`, `splitLabel`, `tabOrder`, `tabActive`, `rootTabUid`, `windowId`. The renderer
reports the measured layout and **`updateSessionLayout` (`app/bridge.ts:1161`)** writes it into
`trackedSessions` and pushes it to the sidecar — which is what `terminal_status` / `hyper status`
/ agents read.

**The pane "handle"** already exists: `pane-band.tsx` renders the pane name + icon (today:
click-to-copy + permission UI). It carries `paneId` — the natural **drag source**. It is **not
draggable yet**.

---

## 2. The core insight that makes this safe

A **move is not a split-new** — it does **not** create a session or touch the PTY. It is a
**relocation of an existing leaf** within the `termGroups` tree. So a **same-window move is a
pure renderer-side Redux mutation**: no `rpc('new')`, no main-process session creation, no PTY
churn. The existing `updateSessionLayout` reporter then syncs the new geometry/location to the
sidecar automatically. That is why this can be added without disturbing existing layouts or the
PTY / bridge lifecycle.

---

## 3. The one new primitive: `MOVE_TERM_GROUP`

A single reducer action + thunk:

`moveTermGroup({ sourceUid, targetUid, position })` where `position ∈ { left, right, top, bottom, center }`.

Reducer logic = **detach + insert**, composed from existing helpers (factor the shared parts out
of `splitGroup` / `removeGroup` so behavior stays identical):

1. **Guard** (no-op): `source === target`; target is inside source's own subtree (would orphan the
   tree); dropping onto the slot it already occupies; horizontal-stack limit.
2. **Detach** source from its parent — same collapse path as `removeGroup` / `replaceParent`
   (sibling replaces parent, `removalRebalance` sizes). Keep the detached subtree intact (its
   `sessionUid` / children survive).
3. **Insert** beside target in `position`'s axis — same logic as `splitGroup`'s insert (reuse
   target's parent if axis matches, else promote target into a new container), `insertRebalance`
   sizes. `center` = move into the target's tab / pane stack (semantics TBD — see §10).
4. **Fix invariants**: set the moved pane active in its new spot; recompute
   `activeRootGroup / activeTermGroup / activeSessions` (reuse the integrity work just done); if
   the **source tab is now empty, close it** (the window-close subscription already handles the
   "last tab gone" case).

Because steps 2–3 are literally the existing detach/insert code paths, existing single-window
split/close behavior is unchanged.

---

## 4. Drag-and-drop UX

- **Drag source:** make `pane-band.tsx` `draggable`; `onDragStart` stamps `dataTransfer` with
  `sourceUid` (+ a custom MIME so only pane drops are accepted). Mirror the HTML5 DnD pattern
  already used for tabs.
- **Drop targets:** while a pane-drag is active, each `term.tsx` pane renders a **5-zone overlay**
  — four edge bands (left / right / top / bottom) + center — and highlights the zone under the
  cursor (`onDragOver`). `onDrop` → `moveTermGroup(sourceUid, targetPaneUid, zone)`.
- **Tab bar as a drop target:** dropping a pane onto the tab strip = `popOutPane` (move to a new
  tab); onto an existing tab = move into that tab. Reuses existing primitives.
- **Affordances:** dim the dragged pane, show a live preview / insertion outline, `Esc` cancels.
  No PTY interaction during drag (selection / keys suppressed on the source while dragging — ties
  into the right-click capture recently added).

---

## 5. Context-menu path (non-drag / accessible)

Add **"Move / Split pane into…"** to the pane right-click menu (the context-menu handler in
`terms.tsx`). It opens a small picker: list the **other panes in the window** (by name), each
expanding to a direction choice (or a 4-arrow + center mini-widget). Selection dispatches the
**same** `moveTermGroup` action. This is the keyboard-friendly fallback and the discoverable
entry point.

---

## 6. Sidecar + agent parity

- **Same-window:** nothing new — `updateSessionLayout` already re-pushes geometry / `splitLabel`
  / `tabActive` after the tree changes, so `terminal_status` reflects the move automatically.
- **MCP tool:** add `terminal_move_pane({ pane, target, position })` (or extend `terminal_split`)
  so agents can relocate panes too — routes a `MovePane` bridge command → renderer →
  `moveTermGroup`. Keeps human and agent capabilities symmetric (the project's stated principle).

---

## 7. Cross-window moves — explicitly Phase 2

Moving a pane to a **different window** crosses store boundaries: the session must leave window
A's store and be **adopted by window B's store while its PTY stays alive in main**. This is
`popOutPane` + a session-adoption IPC (detach in A → main re-binds the session / bridge stream →
`SESSION_ADD`-as-existing in B). Higher risk (bridge re-pointing, focus, active pointers across
windows). **Defer**; ship single-window first.

---

## 8. Why this doesn't break existing layouts / functions

- **Additive:** one new action + UI handlers; `splitGroup`, `removeGroup`, `popOutPane`,
  `reorder`, and close paths are untouched (only **shared helpers are extracted**, not changed).
- **No PTY / main churn** for same-window moves → no risk to session lifecycle or the bridge.
- **Invariants reused:** active-pointer integrity + close-empty-tab (recent fixes) cover the
  post-move state.
- **Auto-persist:** layout is already saved / restored via `SaveLayoutState` /
  `restoreLayoutState`; a move only mutates `termGroups`, so save/restore keeps working.
- **Limits honored:** same horizontal-stack cap and size-rebalancing as native splits.
- **Guard rails** prevent the only ways to corrupt the tree (self / subtree drops).

---

## 9. Suggested phasing

1. **Primitive + context menu** — `MOVE_TERM_GROUP` reducer/thunk + "Move/Split into…" menu (no
   DnD yet). Fully testable, lowest risk, proves the tree surgery.
2. **Drag-and-drop** — pane-band drag source + 5-zone drop overlays + tab-bar drops.
3. **MCP `terminal_move_pane`** for agent parity.
4. **Cross-window** session adoption.

---

## 10. Open questions to settle before building

- `center` semantics: stack-into-tab vs. swap-positions vs. disallow.
- Web panes & agent panes: any pane with a `sessionUid` / `webUrl` should move uniformly —
  confirm web panes relocate cleanly (they're leaves too).
- Whether to reuse HTML5 DnD (matches tabs, simpler) or pointer-events (smoother overlays, more
  code) for the drop zones.

---

## Key code references

| Concern | Location |
|---|---|
| Term-group tree + tree ops (`splitGroup`, `removeGroup`, `replaceParent`, `popOutPane`, `reorder`) | `lib/reducers/term-groups.ts` |
| Split/close/move thunks (`requestSplit`, `userExitTermGroup`, `ptyExitTermGroup`, `popOutPane`, `setActiveGroup`) | `lib/actions/term-groups.ts` |
| Pane rendering / drop-zone host | `lib/components/term.tsx` |
| Split container (resizers, children) | `lib/components/term-group.tsx` |
| Active root group BSP renderer | `lib/components/terms.tsx` |
| Pane name/icon — drag source | `lib/components/pane-band.tsx` |
| Tab bar drag-reorder (DnD pattern to mirror) | `lib/components/tabs.tsx`, `lib/components/tab.tsx` |
| Split request IPC (`rpc 'new'` → `createSession`) | `app/ui/window.ts` |
| Bridge geometry/layout sync to sidecar | `app/bridge.ts` (`updateSessionLayout`, `sendSessionRegister`, `trackedSessions`) |
| Store + rpc wiring | `lib/index.tsx` |
| Agent parity (existing `terminal_split`) | `sidecar/src/mcp.rs`, `sidecar/src/bridge.rs` |
