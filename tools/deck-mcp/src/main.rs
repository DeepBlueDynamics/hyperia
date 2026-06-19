mod device;
mod hyperia;
mod mcp;
mod web;

use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use std::net::SocketAddr;
use crate::device::{StreamDeckPlus, StreamDeckEvent};
use crate::hyperia::HyperiaPane;
use base64::Engine;

lazy_static::lazy_static! {
    static ref FONT: Option<rusttype::Font<'static>> = {
        let font_paths = [
            "C:\\Windows\\Fonts\\segoeui.ttf",
            "C:\\Windows\\Fonts\\arial.ttf",
        ];
        for path in &font_paths {
            if let Ok(data) = std::fs::read(path) {
                if let Some(font) = rusttype::Font::try_from_vec(data) {
                    return Some(font);
                }
            }
        }
        None
    };

}

fn clean_app_name(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.contains("chrome") {
        "Chrome".to_string()
    } else if lower.contains("terminal") {
        "Terminal".to_string()
    } else if lower.contains("sonos") {
        "Sonos".to_string()
    } else if lower.contains("docker") {
        "Docker".to_string()
    } else if lower.contains("hyperia") {
        "Hyperia".to_string()
    } else if lower.contains("clipchamp") {
        "Clipchamp".to_string()
    } else if lower.contains("comfy") {
        "Comfy".to_string()
    } else {
        // Capitalize first letter
        let mut chars = name.chars();
        match chars.next() {
            None => String::new(),
            Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "item_type", content = "data")]
pub enum TouchBarItem {
    Pane(HyperiaPane),
    AddPane,
    AddTab,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RunningApp {
    pub pid: u32,
    pub pids: Vec<u32>,
    pub name: String,
    pub title: String,
    pub icon_base64: String,
    pub window_count: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceStatus {
    pub connected: bool,
    pub serial_number: String,
    pub firmware_version: String,
    pub active_panes: Vec<TouchBarItem>,
    pub pane_scroll_offset: usize,
    pub total_items: usize,
    pub running_apps: Vec<RunningApp>,
    pub app_scroll_offset: usize,
}

pub struct AppState {
    pub device: Mutex<Option<StreamDeckPlus>>,
    pub event_tx: broadcast::Sender<StreamDeckEvent>,
    pub all_items: Mutex<Vec<TouchBarItem>>,
    pub pane_scroll_offset: Mutex<usize>,
    pub status: Mutex<DeviceStatus>,
    pub brightness: Mutex<u8>,
    pub last_focused_pane: Mutex<Option<(String, std::time::Instant)>>,
    pub selected_tab_name: Mutex<Option<String>>,
    pub app_scroll_offset: Mutex<usize>,
    pub running_apps: Mutex<Vec<RunningApp>>,
    pub app_focus_indices: Mutex<std::collections::HashMap<String, usize>>,
}

pub async fn sync_panes_internal(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let client = crate::hyperia::HyperiaClient::new();
    let status = client.get_terminal_status().await?;
    
    // Find focused window (default to first)
    let window = status.windows.iter()
        .find(|w| w.focused)
        .or_else(|| status.windows.first())
        .ok_or("No windows found in Hyperia status")?;
        
    // Find active tab in that window (default to first)
    let active_tab = window.tabs.iter()
        .find(|t| t.active)
        .or_else(|| window.tabs.first())
        .ok_or("No tabs found in window")?;
        
    // Use locally selected tab if it exists in the active window, otherwise default to active tab
    let mut selected_tab_name_guard = state.selected_tab_name.lock().unwrap();
    let tab = if let Some(ref name) = *selected_tab_name_guard {
        if let Some(t) = window.tabs.iter().find(|t| t.name == *name) {
            t
        } else {
            *selected_tab_name_guard = Some(active_tab.name.clone());
            active_tab
        }
    } else {
        *selected_tab_name_guard = Some(active_tab.name.clone());
        active_tab
    };
        
    let override_focus = {
        let guard = state.last_focused_pane.lock().unwrap();
        if let Some((ref pane_id, ref instant)) = *guard {
            if instant.elapsed() < std::time::Duration::from_millis(2000) {
                Some(pane_id.clone())
            } else {
                None
            }
        } else {
            None
        }
    };

    let mut items = Vec::new();
    for pane in &tab.panes {
        let mut p = pane.clone();
        p.tab_name = Some(tab.name.clone());
        p.window_id = Some(window.id);
        if let Some(ref target_id) = override_focus {
            p.focused = p.pane_id == *target_id;
        }
        items.push(TouchBarItem::Pane(p));
    }
    items.push(TouchBarItem::AddPane);
    items.push(TouchBarItem::AddTab);
    
    // Clamp the pane_scroll_offset
    let mut offset = state.pane_scroll_offset.lock().unwrap();
    let max_offset = items.len().saturating_sub(4);
    if *offset > max_offset {
        *offset = max_offset;
    }
    
    // Extract 4 displayed items
    let displayed: Vec<TouchBarItem> = items.iter().skip(*offset).take(4).cloned().collect();
    let total_len = items.len();
    
    {
        let mut all_items_guard = state.all_items.lock().unwrap();
        *all_items_guard = items;
    }
    {
        let mut status_guard = state.status.lock().unwrap();
        status_guard.active_panes = displayed.clone();
        status_guard.pane_scroll_offset = *offset;
        status_guard.total_items = total_len;
        status_guard.running_apps = state.running_apps.lock().unwrap().clone();
        status_guard.app_scroll_offset = *state.app_scroll_offset.lock().unwrap();
    }
    
    // Broadcast state sync event to websocket clients
    let connected = state.status.lock().unwrap().connected;
    let _ = state.event_tx.send(StreamDeckEvent::Sync {
        active_panes: displayed.clone(),
        pane_scroll_offset: *offset,
        total_items: total_len,
        running_apps: state.running_apps.lock().unwrap().clone(),
        app_scroll_offset: *state.app_scroll_offset.lock().unwrap(),
        connected,
    });

    // Redraw the physical touch bar
    let _ = crate::mcp::redraw_touch_bar(&displayed, &*state.device.lock().unwrap(), None, *offset, total_len);
    
    Ok(())
}

pub fn flash_touch_bar(_state: Arc<AppState>, _color: image::Rgb<u8>) {
    // No-op: user requested not to flash background as it is too bright.
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Initializing Stream Deck MCP & Dashboard Server...");

    let (event_tx, _) = broadcast::channel::<StreamDeckEvent>(100);

    let deck_res = StreamDeckPlus::connect(event_tx.clone());

    let (device, status) = match deck_res {
        Ok(deck) => {
            println!("Connected to Stream Deck Plus! Serial: {}", deck.serial);
            
            // Set initial brightness
            let _ = deck.set_brightness(100);
            
            let status = DeviceStatus {
                connected: true,
                serial_number: deck.serial.clone(),
                firmware_version: "1.0.0".to_string(),
                active_panes: Vec::new(),
                pane_scroll_offset: 0,
                total_items: 0,
                running_apps: Vec::new(),
                app_scroll_offset: 0,
            };
            (Some(deck), status)
        }
        Err(e) => {
            eprintln!("Warning: Failed to connect to Stream Deck Plus: {:?}", e);
            let status = DeviceStatus {
                connected: false,
                serial_number: "none".to_string(),
                firmware_version: "N/A".to_string(),
                active_panes: Vec::new(),
                pane_scroll_offset: 0,
                total_items: 0,
                running_apps: Vec::new(),
                app_scroll_offset: 0,
            };
            (None, status)
        }
    };

    let state = Arc::new(AppState {
        device: Mutex::new(device),
        event_tx: event_tx.clone(),
        all_items: Mutex::new(Vec::new()),
        pane_scroll_offset: Mutex::new(0),
        status: Mutex::new(status),
        brightness: Mutex::new(100),
        last_focused_pane: Mutex::new(None),
        selected_tab_name: Mutex::new(None),
        app_scroll_offset: Mutex::new(0),
        running_apps: Mutex::new(Vec::new()),
        app_focus_indices: Mutex::new(std::collections::HashMap::new()),
    });

    // Spawn task to process physical device events
    let state_clone = Arc::clone(&state);
    let mut rx = event_tx.subscribe();
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            match event {
                StreamDeckEvent::TouchShortPress { x, y } => {
                    let col = (x / 200) as usize;
                    println!("TouchShortPress column: {}, x: {}, y: {}", col, x, y);
                    
                    let tapped_item = {
                        let s = state_clone.status.lock().unwrap();
                        s.active_panes.get(col).cloned()
                    };
                    
                    if let Some(item) = tapped_item {
                        let state_temp = Arc::clone(&state_clone);
                        tokio::spawn(async move {
                            let client = crate::hyperia::HyperiaClient::new();
                            match item {
                                TouchBarItem::Pane(pane) => {
                                    println!("Focusing pane: {} ({}) via physical touch", pane.name, pane.pane_id);
                                    
                                    // Update local focus state immediately!
                                    {
                                        let mut items = state_temp.all_items.lock().unwrap();
                                        for it in items.iter_mut() {
                                            if let TouchBarItem::Pane(ref mut p) = it {
                                                p.focused = p.pane_id == pane.pane_id;
                                            }
                                        }
                                        let offset = *state_temp.pane_scroll_offset.lock().unwrap();
                                        let displayed: Vec<TouchBarItem> = items.iter().skip(offset).take(4).cloned().collect();
                                        state_temp.status.lock().unwrap().active_panes = displayed.clone();
                                        let total_len = items.len();
                                        let _ = crate::mcp::redraw_touch_bar(&displayed, &*state_temp.device.lock().unwrap(), None, offset, total_len);
                                    }
                                    
                                    *state_temp.last_focused_pane.lock().unwrap() = Some((pane.pane_id.clone(), std::time::Instant::now()));
                                    if let Some(ref t_name) = pane.tab_name {
                                        *state_temp.selected_tab_name.lock().unwrap() = Some(t_name.clone());
                                    }
                                    if let Err(e) = client.focus_pane(&pane.pane_id, pane.tab_name.as_deref(), pane.window_id).await.map_err(|e| e.to_string()) {
                                        eprintln!("Failed to focus pane: {}", e);
                                    } else {
                                        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                                        let _ = sync_panes_internal(state_temp).await;
                                    }
                                }
                                TouchBarItem::AddPane => {
                                    println!("Splitting pane via physical touch");
                                    let focused_pane_id = {
                                        let status = state_temp.status.lock().unwrap();
                                        status.active_panes.iter().find_map(|item| {
                                            if let TouchBarItem::Pane(ref p) = item {
                                                if p.focused {
                                                    return Some(p.pane_id.clone());
                                                }
                                            }
                                            None
                                        })
                                    };
                                    if let Some(pid) = focused_pane_id {
                                        if let Err(e) = client.split_pane(&pid, None, None).await.map_err(|e| e.to_string()) {
                                            eprintln!("Failed to split pane: {}", e);
                                        } else {
                                            let _ = sync_panes_internal(state_temp).await;
                                        }
                                    }
                                }
                                TouchBarItem::AddTab => {
                                    println!("Creating new tab via physical touch");
                                    if let Err(e) = client.new_tab().await.map_err(|e| e.to_string()) {
                                        eprintln!("Failed to create tab: {}", e);
                                    } else {
                                        *state_temp.pane_scroll_offset.lock().unwrap() = 0;
                                        let _ = sync_panes_internal(state_temp).await;
                                    }
                                }
                            }
                        });
                    }
                }
                StreamDeckEvent::TouchSwipe { start_x, start_y: _, end_x, end_y: _ } => {
                    let swipe_delta = (end_x as i32) - (start_x as i32);
                    println!("TouchSwipe: start_x={}, end_x={}, delta={}", start_x, end_x, swipe_delta);
                    if swipe_delta.abs() > 60 {
                        let all_items_len = state_clone.all_items.lock().unwrap().len();
                        let max_offset = all_items_len.saturating_sub(4);
                        
                        let mut current_offset = state_clone.pane_scroll_offset.lock().unwrap();
                        let mut can_scroll = false;
                        
                        if swipe_delta > 0 {
                            // Swipe right (finger moves left-to-right) -> scroll left (decrease offset)
                            if *current_offset > 0 {
                                *current_offset = current_offset.saturating_sub(1);
                                can_scroll = true;
                            }
                        } else {
                            // Swipe left (finger moves right-to-left) -> scroll right (increase offset)
                            if *current_offset < max_offset {
                                *current_offset = (*current_offset + 1).min(max_offset);
                                can_scroll = true;
                            }
                        }
                        
                        if can_scroll {
                            let state_temp = Arc::clone(&state_clone);
                            tokio::spawn(async move {
                                let _ = sync_panes_internal(state_temp).await;
                            });
                        } else {
                            flash_touch_bar(Arc::clone(&state_clone), image::Rgb([255, 140, 0]));
                        }
                    }
                }
                StreamDeckEvent::DialPress { dial, pressed } => {
                    println!("DialPress: dial={}, pressed={}", dial, pressed);
                    if pressed && dial < 4 {
                        let col = dial as usize;
                        let tapped_item = {
                            let s = state_clone.status.lock().unwrap();
                            s.active_panes.get(col).cloned()
                        };
                        if let Some(item) = tapped_item {
                            let state_temp = Arc::clone(&state_clone);
                            tokio::spawn(async move {
                                let client = crate::hyperia::HyperiaClient::new();
                                match item {
                                    TouchBarItem::Pane(pane) => {
                                        println!("Focusing pane: {} ({}) via dial press", pane.name, pane.pane_id);
                                        
                                        // Update local focus state immediately!
                                        {
                                            let mut items = state_temp.all_items.lock().unwrap();
                                            for it in items.iter_mut() {
                                                if let TouchBarItem::Pane(ref mut p) = it {
                                                    p.focused = p.pane_id == pane.pane_id;
                                                }
                                            }
                                            let offset = *state_temp.pane_scroll_offset.lock().unwrap();
                                            let displayed: Vec<TouchBarItem> = items.iter().skip(offset).take(4).cloned().collect();
                                            state_temp.status.lock().unwrap().active_panes = displayed.clone();
                                            let total_len = items.len();
                                            let _ = crate::mcp::redraw_touch_bar(&displayed, &*state_temp.device.lock().unwrap(), None, offset, total_len);
                                        }
                                        
                                        *state_temp.last_focused_pane.lock().unwrap() = Some((pane.pane_id.clone(), std::time::Instant::now()));
                                        if let Some(ref t_name) = pane.tab_name {
                                            *state_temp.selected_tab_name.lock().unwrap() = Some(t_name.clone());
                                        }
                                        if let Err(e) = client.focus_pane(&pane.pane_id, pane.tab_name.as_deref(), pane.window_id).await.map_err(|e| e.to_string()) {
                                            eprintln!("Failed to focus pane: {}", e);
                                        } else {
                                            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                                            let _ = sync_panes_internal(state_temp).await;
                                        }
                                    }
                                    TouchBarItem::AddPane => {
                                        let focused_pane_id = {
                                            let status = state_temp.status.lock().unwrap();
                                            status.active_panes.iter().find_map(|item| {
                                                if let TouchBarItem::Pane(ref p) = item {
                                                    if p.focused {
                                                        return Some(p.pane_id.clone());
                                                    }
                                                }
                                                None
                                            })
                                        };
                                        if let Some(pid) = focused_pane_id {
                                            if let Err(e) = client.split_pane(&pid, None, None).await.map_err(|e| e.to_string()) {
                                                eprintln!("Failed to split pane: {}", e);
                                            } else {
                                                let _ = sync_panes_internal(state_temp).await;
                                            }
                                        }
                                    }
                                    TouchBarItem::AddTab => {
                                        if let Err(e) = client.new_tab().await.map_err(|e| e.to_string()) {
                                            eprintln!("Failed to create tab: {}", e);
                                        } else {
                                            *state_temp.pane_scroll_offset.lock().unwrap() = 0;
                                            let _ = sync_panes_internal(state_temp).await;
                                        }
                                    }
                                }
                            });
                        }
                    }
                }
                StreamDeckEvent::DialRotate { dial, delta } => {
                    println!("DialRotate: dial={}, delta={}", dial, delta);
                    if dial == 0 {
                        // Scroll panes
                        let all_items_len = state_clone.all_items.lock().unwrap().len();
                        let max_offset = all_items_len.saturating_sub(4);
                        
                        let mut current_offset = state_clone.pane_scroll_offset.lock().unwrap();
                        let mut can_scroll = false;
                        
                        if delta < 0 {
                            if *current_offset > 0 {
                                *current_offset = current_offset.saturating_sub(1);
                                can_scroll = true;
                            }
                        } else if delta > 0 {
                            if *current_offset < max_offset {
                                *current_offset = (*current_offset + 1).min(max_offset);
                                can_scroll = true;
                            }
                        }
                        
                        if can_scroll {
                            let state_temp = Arc::clone(&state_clone);
                            tokio::spawn(async move {
                                let _ = sync_panes_internal(state_temp).await;
                            });
                        } else {
                            // Flash orange/yellow
                            flash_touch_bar(Arc::clone(&state_clone), image::Rgb([255, 140, 0]));
                        }
                    } else if dial == 1 {
                        // Scroll tabs in active window (locally first)
                        let state_temp = Arc::clone(&state_clone);
                        tokio::spawn(async move {
                            let client = crate::hyperia::HyperiaClient::new();
                            match client.get_terminal_status().await.map_err(|e| e.to_string()) {
                                Ok(status) => {
                                    if let Some(window) = status.windows.iter().find(|w| w.focused).or_else(|| status.windows.first()) {
                                        let tabs = &window.tabs;
                                        
                                        let current_tab_name = {
                                            state_temp.selected_tab_name.lock().unwrap().clone()
                                        };
                                        
                                        let active_idx = current_tab_name.and_then(|name| {
                                            tabs.iter().position(|t| t.name == name)
                                        }).unwrap_or(0);

                                        let mut target_idx = active_idx;
                                        if delta < 0 {
                                            if active_idx > 0 {
                                                target_idx = active_idx - 1;
                                            }
                                        } else if delta > 0 {
                                            if active_idx + 1 < tabs.len() {
                                                target_idx = active_idx + 1;
                                            }
                                        }
                                        
                                        if target_idx != active_idx {
                                            let target_tab = &tabs[target_idx];
                                            println!("Scrolling local tab view to: {}", target_tab.name);
                                            
                                            // Update local selected tab
                                            *state_temp.selected_tab_name.lock().unwrap() = Some(target_tab.name.clone());
                                            *state_temp.pane_scroll_offset.lock().unwrap() = 0;
                                            
                                            let _ = sync_panes_internal(state_temp).await;
                                        } else {
                                            // Edge reached: flash touch bar (no-op)
                                            flash_touch_bar(state_temp, image::Rgb([255, 235, 0]));
                                        }
                                    }
                                }
                                Err(e) => {
                                    eprintln!("Failed to get terminal status for tab scroll: {}", e);
                                }
                            }
                        });
                    } else if dial == 2 {
                        // Scroll apps
                        let apps_len = state_clone.running_apps.lock().unwrap().len();
                        let max_offset = apps_len.saturating_sub(8);
                        
                        let mut current_offset = state_clone.app_scroll_offset.lock().unwrap();
                        let mut can_scroll = false;
                        
                        if delta < 0 {
                            if *current_offset > 0 {
                                *current_offset = current_offset.saturating_sub(1);
                                can_scroll = true;
                            }
                        } else if delta > 0 {
                            if *current_offset < max_offset {
                                *current_offset = (*current_offset + 1).min(max_offset);
                                can_scroll = true;
                            }
                        }
                        
                        if can_scroll {
                            let state_temp = Arc::clone(&state_clone);
                            tokio::spawn(async move {
                                // Redraw physical buttons
                                update_physical_buttons(&state_temp);
                                
                                // Sync states (updates status and Web UI)
                                let _ = sync_panes_internal(state_temp).await;
                            });
                        }
                    } else if dial == 3 {
                        // Adjust brightness
                        let current_brightness = {
                            let b = state_clone.brightness.lock().unwrap();
                            *b
                        };
                        let change = delta * 5;
                        let new_brightness = ((current_brightness as i16) + (change as i16)).clamp(0, 100) as u8;
                        *state_clone.brightness.lock().unwrap() = new_brightness;
                        println!("Adjusting brightness to {}%", new_brightness);
                        if let Some(ref d) = *state_clone.device.lock().unwrap() {
                            let _ = d.set_brightness(new_brightness);
                        }
                    }
                }
                StreamDeckEvent::ButtonPress { key, pressed } => {
                    println!("ButtonPress: key={}, pressed={}", key, pressed);
                    if pressed && (key as usize) < 8 {
                        let app_idx = {
                            let offset = state_clone.app_scroll_offset.lock().unwrap();
                            *offset + (key as usize)
                        };
                        let apps = state_clone.running_apps.lock().unwrap();
                        if app_idx < apps.len() {
                            let app = &apps[app_idx];
                            if !app.pids.is_empty() {
                                let mut indices = state_clone.app_focus_indices.lock().unwrap();
                                let current_idx = indices.get(&app.name).cloned().unwrap_or(0);
                                let idx_to_focus = current_idx % app.pids.len();
                                let target_id = app.pids[idx_to_focus];
                                
                                println!("Activating app window: {} (HWND {}, window index {}/{})", app.name, target_id, idx_to_focus + 1, app.pids.len());
                                activate_app_or_hwnd(target_id, true);
                                
                                indices.insert(app.name.clone(), idx_to_focus + 1);
                            } else {
                                println!("Activating app: {} (PID {})", app.name, app.pid);
                                activate_app_or_hwnd(app.pid, false);
                            }
                        }
                    }
                }
                StreamDeckEvent::DeviceDisconnect => {
                    println!("Stream Deck hardware disconnected!");
                    {
                        let mut dev_guard = state_clone.device.lock().unwrap();
                        *dev_guard = None;
                    }
                    {
                        let mut status_guard = state_clone.status.lock().unwrap();
                        status_guard.connected = false;
                    }
                    let _ = sync_panes_internal(Arc::clone(&state_clone)).await;
                }
                _ => {}
            }
        }
    });

    // Start background sync with Hyperia to load initial panes and poll periodically
    let state_clone = Arc::clone(&state);
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        println!("Performing initial Hyperia panes sync...");
        
        // Initial app scan
        let apps = scan_running_apps();
        {
            let mut apps_guard = state_clone.running_apps.lock().unwrap();
            *apps_guard = apps;
        }
        update_physical_buttons(&state_clone);
        
        if let Err(e) = sync_panes_internal(Arc::clone(&state_clone)).await {
            eprintln!("Failed to perform initial Hyperia sync: {:?}", e);
        } else {
            println!("Successfully completed initial Hyperia sync!");
        }

        let mut counter = 0;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;
            let _ = sync_panes_internal(Arc::clone(&state_clone)).await;
            
            counter += 1;
            if counter % 2 == 0 {
                let apps = scan_running_apps();
                {
                    let mut apps_guard = state_clone.running_apps.lock().unwrap();
                    *apps_guard = apps;
                }
                update_physical_buttons(&state_clone);
            }
        }
    });

    // Background reconnect loop
    let state_clone = Arc::clone(&state);
    let event_tx_clone = event_tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            
            let is_disconnected = {
                let dev_guard = state_clone.device.lock().unwrap();
                dev_guard.is_none()
            };
            
            if is_disconnected {
                println!("Device is not connected, trying to reconnect...");
                let deck_opt = match StreamDeckPlus::connect(event_tx_clone.clone()) {
                    Ok(deck) => Some(deck),
                    Err(_) => None,
                };
                
                if let Some(deck) = deck_opt {
                    println!("Successfully reconnected to Stream Deck Plus! Serial: {}", deck.serial);
                    let _ = deck.set_brightness(100);
                    
                    {
                        let mut dev_guard = state_clone.device.lock().unwrap();
                        *dev_guard = Some(deck);
                    }
                    
                    {
                        let mut status_guard = state_clone.status.lock().unwrap();
                        status_guard.connected = true;
                    }
                    
                    update_physical_buttons(&state_clone);
                    let _ = sync_panes_internal(Arc::clone(&state_clone)).await;
                }
            }
        }
    });

    // Setup HTTP routes
    let app = crate::web::create_router(Arc::clone(&state));

    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    println!("HTTP server listening on {}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

pub fn scan_running_apps() -> Vec<RunningApp> {
    let script = r#"
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        $code = @'
        using System;
        using System.Runtime.InteropServices;
        using System.Drawing;
        using System.Text;
        using System.Collections.Generic;

        public class IconExtractor {
            [DllImport("user32.dll", CharSet = CharSet.Unicode)]
            public static extern uint PrivateExtractIcons(
                string lpszFile,
                int nIconIndex,
                int cxIcon,
                int cyIcon,
                IntPtr[] phicon,
                int[] piconid,
                uint nIcons,
                uint flags
            );

            [DllImport("user32.dll")]
            public static extern bool DestroyIcon(IntPtr hIcon);

            public static Bitmap GetIcon(string filePath, int size) {
                IntPtr[] hIcons = new IntPtr[1];
                int[] pIconIds = new int[1];
                uint count = PrivateExtractIcons(filePath, 0, size, size, hIcons, pIconIds, 1, 0);
                if (count > 0 && hIcons[0] != IntPtr.Zero) {
                    try {
                        Icon icon = Icon.FromHandle(hIcons[0]);
                        Bitmap bmp = icon.ToBitmap();
                        icon.Dispose();
                        return bmp;
                    } finally {
                        DestroyIcon(hIcons[0]);
                    }
                }
                return null;
            }
        }

        public class WindowLister {
            [DllImport("user32.dll")]
            private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

            [DllImport("user32.dll")]
            private static extern bool IsWindowVisible(IntPtr hWnd);

            [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
            private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

            [DllImport("user32.dll")]
            private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

            private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

            public struct WindowInfo {
                public IntPtr HWND;
                public uint PID;
                public string Title;
            }

            public static List<WindowInfo> GetVisibleWindows() {
                List<WindowInfo> windows = new List<WindowInfo>();
                EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
                    if (IsWindowVisible(hWnd)) {
                        StringBuilder sb = new StringBuilder(256);
                        GetWindowText(hWnd, sb, sb.Capacity);
                        string title = sb.ToString();
                        
                        if (!string.IsNullOrEmpty(title)) {
                            uint pid;
                            GetWindowThreadProcessId(hWnd, out pid);
                            windows.Add(new WindowInfo { HWND = hWnd, PID = pid, Title = title });
                        }
                    }
                    return true;
                }, IntPtr.Zero);
                return windows;
            }
        }
'@
        Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing -ErrorAction SilentlyContinue
        
        $wins = [WindowLister]::GetVisibleWindows()
        $filtered = @()
        foreach ($w in $wins) {
            $p = Get-Process -Id $w.PID -ErrorAction SilentlyContinue
            if ($p -and $p.Path -and $p.ProcessName -notmatch 'ApplicationFrameHost|TextInputHost|SystemSettings|NVIDIA|nvsphelper|msedgewebview2') {
                if ($p.ProcessName -eq 'explorer' -and $w.Title -eq 'Program Manager') {
                    continue;
                }
                $filtered += [PSCustomObject]@{ HWND=$w.HWND.ToInt64(); PID=$w.PID; ProcessName=$p.ProcessName; Title=$w.Title; Path=$p.Path }
            }
        }
        
        $sonos_proc = Get-Process -Name Sonos -ErrorAction SilentlyContinue
        $has_sonos = $filtered | Where-Object { $_.ProcessName -eq 'sonos' }
        if ($sonos_proc -and -not $has_sonos -and $sonos_proc.Path) {
            $filtered += [PSCustomObject]@{ HWND=0; PID=$sonos_proc.Id; ProcessName='sonos'; Title='Sonos'; Path=$sonos_proc.Path }
        }

        $groups = $filtered | Group-Object ProcessName
        $result = @()
        foreach ($g in $groups) {
            $pids = @()
            $title = ""
            $group_wins = $g.Group
            foreach ($win in $group_wins) {
                if ($win.HWND -ne 0) {
                    $pids += $win.HWND
                }
                if (-not $title -and $win.Title) { $title = $win.Title }
            }
            if (-not $title) { $title = $g.Name }
            
            $p_first = $g.Group[0]
            $base64 = ""
            try {
                $bmp = [IconExtractor]::GetIcon($p_first.Path, 256)
                if (-not $bmp) {
                    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p_first.Path)
                    $bmp = $icon.ToBitmap()
                    $icon.Dispose()
                }
                
                # Crop transparent border
                $minX = $bmp.Width
                $maxX = 0
                $minY = $bmp.Height
                $maxY = 0
                for ($y = 0; $y -lt $bmp.Height; $y++) {
                    for ($x = 0; $x -lt $bmp.Width; $x++) {
                        $color = $bmp.GetPixel($x, $y)
                        if ($color.A -gt 10) {
                            if ($x -lt $minX) { $minX = $x }
                            if ($x -gt $maxX) { $maxX = $x }
                            if ($y -lt $minY) { $minY = $y }
                            if ($y -gt $maxY) { $maxY = $y }
                        }
                    }
                }
                if ($maxX -ge $minX -and $maxY -ge $minY) {
                    $cropW = $maxX - $minX + 1
                    $cropH = $maxY - $minY + 1
                    $cropped = New-Object System.Drawing.Bitmap $cropW, $cropH
                    $graphics = [System.Drawing.Graphics]::FromImage($cropped)
                    $graphics.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $cropW, $cropH), (New-Object System.Drawing.Rectangle $minX, $minY, $cropW, $cropH), [System.Drawing.GraphicsUnit]::Pixel)
                    $graphics.Dispose()
                    $bmp.Dispose()
                    $bmp = $cropped
                }
                
                $ms = New-Object System.IO.MemoryStream
                $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $bytes = $ms.ToArray()
                $base64 = [Convert]::ToBase64String($bytes)
                $bmp.Dispose()
                $ms.Dispose()
            } catch {}
            
            $result += [PSCustomObject]@{
                pid = $p_first.PID
                pids = $pids
                name = $g.Name
                title = $title
                icon_base64 = $base64
                window_count = $pids.Count
            }
        }
        $result | ConvertTo-Json -Compress
    "#;

    let output = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-Command", script])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let _ = std::fs::write("apps.json", &*stdout);
            if let Ok(apps) = serde_json::from_str::<Vec<RunningApp>>(&stdout) {
                let mut sorted = Vec::new();
                let mut others = Vec::new();
                
                for mut app in apps {
                    let lower_name = app.name.to_lowercase();
                    if lower_name.contains("sonos") {
                        if let Ok(bytes) = std::fs::read("src/sonos_icon.jpg") {
                            app.icon_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        }
                    } else if lower_name.contains("explorer") {
                        if let Ok(bytes) = std::fs::read("src/explorer_icon.jpg") {
                            app.icon_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        }
                    }
                    
                    if lower_name.contains("hyperia") || app.title.to_lowercase().contains("hyperia") {
                        sorted.insert(0, app);
                    } else if lower_name.contains("sonos") {
                        let insert_idx = sorted.iter().position(|x| !x.name.to_lowercase().contains("hyperia")).unwrap_or(sorted.len());
                        sorted.insert(insert_idx, app);
                    } else if lower_name.contains("explorer") {
                        let insert_idx = sorted.iter().position(|x| !x.name.to_lowercase().contains("hyperia") && !x.name.to_lowercase().contains("sonos")).unwrap_or(sorted.len());
                        sorted.insert(insert_idx, app);
                    } else {
                        others.push(app);
                    }
                }
                sorted.extend(others);
                return sorted;
            }
        }
        Err(e) => {
            eprintln!("Failed to scan running apps: {:?}", e);
        }
    }
    Vec::new()
}

pub fn create_button_image(icon_bytes: &[u8], app_name: &str, window_count: usize) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let icon_img = image::load_from_memory(icon_bytes)?;
    let bg_color = image::Rgb([30, 30, 35]);
    let mut canvas = image::ImageBuffer::from_pixel(120, 120, bg_color);
    
    let is_full_size = app_name.to_lowercase().contains("hyperia") || app_name.to_lowercase().contains("sonos");
    
    if is_full_size {
        // Resize icon to fill the button completely (120x120)
        let resized_icon = icon_img.resize_to_fill(120, 120, image::imageops::FilterType::Lanczos3).to_rgba8();
        let w = resized_icon.width().min(120);
        let h = resized_icon.height().min(120);
        let dx = (120 - w) / 2;
        let dy = (120 - h) / 2;
        for x in 0..w {
            for y in 0..h {
                let pixel = resized_icon.get_pixel(x, y);
                let alpha = (pixel[3] as f32) / 255.0;
                let bg_pixel = canvas.get_pixel_mut(dx + x, dy + y);
                
                let r = ((pixel[0] as f32 * alpha) + (bg_pixel.0[0] as f32 * (1.0 - alpha))) as u8;
                let g = ((pixel[1] as f32 * alpha) + (bg_pixel.0[1] as f32 * (1.0 - alpha))) as u8;
                let b = ((pixel[2] as f32 * alpha) + (bg_pixel.0[2] as f32 * (1.0 - alpha))) as u8;
                
                *bg_pixel = image::Rgb([r, g, b]);
            }
        }
    } else {
        // Resize icon to fit nicely and centered (64x64)
        let resized_icon = icon_img.resize(64, 64, image::imageops::FilterType::Lanczos3).to_rgba8();
        
        // Center it on canvas at Y=15
        let x_offset = (120 - resized_icon.width()) / 2;
        let y_offset = 15;
        
        for x in 0..resized_icon.width() {
            for y in 0..resized_icon.height() {
                let pixel = resized_icon.get_pixel(x, y);
                let alpha = (pixel[3] as f32) / 255.0;
                let bg_pixel = canvas.get_pixel_mut(x_offset + x, y_offset + y);
                
                let r = ((pixel[0] as f32 * alpha) + (bg_pixel.0[0] as f32 * (1.0 - alpha))) as u8;
                let g = ((pixel[1] as f32 * alpha) + (bg_pixel.0[1] as f32 * (1.0 - alpha))) as u8;
                let b = ((pixel[2] as f32 * alpha) + (bg_pixel.0[2] as f32 * (1.0 - alpha))) as u8;
                
                *bg_pixel = image::Rgb([r, g, b]);
            }
        }

        // Draw the app name at Y=92, centered
        let cleaned = clean_app_name(app_name);
        if let Some(ref font) = *FONT {
            let font_size = 12.0;
            let scale = rusttype::Scale::uniform(font_size);
            
            // Measure text width
            let glyphs: Vec<_> = font.layout(&cleaned, scale, rusttype::point(0.0, 0.0)).collect();
            let mut text_width: f32 = 0.0;
            for g in glyphs {
                if let Some(bbox) = g.pixel_bounding_box() {
                    text_width = text_width.max(bbox.max.x as f32);
                }
            }
            let text_width = text_width as i32;
            let text_x = (120 - text_width) / 2;
            let text_y = 92;
            
            let v_metrics = font.v_metrics(scale);
            let layout_glyphs: Vec<_> = font
                .layout(&cleaned, scale, rusttype::point(text_x as f32, text_y as f32 + v_metrics.ascent))
                .collect();
                
            let text_color = image::Rgb([220, 220, 225]);
            for glyph in layout_glyphs {
                if let Some(bounding_box) = glyph.pixel_bounding_box() {
                    glyph.draw(|gx, gy, gv| {
                        let px = bounding_box.min.x + gx as i32;
                        let py = bounding_box.min.y + gy as i32;
                        if px >= 0 && px < 120 && py >= 0 && py < 120 {
                            let pixel = canvas.get_pixel_mut(px as u32, py as u32);
                            let alpha = gv;
                            let r = ((text_color.0[0] as f32 * alpha) + (pixel.0[0] as f32 * (1.0 - alpha))) as u8;
                            let g = ((text_color.0[1] as f32 * alpha) + (pixel.0[1] as f32 * (1.0 - alpha))) as u8;
                            let b = ((text_color.0[2] as f32 * alpha) + (pixel.0[2] as f32 * (1.0 - alpha))) as u8;
                            *pixel = image::Rgb([r, g, b]);
                        }
                    });
                }
            }
        }
    }

    if window_count > 1 {
        let center_x = 104i32;
        let center_y = 104i32;
        let radius = 10i32;
        let red_color = image::Rgb([235, 30, 30]);
        for x in (center_x - radius)..=(center_x + radius) {
            for y in (center_y - radius)..=(center_y + radius) {
                if x >= 0 && x < 120 && y >= 0 && y < 120 {
                    let dx = x - center_x;
                    let dy = y - center_y;
                    if dx * dx + dy * dy <= radius * radius {
                        canvas.put_pixel(x as u32, y as u32, red_color);
                    }
                }
            }
        }
        // Draw the number centered in the red circle
        let count_str = window_count.to_string();
        if let Some(ref font) = *FONT {
            let font_size = 11.0;
            let scale = rusttype::Scale::uniform(font_size);
            
            // Measure text width
            let glyphs: Vec<_> = font.layout(&count_str, scale, rusttype::point(0.0, 0.0)).collect();
            let mut text_width: f32 = 0.0;
            for g in glyphs {
                if let Some(bbox) = g.pixel_bounding_box() {
                    text_width = text_width.max(bbox.max.x as f32);
                }
            }
            let text_width = text_width as i32;
            let text_x = center_x - (text_width / 2);
            let text_y = center_y - 5;
            
            let v_metrics = font.v_metrics(scale);
            let layout_glyphs: Vec<_> = font
                .layout(&count_str, scale, rusttype::point(text_x as f32, text_y as f32 + v_metrics.ascent))
                .collect();
                
            let text_color = image::Rgb([255, 255, 255]);
            for glyph in layout_glyphs {
                if let Some(bounding_box) = glyph.pixel_bounding_box() {
                    glyph.draw(|gx, gy, gv| {
                        let px = bounding_box.min.x + gx as i32;
                        let py = bounding_box.min.y + gy as i32;
                        if px >= 0 && px < 120 && py >= 0 && py < 120 {
                            let pixel = canvas.get_pixel_mut(px as u32, py as u32);
                            let alpha = gv;
                            let r = ((text_color.0[0] as f32 * alpha) + (pixel.0[0] as f32 * (1.0 - alpha))) as u8;
                            let g = ((text_color.0[1] as f32 * alpha) + (pixel.0[1] as f32 * (1.0 - alpha))) as u8;
                            let b = ((text_color.0[2] as f32 * alpha) + (pixel.0[2] as f32 * (1.0 - alpha))) as u8;
                            *pixel = image::Rgb([r, g, b]);
                        }
                    });
                }
            }
        }
    }
    
    let mut jpeg_bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
    encoder.encode(&canvas, 120, 120, image::ColorType::Rgb8)?;
    Ok(jpeg_bytes)
}

pub fn update_physical_buttons(state: &AppState) {
    let deck = state.device.lock().unwrap();
    let deck_ref = match &*deck {
        Some(d) => d,
        None => return,
    };
    
    let apps = state.running_apps.lock().unwrap();
    let offset = *state.app_scroll_offset.lock().unwrap();
    
    for i in 0..8 {
        let app_idx = offset + i;
        if app_idx < apps.len() {
            let app = &apps[app_idx];
            if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&app.icon_base64) {
                let decoded_bytes: &[u8] = &decoded;
                if let Ok(jpeg_bytes) = create_button_image(decoded_bytes, &app.name, app.window_count as usize) {
                    let _ = deck_ref.fill_button_image(i as u8, &jpeg_bytes);
                    continue;
                }
            }
        }
        // Fallback: dark button
        let bg_color = image::Rgb([30, 30, 35]);
        let canvas = image::ImageBuffer::from_pixel(120, 120, bg_color);
        let mut jpeg_bytes = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
        if let Ok(_) = encoder.encode(&canvas, 120, 120, image::ColorType::Rgb8) {
            let _ = deck_ref.fill_button_image(i as u8, &jpeg_bytes);
        }
    }
}
#[cfg(windows)]
type HWND = *mut std::ffi::c_void;
#[cfg(windows)]
type BOOL = i32;
#[cfg(windows)]
type DWORD = u32;

#[cfg(windows)]
struct EnumData {
    target_pid: u32,
    found_hwnd: HWND,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetForegroundWindow(hWnd: HWND) -> BOOL;
    fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> BOOL;
    fn EnumWindows(lpEnumFunc: unsafe extern "system" fn(HWND, isize) -> BOOL, lParam: isize) -> BOOL;
    fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut DWORD) -> DWORD;
    fn IsWindowVisible(hWnd: HWND) -> BOOL;
    fn keybd_event(bVk: u8, bScan: u8, dwFlags: u32, dwExtraInfo: usize);
}

#[cfg(windows)]
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: isize) -> BOOL {
    let data = &mut *(lparam as *mut EnumData);
    let mut pid: DWORD = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == data.target_pid && IsWindowVisible(hwnd) != 0 {
        data.found_hwnd = hwnd;
        return 0; // Stop enumerating
    }
    1 // Continue enumerating
}

#[cfg(windows)]
pub fn activate_app_or_hwnd(id: u32, is_hwnd: bool) {
    println!("Activating target (id: {}, is_hwnd: {})", id, is_hwnd);
    unsafe {
        let hwnd = if is_hwnd {
            id as usize as HWND
        } else {
            let mut data = EnumData {
                target_pid: id,
                found_hwnd: std::ptr::null_mut(),
            };
            EnumWindows(enum_windows_callback, &mut data as *mut EnumData as isize);
            data.found_hwnd
        };
        
        if !hwnd.is_null() {
            // Tap Alt key to unlock foreground focus stealing prevention
            keybd_event(0x12, 0, 0, 0); // Alt down
            keybd_event(0x12, 0, 2, 0); // Alt up
            
            ShowWindow(hwnd, 9); // SW_RESTORE
            SetForegroundWindow(hwnd);
            println!("Activated window handle {:?}", hwnd);
        } else {
            if !is_hwnd {
                println!("No window found for PID {}, falling back to WScript.Shell", id);
                let script = format!(
                    r#"
                    $wshell = New-Object -ComObject Wscript.Shell
                    $wshell.AppActivate({})
                    "#,
                    id
                );
                let _ = std::process::Command::new("powershell")
                    .args(&["-NoProfile", "-Command", &script])
                    .status();
            } else {
                println!("No window handle found for HWND {}", id);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn activate_app_or_hwnd(id: u32, is_hwnd: bool) {
    println!("Activating target: {} (is_hwnd: {}) (stub on non-Windows)", id, is_hwnd);
}
