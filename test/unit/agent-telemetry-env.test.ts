import test from 'ava';

import {agentTelemetryEnv} from '../../app/utils/agent-telemetry-env';

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
