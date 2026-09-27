# Hyperia v0.21.1 — no more phantom tabs 👻

One fix: shells that lost their tab come back.

## Lost tabs come back

Sometimes a shell kept running after its tab disappeared from the tab bar, for example after closing panes or when the window reloaded. You couldn't see it, but it was still there:

- agents calling `terminal_status` listed a tab you had no way to reach;
- closing the window warned about a pane you couldn't find.

Hyperia was supposed to put these shells back in a tab automatically, and **Recover Panes** was supposed to do it on demand. Neither ever did: the recovered shell was treated as a restore, and restores don't create tabs. Now a shell that loses its tab gets a new one within a few seconds, in the background, without moving you away from what you're working on. The tab bar, the close warning and what agents see now match.

Coming from further back? [v0.21.0](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.21.0) added sticky runs, splits in every direction and full-page screenshots.
