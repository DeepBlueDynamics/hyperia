# Hyperia v0.16.19

Highlights since v0.16.15 — the web-pane experience gets a lot steadier, and links become actionable everywhere.

## Web panes — no more frozen / flashing pages
- **Fixed panes getting stuck as a dead, flashing screenshot (#156).** A native browser view is hidden behind a still-frame while DOM chrome/consent prompts show over it; a leaked consent prompt used to hide **every** web pane indefinitely (now auto-expires), and a transient page-reflow blip no longer hides the live view (debounced). So the page stays live and interactive.
- **Fixed the one-frame flash (#155)** when mousing between a page and its pane controls — the still-frame and the native view now overlap across the swap, so there's never a hole.
- **Links that open a new tab** (`target="_blank"` / `window.open`) now open a **new Hyperia tab** by default instead of splitting below. Configurable via `config.webPaneLinkTarget` — `"tab"` (default) / `"split-right"` / `"split-down"`. OAuth pop-ups still go to the system browser.

## Link actions — in notes and terminals
- **Left-click a URL → copies it** + a toast ("Link copied · right-click for options").
- **Right-click a URL in a note →** Edit Link · Open in Browser · Open in Web Pane · Copy Link.
- **Terminals:** left-click a URL copies it + toast; Ctrl/Cmd+click opens it.

## Fixes
- **Splash** no longer floats over — or steals focus back from — another app if you click away during startup.
- **Directory navigator:** Ctrl+Enter on a fresh (chooser) pane now launches the default shell **in the chosen directory** instead of silently doing nothing.
- **Linux packaging** (`.deb` / AppImage) unbroken — a `${os}` token in a comment was crashing electron-builder's fpm step.
- Shell detection & config resilience from v0.16.15 carried forward (PowerShell 7 found at any install path; malformed profiles can't break startup).

## Known issues
- **Google Maps (and similar) can flash white + reset on drag** — a freeze-during-drag gap in the web-pane layer. Tracked in **#160**.
- The **terminal right-click *link* menu** and a persistent link **overline** affordance are still pending. Tracked in **#158**.

## Signing & platforms
| Platform | Status |
|---|---|
| **Windows `.exe`** | **Authenticode-signed** (Azure Trusted Signing · DeepBlue Dynamics LLC) |
| **macOS `.dmg`/`.zip`** | Unsigned — Gatekeeper prompt (right-click → Open) |
| **Linux `.deb`/AppImage** | Unsigned |
