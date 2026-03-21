use base64::Engine;
use image::{DynamicImage, Rgb, RgbImage};
use rmcp::{
    ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
};

use super::device_actor::DeviceHandle;
use super::screenshot::{encode_png, render_screenshot};
use super::state::SharedState;

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SetBrightnessRequest {
    /// Brightness level from 0 (off) to 100 (maximum)
    pub percent: u8,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SetButtonImageRequest {
    /// Button index (0-7)
    pub key: u8,
    /// Base64-encoded PNG or JPEG image data (will be resized to 120x120)
    pub image_base64: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ClearButtonRequest {
    /// Button index (0-7), or omit to clear all buttons
    pub key: Option<u8>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SetButtonColorRequest {
    /// Button index (0-7)
    pub key: u8,
    /// Red component (0-255)
    pub r: u8,
    /// Green component (0-255)
    pub g: u8,
    /// Blue component (0-255)
    pub b: u8,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SetTouchstripImageRequest {
    /// Base64-encoded PNG or JPEG image (resized to 800x100)
    pub image_base64: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SetTouchstripColorRequest {
    /// Red component (0-255)
    pub r: u8,
    /// Green component (0-255)
    pub g: u8,
    /// Blue component (0-255)
    pub b: u8,
}

#[derive(Clone)]
pub struct StreamDeckMcp {
    tool_router: ToolRouter<Self>,
    pub device: DeviceHandle,
    pub state: SharedState,
}

#[tool_router]
impl StreamDeckMcp {
    pub fn new(device: DeviceHandle, state: SharedState) -> Self {
        Self {
            tool_router: Self::tool_router(),
            device,
            state,
        }
    }

    #[tool(description = "Get Stream Deck Plus device info and current state: brightness, button states, encoder positions, last touch position.")]
    async fn get_device_info(&self) -> Result<CallToolResult, ErrorData> {
        let state = self.state.lock().await;
        let status = state.status();
        let json = serde_json::to_string_pretty(&status).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(description = "Set display brightness (0=off, 100=max).")]
    async fn set_brightness(
        &self,
        Parameters(req): Parameters<SetBrightnessRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let pct = req.percent.min(100);
        self.device.set_brightness(pct).await.map_err(|e| {
            ErrorData::internal_error(format!("set_brightness: {e}"), None)
        })?;
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Brightness set to {pct}%"
        ))]))
    }

    #[tool(description = "Set a button image from base64-encoded PNG/JPEG data. Button index 0-7.")]
    async fn set_button_image(
        &self,
        Parameters(req): Parameters<SetButtonImageRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if req.key > 7 {
            return Ok(CallToolResult::error(vec![Content::text("Key must be 0-7")]));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&req.image_base64)
            .map_err(|e| ErrorData::invalid_params(format!("bad base64: {e}"), None))?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| ErrorData::invalid_params(format!("bad image: {e}"), None))?;
        self.device.set_button_image(req.key, img).await.map_err(|e| {
            ErrorData::internal_error(format!("set_button_image: {e}"), None)
        })?;
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Button {} image set", req.key
        ))]))
    }

    #[tool(description = "Set a button to a solid color. Button index 0-7, RGB 0-255.")]
    async fn set_button_color(
        &self,
        Parameters(req): Parameters<SetButtonColorRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if req.key > 7 {
            return Ok(CallToolResult::error(vec![Content::text("Key must be 0-7")]));
        }
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(120, 120, Rgb([req.r, req.g, req.b])));
        self.device.set_button_image(req.key, img).await.map_err(|e| {
            ErrorData::internal_error(format!("set_button_color: {e}"), None)
        })?;
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Button {} set to RGB({},{},{})", req.key, req.r, req.g, req.b
        ))]))
    }

    #[tool(description = "Clear button image(s). Specify key 0-7 for one button, or omit to clear all.")]
    async fn clear_button(
        &self,
        Parameters(req): Parameters<ClearButtonRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(k) = req.key {
            if k > 7 {
                return Ok(CallToolResult::error(vec![Content::text("Key must be 0-7")]));
            }
        }
        self.device.clear_button(req.key).await.map_err(|e| {
            ErrorData::internal_error(format!("clear: {e}"), None)
        })?;
        let msg = match req.key {
            Some(k) => format!("Button {k} cleared"),
            None => "All buttons cleared".into(),
        };
        Ok(CallToolResult::success(vec![Content::text(msg)]))
    }

    #[tool(description = "Set the touchstrip LCD to a base64-encoded PNG/JPEG image (resized to 800x100).")]
    async fn set_touchstrip_image(
        &self,
        Parameters(req): Parameters<SetTouchstripImageRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&req.image_base64)
            .map_err(|e| ErrorData::invalid_params(format!("bad base64: {e}"), None))?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| ErrorData::invalid_params(format!("bad image: {e}"), None))?;
        self.device.set_touchstrip_image(img).await.map_err(|e| {
            ErrorData::internal_error(format!("set_touchstrip: {e}"), None)
        })?;
        Ok(CallToolResult::success(vec![Content::text("Touchstrip image set")]))
    }

    #[tool(description = "Set the touchstrip LCD to a solid color (RGB 0-255).")]
    async fn set_touchstrip_color(
        &self,
        Parameters(req): Parameters<SetTouchstripColorRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(800, 100, Rgb([req.r, req.g, req.b])));
        self.device.set_touchstrip_image(img).await.map_err(|e| {
            ErrorData::internal_error(format!("set_touchstrip: {e}"), None)
        })?;
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Touchstrip set to RGB({},{},{})", req.r, req.g, req.b
        ))]))
    }

    #[tool(description = "Take a screenshot of the entire Stream Deck Plus. Returns a composite PNG image.")]
    async fn screenshot(&self) -> Result<CallToolResult, ErrorData> {
        let state = self.state.lock().await;
        let composite = render_screenshot(&state);
        let png_bytes = encode_png(&composite);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        Ok(CallToolResult::success(vec![Content::image(b64, "image/png")]))
    }

    #[tool(description = "Reset the Stream Deck Plus to factory state (clears all buttons and touchstrip).")]
    async fn reset(&self) -> Result<CallToolResult, ErrorData> {
        self.device.reset().await.map_err(|e| {
            ErrorData::internal_error(format!("reset: {e}"), None)
        })?;
        Ok(CallToolResult::success(vec![Content::text("Device reset")]))
    }
}

#[tool_handler]
impl ServerHandler for StreamDeckMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Stream Deck Plus MCP server. Controls an Elgato Stream Deck Plus with \
                 8 LCD buttons (120x120px), 4 rotary encoders, and an 800x100 touchstrip. \
                 Tools: get_device_info, set_brightness, set_button_image, set_button_color, \
                 clear_button, set_touchstrip_image, set_touchstrip_color, screenshot, reset."
                    .into(),
            ),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
            ..Default::default()
        }
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult {
            resources: vec![RawResource::new(
                "streamdeck://device/status",
                "Device Status".to_string(),
            )
            .no_annotation()],
            next_cursor: None,
            meta: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        match request.uri.as_str() {
            "streamdeck://device/status" => {
                let state = self.state.lock().await;
                let status = state.status();
                let json = serde_json::to_string_pretty(&status).unwrap_or_default();
                Ok(ReadResourceResult {
                    contents: vec![ResourceContents::text(json, request.uri)],
                })
            }
            _ => Err(ErrorData::resource_not_found(
                "not found",
                Some(serde_json::json!({ "uri": request.uri })),
            )),
        }
    }
}
