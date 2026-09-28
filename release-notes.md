# Hyperia v0.21.4 — tabs that behave, stickies that save 🧹

A cleanup release: stray tabs, stuck web pages and lost sticky text are fixed, and saved tabs got autosave.

## Stickies save again

Text typed into a sticky since v0.21.0 wasn't being saved. It is now. **Before updating, copy out anything you typed into a text sticky on 0.21.0–0.21.3**: the restart loses text that was never saved.

New stickies also open at a size that suits your screen and grow to fit their content, and notes created through the API get the position and size they asked for.

## No more stray tabs

Hidden shells kept turning into surprise tabs, and agents saw tabs you couldn't. Three leaks caused it:

- **Closing a split tab** crashed partway, so its other panes' sessions never closed.
- **Launching from a picker** (or switching a pane back to a picker) left the old session running with no pane. The **Picker** menu item even left your shell running, hidden.
- Leftovers were saved into the last session and brought back on every launch.

All three are fixed. If a stranded session still turns up, Hyperia now closes it quietly instead of opening it as a tab.

## Web panes

- A reload no longer leaves half a web page stuck over every tab.
- A web page closing unexpectedly no longer crashes Hyperia.

## Saved tabs and autosave

- **Autosave a saved tab:** tick "Autosave changes to this tab" in Save Tab, and every folder change, split, rename or web URL change is saved about 2 seconds later. The tab's top line pulses when it saves, and when you click **Save**.
- Autosave keeps working in tabs full of busy agents. It saves at least every 10 seconds, and only when something you'd get back on restore has changed.
- Restoring a saved tab that autosaves keeps autosaving. Deleting it stops autosave from re-creating it. Only one tab autosaves to a given name.
- **n8 panes keep `--danger`:** each n8 row in Save Tab has a **danger** toggle, on by default for panes started with `--danger`, and restore resumes them the same way.
- The pane count next to saved tabs is a bright window badge, and the delete button sits right beside it.
- Deleting the last saved tab no longer maximizes the window. Double-clicking inside the header's menus no longer does either; only empty header space does.

## Also

- New windows open in the folder you were last in, even after a restart.
- **Tab** in the directory picker's search box completes the highlighted folder instead of jumping to the picker behind it.

## For contributors

`node scripts/dev-harness.js` runs a sandboxed copy of Hyperia and checks all of the above end to end. It never touches your own `~/.hyperia`.

Coming from further back? [v0.21.1](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.21.1) fixed hidden tabs coming back; [v0.21.0](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.21.0) added sticky runs.
