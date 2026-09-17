# Hyperia v0.19.2 — the pane remembers what it was doing ✍️

Save a tab with vim open and get vim back, on the same file, when you restore it.

## Running commands come back on restore

Saving a tab workspace already recorded each pane's working directory, but the resume-once checklist in the save confirm only ever listed nemesis8 sessions. Anything else running in a pane (vim, nano, `npm run dev`, an ssh session) was silently dropped, so a restored workspace was a row of bare shells in the right directories.

The cause was a gap between main and renderer: shell integration reported the running program on every `preexec` (the OSC 697 command line), but the field the save confirm looked at was never filled, and the renderer's idea of a busy pane (`busy`) never matched what main actually reports (`running`). The confirm now reads the shell-reported command line, exactly as you typed it and relative to the pane's directory, and treats a pane as running when either side says so.

Those rows are **pre-checked**, same as n8 resumes: what was running is what you expect back. Untick one to keep that pane as a plain shell. The safety rule is unchanged: only the shell-integration-reported command or an n8 session binding can ever be executed on restore, and the screen scrape is still display-only.

## Whole-app restore runs resume-once too

A workspace file carrying `resumeOnce` behaved differently depending on how you brought it back: the **+** menu tab restore ran it, `workspace_restore` and the boot restore ignored it. Both paths now honor it the same way.

## Web panes

Web panes already track in-page navigation into the saved URL, so a restored web pane loads the page it was last on. `docs/workspace-format.md` now says so explicitly.

## Housekeeping

- `workspace-capture` unit test caught up with the hidden-stickies restore change from v0.19.1 (its sticky stub lacked the new read).
