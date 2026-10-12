import test from 'ava';

import {agentProxyEnv, agentTelemetryEnv} from '../../app/utils/agent-telemetry-env';

const opts = {pane: 'p-1', port: '9800', enabled: true};

test('points Claude Code OTLP at the sidecar, tagged with the pane', (t) => {
  const env = agentTelemetryEnv({}, opts);
  t.is(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  t.is(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  t.is(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:9800/otel');
  t.is(env.OTEL_LOG_TOOL_DETAILS, '1');
  t.is(env.OTEL_RESOURCE_ATTRIBUTES, 'hyperia.pane=p-1');
});

test('appends the pane tag to existing resource attributes', (t) => {
  t.is(
    agentTelemetryEnv({OTEL_RESOURCE_ATTRIBUTES: 'team=lume'}, opts).OTEL_RESOURCE_ATTRIBUTES,
    'team=lume,hyperia.pane=p-1'
  );
});

test("a user's own collector wins: nothing is added", (t) => {
  t.deepEqual(agentTelemetryEnv({OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'}, opts), {});
  t.deepEqual(agentTelemetryEnv({OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://c:4318/v1/logs'}, opts), {});
});

test('never overrides a variable the user set', (t) => {
  const env = agentTelemetryEnv({CLAUDE_CODE_ENABLE_TELEMETRY: '0', OTEL_METRICS_EXPORTER: 'console'}, opts);
  t.false('CLAUDE_CODE_ENABLE_TELEMETRY' in env);
  t.false('OTEL_METRICS_EXPORTER' in env);
  t.is(env.OTEL_LOGS_EXPORTER, 'otlp');
});

test('disabled or no pane: nothing', (t) => {
  t.deepEqual(agentTelemetryEnv({}, {...opts, enabled: false}), {});
  t.deepEqual(agentTelemetryEnv({}, {...opts, pane: ''}), {});
});

const popts = {pane: 'p-1', proxyPort: '9813', enabled: true};

test('routes HTTPS through the counting proxy, tagged with the pane', (t) => {
  const env = agentProxyEnv({}, popts);
  t.is(env.HTTPS_PROXY, 'http://p-1:x@127.0.0.1:9813');
  t.is(env.https_proxy, env.HTTPS_PROXY);
  t.is(env.NO_PROXY, 'localhost,127.0.0.1,::1,host.docker.internal');
});

test("a user's proxy wins; their NO_PROXY is kept and extended", (t) => {
  t.deepEqual(agentProxyEnv({HTTPS_PROXY: 'http://corp:8080'}, popts), {});
  t.deepEqual(agentProxyEnv({all_proxy: 'socks5://x'}, popts), {});
  t.is(
    agentProxyEnv({NO_PROXY: 'intra.lan,localhost'}, popts).NO_PROXY,
    'intra.lan,localhost,127.0.0.1,::1,host.docker.internal'
  );
});

test('proxy disabled or no pane: nothing', (t) => {
  t.deepEqual(agentProxyEnv({}, {...popts, enabled: false}), {});
  t.deepEqual(agentProxyEnv({}, {...popts, pane: ''}), {});
});
