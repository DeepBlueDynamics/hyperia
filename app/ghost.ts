// Legacy ghost chat BrowserWindow has been removed. The agentic chat
// surface is now the shell pane (HTML served by the sidecar at /shell,
// rendered inside a Hyperia `webUrl` pane via lib/components/web-pane.tsx).
// This file used to be ~1300 lines: buildHyperiaHtml(), openHyperia(), and
// supporting helpers. All of that lived in app/ghost.ts at git HEAD up to
// commit 3ee2f446 (2026-05-20) — full history retrievable with
// `git log -p app/ghost.ts`. Feature parity confirmed:
//   * SSE event grammar (text_delta / tool_start / tool_result /
//     show_widget / stats / watercooler / retrying / done / error) →
//     shell.html handleEvent()
//   * Soft-preemption injected-row styling → shell.html .row.user.injected
//   * History seeding on load → shell.html seedHistory()
//   * Reset / continue flows → shell.html hardwired commands `reset` /
//     `continue` (cmdResetConversation, cmdContinue)
//   * Stale auto-reset on boot → shell.html maybeAutoResetIfStale()
//   * window.onerror → /api/log forwarding → shell.html postClientLog()
// Consciously dropped (cosmetic / superseded):
//   * Emoji picker (asset paste/drop covers media attachment)
//   * Retro CRT HUD strip (compact titlebar HUD is the new look)
//   * Long-form "I'm Hyperia..." intro greeting (level-aware one-liner
//     from /capabilities replaces it)
//   * Frameless drag titlebar + traffic-light buttons (web pane gets
//     Hyperia's chrome instead)
//   * /api/ghost/window-closed ping (not relevant to a web pane)
//   * 'ACTION:open_settings' IPC bridge from tool_result (the agent uses
//     mcp__hyperia__settings_set directly now)

import {app, BrowserWindow, ipcMain} from 'electron';

export function initHyperia() {
  // Routes the legacy `open-ghost` IPC (still fired by the right-click
  // "Ask Hyperia" menu entries in lib/components/{web-pane,tab}.tsx and
  // app/ui/contextmenu.ts) to opening the shell pane via the focused
  // window's rpc channel — same channel used by the
  // pane:openWebPane command in app/commands.ts.
  ipcMain.on('open-ghost', () => {
    const port = process.env.HYPERIA_PORT || '9800';
    const shellUrl = `http://localhost:${port}/shell`;

    const win = BrowserWindow.getFocusedWindow();
    const rpc = (win as unknown as {rpc?: {emit: (channel: string, data: unknown) => void}} | null)?.rpc;
    if (win && rpc) {
      rpc.emit('open web pane req', {url: shellUrl});
      return;
    }

    // No Hyperia window currently focused (invoked from menu bar / tray /
    // external sender). Create a fresh window. The user can then
    // right-click → Hyperia Shell once it loads, or re-trigger
    // `open-ghost` and the window-focused branch above will take over.
    (app as unknown as {createWindow?: () => BrowserWindow}).createWindow?.();
  });
}
