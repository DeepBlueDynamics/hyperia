use image::{DynamicImage, Rgb, RgbImage};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Tracked state for the entire Stream Deck Plus.
pub struct DeviceState {
    pub brightness: u8,
    pub button_images: [Option<DynamicImage>; 8],
    pub button_pressed: [bool; 8],
    pub touchstrip_image: Option<DynamicImage>,
    pub encoder_positions: [i32; 4],
    pub encoder_pressed: [bool; 4],
    pub last_touch: Option<(u16, u16)>,
    pub device_info: Option<DeviceInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub kind: String,
    pub serial: String,
    pub firmware: String,
    pub manufacturer: String,
    pub product: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStatus {
    pub connected: bool,
    pub brightness: u8,
    pub button_pressed: [bool; 8],
    pub encoder_positions: [i32; 4],
    pub encoder_pressed: [bool; 4],
    pub last_touch: Option<(u16, u16)>,
    pub device_info: Option<DeviceInfo>,
}

pub type SharedState = Arc<Mutex<DeviceState>>;

impl DeviceState {
    pub fn new() -> Self {
        Self {
            brightness: 50,
            button_images: Default::default(),
            button_pressed: [false; 8],
            touchstrip_image: None,
            encoder_positions: [0; 4],
            encoder_pressed: [false; 4],
            last_touch: None,
            device_info: None,
        }
    }

    pub fn status(&self) -> DeviceStatus {
        DeviceStatus {
            connected: self.device_info.is_some(),
            brightness: self.brightness,
            button_pressed: self.button_pressed,
            encoder_positions: self.encoder_positions,
            encoder_pressed: self.encoder_pressed,
            last_touch: self.last_touch,
            device_info: self.device_info.clone(),
        }
    }

    pub fn button_image_or_black(&self, idx: usize) -> DynamicImage {
        if let Some(ref img) = self.button_images[idx] {
            img.clone()
        } else {
            DynamicImage::ImageRgb8(RgbImage::from_pixel(120, 120, Rgb([0, 0, 0])))
        }
    }

    pub fn touchstrip_image_or_black(&self) -> DynamicImage {
        if let Some(ref img) = self.touchstrip_image {
            img.clone()
        } else {
            DynamicImage::ImageRgb8(RgbImage::from_pixel(800, 100, Rgb([15, 15, 15])))
        }
    }
}

pub fn new_shared_state() -> SharedState {
    Arc::new(Mutex::new(DeviceState::new()))
}
