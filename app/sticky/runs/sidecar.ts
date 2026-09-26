// Main → sidecar HTTP as the System identity. Port from HYPERIA_PORT, never hard-coded.
import {SYSTEM_TOKEN} from '../../system-token';

export type SidecarReply = {ok: boolean; status: number; data: any; text: string};

export function sidecarBase(): string {
  return `http://127.0.0.1:${process.env.HYPERIA_PORT || 9800}`;
}

/** Never throws: network errors come back as status 0 with the message in `text`. */
export async function sidecarRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 15000
): Promise<SidecarReply> {
  try {
    const res = await fetch(`${sidecarBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${SYSTEM_TOKEN}`,
        ...(body !== undefined ? {'content-type': 'application/json'} : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return {ok: res.ok, status: res.status, data, text};
  } catch (e) {
    return {ok: false, status: 0, data: null, text: `sidecar unreachable: ${(e as Error).message || e}`};
  }
}

/** Best error string from a failed reply: JSON `error` field, else the body. */
export function replyError(r: SidecarReply): string {
  const fromJson = r.data && typeof r.data === 'object' ? r.data.error || r.data.message : null;
  const detail = (typeof fromJson === 'string' && fromJson) || r.text || 'no response body';
  return r.status ? `HTTP ${r.status}: ${detail}` : detail;
}

export type OpenPane = {uid: string; name: string; tab: string; window: number; app: string};

/** Panes open right now, flattened from the sidecar's /api/status. */
export function panesFromStatus(status: any): OpenPane[] {
  const out: OpenPane[] = [];
  for (const w of status?.windows || []) {
    for (const t of w?.tabs || []) {
      for (const p of t?.panes || []) {
        if (!p?.paneId) continue;
        const app = (p.app && typeof p.app === 'object' && p.app.name) || p.process || p.shell || '';
        out.push({uid: p.paneId, name: p.name || p.title || p.paneId, tab: t.name || '', window: w.id, app});
      }
    }
  }
  return out;
}

export async function listOpenPanes(): Promise<{ok: true; panes: OpenPane[]} | {ok: false; error: string}> {
  const r = await sidecarRequest('GET', '/api/status');
  if (!r.ok) return {ok: false, error: replyError(r)};
  return {ok: true, panes: panesFromStatus(r.data)};
}
