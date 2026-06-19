use hidapi::{HidApi, HidDevice};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio::sync::broadcast;
use lazy_static::lazy_static;

lazy_static! {
    static ref HID_API: Mutex<HidApi> = Mutex::new(HidApi::new().expect("Failed to initialize HIDAPI"));
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", content = "data")]
pub enum StreamDeckEvent {
    ButtonPress { key: u8, pressed: bool },
    DialPress { dial: u8, pressed: bool },
    DialRotate { dial: u8, delta: i8 },
    TouchShortPress { x: u16, y: u16 },
    TouchLongPress { x: u16, y: u16 },
    TouchSwipe { start_x: u16, start_y: u16, end_x: u16, end_y: u16 },
    Flash { color: String },
    DeviceDisconnect,
    Sync {
        active_panes: Vec<crate::TouchBarItem>,
        pane_scroll_offset: usize,
        total_items: usize,
        running_apps: Vec<crate::RunningApp>,
        app_scroll_offset: usize,
        connected: bool,
    },
}

pub struct StreamDeckPlus {
    device: Arc<Mutex<HidDevice>>,
    _tx: broadcast::Sender<StreamDeckEvent>,
    pub serial: String,
}

impl StreamDeckPlus {
    pub fn connect(tx: broadcast::Sender<StreamDeckEvent>) -> Result<Self, Box<dyn std::error::Error>> {
        let mut api = HID_API.lock().unwrap();
        api.refresh_devices()?;
        let device_info = api.device_list().find(|dev| dev.vendor_id() == 0x0FD9 && dev.product_id() == 0x0084)
            .ok_or("Stream Deck Plus (VID 0x0FD9, PID 0x0084) not found")?;
        
        let serial = device_info.serial_number().unwrap_or("unknown").to_string();
        let device = device_info.open_device(&api)?;
        device.set_blocking_mode(false)?;
        
        let device_arc = Arc::new(Mutex::new(device));
        let device_read_arc = Arc::clone(&device_arc);
        let tx_clone = tx.clone();
        
        // Spawn background thread to poll inputs
        thread::spawn(move || {
            let mut buf = [0u8; 1024];
            // Track button and encoder click states to only report state changes
            let mut last_buttons = [false; 8];
            let mut last_dials = [false; 4];
            
            loop {
                let res = {
                    let dev = device_read_arc.lock().unwrap();
                    dev.read(&mut buf)
                };
                
                match res {
                    Ok(len) if len > 1 => {
                        let report_id = buf[0];
                        if report_id == 1 {
                            let event_type = buf[1];
                            match event_type {
                                0 => {
                                    // Button/Key states:
                                    if len >= 12 {
                                        for i in 0..8 {
                                            let pressed = buf[4 + i] != 0;
                                            if pressed != last_buttons[i] {
                                                last_buttons[i] = pressed;
                                                let _ = tx_clone.send(StreamDeckEvent::ButtonPress { key: i as u8, pressed });
                                            }
                                        }
                                    }
                                }
                                2 => {
                                    // Touch screen events:
                                    if len >= 10 {
                                        let action = buf[4]; // 1 = short press, 2 = long press, 3 = swipe
                                        let x = u16::from_le_bytes([buf[6], buf[7]]);
                                        let y = u16::from_le_bytes([buf[8], buf[9]]);
                                        
                                        match action {
                                            1 => {
                                                let _ = tx_clone.send(StreamDeckEvent::TouchShortPress { x, y });
                                            }
                                            2 => {
                                                let _ = tx_clone.send(StreamDeckEvent::TouchLongPress { x, y });
                                            }
                                            3 if len >= 14 => {
                                                let end_x = u16::from_le_bytes([buf[10], buf[11]]);
                                                let end_y = u16::from_le_bytes([buf[12], buf[13]]);
                                                let _ = tx_clone.send(StreamDeckEvent::TouchSwipe {
                                                    start_x: x,
                                                    start_y: y,
                                                    end_x,
                                                    end_y,
                                                });
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                3 => {
                                    // Encoder/knob events:
                                    if len >= 9 {
                                        let action = buf[4]; // 0 = PUSH, 1 = TURN
                                        match action {
                                            0 => {
                                                // Click events: buf[5..9] represents dials 0 to 3 press states
                                                for i in 0..4 {
                                                    let pressed = buf[5 + i] != 0;
                                                    if pressed != last_dials[i] {
                                                        last_dials[i] = pressed;
                                                        let _ = tx_clone.send(StreamDeckEvent::DialPress { dial: i as u8, pressed });
                                                    }
                                                }
                                            }
                                            1 => {
                                                // Rotation events: buf[5..9] represents signed 8-bit increments
                                                for i in 0..4 {
                                                    let delta = buf[5 + i] as i8;
                                                    if delta != 0 {
                                                        let _ = tx_clone.send(StreamDeckEvent::DialRotate { dial: i as u8, delta });
                                                    }
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Ok(_) => {
                        // Non-blocking read returned 0 bytes
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => {
                        eprintln!("Error reading from HID: {:?}", e);
                        let _ = tx_clone.send(StreamDeckEvent::DeviceDisconnect);
                        break;
                    }
                }
            }
        });
        
        Ok(StreamDeckPlus {
            device: Arc::clone(&device_arc),
            _tx: tx,
            serial,
        })
    }

    pub fn set_brightness(&self, percentage: u8) -> Result<(), Box<dyn std::error::Error>> {
        let pct = percentage.min(100);
        let mut buf = [0u8; 32];
        buf[0] = 0x03;
        buf[1] = 0x08;
        buf[2] = pct;
        
        let dev = self.device.lock().unwrap();
        dev.send_feature_report(&buf)?;
        Ok(())
    }

    pub fn reset_to_logo(&self) -> Result<(), Box<dyn std::error::Error>> {
        let mut buf = [0u8; 32];
        buf[0] = 0x03;
        buf[1] = 0x02;
        
        let dev = self.device.lock().unwrap();
        dev.send_feature_report(&buf)?;
        Ok(())
    }

    pub fn fill_button_image(&self, key_index: u8, jpeg_data: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        // Button images: chunked into 1024-byte packets with 8-byte headers.
        // Command ID is 0x07. Report ID is 0x02.
        let chunk_size = 1024 - 8;
        let mut remaining = jpeg_data.len();
        let mut chunk_idx = 0u16;
        
        let dev = self.device.lock().unwrap();
        
        while remaining > 0 {
            let size = remaining.min(chunk_size);
            let is_last = remaining <= chunk_size;
            
            let mut packet = [0u8; 1024];
            packet[0] = 0x02;
            packet[1] = 0x07;
            packet[2] = key_index;
            packet[3] = if is_last { 1 } else { 0 };
            packet[4..6].copy_from_slice(&(size as u16).to_le_bytes());
            packet[6..8].copy_from_slice(&chunk_idx.to_le_bytes());
            
            let start_offset = chunk_idx as usize * chunk_size;
            packet[8..8 + size].copy_from_slice(&jpeg_data[start_offset..start_offset + size]);
            
            dev.write(&packet)?;
            
            remaining -= size;
            chunk_idx += 1;
        }
        
        Ok(())
    }

    pub fn fill_lcd_image(&self, x: u16, y: u16, width: u16, height: u16, jpeg_data: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        // Touch bar LCD image: chunked into 1024-byte packets with 16-byte headers.
        // Command ID is 0x0C. Report ID is 0x02.
        let chunk_size = 1024 - 16;
        let mut remaining = jpeg_data.len();
        let mut chunk_idx = 0u16;
        
        let dev = self.device.lock().unwrap();
        
        while remaining > 0 {
            let size = remaining.min(chunk_size);
            let is_last = remaining <= chunk_size;
            
            let mut packet = [0u8; 1024];
            packet[0] = 0x02;
            packet[1] = 0x0C;
            packet[2..4].copy_from_slice(&x.to_le_bytes());
            packet[4..6].copy_from_slice(&y.to_le_bytes());
            packet[6..8].copy_from_slice(&width.to_le_bytes());
            packet[8..10].copy_from_slice(&height.to_le_bytes());
            packet[10] = if is_last { 1 } else { 0 };
            packet[11..13].copy_from_slice(&chunk_idx.to_le_bytes());
            packet[13..15].copy_from_slice(&(size as u16).to_le_bytes());
            packet[15] = 0; // padding
            
            let start_offset = chunk_idx as usize * chunk_size;
            packet[16..16 + size].copy_from_slice(&jpeg_data[start_offset..start_offset + size]);
            
            dev.write(&packet)?;
            
            remaining -= size;
            chunk_idx += 1;
        }
        
        Ok(())
    }
}
