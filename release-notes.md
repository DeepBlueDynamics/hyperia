# Hyperia v0.20.12 — install runs in a real shell 🐚

A small follow-up to v0.20.11: the install and update **run** buttons in the new-pane picker now open a plain shell instead of whatever your default profile happens to be.

## Install and update open the right shell

The picker's **run** button (for the Hyperia update line and the agent installers) opens a new pane with the command typed in, waiting for you to press Enter. It used to open your *default* profile. If that was a custom shell, say one that launches Claude, the install command went into Claude instead of a shell.

Now **run** always opens your system's own shell, picked from the shells Hyperia already detected. Nothing is hardcoded:

- **Windows:** the newest PowerShell 7 (`pwsh`) Hyperia finds, whether it's installed under Program Files, as a 32-bit install, or from the Store or winget. Without one it falls back to Windows PowerShell, then cmd.
- **macOS / Linux:** your login shell, then zsh, then bash.

Custom shells and agents are never picked. In PowerShell, the update command is now plain `irm https://hyperia.nuts.services/install.ps1 | iex` rather than the `powershell -c "…"` wrapper, which forced Windows PowerShell 5.1.

## No Windows shells on a Mac

A config synced from a Windows machine can carry Windows-only shells such as `C:\…\pwsh.exe`. The custom-shell setup used to list them as base shells on macOS and Linux, and could even pick one as the default. It now offers only plain shells that exist on the current platform.

Coming from further back? [v0.20.11](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.20.11) is the big one: a directory picker that fits any pane, correctly sized terminals, two-level bells, and a separate identity for every agent session. [v0.20.2](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.20.2) gave agents a mailbox and made "Allow" actually run the approved action.
