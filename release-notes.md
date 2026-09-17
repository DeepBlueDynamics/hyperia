# Hyperia v0.19.0 — a sessions pulldown, and a quieter way out 🗂️

Saved sessions grow into a proper pulldown right in the pane picker, hidden stickies finally stay hidden, and closing a window stops crying wolf.

## Saved Sessions is a real pulldown

In the pane picker, **Saved Sessions** is now a type-to-filter combobox — the *same* shape, width, and keyboard flow as **New Shell** and **New Agent**. Pick one (or press **Enter** on a match) to restore that saved layout into a new tab.

- **R** restores your default session, right alongside **S** (shell) and **A** (agent).
- The default — what the box pre-fills and what **R** opens — is the **last session you loaded**, remembered across restarts.
- Every row has a **trash** with a two-click confirm (trash → **Delete?** → gone).

## Right-click works in the picker

Right-clicking a picker pane now opens the **regular** context menu — Split, New Tab / Window, Hyperia Agent, New / Search Stickys, Clear Buffer, Find — just like any other pane. It used to only flash.

## Hidden stickies stay hidden

Stickies you'd hidden kept reappearing on install and restart. Two boot-restore paths both re-open your notes, and one of them was un-hiding a note the other had correctly kept down. They now both honor **Hide** — a hidden sticky stays hidden until you show it.

## A close prompt that only asks when it matters

Closing a window (or quitting) would warn *"a pane is still running…"* even for an idle shell or a picker — then close silently on the second try. The prompt now fires **only when a pane is genuinely running something** (an agent, an ssh session, a build). Idle shells, pickers, and multi-tab layouts are saved and restored on next launch, so there's nothing to warn about.

Coming from further back? [v0.18.2](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.18.2) was the previous published build.
