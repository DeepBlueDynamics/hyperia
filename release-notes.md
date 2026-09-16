# Hyperia v0.18.1 — prompts on top, panes in their place 🧹

A tidy-up release: toasts and consent prompts stop hiding behind (or blanking) web panes, Quick Layout opens where you actually are, hidden sticky notes stay hidden across a restart, and agents finally hear back the moment you grant or deny their access.

## Toasts and prompts sit above web panes — without blanking the page

Native web panes paint above the app's own UI, so a DOM overlay had only bad options: hide behind the page, or — if we pulled the page off-screen to show the overlay — leave a blank white rectangle (that's what happened when you saved a workspace over a web pane).

Now, whenever an overlay needs the foreground, Hyperia hands the renderer a **frozen still** of the live page first, then swaps the native view out. The page looks frozen, not blank, and the overlay renders cleanly on top. This fixes the Save-Workspace toast (no more blank), the close-confirm dialog, and the cross-pane **consent / ACL prompt** — which could previously sit invisibly behind a web pane, so you never saw what an agent was waiting on.

## Quick Layout opens where you are

Splitting a pane inherits its working directory; the Quick Layout presets didn't — the new pickers were born in your home directory instead of the folder you triggered the layout from. They now inherit the source pane's cwd, exactly like a split, so the shell you pick lands in the right place.

## Hidden sticky notes stay hidden

If you'd hidden your stickies (Hide All), a restart reopened them all — because the boot restore reopened saved sticky windows without honoring the hidden state. Restore now keeps hidden notes hidden.

## Agents hear your access decision

A gated tool call returns "held — waiting for approval," but some third-party CLIs treat that as a hard failure and never retry, then act as if they still lack access you've since granted. When you allow or deny a request, Hyperia now pokes the **requesting** agent's own pane with the outcome, so it proceeds (or stops) without you relaying it by hand.

## Also

- Retired the legacy Hyper e2e-screenshot PR-comment workflow (it had been failing on every PR).

Coming from further back? [v0.18.0](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.18.0) was the previous published build.
