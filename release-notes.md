# Hyperia v0.17.69 — save a tab, get it back 📑

Workspaces learn to work one tab at a time, tab screenshots stop leaving web panes blank, and Google Maps stops flashing white while you drag it.

## Tab-scoped workspaces

Right-click a tab and choose **Save Workspace…**. A confirm toast opens with the name pre-filled from the tab, plus a **resume-once checklist**: each pane's detected command with a checkbox. Nemesis8 session resumes are pre-checked; plain shell commands are opt-in. Saving writes a single-tab workspace into the same library the whole-app workspaces already use, so every `hyws` and MCP verb works on it.

To bring one back, hover the **+** button. Beneath the layout presets there is now a **Saved Workspaces** section. Clicking a row grafts that tab *additively* into the current window: your existing tabs stay put, the restored tab gets fresh pane ids, missing working directories are bannered, and focus follows because you asked for it.

`resumeOnce` is the one deliberate exception to "restore never executes". It is recorded only from the boxes you tick at save time, and its value can only come from the pane's n8 session binding or the shell-integration-reported command of a pane that was actually busy. The screen scrape is never promoted to a command. The format is documented in `docs/workspace-format.md` under *Scopes* and *resumeOnce*.

## Tab screenshots include web panes

The whole-tab screenshot (`tab_snapshot`) is a renderer capture, and web panes are native views the renderer never paints, so a tab with a web pane came out with a blank hole. Each on-screen web pane is now captured from main and composited onto the base shot at its bounds. Scale factor comes from the captured image itself, so HiDPI and Linux UI zoom land correctly. Panes parked off-screen from other tabs are filtered out, and if compositing fails you still get the terminals-only shot.

## Web panes stop reloading on page-driven URL changes

Google Maps rewrites the URL with `history.replaceState` continuously while you pan. Hyperia reported that change, persisted it, and then treated the round-trip as a navigation request, calling a full `loadURL` on a page that was already there. The result was a white flash and the map rebooting to whatever coordinates the URL held mid-drag. Chrome never turns `replaceState` into a load, which is why it never reproduced there.

Two guards now stop the echo, either sufficient on its own. The renderer remembers the last page-reported URL and skips the load when the new prop is just that echo. The manager skips a load whose target already equals the current URL. Pressing Enter in the URL bar on the current URL still reloads, matching Chrome. The temporary click marker in Maps, which the mid-drag reload used to wipe, comes back for free.

This addresses the root cause in #160. The issue stays open for a hands-on Maps pass and the separate freeze-during-drag hardening idea.

## Also

- Web pane manager gained a `web-panes:capture-for-window` IPC handler used by the tab screenshot compositor.
- Sidecar workspace validation enforces exactly one window when `scope` is `tab`, with new round-trip tests.

Coming from further back? [v0.17.67](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.17.67) was the previous published build.
