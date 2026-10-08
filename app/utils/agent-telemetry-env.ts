// Env that points Claude Code's OpenTelemetry at Hyperia's sidecar, so an
// agent in a pane reports tokens and file edits (sidecar host_telemetry/otlp).
// A user who already exports OTLP somewhere (their own collector) keeps theirs:
// any existing OTLP endpoint means we add nothing, and no individual variable
// the user set is ever overridden.

export interface AgentTelemetryOpts {
  pane: string;
  port: string;
  enabled: boolean;
}

const ENDPOINT_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'
];

export function agentTelemetryEnv(
  base: Record<string, string | undefined>,
  {pane, port, enabled}: AgentTelemetryOpts
): Record<string, string> {
  if (!enabled || !pane) return {};
  if (ENDPOINT_KEYS.some((k) => (base[k] || '').trim())) return {};
  const wanted: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/otel`,
    // File paths on tool_result events (no file contents).
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_METRIC_EXPORT_INTERVAL: '5000',
    OTEL_LOGS_EXPORT_INTERVAL: '5000'
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(wanted)) {
    if (base[k] === undefined || base[k] === '') out[k] = v;
  }
  const attrs = (base.OTEL_RESOURCE_ATTRIBUTES || '').trim();
  const tag = `hyperia.pane=${pane}`;
  out.OTEL_RESOURCE_ATTRIBUTES = attrs ? `${attrs},${tag}` : tag;
  return out;
}
