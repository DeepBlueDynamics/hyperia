# Hyperia v0.20.2 — agents get mail 📬

Agents stop shouting into each other's panes. They now have a mailbox, deliveries you approve actually go through, and every permission is tied to a real identity instead of a display name.

## An inbox for every agent

Agents used to talk to each other by typing raw text into the other pane: no length limit, no record, no reply channel. There's now a local mailbox:

- **`msg_send`** leaves a durable message for an agent or a pane, up to 16 KB.
- **`msg_inbox`** previews your mail, **`msg_check`** fetches your unread mail and marks it read, **`msg_read`** acknowledges one message, and **`msg_search`** searches what you've sent and received.

The recipient gets a short, coalesced "you've got mail" notice in its pane. The notice never carries the message body, and it doesn't wait for the agent to go quiet first. Mail is addressed to a verified identity, never a display label, and an agent that runs under its own token links itself to its pane with **`pane_bind`**.

Typing a long message straight into another agent's pane is capped at 512 characters, and the error points you to the mailbox. Pass `allow_long` if you really need to paste it.

## "Allow" actually does the thing

Previously, approving an agent's request after the ~8 second wait granted the permission but dropped the action, so the agent had to try again. Now the request is saved first and a worker runs it once you approve. Each request gets an operation ID you can look up with **`delivery_status`**, retries don't create duplicates, and if Hyperia isn't sure a write reached the pane it won't blindly send it again.

## Permissions follow identities, not names

Grants, owners and consent now use a canonical identity key (`agent:<name>` / `pane:<id>`). A display label can no longer inherit someone else's access. On first launch your saved permissions are migrated once. Any grant that can't be tied to a single known agent is dropped, and that agent will ask again. Pane and tab streams check permission on every keystroke, and anonymous viewers stay read-only.

## Safer ways to type into panes

- **`terminal_run`** only runs at a real shell prompt. It refuses to type a shell command into an agent or a busy pane.
- **`pane_send`** is the new way to hand an agent text, with Enter as a separate step.
- **`terminal_keys`** is for explicit control keys and never adds an Enter on its own.

Automated re-pokes now say what they are: **`[Hyperia auto-poke …]`**, *not a person messaging you*, and how to stop it with `pane_pulse_clear`. The tool descriptions also warn that raw control characters sent into another agent's pane can crash it.

**Heads-up for scripts and clients:** refresh your tool list after upgrading. `/api/type-and-collect` now returns a saved shell operation instead of screen output, so read the output explicitly with `terminal_screen`.

## Also fixed

- **2×2 quick layout:** the original pane no longer gets a scrollbar with its old prompt pushed into scrollback when you apply the layout.
- **Restored tabs:** a tab you never renamed now gets a "(2)" suffix when you restore a copy while the original is still open, the same as renamed tabs.

Coming from further back? [v0.19.7](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.19.7) is where saved layouts became "saved tabs".
