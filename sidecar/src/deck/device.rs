use elgato_streamdeck::{list_devices, new_hidapi, StreamDeck};
use elgato_streamdeck::info::Kind;
use std::time::Duration;

/// Device capabilities discovered at connection time
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceCapabilities {
    pub kind: String,
    pub serial: String,
    pub firmware: String,
    pub manufacturer: String,
    pub product: String,
    pub button_count: u8,
    pub encoder_count: u8,
    pub has_touchstrip: bool,
    pub button_resolution: (u16, u16),
    pub touchstrip_resolution: (u16, u16),
}

/// Discover all connected Stream Deck devices, return (Kind, serial) pairs.
pub fn discover_devices() -> Result<Vec<(Kind, String)>, String> {
    let hid = new_hidapi().map_err(|e| format!("HidApi init failed: {e}"))?;
    let devices = list_devices(&hid);
    Ok(devices)
}

/// Connect to a specific Stream Deck by serial, or the first Plus found.
pub fn connect_plus(serial: Option<&str>) -> Result<(StreamDeck, DeviceCapabilities), String> {
    let hid = new_hidapi().map_err(|e| format!("HidApi init failed: {e}"))?;
    let devices = list_devices(&hid);

    if devices.is_empty() {
        return Err("No Stream Deck devices found".into());
    }

    let (kind, target_serial) = if let Some(s) = serial {
        devices
            .iter()
            .find(|(_, ser)| ser == s)
            .ok_or_else(|| format!("No device with serial {s}"))?
            .clone()
    } else {
        devices
            .iter()
            .find(|(k, _)| matches!(k, Kind::Plus))
            .or_else(|| devices.first())
            .ok_or("No devices found")?
            .clone()
    };

    let deck = StreamDeck::connect(&hid, kind, &target_serial)
        .map_err(|e| format!("Connect failed: {e}"))?;

    let caps = probe_capabilities(&deck, kind)?;

    Ok((deck, caps))
}

fn probe_capabilities(deck: &StreamDeck, kind: Kind) -> Result<DeviceCapabilities, String> {
    let serial = deck.serial_number().map_err(|e| format!("serial: {e}"))?;
    let firmware = deck.firmware_version().map_err(|e| format!("firmware: {e}"))?;
    let manufacturer = deck.manufacturer().map_err(|e| format!("manufacturer: {e}"))?;
    let product = deck.product().map_err(|e| format!("product: {e}"))?;

    let (button_count, encoder_count, has_touchstrip, btn_res, touch_res) = match kind {
        Kind::Plus => (8, 4, true, (120, 120), (800, 100)),
        Kind::Xl | Kind::XlV2 => (32, 0, false, (96, 96), (0, 0)),
        Kind::Mk2 => (15, 0, false, (72, 72), (0, 0)),
        Kind::Mini | Kind::MiniMk2 => (6, 0, false, (80, 80), (0, 0)),
        Kind::Original | Kind::OriginalV2 => (15, 0, false, (72, 72), (0, 0)),
        Kind::Neo => (8, 0, true, (120, 120), (248, 58)),
        Kind::Pedal => (3, 0, false, (0, 0), (0, 0)),
        _ => (0, 0, false, (0, 0), (0, 0)),
    };

    Ok(DeviceCapabilities {
        kind: format!("{kind:?}"),
        serial,
        firmware,
        manufacturer,
        product,
        button_count,
        encoder_count,
        has_touchstrip,
        button_resolution: btn_res,
        touchstrip_resolution: touch_res,
    })
}

/// Read a single input event with timeout.
pub fn read_input(deck: &StreamDeck, timeout: Duration) -> Result<elgato_streamdeck::StreamDeckInput, String> {
    deck.read_input(Some(timeout)).map_err(|e| format!("read_input: {e}"))
}
