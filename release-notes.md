# Hyperia v0.18.2 — reach and prune your saved sessions 🗂️

Saved sessions grow up: they're now in the pane picker as well as the `+` menu, you can delete the ones you don't need, and the tab-bar menus that list them finally sit *above* your web panes instead of behind them.

## Tab-bar menus sit above web panes

The `+` new-tab dropdown (layouts + saved sessions), the **New Window** tooltip, and the **New Stickys** tooltip all drop down over the pane area — where a native web pane painted right on top of them, so you couldn't see the menu. Hovering the button cluster now pulls the window's web panes to a frozen still (no blank) for as long as you're in the menu, so it renders on top; the live page returns the moment you leave.

## Saved Sessions in the pane picker

The "pick a shell / agent / URL" picker now has a **Saved Sessions** list too, mirroring the `+` menu. Click one to restore it into a new tab — so a saved layout is reachable from the place you're already choosing what to open.

## Delete saved sessions

Every saved-session row — in both the `+` menu and the picker — now has a **trash** button with a two-click confirm (trash → **Delete?** → gone). Deleting removes only genuine tab-workspaces (the name is path-sanitized and scope-checked), and every open menu refreshes at once.

## Also

- Both lists cap their height and scroll, so a large library never runs off the bottom of the screen.

Coming from further back? [v0.18.1](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.18.1) was the previous published build.
