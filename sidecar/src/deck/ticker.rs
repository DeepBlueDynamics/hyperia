use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Arc;
use std::time::Duration;

use image::DynamicImage;

use super::device_actor::DeviceHandle;
use super::visuals;

struct Stock {
    symbol: &'static str,
    price: f32,
    change_pct: f32,
}

pub struct Ticker {
    stocks: Vec<Stock>,
    offset: u32,
    frame: u64,
}

impl Ticker {
    fn new() -> Self {
        Self {
            stocks: vec![
                Stock { symbol: "AAPL", price: 185.42, change_pct: 1.2 },
                Stock { symbol: "MSFT", price: 420.15, change_pct: -0.3 },
                Stock { symbol: "GOOG", price: 141.80, change_pct: 0.8 },
                Stock { symbol: "NVDA", price: 875.30, change_pct: 2.4 },
                Stock { symbol: "TSLA", price: 248.50, change_pct: -1.1 },
                Stock { symbol: "AMZN", price: 178.25, change_pct: 0.5 },
                Stock { symbol: "META", price: 505.60, change_pct: 1.8 },
                Stock { symbol: "AMD",  price: 164.90, change_pct: -0.7 },
            ],
            offset: 0,
            frame: 0,
        }
    }

    fn tick(&mut self) {
        self.offset += 2;
        self.frame += 1;

        // Every 120 frames (~6s at 50ms), apply small random walk to prices
        if self.frame % 120 == 0 {
            for (i, stock) in self.stocks.iter_mut().enumerate() {
                let r = visuals::prand(self.frame + i as u64, 70);
                let delta = ((r % 100) as f32 - 50.0) / 500.0;
                stock.price *= 1.0 + delta;

                let r2 = visuals::prand(self.frame + i as u64, 71);
                stock.change_pct += ((r2 % 100) as f32 - 50.0) / 200.0;
                stock.change_pct = stock.change_pct.clamp(-9.9, 9.9);
            }
        }
    }

    fn render(&self) -> DynamicImage {
        let items: Vec<visuals::TickerItem> = self.stocks.iter().map(|s| {
            visuals::TickerItem {
                symbol: s.symbol.to_string(),
                price: s.price,
                change_pct: s.change_pct,
            }
        }).collect();
        visuals::render_ticker_frame(&items, self.offset)
    }
}

pub fn spawn_ticker(device: DeviceHandle, ticker_active: Arc<AtomicBool>) {
    tokio::spawn(async move {
        ticker_active.store(true, Relaxed);
        let mut ticker = Ticker::new();
        let mut interval = tokio::time::interval(Duration::from_millis(50));
        loop {
            interval.tick().await;
            ticker.tick();
            let img = ticker.render();
            device.set_touchstrip_image(img).await.ok();
        }
    });
}
