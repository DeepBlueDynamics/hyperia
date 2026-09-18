# Hyperia v0.19.7 — a tab is a tab 🗂️

Saved layouts are "saved tabs" now, they come back under the name you saved them, and the "+" menu stops jumping around.

## "Saved Tabs", not "workspaces"

Inside Hyperia a *workspace* is the directory mapped into an agent's container, so calling a saved tab layout a "workspace" was overloaded. Tab-scoped saves are **tabs** throughout now: the **+** menu heading reads **Saved Tabs**, the tab right-click is **Save Tab…**, the save dialog is **Save Tab**, and the pane picker's list — previously "Saved Sessions" — is **Saved Tabs** too. (Whole-app `workspace` saves and the `workspace_*` tools keep the name; those really are app-wide snapshots.) The agent-config badge in the picker is now capitalized: **Configure**.

## A restored tab keeps the name you saved it under

Rename a tab to "Bob", save it as "Bob two", then restore it — and it used to come back as "Bob". The restore was reading the name baked into the layout at save time instead of the name on the saved entry. It now uses the entry name, so **"Bob two" comes back as "Bob two"**.

Restoring a copy while the original is still open — a deliberate "give me another one" — now adds a file-style suffix: **Bob (2)**, **Bob (3)**. The number is worked out at restore time, so a second copy never stacks up "(2) (2)".

## The "+" menu holds still

Two small fixes to the new-tab menu: the two-click **Delete?** confirm on a saved row now reserves its space, so the row no longer jumps when the trash icon turns into "Delete?". And the quick-layout previews are centered and evenly padded — they were skewed to the right on Windows and had no padding at all on Linux.

Coming from further back? [v0.19.6](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.19.6) is where the pane started remembering what it was running on restore.
