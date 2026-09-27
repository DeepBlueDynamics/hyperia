# Hyperia v0.21.0 — stickies that run themselves ⏰

Stickies can now run on a schedule and hand their prompt to an agent. This release also adds splits and clones in every direction, full-page screenshots, and a sturdier bridge between Hyperia and its sidecar.

## Sticky runs

A sticky now has three parts: the **prompt** you write, a **result** (Markdown, replaced each run) and a **footer** showing the last run, the next run, status, errors and history.

- **When:** Now, At a time, or Every: an interval, daily, weekly, or a cron line. Schedules follow local time through DST changes. A missed run catches up once, runs never overlap, and you can pause and resume.
- **Run:**
  - **Notify** just reminds you.
  - **Agent** sends the prompt to nemesis8, starting `n8 serve` if it isn't running.
  - **Pane** delivers the prompt to a pane you pick by name.
- **Approvals:** a run aimed at a pane, or created by an agent, waits for you to approve it. While a run is armed the prompt is locked; pause it to edit.
- **Links:** stickies link to web pages, to other stickies with `[[Sticky]]` or `sticky:<id>`, and open only http, https and mailto links outside.
- **Delete:** deleting a sticky now asks in a styled panel, not the system dialog.
- **MCP:** agents get `sticky_note_run`, `sticky_note_runs`, `sticky_note_history`, `sticky_note_pause` and `sticky_note_unschedule`, and can write a sticky's result. `sticky_note_schedule` is gone.

## Split and clone in every direction

Split Up and Split Left, plus Clone Up and Clone Left, now have commands and default shortcuts. That's **Ctrl+Shift+<** and **Ctrl+Shift+"** to split (Cmd on macOS), with Alt added to clone. They're in the Shell menu and both context menus. The pane bar's hints come from your actual keymap, so your own bindings show there too.

Clone copies the source pane's profile and folder, plus the program it's running when shell integration knows it (e.g. `n8 --danger`). In Quick Layouts, **Shift+click** clones the current pane into every new pane; a plain click still opens pickers. The Quick Layouts previews are centered in their tiles now.

## Full-page screenshots

**Shift+click** the camera in the pane bar to capture everything: the whole web page, or a terminal's entire scrollback. A plain click still captures what's on screen. Both copy to the clipboard and save to `~/.hyperia/snapshots`.

## Fixes

- In nested splits, the right column no longer runs past the window edge and clips the close ×. The same fix applies to the bottom row.
- Renaming a tab that shows a 🔔 stays on one line and shows the whole name.
- If the sidecar's link to the window died silently, commands used to hang with no log. Hyperia now spots it, reconnects and logs the crash.

## Agents

- When a nemesis8 container restarts in the same pane, it keeps the permissions you already granted there, instead of asking again under its new random name. The prompt names the pane: "n8-olive-crow (in pane Eldest Dog)".
- An Enter an agent sent while you were typing is now submitted once the pane is free, so mail notices no longer sit unsent.
- `terminal_status` labels each pane as a terminal or web pane. It also names the calling agent's own pane and lists ready-to-use tool calls with pane IDs filled in: a web page beside a pane, a new shell, reading a pane and closing one. The MCP instructions explain the window → tab → pane layout.

## Housekeeping

- Canary CI builds are now unsigned build checks. Releases are still signed, and notarized on macOS.
- `docs/ui-debugging.md` and `scripts/cdp.js` show agents how to check UI fixes in a running window.

Coming from further back? [v0.20.21](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.20.21) fixed moving panes between tabs and added Open in Explorer.
