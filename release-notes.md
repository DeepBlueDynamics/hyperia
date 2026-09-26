# Hyperia v0.20.21 — tabs that stay put, folders one click away 📂

Fixes for moving panes between tabs, a way to jump from a pane to its folder, and a cleaner shell list on Linux and macOS.

## Move pane to new tab works

Moving a pane into a new tab used to leave the old tab pointing at it, so clicking either tab showed the moved pane and the old tab only came back after closing the new one. Each tab now selects itself.

## Open the folder in your file browser

Right-click the path pill in the pane bar for **Open in Explorer** (Windows), **Open in Finder** (macOS) or **Open in File Manager** (Linux), plus **Copy Path**. The directory picker's footer has the same button for the folder you're browsing. It's disabled when the folder isn't on this machine.

## Only shells this machine can run

On Linux and macOS, profiles from old configs that point at Windows shells or shells that aren't installed (a `/bin/zsh` on a box without zsh, "Claude Code (macOS)" on Linux) are dropped when the config loads. Your config file isn't rewritten.

## Agents

- The mail notice names the pane that sent the newest unread message and when, in UTC: `Latest from Clear Bee (pane 11e87950) at 2026-09-26T18:04:12Z`.
- n8 containers' liveness pulse is accepted again. Containers now carry their own agent identity; Hyperia maps it to the pane it's bound to, so busy agents stop getting poked.
- Telemetry accepts **Edit** events: which file, which lines, lines added and removed, per pane. nemesis8 0.26.3 sends them from its file-edit tools.

## Housekeeping

- Removed the leftover Hyper auto-updater, which pointed at Vercel's update server, and every hyper.is link.
- GitHub issues now post to Discord when opened, closed or commented on.

Coming from further back? [v0.20.20](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.20.20) gave every agent its own voice and added the web pane Stop button.
