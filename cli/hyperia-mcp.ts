// Hyperia CLI — MCP client core (epic #122, phases C1 + C2).
//
// C1: endpoint + token resolution, Bearer auth, MCP transport, actionable
//     errors, --json output + exit codes.
// C2: a generic, self-describing layer that mirrors the LIVE tool catalog:
//       hyperia tools            — list every tool + one-line description
//       hyperia describe <tool>  — print a tool's input schema
//       hyperia call <tool> ...  — invoke any tool ('{json}' or --field value)
//     plus identity helpers: `hyperia whoami`, `hyperia login [name]`.
//
// This is a CLI tool — console output is the product.
/* eslint no-console: 0 */
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {dirname, join} from 'path';

import got from 'got';

// ---------- endpoint resolution ----------
// HYPERIA_MCP_URL is injected into panes as "http://host:port/mcp"; we want the
// base. Inside a container localhost is the container — the caller must point
// HYPERIA_MCP_URL at the host gateway (e.g. http://host.docker.internal:9800).
export function baseUrl(): string {
  let u = (process.env.HYPERIA_MCP_URL || 'http://localhost:9800').trim();
  u = u.replace(/\/+$/, '').replace(/\/mcp$/i, '');
  return u || 'http://localhost:9800';
}

// ---------- token store ----------
function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}
function cliConfigPath(): string {
  return join(homeDir(), '.hyperia', 'cli.json');
}
// Precedence: in-pane env identity > explicit CLI env token > cached file.
export function loadToken(): string | undefined {
  if (process.env.HYPERIA_AGENT_TOKEN) return process.env.HYPERIA_AGENT_TOKEN;
  if (process.env.HYPERIA_CLI_TOKEN) return process.env.HYPERIA_CLI_TOKEN;
  try {
    const j = JSON.parse(readFileSync(cliConfigPath(), 'utf8')) as {token?: string};
    return j.token;
  } catch {
    return undefined;
  }
}
function saveToken(token: string, name: string): void {
  const p = cliConfigPath();
  mkdirSync(dirname(p), {recursive: true});
  writeFileSync(p, JSON.stringify({token, name}, null, 2), 'utf8');
}
function authHeaders(): Record<string, string> {
  const t = loadToken();
  return t ? {Authorization: `Bearer ${t}`} : {};
}

// ---------- errors with an exit code + a next-step hint ----------
class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

function wrapNet(e: unknown): CliError {
  if (e instanceof CliError) return e;
  const msg = (e as Error)?.message || String(e);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed ?out|getaddrinfo|ECONNRESET/i.test(msg)) {
    return new CliError(
      `can't reach Hyperia at ${baseUrl()} (${msg}). Set HYPERIA_MCP_URL — in a container use the host gateway, e.g. http://host.docker.internal:9800.`,
      3
    );
  }
  return new CliError(msg);
}

// ---------- HTTP ----------
async function mint(name: string): Promise<{token: string; name: string}> {
  try {
    const res = await got(`${baseUrl()}/api/identity/agent`, {
      method: 'POST',
      json: {name},
      responseType: 'json',
      timeout: {request: 10000},
      throwHttpErrors: false
    });
    if ((res.statusCode || 0) >= 400) {
      throw new CliError(`mint failed (${res.statusCode}): ${JSON.stringify(res.body)}`);
    }
    return res.body as {token: string; name: string};
  } catch (e) {
    throw wrapNet(e);
  }
}

// MCP JSON-RPC over /mcp. Streamable-http returns SSE-framed bodies ("data: {…}")
// or, occasionally, plain JSON — handle both. The server is sessionless, so a
// single POST works without an initialize handshake.
let rpcId = 0;
function parseRpc(body: string): {result?: unknown; error?: {message?: string}} {
  const trimmed = body.trim();
  try {
    const j = JSON.parse(trimmed);
    if (j && (j.result !== undefined || j.error !== undefined)) return j;
  } catch {
    /* fall through to SSE parsing */
  }
  const datas: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m) datas.push(m[1]);
  }
  for (const d of [...datas].reverse()) {
    try {
      const j = JSON.parse(d);
      if (j && (j.result !== undefined || j.error !== undefined)) return j;
    } catch {
      /* keep trying */
    }
  }
  try {
    return JSON.parse(datas.join('')) as {result?: unknown};
  } catch {
    throw new CliError(`unparseable MCP response: ${trimmed.slice(0, 200)}`);
  }
}

export async function mcp(method: string, params: unknown): Promise<any> {
  let res;
  try {
    res = await got(`${baseUrl()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...authHeaders()
      },
      body: JSON.stringify({jsonrpc: '2.0', id: ++rpcId, method, params}),
      responseType: 'text',
      timeout: {request: 30000},
      throwHttpErrors: false
    });
  } catch (e) {
    throw wrapNet(e);
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new CliError(
      `not authorized (${res.statusCode}). Run \`hyperia login\` to get an identity. If a pane action was refused, request consent: \`hyperia call request_access '{"pane":"<id>","purpose":"..."}'\`.`,
      4
    );
  }
  const rpc = parseRpc(res.body);
  if (rpc.error) throw new CliError(`MCP ${method}: ${rpc.error.message || JSON.stringify(rpc.error)}`);
  return rpc.result;
}

// ---------- arg parsing ----------
// Positionals + simple flags. `--key value` → string; bare `--key` → true.
function parseArgs(argv: string[]): {pos: string[]; flags: Record<string, string | boolean>} {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return {pos, flags};
}
function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function firstSentence(s: string, max = 140): string {
  const oneLine = String(s || '').replace(/\s+/g, ' ').trim();
  const dot = oneLine.indexOf('. ');
  const cut = dot > 0 ? oneLine.slice(0, dot + 1) : oneLine;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

// ---------- commands ----------
interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

async function cmdTools(wantJson: boolean): Promise<number> {
  const res = await mcp('tools/list', {});
  const tools: ToolDef[] = (res?.tools as ToolDef[]) || [];
  if (wantJson) {
    console.log(JSON.stringify(tools, null, 2));
    return 0;
  }
  const width = tools.reduce((w, t) => Math.max(w, t.name.length), 0);
  for (const t of tools) {
    console.log(`${t.name.padEnd(width)}  ${firstSentence(t.description || '')}`);
  }
  console.log(
    `\n${tools.length} tools. \`hyperia describe <tool>\` for args · \`hyperia call <tool> '{json}'\` to invoke · add --json for machine output.`
  );
  return 0;
}

async function cmdDescribe(tool: string | undefined, wantJson: boolean): Promise<number> {
  if (!tool) throw new CliError('usage: hyperia describe <tool>');
  const res = await mcp('tools/list', {});
  const t = ((res?.tools as ToolDef[]) || []).find((x) => x.name === tool);
  if (!t) throw new CliError(`unknown tool: ${tool}. Run \`hyperia tools\` to list them.`);
  if (wantJson) {
    console.log(JSON.stringify(t, null, 2));
    return 0;
  }
  console.log(`${t.name}\n\n${t.description || '(no description)'}\n\nInput schema:\n${JSON.stringify(t.inputSchema, null, 2)}`);
  return 0;
}

async function cmdCall(pos: string[], flags: Record<string, string | boolean>, wantJson: boolean): Promise<number> {
  const tool = pos[0];
  if (!tool) throw new CliError("usage: hyperia call <tool> ['{json args}'] [--field value ...] [--json]");
  let args: Record<string, unknown> = {};
  const posJson = pos[1];
  if (posJson) {
    try {
      args = JSON.parse(posJson);
    } catch (e) {
      throw new CliError(`bad JSON arguments: ${(e as Error).message}`);
    }
  } else {
    for (const [k, v] of Object.entries(flags)) {
      if (k === 'json') continue;
      args[k] = typeof v === 'string' ? coerce(v) : v;
    }
  }
  return invoke(tool, args, wantJson);
}

// Shared tool invocation + result printing (used by `call` and the curated verbs).
async function invoke(tool: string, args: Record<string, unknown>, wantJson: boolean): Promise<number> {
  const result = await mcp('tools/call', {name: tool, arguments: args});
  const isErr = !!result?.isError;
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return isErr ? 5 : 0;
  }
  const text = ((result?.content as Array<{text?: string}>) || [])
    .map((c) => c?.text ?? '')
    .join('\n')
    .trim();
  console.log(text || JSON.stringify(result));
  return isErr ? 5 : 0;
}

async function cmdWhoami(wantJson: boolean): Promise<number> {
  let res;
  try {
    res = await got(`${baseUrl()}/api/identity/whoami`, {
      headers: authHeaders(),
      responseType: 'json',
      timeout: {request: 10000},
      throwHttpErrors: false
    });
  } catch (e) {
    throw wrapNet(e);
  }
  const body = res.body as {kind?: string; label?: string; anonymous?: boolean};
  if (wantJson) {
    console.log(JSON.stringify(body, null, 2));
    return body.anonymous ? 2 : 0;
  }
  if (body.anonymous) {
    console.log('identity: anonymous — run `hyperia login` to get an identity.');
    return 2;
  }
  console.log(`identity: ${body.kind} (${body.label})`);
  return 0;
}

async function cmdLogin(name: string | undefined, wantJson: boolean): Promise<number> {
  if (process.env.HYPERIA_AGENT_TOKEN) {
    console.error('note: HYPERIA_AGENT_TOKEN is set (in-pane identity) — it takes precedence over a saved token.');
  }
  const n = name || process.env.HYPERIA_CLI_NAME || `cli-${process.platform}-${process.pid}`;
  const rec = await mint(n);
  saveToken(rec.token, rec.name);
  if (wantJson) {
    console.log(JSON.stringify({name: rec.name, saved: cliConfigPath()}, null, 2));
    return 0;
  }
  // Never echo the token to stdout — just where it landed.
  console.log(
    `logged in as "${rec.name}". Token saved to ${cliConfigPath()}.\n` +
      'It only NAMES you — pane actions still need the human\'s consent via ' +
      '`hyperia call request_access \'{"pane":"<id>","purpose":"..."}\'`.'
  );
  return 0;
}

// ---------- C3: curated verbs (friendly aliases over the generic layer) ----------
type Flags = Record<string, string | boolean>;

// Pull window/tab/pane targeting flags into a tool-arguments object.
function target(flags: Flags): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  if (flags.window !== undefined && flags.window !== true) t.window = coerce(String(flags.window));
  if (typeof flags.tab === 'string') t.tab = flags.tab;
  if (typeof flags.pane === 'string') t.pane = flags.pane;
  return t;
}

// Render terminal_status as a readable window→tab→pane tree (dumb-agent friendly).
function fmtStatus(raw: string): string {
  let data: {windows?: any[]};
  try {
    data = JSON.parse(raw);
  } catch {
    return raw;
  }
  const lines: string[] = [];
  for (const w of data.windows || []) {
    lines.push(`window ${w.id}${w.focused ? ' (focused)' : ''}`);
    for (const tab of w.tabs || []) {
      lines.push(`  tab "${tab.name}"${tab.active ? ' (active)' : ''}`);
      for (const p of tab.panes || []) {
        const id = String(p.paneId || '').slice(0, 8);
        const app = p.app && p.app.name ? ` ${p.app.name}` : '';
        const cwd = p.cwd ? ` cwd=${p.cwd}` : '';
        const focused = p.focused ? '  <focused>' : '';
        lines.push(`    • ${p.name || p.title || '(pane)'}  [${id}]  ${p.state || ''} ${p.shell || ''}${app}${cwd}${focused}`);
      }
    }
  }
  return lines.join('\n') || raw;
}

async function cmdStatus(wantJson: boolean): Promise<number> {
  const result = await mcp('tools/call', {name: 'terminal_status', arguments: {}});
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const text = ((result?.content as Array<{text?: string}>) || []).map((c) => c?.text ?? '').join('').trim();
  console.log(fmtStatus(text));
  return 0;
}

async function cmdRun(pos: string[], flags: Flags, wantJson: boolean): Promise<number> {
  const command = pos[0];
  if (!command) throw new CliError('usage: hyperia run "<command>" [--pane <id>] [--window <id>] [--tab <name>]');
  return invoke('terminal_run', {command, ...target(flags)}, wantJson);
}

async function cmdKeys(pos: string[], flags: Flags, wantJson: boolean): Promise<number> {
  const keys = pos[0];
  if (!keys) throw new CliError('usage: hyperia keys "<keys>" [--pane <id>]');
  return invoke('terminal_keys', {keys, ...target(flags)}, wantJson);
}

async function cmdCd(pos: string[], flags: Flags, wantJson: boolean): Promise<number> {
  const path = pos[0];
  if (!path) throw new CliError('usage: hyperia cd <dir> [--pane <id>]');
  return invoke('terminal_cd', {path, ...target(flags)}, wantJson);
}

async function cmdOpen(pos: string[], wantJson: boolean): Promise<number> {
  const url = pos[0];
  if (!url) {
    throw new CliError(
      'usage: hyperia open <url>   (opens a NEW web-pane tab; for a web pane in the CURRENT tab use `hyperia split --url <url>`)'
    );
  }
  return invoke('open_web_pane', {url}, wantJson);
}

async function cmdSplit(flags: Flags, wantJson: boolean): Promise<number> {
  const args: Record<string, unknown> = {...target(flags)};
  if (typeof flags.url === 'string') args.url = flags.url;
  if (typeof flags.command === 'string') args.command = flags.command;
  if (typeof flags.profile === 'string') args.profile = flags.profile;
  const dir = flags.direction ?? flags.dir;
  if (typeof dir === 'string') args.direction = dir;
  return invoke('terminal_split', args, wantJson);
}

async function cmdScreen(flags: Flags, wantJson: boolean): Promise<number> {
  return invoke('terminal_screen', {...target(flags)}, wantJson);
}

async function cmdClose(flags: Flags, wantJson: boolean): Promise<number> {
  // NOTE: `--force` (self-close override) lands with hyperia#118; harmless until then.
  const args: Record<string, unknown> = {...target(flags)};
  if (flags.force === true) args.force = true;
  return invoke('terminal_close', args, wantJson);
}

async function cmdFocus(flags: Flags, wantJson: boolean): Promise<number> {
  return invoke('terminal_focus', {...target(flags)}, wantJson);
}

async function cmdRename(pos: string[], flags: Flags, wantJson: boolean): Promise<number> {
  const name = pos[0];
  if (!name) throw new CliError('usage: hyperia rename <name> [--pane <id>]');
  return invoke('terminal_rename', {name, ...target(flags)}, wantJson);
}

async function cmdRequestAccess(pos: string[], flags: Flags, wantJson: boolean): Promise<number> {
  const args: Record<string, unknown> = {...target(flags)};
  const pane = pos[0] ?? (typeof flags.pane === 'string' ? flags.pane : undefined);
  if (pane) args.pane = pane;
  args.purpose = typeof flags.purpose === 'string' ? flags.purpose : pos[1] || 'CLI access';
  return invoke('request_access', args, wantJson);
}

// ---------- dispatch ----------
export const MCP_COMMANDS = new Set([
  // C2 generic + identity
  'tools',
  'call',
  'describe',
  'whoami',
  'login',
  // C3 curated verbs
  'status',
  'run',
  'keys',
  'cd',
  'open',
  'split',
  'screen',
  'close',
  'focus',
  'rename',
  'request-access'
]);

export async function runMcpCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const {pos, flags} = parseArgs(argv.slice(1));
  const wantJson = flags.json === true;
  try {
    switch (cmd) {
      case 'tools':
        return await cmdTools(wantJson);
      case 'describe':
        return await cmdDescribe(pos[0], wantJson);
      case 'call':
        return await cmdCall(pos, flags, wantJson);
      case 'whoami':
        return await cmdWhoami(wantJson);
      case 'login':
        return await cmdLogin(pos[0], wantJson);
      case 'status':
        return await cmdStatus(wantJson);
      case 'run':
        return await cmdRun(pos, flags, wantJson);
      case 'keys':
        return await cmdKeys(pos, flags, wantJson);
      case 'cd':
        return await cmdCd(pos, flags, wantJson);
      case 'open':
        return await cmdOpen(pos, wantJson);
      case 'split':
        return await cmdSplit(flags, wantJson);
      case 'screen':
        return await cmdScreen(flags, wantJson);
      case 'close':
        return await cmdClose(flags, wantJson);
      case 'focus':
        return await cmdFocus(flags, wantJson);
      case 'rename':
        return await cmdRename(pos, flags, wantJson);
      case 'request-access':
        return await cmdRequestAccess(pos, flags, wantJson);
      default:
        console.error(`unknown hyperia command: ${cmd}`);
        return 1;
    }
  } catch (e) {
    const ce = e instanceof CliError ? e : new CliError((e as Error)?.message || String(e));
    console.error(`hyperia: ${ce.message}`);
    return ce.code || 1;
  }
}
