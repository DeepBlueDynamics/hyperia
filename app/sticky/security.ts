import type {Event, IpcMainInvokeEvent, WebContents, WebPreferences} from 'electron';

import {stickyWindows} from './registry';

/**
 * Explicit security webPreferences for all sticky note windows.
 *
 * NOTE: nodeIntegration: true and contextIsolation: false remain documented
 * technical debt from legacy sticky renderer design, pending full preload migration.
 * webSecurity is explicitly enforced true and insecure content blocked.
 */
export const STICKY_WEB_PREFERENCES: Readonly<WebPreferences> = Object.freeze({
  nodeIntegration: true,
  contextIsolation: false,
  webSecurity: true,
  allowRunningInsecureContent: false
});

/**
 * Install navigation and content isolation guards on sticky note WebContents.
 * Blocks emitted navigation/redirect events, window opening, and webviews.
 * Electron about:blank navigation can bypass these events (electron/electron#21136).
 * Full renderer isolation remains tracked in Hyperia #208.
 */
export function installStickySecurityGuards(wc: WebContents): void {
  // Deny all renderer-requested window creation (e.g. window.open)
  wc.setWindowOpenHandler(() => ({action: 'deny'}));

  // Prevent all renderer-initiated navigation
  wc.on('will-navigate', (event: Event) => {
    event.preventDefault();
  });

  // Block HTTP/HTTPS redirects
  wc.on('will-redirect', (event: Event) => {
    event.preventDefault();
  });

  // Block webview attachment inside sticky windows
  wc.on('will-attach-webview', (event: Event) => {
    event.preventDefault();
  });
}

export interface HighlightPayload {
  content?: unknown;
}

export interface HighlightResult {
  ok: boolean;
  rules: unknown[];
  error?: string;
}

/**
 * Narrow IPC handler for code syntax highlighting via Hyperia sidecar.
 * Verifies caller is a registered sticky window main frame, bounds content <= 4000 chars,
 * and posts strictly to fixed local endpoint with timeout protection.
 */
export async function handleStickyHighlight(
  event: IpcMainInvokeEvent,
  payload: HighlightPayload
): Promise<HighlightResult> {
  const senderWc = event?.sender;
  if (!senderWc) {
    return {ok: false, rules: [], error: 'Missing sender'};
  }

  let isRegistered = false;
  for (const win of stickyWindows.values()) {
    if (!win.isDestroyed() && win.webContents === senderWc) {
      isRegistered = true;
      break;
    }
  }
  if (!isRegistered) {
    return {ok: false, rules: [], error: 'Sender is not a registered sticky window'};
  }

  const senderFrame = (event as any)?.senderFrame;
  const mainFrame = (senderWc as any)?.mainFrame;
  if (!senderFrame || !mainFrame || senderFrame !== mainFrame) {
    return {ok: false, rules: [], error: 'Sender frame is not main frame'};
  }

  if (!payload || typeof payload !== 'object' || typeof payload.content !== 'string') {
    return {ok: false, rules: [], error: 'Invalid payload: content string required'};
  }

  if (payload.content.length > 4000) {
    return {ok: false, rules: [], error: 'Payload oversize: content exceeds 4000 character limit'};
  }

  const trimmed = payload.content.trim();
  if (!trimmed) {
    return {ok: true, rules: []};
  }

  const url = 'http://localhost:9800/api/notes/highlight';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({content: payload.content}),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      return {ok: false, rules: [], error: `HTTP ${res.status}`};
    }

    const data = (await res.json()) as {rules?: unknown};
    return {
      ok: true,
      rules: Array.isArray(data.rules) ? data.rules : []
    };
  } catch (err) {
    return {ok: false, rules: [], error: (err as Error)?.message || 'Highlight request failed'};
  }
}
