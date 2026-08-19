# Hyperia v0.17.8

Five point releases of hardening since v0.17.3, rolled into one drop. The headliner: **resizing no longer garbles your terminals** — the renderer moved to @xterm/xterm 5.5 with the ConPTY reflow fixes. Around it: consent that *does the thing* when you say ok, folder drops that behave, and clickable approval UI.

## Terminals survive reflow (v0.17.6)

Dragging a split divider or resizing the window could mangle pane content on Windows — characters dropped and scattered, lines spread with gaps (display-only, but ugly). Windows ConPTY re-emits its whole buffer re-wrapped on every resize, and xterm 5.3's Windows handling garbled the repaint. The renderer now runs **@xterm/xterm 5.5** (plus all eight addons at matching versions), which carries the ConPTY reflow fixes. This also improves the stray-artifact behavior in remote TUIs (agents over ssh).

## Consent: saying "ok" does the thing (v0.17.4, v0.17.8)

- **Approving an agent's split or new-tab request now EXECUTES it.** Previously the consent check waited ~8 s inline — approve slower than that and your "Allow" merely recorded a grant while the split itself was silently dropped (the agent had to notice and re-ask). Creates are now held like keystrokes: click Allow, the split happens, and the requesting agent owns the pane it asked for — no second prompt to start driving it.
- **The "agents waiting for approval — click to review" pill actually opens the prompt.** It parks in the frameless window's drag strip, and without `no-drag` a click started a *window drag* instead of dispatching the click. Create-consent toast cards had the same latent flaw on their top edge — both fixed.

## Drag & drop (v0.17.5)

Dropping a **folder** onto a pane copied the folder *and* splattered its contents into the cwd next to it (Chromium expands directory drops into the folder plus each descendant as separate entries). Drops are now reduced to root paths — you get exactly one copy of the folder with everything inside it.

## Linux (v0.17.7)

The min/max/close window controls (frameless CSD) sat comically far apart — oversized 46px cells each holding a glyph the shared header CSS had shrunk to ~10px. Now compact 34px buttons flush together with properly sized icons. Windows overlay and macOS traffic lights untouched.

## Signing & platforms

| Platform | Status |
|---|---|
| **Windows `.exe`** | **Authenticode-signed** (Azure Trusted Signing · DeepBlue Dynamics LLC) |
| **macOS `.dmg`/`.zip`** | Signed + notarized in CI (zips now included — mac auto-update works) |
| **Linux `.deb`/AppImage** | Unsigned |
