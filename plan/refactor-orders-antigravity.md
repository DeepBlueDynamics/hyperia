# Orders — remove the shell-swap subsystem, then split the giant pane files

**Why.** `lib/components/term.tsx` (~2,575 lines) and `lib/components/web-pane.tsx`
(~3,200 lines) have become unmaintainable: a terminal/web pane, its band, a
directory navigator, a URL navigator, a picker, AI conversations, AND a
now-unwanted in-place shell-swap menu all live in two files mixing `<style jsx>`
with hundreds of inline `style={{}}` objects. Every change is expensive and
collision-prone. Fix in ordered phases. **Stop after each phase for review.**

**Keep (do NOT remove or restyle):** the `<PaneBand>` component, the Tabler
icon font wiring, the Rust `/api/fs/dirs` directory listing, the directory
navigator's browse-without-cd + **Go button** behavior, web nav/history, tabs.

---

## Phase 1 — Delete the in-place shell-swap subsystem (highest priority)

The user wants the "replace a pane's shell in place" concept gone **entirely** —
the per-pane shell/profile pulldown and all the kill-and-respawn machinery. A
pane is created once with a shell; you never swap its shell in place. New shells
come from the top tab pulldown / new-tab, not from a per-pane menu.

Remove every piece, in this order so the build never half-breaks:

1. **`lib/components/term.tsx`** — remove the profile menu UI + handlers:
   `toggleProfileMenu`, `handleShellProfileSelect`, `handleRightClickProfile`,
   `handleWebPaneSelect`, `handleWebPaneSubmit`, `handleWebPaneCancel`; the
   `{this.state.isProfileMenuOpen && (...)}` menu JSX (the `.term_profileMenu`
   block) and its `.term_profileMenu` CSS; the `onClick={…toggleProfileMenu}`
   trigger on the band; and state fields `isProfileMenuOpen`, `showWebPaneInput`,
   `webPaneUrlInput` (and any `componentDidUpdate` references to them).
2. **`lib/components/web-pane.tsx`** — remove the same per-pane profile/shell
   menu + any `switchPaneProfile` / `switchPaneToWeb` calls.
3. **`lib/components/term-group.tsx`, `lib/components/terms.tsx`** — stop passing
   the `switchPaneProfile` / `switchPaneToWeb` props.
4. **`lib/containers/terms.ts`** — remove the `switchPaneProfile` /
   `switchPaneToWeb` dispatch wiring + imports.
5. **`lib/actions/term-groups.ts`** — delete `switchPaneProfile` and
   `switchPaneToWeb`.
6. **`lib/reducers/term-groups.ts`** — delete the `TERM_GROUP_PREPARE_SWITCH`
   case and the `isSwitching` flag (+ the `isSwitching?` field in
   `typings/hyper.d.ts`).
7. **`app/ui/window.ts`** — remove the `rpc.on('reset session', …)` and
   `rpc.on('park session', …)` handlers.
8. **`app/session.ts`** — remove `resetWithProfile` and `parkPty`. The `gen`
   counter + the `this.gen !== myGen` guards in `onData`/`onExit` existed only
   to support those — remove them too (revert those guards to the simple
   `if (this.ended) return;` form).
9. **`typings/common.d.ts`** — remove `'reset session'` and `'park session'`
   from `MainEvents`.

**Acceptance:** `tsc -b` clean, `yarn lint` clean, panes still open/close/split,
no per-pane shell pulldown anywhere, no dead references to the removed symbols.
**Deliverable:** diff across the files above. **Build clean. STOP. Wait.**

---

## Phase 2 — Extract `<DirectoryNavigator>` out of `term.tsx`

Move the directory navigator into its own file so `term.tsx` is just the xterm
wrapper + `<PaneBand>` wiring.

Create **`lib/components/directory-navigator.tsx`**. Move into it: the
breadcrumb row (`renderNavigatorBreadcrumbs`), the directory list
(`renderNavigatorDirectoryList`), the popup, `loadNavigatorDirs`,
`goToNavigatorDir`, the keyboard handler (type-to-jump, arrows, Enter, parent),
and the `.term_navigator*` CSS. It fetches `GET /api/fs/dirs` and calls back
with the chosen path on **Go** (props: `sessionCwd`, `onGo(path)`, `onClose`).
`term.tsx` renders `<DirectoryNavigator>` and runs `cd` in its `onGo`.

**Acceptance:** `tsc -b` + lint clean; navigator behaves identically (browse,
type-to-jump, Go cds, Esc closes); `term.tsx` drops ≥250 lines.
**Deliverable:** new file + `term.tsx` diff. **Build clean, screenshot. STOP.**

---

## Phase 3 — Extract `<UrlNavigator>` and `<PanePicker>` out of `web-pane.tsx`

Same treatment for the web pane. Create **`lib/components/url-navigator.tsx`**
(the URL popup: editable input + ↵ + live-filtered history + footer
classification) and **`lib/components/pane-picker.tsx`** (the "pick a shell or
enter a URL" empty state). `web-pane.tsx` renders them and keeps only the
webview + AI-conversation logic.

**Acceptance:** `tsc -b` + lint clean; web pane behaves identically;
`web-pane.tsx` drops ≥400 lines. **Deliverable:** new files + `web-pane.tsx`
diff. **Build clean, screenshot. STOP.**

---

## Constraints — read these

- **Behavior unchanged** except the Phase-1 swap removal. No new features.
- **No new dependencies.** No Tailwind, CSS-modules, styled-components. Keep the
  existing `<style jsx>` pattern.
- **Out of scope:** tab strip, toolbar, split-pane, `<PaneBand>` internals, the
  font wiring, the Rust sidecar. Don't touch them.
- **One phase per build.** End each phase with a clean build + a checkpoint.
  **Do not slide forward. Do not pre-stage later phases. Do not redesign.**
- After each phase, output the diff and wait for review.

## Cadence

Phase 1 → diff of the 9 files, await review.
Phase 2 → new `directory-navigator.tsx` + `term.tsx` diff, await review.
Phase 3 → new `url-navigator.tsx` + `pane-picker.tsx` + `web-pane.tsx` diff.
