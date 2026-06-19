use serde::{Deserialize, Serialize};
use std::env;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, ACCEPT, CONTENT_TYPE};

#[derive(Deserialize, Debug)]
struct JsonRpcResponse {
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HyperiaAppInfo {
    pub name: Option<String>,
    pub cmdline: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HyperiaPane {
    pub active: bool,
    pub name: String,
    #[serde(rename = "paneId")]
    pub pane_id: String,
    pub focused: bool,
    pub process: Option<String>,
    pub title: Option<String>,
    pub app: Option<HyperiaAppInfo>,
    pub shell: Option<String>,
    #[serde(skip_deserializing)]
    pub tab_name: Option<String>,
    #[serde(skip_deserializing)]
    pub window_id: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HyperiaTab {
    pub active: bool,
    pub name: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    pub panes: Vec<HyperiaPane>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HyperiaWindow {
    pub focused: bool,
    pub id: u32,
    pub tabs: Vec<HyperiaTab>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TerminalStatusResult {
    pub version: String,
    pub windows: Vec<HyperiaWindow>,
}

pub struct HyperiaClient {
    base_url: String,
    token: String,
}

impl HyperiaClient {
    pub fn new() -> Self {
        let base_url = env::var("HYPERIA_URL").unwrap_or_else(|_| "http://localhost:9800".to_string()).trim_end_matches('/').to_string();
        let token = env::var("HYPERIA_AGENT_TOKEN").unwrap_or_default();
        HyperiaClient { base_url, token }
    }

    pub async fn call_tool(&self, tool_name: &str, arguments: serde_json::Value) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let client = reqwest::Client::new();
        
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/event-stream"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if !self.token.is_empty() {
            headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {}", self.token))?);
        }

        // 1. Initialize session
        let init_req = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "deck-mcp-client",
                    "version": "1.0.0"
                }
            },
            "id": 1
        });

        let init_res = client.post(&format!("{}/mcp", self.base_url))
            .headers(headers.clone())
            .json(&init_req)
            .send()
            .await?;

        init_res.error_for_status_ref()?;

        // Extract session ID from headers if present
        let session_id = init_res.headers()
            .get("mcp-session-id")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string());

        // 2. Send notifications/initialized
        let mut headers_with_session = headers.clone();
        if let Some(ref sid) = session_id {
            headers_with_session.insert("mcp-session-id", HeaderValue::from_str(sid)?);
        }

        let init_notify = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });

        let notify_res = client.post(&format!("{}/mcp", self.base_url))
            .headers(headers_with_session.clone())
            .json(&init_notify)
            .send()
            .await?;

        notify_res.error_for_status_ref()?;

        // 3. Call the tool
        let tool_req = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            },
            "id": 2
        });

        let tool_res = client.post(&format!("{}/mcp", self.base_url))
            .headers(headers_with_session)
            .json(&tool_req)
            .send()
            .await?;

        tool_res.error_for_status_ref()?;

        let rpc_res = parse_response(tool_res).await?;
        if let Some(err) = rpc_res.error {
            return Err(format!("Hyperia MCP error: {:?}", err).into());
        }

        let result = rpc_res.result.ok_or("No result returned from Hyperia MCP")?;
        Ok(result)
    }

    pub async fn get_terminal_status(&self) -> Result<TerminalStatusResult, Box<dyn std::error::Error>> {
        let val = self.call_tool("terminal_status", serde_json::json!({})).await?;
        
        let content_array = val.get("content").ok_or("No content block in response")?
            .as_array().ok_or("Content is not an array")?;
        
        let text_block = content_array.iter()
            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .ok_or("No text block in content")?;
        
        let text = text_block.get("text").ok_or("No text field in text block")?
            .as_str().ok_or("Text field is not a string")?;

        let status: TerminalStatusResult = serde_json::from_str(text)?;
        Ok(status)
    }

    pub async fn focus_pane(&self, pane_id: &str, tab_name: Option<&str>, window_id: Option<u32>) -> Result<(), Box<dyn std::error::Error>> {
        let mut args = serde_json::json!({
            "pane": pane_id
        });
        if let Some(tab) = tab_name {
            args["tab"] = serde_json::Value::String(tab.to_string());
        }
        if let Some(win) = window_id {
            args["window"] = serde_json::Value::Number(win.into());
        }
        self.call_tool("terminal_focus", args).await?;
        Ok(())
    }

    pub async fn run_command(&self, pane_id: &str, command: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.call_tool("terminal_run", serde_json::json!({
            "pane": pane_id,
            "command": command
        })).await?;
        Ok(())
    }

    pub async fn split_pane(&self, pane_id: &str, profile: Option<&str>, url: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let mut args = serde_json::json!({
            "pane": pane_id
        });
        if let Some(p) = profile {
            args["profile"] = serde_json::Value::String(p.to_string());
        }
        if let Some(u) = url {
            args["url"] = serde_json::Value::String(u.to_string());
        }
        self.call_tool("terminal_split", args).await?;
        Ok(())
    }

    pub async fn new_tab(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.call_tool("terminal_new_tab", serde_json::json!({})).await?;
        Ok(())
    }
}

async fn parse_response(res: reqwest::Response) -> Result<JsonRpcResponse, Box<dyn std::error::Error>> {
    let content_type = res.headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();

    if content_type.contains("application/json") {
        let rpc_res: JsonRpcResponse = res.json().await?;
        Ok(rpc_res)
    } else if content_type.contains("text/event-stream") {
        use futures::StreamExt;
        let mut stream = res.bytes_stream();
        let mut buffer = Vec::new();
        let mut json_str = String::new();
        
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res?;
            buffer.extend_from_slice(&chunk);
            
            if let Some(last_newline_idx) = buffer.iter().rposition(|&b| b == b'\n') {
                if let Ok(text) = String::from_utf8(buffer[..=last_newline_idx].to_vec()) {
                    for line in text.lines() {
                        if line.starts_with("data: ") {
                            json_str = line.trim_start_matches("data: ").trim().to_string();
                            break;
                        }
                    }
                }
            }
            if !json_str.is_empty() {
                break;
            }
            // Protect against unbounded buffer growth
            if buffer.len() > 65536 {
                break;
            }
        }
        
        if json_str.is_empty() {
            return Err("No data event found in SSE stream".into());
        }
        let rpc_res: JsonRpcResponse = serde_json::from_str(&json_str)?;
        Ok(rpc_res)
    } else {
        Err(format!("Unexpected content-type: {}", content_type).into())
    }
}
