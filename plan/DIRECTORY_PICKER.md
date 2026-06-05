# Plan — Directory Picker & Shell Sync (Jolly Turtle / sticky 17v2)

## Overview

The Directory Picker allows the user to browse the local filesystem directly from a terminal pane and navigate to a selected folder. This plan addresses the sync logic between the shell's active directory (CWD) and the picker, and prevents accidental interference when a CLI program is running inside the terminal.

---

## Part 1 — Bi-directional Sync

### 1. Shell → Picker (Updating CWD when Shell changes)
When the user runs `cd` inside the terminal shell, the PTY detects the directory change and propagates the new path as the `sessionCwd` prop to the `Term` component.

- **Current Behavior**: When `sessionCwd` updates, `componentDidUpdate` appends it to `cwdHistory` and moves the cursor, but does not update `navigatorCurrentPath` or reload the directory contents if the picker is open.
- **Proposed Behavior**: In `componentDidUpdate`, if `sessionCwd` changes AND the directory picker is open (`isDirNavigatorOpen` is true), we should call `loadNavigatorDirs(sessionCwd)` to automatically refresh the picker's listed directory to match the shell's new location.

### 2. Picker → Shell (Updating Shell when Picker changes)
- **Current Behavior**: Clicking a folder and hitting "Go" triggers `goToNavigatorDir()`, which executes `performCd()`:
  ```typescript
  const performCd = () => {
    this.props.onData!(`cd "${target}"\r`);
    if ((this.props as any).onCwd) {
      (this.props as any).onCwd(target);
    }
    this.setState({ isDirNavigatorOpen: false });
  };
  ```
  This successfully updates the shell process by feeding the `cd` command and notifies the main process via `onCwd`.

---

## Part 2 — Handling Active Programs (The Safe-Guard)

### The Problem
If a user is running an interactive CLI program (like `vim`, `less`, `python` REPL, or `Claude Code`) inside the terminal, clicking the directory picker and choosing a folder would write `cd "/some/dir"\r` directly into the PTY. This would feed raw keystrokes to the running program, potentially corrupting files or executing random commands within that program.

### 1. How We Detect if a Program is Running
We already have a highly effective terminal screen-scraping detector in `lib/components/term.tsx`:
```typescript
detectInteractiveProgram = (screenText: string): string | null => { ... }
```
This scans the current screen buffer for patterns corresponding to active programs:
- `Claude Code` / `Codex`
- `Python REPL` / `Node REPL`
- `vim`
- `less/man`
- `Nemesis8`

### 2. Preventing Picker Use When a Program is Running

Instead of allowing the user to open the directory picker and then failing or sending attention messages, we should **disable the directory picker entirely** when an active program is running.

#### UX Enhancements:
1. **Disabled Style for Location Bar**:
   In `render()`, we will query `detectInteractiveProgram(this.getTerminalScreenText())` (or keep it in a lightweight state variable updated on terminal data/renders).
   If a program is running:
   - Change the cursor of `.term_locationBar` from `pointer` to `not-allowed`.
   - Dim the background of the location bar (`opacity: 0.5`).
   - Change the folder icon to a locked folder icon (`ti ti-folder-off` or a lock icon `ti ti-lock`).
   - Show a helpful tooltip: `Directory browsing disabled while ${activeProgram} is running`.

2. **Intercept Open Actions**:
   - In `toggleDirNavigator()`, check if a program is running. If so, do not open the picker and instead fire a gentle notification or flash the location bar to indicate it is locked.
   - Intercept the `Ctrl+O` hotkey in `onKeyDown` and prevent it from opening the directory navigator if an active program is detected.

---

## Code Changes Map

| File | Component / Section | Change Description |
|------|--------------------|--------------------|
| `lib/components/term.tsx` | `componentDidUpdate` | If `sessionCwd` changes and `isDirNavigatorOpen` is true, call `loadNavigatorDirs(sessionCwd)` to refresh the directory list. |
| `lib/components/term.tsx` | `toggleDirNavigator` | Check `detectInteractiveProgram()` before opening. If active, block opening and show a visual alert/toast. |
| `lib/components/term.tsx` | `render()` Location Bar | Retrieve `activeProgram`. If present, apply disabled styles, change folder icon to a locked state, and disable `onClick` handler or show a locked tooltip. |

---

## Verification Plan

1. **Manual Sync Test**:
   - Open a terminal tab and click the folder icon to open the directory picker.
   - Run a command in the terminal like `cd ../` or `cd /etc`.
   - Verify that the open directory picker automatically refreshes its directory view to match the new location.

2. **Program Guard Test**:
   - Open a terminal tab and launch `python` or `vi`.
   - Verify that the location bar immediately dims, the folder icon changes to a locked/disabled icon, and the cursor changes to `not-allowed`.
   - Attempt to click the location bar or press `Ctrl+O`; verify that the picker does not open and no commands are sent to the running program.
   - Exit the program and verify the picker instantly returns to its active, clickable state.
