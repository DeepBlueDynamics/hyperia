//! OTLP/HTTP JSON receiver for Claude Code's OpenTelemetry.
//!
//! Hyperia injects OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>/otel
//! and OTEL_RESOURCE_ATTRIBUTES=hyperia.pane=<uid> into every pane, so a
//! Claude in a pane exports here. Same open-on-loopback posture as
//! /api/telemetry/event. Mapping:
//!   api_request            → local Tokens (not forwarded: n8 token schema TBD)
//!   tool_result (file edit) → local Edit + n8 `edit` event
//! Everything else is ignored, and prompt or tool content is never logged.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use serde_json::{json, Map, Value};

use crate::dashboard::DashboardState;
use crate::telemetry::TelemetryEvent;

const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// One mapped OTLP record: what to record locally, and what (if anything) to
/// forward to n8.
#[derive(Debug)]
pub(crate) struct Mapped {
    pub pane: String,
    pub local: TelemetryEvent,
    pub forward: Option<Value>,
}

/// OTLP AnyValue → plain JSON. intValue arrives as a string in the JSON encoding.
fn any_value(v: &Value) -> Value {
    if let Some(s) = v.get("stringValue") {
        return s.clone();
    }
    if let Some(i) = v.get("intValue") {
        return match i {
            Value::String(s) => s.parse::<i64>().map(Value::from).unwrap_or(Value::Null),
            other => other.clone(),
        };
    }
    for k in ["doubleValue", "boolValue"] {
        if let Some(x) = v.get(k) {
            return x.clone();
        }
    }
    Value::Null
}

fn attrs(list: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for kv in list.and_then(Value::as_array).into_iter().flatten() {
        if let (Some(k), Some(v)) = (kv.get("key").and_then(Value::as_str), kv.get("value")) {
            out.insert(k.to_string(), any_value(v));
        }
    }
    out
}

fn num(m: &Map<String, Value>, k: &str) -> u64 {
    match m.get(k) {
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<f64>().map(|f| f.max(0.0) as u64).unwrap_or(0),
        _ => 0,
    }
}

fn text<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Event name: `event.name` attribute, the record's eventName, or its body;
/// with any `claude_code.` prefix removed.
fn event_name(rec: &Value, a: &Map<String, Value>) -> String {
    let raw = text(a, "event.name")
        .map(str::to_string)
        .or_else(|| rec.get("eventName").and_then(Value::as_str).map(str::to_string))
        .or_else(|| rec.get("body").map(any_value).and_then(|v| v.as_str().map(str::to_string)))
        .unwrap_or_default();
    raw.strip_prefix("claude_code.").unwrap_or(&raw).to_string()
}

/// The file a tool call targeted, from its parameters (a JSON string when
/// OTEL_LOG_TOOL_DETAILS=1) or its input.
fn tool_path(a: &Map<String, Value>) -> Option<String> {
    for key in ["tool_parameters", "tool_input"] {
        let parsed = match a.get(key) {
            Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok(),
            Some(v @ Value::Object(_)) => Some(v.clone()),
            _ => None,
        };
        if let Some(p) = parsed {
            for f in ["file_path", "notebook_path", "path"] {
                if let Some(s) = p.get(f).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        None => true, // older exporters omit it on success
        _ => false,
    }
}

pub(crate) fn map_logs(body: &Value) -> Vec<Mapped> {
    let mut out = Vec::new();
    for rl in body.get("resourceLogs").and_then(Value::as_array).into_iter().flatten() {
        let res = attrs(rl.get("resource").and_then(|r| r.get("attributes")));
        let Some(pane) = text(&res, "hyperia.pane").map(str::to_string) else { continue };
        for sl in rl.get("scopeLogs").and_then(Value::as_array).into_iter().flatten() {
            for rec in sl.get("logRecords").and_then(Value::as_array).into_iter().flatten() {
                let a = attrs(rec.get("attributes"));
                match event_name(rec, &a).as_str() {
                    "api_request" => out.push(Mapped {
                        pane: pane.clone(),
                        local: TelemetryEvent::Tokens {
                            input: num(&a, "input_tokens"),
                            output: num(&a, "output_tokens"),
                            cache: num(&a, "cache_read_tokens") + num(&a, "cache_creation_tokens"),
                            model: text(&a, "model").unwrap_or("").to_string(),
                        },
                        forward: None,
                    }),
                    "tool_result" => {
                        let Some(tool) = text(&a, "tool_name").filter(|t| EDIT_TOOLS.contains(t)) else { continue };
                        if !truthy(a.get("success")) {
                            continue;
                        }
                        let Some(path) = tool_path(&a) else { continue };
                        let tool = format!("claude_code:{tool}");
                        out.push(Mapped {
                            pane: pane.clone(),
                            local: TelemetryEvent::Edit {
                                path: path.clone(),
                                tool: tool.clone(),
                                lines_added: 0,
                                lines_removed: 0,
                                substitutions: 0,
                                regions: Vec::new(),
                                bytes_before: None,
                                bytes_after: None,
                            },
                            forward: Some(json!({"kind": "edit", "tool": tool, "path": path,
                                "lines_added": 0, "lines_removed": 0, "substitutions": 0, "regions": []})),
                        });
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// OTLP over http/protobuf isn't supported: we inject http/json.
fn check_json(headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
    let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if ct.is_empty() || ct.contains("json") {
        Ok(())
    } else {
        Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("Hyperia's OTLP receiver takes http/json only (got {ct}); set OTEL_EXPORTER_OTLP_PROTOCOL=http/json"),
        ))
    }
}

/// POST /otel/v1/logs
pub async fn post_logs(State(state): State<DashboardState>, headers: HeaderMap, body: Bytes) -> (StatusCode, String) {
    if let Err(e) = check_json(&headers) {
        return e;
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "Bad OTLP JSON".into());
    };
    for m in map_logs(&v) {
        if let Some(f) = m.forward {
            crate::host_telemetry::forward::enqueue(&m.pane, f);
        }
        state.telemetry.record(&m.pane, m.local);
    }
    (StatusCode::OK, "{}".into())
}

/// POST /otel/v1/metrics — accepted so the exporter stays healthy.
// TODO: claude_code.lines_of_code.count (type=added|removed) could feed
// per-pane line totals once its temporality (delta vs cumulative) is pinned;
// it has no file path, so it must not be turned into per-file edits.
pub async fn post_metrics(headers: HeaderMap, _body: Bytes) -> (StatusCode, String) {
    if let Err(e) = check_json(&headers) {
        return e;
    }
    (StatusCode::OK, "{}".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(k: &str, v: Value) -> Value {
        json!({"key": k, "value": v})
    }

    fn logs(pane: Option<&str>, records: Vec<Value>) -> Value {
        let mut res = vec![kv("service.name", json!({"stringValue": "claude-code"}))];
        if let Some(p) = pane {
            res.push(kv("hyperia.pane", json!({"stringValue": p})));
        }
        json!({"resourceLogs": [{"resource": {"attributes": res},
            "scopeLogs": [{"scope": {"name": "com.anthropic.claude_code.events"}, "logRecords": records}]}]})
    }

    #[test]
    fn api_request_becomes_local_tokens_only() {
        let rec = json!({"body": {"stringValue": "claude_code.api_request"}, "attributes": [
            kv("event.name", json!({"stringValue": "api_request"})),
            kv("model", json!({"stringValue": "claude-opus-5-5"})),
            kv("input_tokens", json!({"intValue": "1200"})),
            kv("output_tokens", json!({"intValue": 300})),
            kv("cache_read_tokens", json!({"stringValue": "50"})),
            kv("cache_creation_tokens", json!({"doubleValue": 7.0})),
        ]});
        let m = map_logs(&logs(Some("p1"), vec![rec]));
        assert_eq!(m.len(), 1);
        assert!(m[0].forward.is_none(), "tokens are not forwarded yet");
        match &m[0].local {
            TelemetryEvent::Tokens { input, output, cache, model } => {
                assert_eq!((*input, *output, *cache, model.as_str()), (1200, 300, 57, "claude-opus-5-5"));
            }
            other => panic!("expected Tokens, got {other:?}"),
        }
    }

    #[test]
    fn edit_tool_result_maps_path_from_tool_parameters_and_forwards() {
        let params = json!({"file_path": "C:\\work\\src\\main.rs", "old_string": "a"}).to_string();
        let rec = json!({"attributes": [
            kv("event.name", json!({"stringValue": "claude_code.tool_result"})),
            kv("tool_name", json!({"stringValue": "Edit"})),
            kv("success", json!({"stringValue": "true"})),
            kv("tool_parameters", json!({"stringValue": params})),
        ]});
        let m = map_logs(&logs(Some("p2"), vec![rec]));
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].pane, "p2");
        let f = m[0].forward.as_ref().unwrap();
        assert_eq!(f["kind"], "edit");
        assert_eq!(f["tool"], "claude_code:Edit");
        assert_eq!(f["path"], "C:\\work\\src\\main.rs");
        assert!(matches!(&m[0].local, TelemetryEvent::Edit { path, .. } if path == "C:\\work\\src\\main.rs"));
    }

    #[test]
    fn non_edit_tools_failures_and_pathless_results_are_ignored() {
        let mk = |tool: &str, success: &str, params: Option<&str>| {
            let mut a = vec![
                kv("event.name", json!({"stringValue": "tool_result"})),
                kv("tool_name", json!({"stringValue": tool})),
                kv("success", json!({"stringValue": success})),
            ];
            if let Some(p) = params {
                a.push(kv("tool_parameters", json!({"stringValue": p})));
            }
            json!({"attributes": a})
        };
        let recs = vec![
            mk("Bash", "true", Some(r#"{"command":"ls"}"#)),
            mk("Write", "false", Some(r#"{"file_path":"/x"}"#)),
            mk("Write", "true", None),
            mk("Read", "true", Some(r#"{"file_path":"/x"}"#)),
        ];
        assert!(map_logs(&logs(Some("p"), recs)).is_empty());
    }

    #[test]
    fn records_without_a_pane_are_dropped() {
        let rec = json!({"attributes": [kv("event.name", json!({"stringValue": "api_request"})),
            kv("input_tokens", json!({"intValue": "5"}))]});
        assert!(map_logs(&logs(None, vec![rec])).is_empty());
    }

    #[test]
    fn protobuf_is_refused_json_accepted() {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, "application/x-protobuf".parse().unwrap());
        assert_eq!(check_json(&h).unwrap_err().0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        h.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        assert!(check_json(&h).is_ok());
    }
}
