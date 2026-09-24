# Hyperia v0.20.11 — the swarm fixes its own house 🐙

Four agents worked inside Hyperia on Hyperia itself, and fixed every bug they ran into along the way. What you get: panes that size correctly, a directory picker that fits any pane, bells that clear the way you'd expect, and agents that each keep their own identity.

## The directory picker fits its pane

The path popup used to run past the bottom of short panes, and focusing its search box scrolled the whole window, hiding the tab bar. Now:

- The path row stays at the top, right under the button you clicked. The search box stays at the bottom, inside the pane, and has focus when the popup opens.
- Folders and recent directories each get their own scrollbar in between. Recents shrink to a single line and never hide entries.
- Resizing the window or pane re-fits the popup instead of closing it, and the top bar never moves.
- The Home shortcut in recents actually shows up now.

## Terminals size and scroll correctly

- **No more duplicated or pushed-down prompts** on quad layouts. A late resize could override a newer size.
- **No gray strip under the last row.** The leftover space below the last row is now the terminal's own background.
- **Codex no longer throws you to the top.** When a program clears the scrollback while redrawing, your scroll position is kept. Scrolling yourself still wins.
- **Startup commands open where you asked.** A `cd` in a startup command is honored for new tabs and splits instead of landing in your home directory.

## Tabs and pane bands

- The tab strip scrolls by whole tabs, a new tab pins it to the far right, and the scroll arrows show hints and draw above web panes. On Windows the arrows stay clear of the title-bar buttons.
- Picker panes hide the navigation arrows, clear-buffer and screenshot buttons, since they do nothing there.
- **Bells work in two levels.** Selecting a tab clears its tab bell. The 🔔 on the pane band stays until you focus the pane that rang.

## Every agent session has its own identity

Every Claude Code session on the same machine used to share one identity through a common token: one mailbox, one set of permissions, one name. Now each MCP session gets its own identity under the token's owner:

- Each session has its own mailbox and can set a unique label with **`set_label`**. A session that reconnects gets the same identity, label and mail back.
- Permissions you've granted the owner carry over to its sessions, but a session's own grants stay with that session.
- The internal credential that links a session to Hyperia never leaves Hyperia. It only works from the local machine, and closing the session revokes it.
- If a second client shows up with a pane's token while the first is still active, it's refused and you're notified. After 60 seconds of quiet, the newcomer takes over. **`whoami`** tells you which kind of credential you're using.

## Agent messaging is more reliable

- Waiting for your approval no longer surfaces as "error sending request". A timeout now says "timed out waiting (possibly for consent); approve and retry", and it's never retried automatically.
- Messages typed into another pane submit properly: Enter goes as its own keystroke. `pane_send` also works with nemesis8 agent panes now.
- The tool list refreshes without a restart, and the "you've got mail" notice fires once per delivery instead of repeating.
- **`msg_check`** can acknowledge just the messages you name with `ack_ids`, and **`delivery_status`** shows live read receipts.
- Two spoken summaries now queue up instead of talking over each other.
- Sticky notes accept `content` as well as `text`, and a parameter the tool doesn't recognize is now an error instead of silently making an empty note.

## Under the hood

- Quieter sidecar logs: MCP protocol chatter drops to warnings, and single log lines are capped at 4,000 characters.
- Fixed an error on quit when window cleanup touched a window that was already closed.
- Test isolation and build-script fixes for the local installer build.
