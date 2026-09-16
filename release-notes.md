# Hyperia v0.18.0 — Saved Workspaces 🗂️

The minor bump is named for the feature that earns it: **saved workspaces** now work one tab at a time. Any tab — its layout, directories, web panes, and the commands worth resuming — becomes a workspace you can bring back with a click. This release rounds that out: the save toast now sits above web panes, and a tab screenshot tells you it worked.

## Tab-scoped workspaces

Right-click a tab and choose **Save Workspace…**. A confirm toast opens with the name pre-filled from the tab, plus a **resume-once checklist**: each pane's detected command with a checkbox. Nemesis8 session resumes are pre-checked; plain shell commands are opt-in. Saving writes a single-tab workspace into the same library the whole-app workspaces already use, so every `hyws` and MCP verb works on it.

To bring one back, hover the **+** button. Beneath the layout presets there is now a **Saved Workspaces** section. Clicking a row grafts that tab *additively* into the current window: your existing tabs stay put, the restored tab gets fresh pane ids, missing working directories are bannered, and focus follows because you asked for it.

`resumeOnce` is the one deliberate exception to "restore never executes". It is recorded only from the boxes you tick at save time, and its value can only come from the pane's n8 session binding or the shell-integration-reported command of a pane that was actually busy. The screen scrape is never promoted to a command. The format is documented in `docs/workspace-format.md` under *Scopes* and *resumeOnce*.

## The save toast now sits above web panes

Native web panes paint above the app's own UI, so in a tab with a web pane the Save Workspace toast was hidden behind the page. The window's web panes are now pulled off-screen while the toast is open — the same move the close-confirm dialog makes — and restored the moment you save or cancel.

## Tab screenshots confirm themselves

Right-click a tab → **Screenshot** copies the whole tab — terminals, header bands, and any web panes composited in from their native views — to the clipboard. The tab name now flashes **"Screenshot copied ✓"** so you know it landed instead of leaving you guessing whether anything happened.

## Also

- The release pipeline is now a single publisher: the GitHub release name and notes come straight from this file, so builds stop landing as a bare version number with an empty body.
- A per-run Discord post now summarizes each release with its per-platform build status.

Coming from further back? [v0.17.69](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.17.69) was the previous published build.
