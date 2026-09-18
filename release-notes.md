# Hyperia v0.19.6 — the pane remembers what it was doing ✍️

Save a tab with vim open and get vim back, on the same file, when you restore it.

## Running commands come back on restore

Saving a tab workspace already recorded each pane's working directory, but the resume-once checklist in the save confirm only ever listed nemesis8 sessions. Anything else running in a pane (vim, nano, `npm run dev`, an ssh session) was silently dropped, so a restored workspace was a row of bare shells in the right directories.

The cause was a gap between main and renderer: shell integration reported the running program on every `preexec` (the OSC 697 command line), but the field the save confirm looked at was never filled, and the renderer's idea of a busy pane (`busy`) never matched what main actually reports (`running`). The confirm now reads the shell-reported command line, exactly as you typed it and relative to the pane's directory, and treats a pane as running when either side says so.

Those rows are **pre-checked**, same as n8 resumes: what was running is what you expect back. Untick one to keep that pane as a plain shell. The safety rule is unchanged: only the shell-integration-reported command or an n8 session binding can ever be executed on restore, and the screen scrape is still display-only.

## Bash panes report their first command again

With [bash-preexec](https://github.com/rcaloras/bash-preexec) loaded from `~/.bashrc` (common on Ubuntu and Pop!_OS setups), a fresh bash pane never reported the first command you typed. bash-preexec replaces the DEBUG trap at the first prompt and re-invokes Hyperia's hook as one of its own preexec functions, and Hyperia's history-number dedupe had already recorded that number while bash-preexec's install commands ran under the prompt, so the first real command matched the guard and was dropped. Open vim in a new pane, save, and the pane looked idle.

The bash integration now detects bash-preexec and registers with its `preexec_functions` / `precmd_functions` arrays instead of fighting it for the DEBUG trap. That also reports the full typed line (`echo hi | cat`, not just `echo hi`). Without bash-preexec, the DEBUG-trap path stays, deduped by a prompt marker instead of the history number, and it handles bash 5.1's array-valued `PROMPT_COMMAND`.

## Whole-app restore runs resume-once too

A workspace file carrying `resumeOnce` behaved differently depending on how you brought it back: the **+** menu tab restore ran it, `workspace_restore` and the boot restore ignored it. Both paths now honor it the same way.

## Web panes

Web panes already track in-page navigation into the saved URL, so a restored web pane loads the page it was last on. `docs/workspace-format.md` now says so explicitly.

## Save confirm lists your saved workspaces

Under the name field, the **Save Workspace…** confirm now lists the tab workspaces you already have, newest first, with their pane counts. Click one to prefill its name; the button switches to **Overwrite** right away, so replacing a saved layout is one click plus Enter. Edit the name and it goes back to a plain save.

## Sticky notes, rebuilt underneath

The two oversized sticky files — a 1,655-line main and a 2,175-line renderer — were split into cohesive modules with one owned show/hide path, which is what finally nailed the recurring "hidden stickies come back on start" symptom for good. Same notes, same files on disk; nothing moves on your screen.

Sticky windows also run locked down now: web security on, a strict content-security policy, no stray navigation or popups, and AI highlight rules validated and escaped before they touch the page — a malformed or hostile rule can't inject anything or break out of its attribute. Deeper renderer isolation is tracked separately in #208.

## Closing the last window no longer takes four seconds

Closing a window saves the whole session first, then destroys the window. But the app's own close hook ran on that first, held close pass and tore the window down immediately: its rpc destroyed, its shells killed, and the window dropped from the capture set. The save then found zero windows, the sidecar refused the empty workspace, the fallback fired on a dead rpc, and only a 4-second failsafe finally closed the window. Every last-window close took 4 seconds and saved nothing, so a quit from the tray afterwards had nothing to write either.

Teardown now waits for the window to actually be gone (`closed`); only geometry is recorded on the close pass, while the window is still alive. Measured in the dev build: close is 70 ms including a successful save, and a tray quit with no windows left skips the pointless save and exits in under 100 ms. The quit and close paths also log an elapsed-time trail (`[quit +Nms] …`, `[close +Nms] …`) so a slow shutdown can be attributed to a stage.

## The tray icon opens a window again

A side effect of that close rework: after the last window closed, the app kept a reference to the now-destroyed window, so clicking the tray icon (or asking for a new window) tried to show the dead one — nothing opened, and on Linux it surfaced an "Object has been destroyed" error. The window is now dropped the instant it's gone, and the tray and new-window paths never receive a destroyed window, so clicking the tray with nothing open reliably opens a fresh one.

## Housekeeping

- The **Hyperia Agent** text link under the new-pane picker is replaced by **configure**, which opens the agent configuration view in that pane. Launching the agent stays in the picker's agent combobox (once configured), the tab-bar context menu, and the **A** hotkey.

- `workspace-capture` unit test caught up with the hidden-stickies restore change from v0.19.1 (its sticky stub lacked the new read).

Coming from further back? [v0.19.1](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.19.1) made hidden stickies stay hidden; [v0.19.0](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.19.0) added the Saved Sessions pulldown and a quieter close prompt.
