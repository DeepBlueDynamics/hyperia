# Hyperia v0.21.8 — downloads, a comms dashboard, and agents that hear their mail ⬇

Web panes can download files properly, the dashboard gains a live comms view, and agents running in n8 containers now get their mail notices.

## Agents get their mail

Agents running inside n8 (Docker) containers never saw the "[Hyperia mail]" notice: their mail was stored, but nobody told them, and typing into their pane was refused as "not a supported agent". Hyperia now recognizes n8 by the whole process chain (`n8 → docker attach`), even when it runs a gateway alongside or the shell didn't record it. Agents running a tool still count as the agent.

## Downloads in web panes

- Downloads go straight to your Downloads folder, no Save dialog, with Chrome-style names (`report (1).pdf`).
- A progress toast shows the file, size and a bar, with **Pause/Resume** and **Cancel**. When it finishes: **Open** and **Show in folder**.
- A new **Downloads** button in the web pane header lists recent downloads, kept across restarts.

## Toasts and prompts over web pages

- Bottom-right toasts (drag-drop copies, downloads, audio, update notices) now draw above web panes instead of hiding behind them.
- Agent permission cards ("run JavaScript in a web pane", "open a tab"…) now sit in the middle of the window, like the pane-access prompt.
- Dialogs and menus over web panes no longer reappear under the page when another overlay closes. The Open Browser dialog, the pulse popover and every close confirmation now stay on top.

## Dashboard: proto_viz

A new **proto_viz** tab on the dashboard: a live view of who's talking to whom. Agents and panes form a ring, with mail and pane access drawn between them, a sorted top-comms list and live stream, an agent-to-agent mail donut, plus file edits, tokens and services. It shows only who contacted whom and when, never message contents.

## Tabs

- A tab that rings its bell no longer shows just "🔔 …"; the name stays readable.
- Renaming a tab: click-drag and double-click now select text instead of ending the rename.

Coming from further back? [v0.21.7](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.21.7) made mail notices email-style and put toasts above web panes.
