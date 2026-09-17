# Hyperia v0.19.1 — hidden stickies, actually hidden 📌

The one where hidden sticky notes stop coming back on start. For real this time.

## Hidden stickies stay hidden — a hard invariant

If you'd hidden your stickies (**Hide All**), they kept reappearing every time Hyperia started. The earlier fixes each closed one door and missed the next: showing a sticky isn't done in a single place, so a restore-path race, a focus, or a note update could still slip one back onto the screen.

This release enforces it at the window itself: a note that was restored while Hide-All is active **re-hides itself the instant anything tries to show it**, until you explicitly **Show All** (or open that one note yourself). No matter which path calls show, the note snaps back down. Hidden means hidden.

Coming from further back? [v0.19.0](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.19.0) added the Saved Sessions pulldown, the R hotkey, and a quieter close prompt.
