/* eslint-disable eslint-comments/disable-enable-pair */

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

// Load the CLI with `got` stubbed: capture each JSON-RPC request body and
// answer with a canned MCP result — the same seam cli-api.test.ts uses.
const load = (resultText: string) => {
  const calls: Array<{url: string; body: any}> = [];
  const {runMcpCli} = proxyquire('../../cli/hyperia-mcp', {
    got: (url: string, opts: {body: string}) => {
      const body = JSON.parse(opts.body);
      calls.push({url, body});
      return Promise.resolve({
        statusCode: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {content: [{type: 'text', text: resultText}], isError: false}
        })
      });
    }
  });
  return {runMcpCli, calls};
};

test('workspace save passes name and omits overwrite by default', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  const code = await runMcpCli(['workspace', 'save', 'deploy-day']);
  t.is(code, 0);
  t.is(calls.length, 1);
  t.is(calls[0].body.params.name, 'workspace_save');
  t.deepEqual(calls[0].body.params.arguments, {name: 'deploy-day'});
});

test('workspace save --overwrite sets the flag', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  const code = await runMcpCli(['workspace', 'save', 'deploy-day', '--overwrite']);
  t.is(code, 0);
  t.deepEqual(calls[0].body.params.arguments, {name: 'deploy-day', overwrite: true});
});

test('workspace rename passes from/to', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  const code = await runMcpCli(['workspace', 'rename', 'old', 'new']);
  t.is(code, 0);
  t.is(calls[0].body.params.name, 'workspace_rename');
  t.deepEqual(calls[0].body.params.arguments, {from: 'old', to: 'new'});
});

test('workspace delete passes the name', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  const code = await runMcpCli(['workspace', 'delete', 'stale']);
  t.is(code, 0);
  t.is(calls[0].body.params.name, 'workspace_delete');
  t.deepEqual(calls[0].body.params.arguments, {name: 'stale'});
});

test.serial('workspace list renders rows and flags invalid files', async (t) => {
  const rows = {
    workspaces: [
      {name: 'good', savedAt: '2026-08-28T12:00:00Z', windows: 2, panes: 3, webPanes: 1, valid: true},
      {name: 'broken', savedAt: '', windows: 0, panes: 0, webPanes: 0, valid: false, error: 'not valid JSON'}
    ]
  };
  const {runMcpCli, calls} = load(JSON.stringify(rows));
  const logged: string[] = [];
  const orig = console.log;
  console.log = (line: string) => logged.push(String(line));
  try {
    const code = await runMcpCli(['workspace', 'list']);
    t.is(code, 0);
  } finally {
    console.log = orig;
  }
  t.is(calls[0].body.params.name, 'workspace_list');
  const out = logged.join('\n');
  t.true(out.includes('good'));
  t.true(out.includes('2 windows, 3 panes + 1 web'));
  t.true(out.includes('[invalid: not valid JSON]'));
});

test('workspace restore passes the name', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  const code = await runMcpCli(['workspace', 'restore', 'deploy-day']);
  t.is(code, 0);
  t.is(calls[0].body.params.name, 'workspace_restore');
  t.deepEqual(calls[0].body.params.arguments, {name: 'deploy-day'});
});

test.serial('workspace preview renders counts and issues', async (t) => {
  const report = {
    name: 'demo',
    windows: 1,
    panes: 2,
    webPanes: 0,
    savedAt: '2026-08-28T12:00:00Z',
    issues: [{kind: 'missing-cwd', value: '/gone', resolution: 'will open in the home directory'}]
  };
  const {runMcpCli, calls} = load(JSON.stringify(report));
  const logged: string[] = [];
  const orig = console.log;
  console.log = (line: string) => logged.push(String(line));
  try {
    const code = await runMcpCli(['workspace', 'preview', 'demo']);
    t.is(code, 0);
  } finally {
    console.log = orig;
  }
  t.is(calls[0].body.params.name, 'workspace_preview');
  const out = logged.join('\n');
  t.true(out.includes('1 window, 2 panes'));
  t.true(out.includes('missing-cwd: /gone — will open in the home directory'));
});

test('workspace export resolves the path and passes overwrite', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  const code = await runMcpCli(['workspace', 'export', 'demo', 'out/demo.json', '--overwrite']);
  t.is(code, 0);
  t.is(calls[0].body.params.name, 'workspace_export');
  const args = calls[0].body.params.arguments;
  t.is(args.name, 'demo');
  t.true(args.path.startsWith('/'), 'relative path resolved to absolute');
  t.true(args.path.endsWith('/out/demo.json'));
  t.is(args.overwrite, true);
});

test('workspace import passes resolved path and optional name', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  const code = await runMcpCli(['workspace', 'import', '/abs/from.json', '--name', 'brought-in']);
  t.is(code, 0);
  t.is(calls[0].body.params.name, 'workspace_import');
  t.deepEqual(calls[0].body.params.arguments, {path: '/abs/from.json', name: 'brought-in'});
});

test('workspace with a missing sub-verb or name errors without calling out', async (t) => {
  const {runMcpCli, calls} = load('{"ok":true}');
  t.not(await runMcpCli(['workspace']), 0);
  t.not(await runMcpCli(['workspace', 'save']), 0);
  t.not(await runMcpCli(['workspace', 'rename', 'only-one']), 0);
  t.is(calls.length, 0, 'no MCP call should be made on usage errors');
});
