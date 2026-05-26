# Terminal App — Design Specification

## Layout Model

The app is a Windows desktop terminal emulator with one hierarchy: **window → tabs → panes**. Each tab contains one window-full of panes; panes split horizontally or vertically and carry labels. There is no sidebar. Tabs do not nest inside panes. The hierarchy ends at the pane.

*Rationale*: A local GUI terminal already gets window management from the OS (tiling layouts, Alt+Tab, minimize/close). The sidebar pattern in tmux/Zellij solves a remote-session reattach problem this app does not have. Cutting it reclaims the bottom-left real estate for content.

---

## Title Bar

Tabs occupy the title bar directly, Windows Terminal style. No separate caption strip above — the active tab's name is the window title.

Single row, 36px tall, left to right:
- Tab strip (flush left, 12px inset from the window edge)
- New-tab `+` button
- Profile-picker chevron (`ti-chevron-down`)
- Empty draggable span — minimum 60px reserved
- Window controls cluster: minimize, maximize, close (flush right, 14px inset)

The empty span between the chevron and the controls is the OS drag handle (`-webkit-app-region: drag` in Electron, equivalent native hit-test response otherwise). Without it the window cannot be moved by mouse.

---

## Tabs

Each tab shows its name followed by a close `×` icon. The active tab fills with `--color-background-primary` (same as the pane area beneath), has a 0.5px border on top/left/right with `border-radius: 6px 6px 0 0`, and overlaps the tab-strip's bottom border by `-0.5px` so the active tab and the content area below read as one continuous surface. Inactive tabs are unfilled, text-only in `--color-text-secondary`. The close icon appears on hover for inactive tabs; on the active tab it is always visible.

---

## Profile Picker — Chevron Dropdown

Triggered by the chevron next to `+`. Opens new tabs running non-default shell profiles.

- **Profile data**: Each profile is a config entry: `id`, `displayName`, `command` (shell binary + args), `cwd`, `env`, `iconPath`, `colorScheme`. Exactly one entry is marked `default: true`.
- **Trigger**: Icon-only button, hover state matches the `+` so the pair reads as one control. `aria-label="New tab options"`, `aria-haspopup="menu"`, `aria-expanded` toggles on open.
- **Menu**: Anchored to the chevron's bottom edge, opens downward. Contents in order: one row per profile (icon + displayName, default first or marked), divider, `Settings…`, `About`. Each profile row dispatches `createTab({ profileId })`.
- **Keyboard**: `↑/↓` move focus, `Enter` activates, `Esc` closes and returns focus to the chevron. Focus is trapped in the menu while open.
- **Alt-click shortcut**: Holding `Alt` while clicking a profile splits the focused pane with that profile instead of opening a new tab.

---

## Pane Layout

Panes occupy the active tab's content area in a flexible split grid. Splits are horizontal or vertical and may nest arbitrarily. The content-area background is `--color-background-tertiary`, which shows through as 8px gutters between adjacent panes. Pane focus moves by click or by keybind (`Ctrl+Alt+arrow`, to be finalized).

---

## Pane Visual Style

- **Border**: One continuous 0.5px stroke around all four sides of each pane, color `--color-border-tertiary`. Uniform along the entire perimeter — no color shifts between sides, no gradient, no dashing, no inner accent line. Implemented as one declaration: `border: 0.5px solid var(--color-border-tertiary)`.
- **Corner radius**: 4px on all four corners of every pane. Window frame uses 8px. Inner radius is always less than outer — that differential is what makes nesting feel right without needing shadows.
- **Gutters**: Panes do not share borders. They sit on the tertiary canvas with 8px gaps. The negative space does half the separating work; the hairline border is the pane card's edge, not a divider between panes.
- **Overflow**: Every pane container sets `overflow: hidden` so the colored label band at the top is clipped by the pane's rounded corners. The label rect itself stays a plain rectangle; the rounding comes from the parent clip.
- **No internal lines**: Inside a pane there is no `border-bottom` between the label band and the terminal content. Separation comes from background-color contrast. The border is the only line in the pane; everything else is a region.

---

## Pane Label Band

Full-width strip at the top of every pane, 22px tall (5px vertical padding × 11px font + line-height). The band's left edge meets the inside of the pane's left border, right edge meets the inside of the right border, top edge meets the inside of the top border — flush on all three sides, zero gap. Justified left, right, and top.

- **Left content (the pane label name)**: 11px, weight 500, sentence case. Color is the darkest stop of the band's tint ramp. Clickable to enter rename mode (inline edit, future spec).
- **Right content (the profile chip)**: Shows the running shell — `pwsh 7.5`, `wsl: ubuntu`, `bash`, etc. 11px, weight 400, 0.85 opacity, trailing chevron (`▼`). Clicking the chip opens a menu of available profiles using the same interaction model as the title-bar chevron. If a process is running, swapping confirms before killing it.
- **Tint**: Each label band uses a semantic background/text pair:
  - `--color-background-success` / `--color-text-success` for build & serve roles
  - `--color-background-info` / `--color-text-info` for log & observer roles
  - `--color-background-warning` / `--color-text-warning` for test & runner roles
  - `--color-background-secondary` / `--color-text-secondary` for untitled / unconfigured panes

Tints encode role, not status. The user can change a pane's tint when renaming.

---

## Splitting a Pane

When the user splits the focused pane, the new pane does **not** clone the focused pane's profile. Instead:

1. The new pane spawns with no shell running.
2. Its label band shows `untitled` in italic tertiary text on the left, and a hint `just split — pick a shell` in tertiary text on the right.
3. The pane body centers a picker: heading `Pick a shell for this pane`, a 3-column grid of profile buttons (icon + name), and a checkbox `Use this profile for future splits`.
4. Clicking a profile spawns that shell in the pane, replaces the picker with the terminal view, and (if the checkbox is checked) updates the per-tab split default — globally if the user prefers, configurable in settings.

After a shell is running, the user changes the profile via the pane's label-band chip. The chip menu confirms before killing an active process.

The Alt-click shortcut on the title-bar chevron skips the inline picker — it splits with the chosen profile directly. Same outcome, fewer clicks for the keyboard-driven user.

---

## Dropdown State Model — No Open/Close Loops

All dropdowns in the app (title-bar chevron, pane profile chip, future menus) follow one rule set:

- One piece of state per dropdown: `open: boolean`.
- `open` flips to `true` only on explicit click of the trigger.
- `open` flips to `false` only on: (a) click on a menu item, (b) `Escape` key, (c) `pointerdown` outside the menu's bounding box.
- Never flip on `blur`, `focusout`, `mouseleave`, `mouseenter`, or any focus-derived event.
- While `open`, trigger and menu surface form one focus trap. Re-entering the trigger while open is a no-op, not a toggle.

The inline split-picker uses the same rules: it dismisses on profile selection or pane close, never on focus changes elsewhere in the app.

---

## Visual Design Tokens

- **Background tiers**: `primary` (pane interior — white in light / near-black in dark), `secondary` (raised surfaces), `tertiary` (canvas behind panes). All CSS variables, all theme-adaptive.
- **Text tiers**: `primary`, `secondary`, `tertiary`. Same naming, same adaptation.
- **Semantic colors**: `success`, `info`, `warning`, `danger` — matching `background` and `text` variants. Used for pane label tints, not status badges.
- **Borders**: One token: `--color-border-tertiary` at ~15% alpha. One weight: 0.5px. Used everywhere.
- **Typography**: Sans-serif (system stack) for all chrome. Monospace (`ui-monospace, SFMono-Regular, Menlo, monospace`) for terminal content only. 11px minimum anywhere. Two weights: 400 regular, 500 medium. No bold, no italic in chrome — italic only for placeholder/untitled states.
- **Case**: Sentence case everywhere. No `ALL CAPS`, no `Title Case`.
- **Banned**: Gradients, drop shadows (except a 2px focus ring on inputs), glow/neon, background patterns, icons heavier than outline weight, borders thicker than 0.5px, font-sizes under 11px, hardcoded hex outside the token definitions.

---

## Theme

Single source of truth: CSS custom properties. Theme switches by root class toggle or `prefers-color-scheme`. Light mode: white pane on light-gray canvas. Dark mode: near-black pane on darker canvas. Every border, fill, and text color resolves through a variable.
