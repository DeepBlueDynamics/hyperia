//! Byte-counting HTTPS proxy for host agents, so their real network shows per
//! pane. CONNECT only, on 127.0.0.1: it relays the encrypted stream untouched
//! and counts bytes. Hyperia gives agent panes HTTPS_PROXY with the pane uid as
//! the proxy username; every few seconds the counts become Network events with
//! host "proxy" (exact, unlike netio's approximation).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::telemetry::{NetDirection, TelemetryEvent, TelemetryStore};

pub const HOST_PROXY: &str = "proxy";
const FLUSH_EVERY: Duration = Duration::from_secs(3);
const MAX_HEAD: usize = 16 * 1024;

type Counts = Arc<Mutex<HashMap<String, (u64, u64)>>>;

/// The proxy port for a sidecar port (9800 → 9813). The app uses the same rule.
pub fn port_for(sidecar_port: u16) -> u16 {
    sidecar_port.wrapping_add(13)
}

/// (target "host:port", pane uid) from a CONNECT request head, or None.
pub(crate) fn parse_connect(head: &str) -> Option<(String, String)> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    if !first.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let target = first.next()?.to_string();
    if !target.contains(':') {
        return None;
    }
    let mut pane = String::new();
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        if !k.trim().eq_ignore_ascii_case("proxy-authorization") {
            continue;
        }
        let v = v.trim();
        let b64 = v.strip_prefix("Basic ").or_else(|| v.strip_prefix("basic ")).unwrap_or("");
        use base64::Engine as _;
        if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
            let s = String::from_utf8_lossy(&raw).to_string();
            pane = s.split(':').next().unwrap_or("").to_string();
        }
    }
    Some((target, pane))
}

pub fn spawn(telemetry: TelemetryStore, port: u16) {
    let counts: Counts = Arc::new(Mutex::new(HashMap::new()));
    // Flush counts as rates.
    {
        let counts = counts.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(FLUSH_EVERY).await;
                let taken: Vec<(String, (u64, u64))> = counts.lock().unwrap_or_else(|e| e.into_inner()).drain().collect();
                let secs = FLUSH_EVERY.as_secs().max(1);
                for (pane, (up, down)) in taken {
                    if down > 0 {
                        telemetry.record(&pane, TelemetryEvent::Network { direction: NetDirection::Inbound, host: HOST_PROXY.into(), bytes: down / secs });
                    }
                    if up > 0 {
                        telemetry.record(&pane, TelemetryEvent::Network { direction: NetDirection::Outbound, host: HOST_PROXY.into(), bytes: up / secs });
                    }
                }
            }
        });
    }
    tokio::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(target: "proxy", "agent proxy not started on 127.0.0.1:{port}: {e}");
                return;
            }
        };
        tracing::info!(target: "proxy", "agent network proxy on 127.0.0.1:{port}");
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let counts = counts.clone();
            tokio::spawn(async move {
                let _ = handle(sock, counts).await;
            });
        }
    });
}

async fn handle(mut client: TcpStream, counts: Counts) -> std::io::Result<()> {
    // Read the request head.
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 2048];
    let body_start = loop {
        let n = client.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(i) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if head.len() > MAX_HEAD {
            return client.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n").await;
        }
    };
    let text = String::from_utf8_lossy(&head[..body_start]).to_string();
    let Some((target, pane)) = parse_connect(&text) else {
        // Only CONNECT (HTTPS) is supported; plain HTTP isn't routed here.
        return client.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n").await;
    };
    let upstream = match tokio::time::timeout(Duration::from_secs(15), TcpStream::connect(&target)).await {
        Ok(Ok(s)) => s,
        _ => return client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").await,
    };
    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
    let _ = upstream.set_nodelay(true);
    let (mut cr, mut cw) = client.into_split();
    let (mut ur, mut uw) = upstream.into_split();
    // Anything the client sent after the head goes straight up.
    if body_start < head.len() {
        uw.write_all(&head[body_start..]).await?;
    }
    let add = |pane: &str, up: u64, down: u64| {
        if pane.is_empty() {
            return;
        }
        let mut m = counts.lock().unwrap_or_else(|e| e.into_inner());
        let e = m.entry(pane.to_string()).or_insert((0, 0));
        e.0 += up;
        e.1 += down;
    };
    let p1 = pane.clone();
    let up = async {
        let mut b = vec![0u8; 16 * 1024];
        loop {
            let n = cr.read(&mut b).await?;
            if n == 0 {
                let _ = uw.shutdown().await;
                return Ok::<_, std::io::Error>(());
            }
            uw.write_all(&b[..n]).await?;
            add(&p1, n as u64, 0);
        }
    };
    let down = async {
        let mut b = vec![0u8; 16 * 1024];
        loop {
            let n = ur.read(&mut b).await?;
            if n == 0 {
                let _ = cw.shutdown().await;
                return Ok::<_, std::io::Error>(());
            }
            cw.write_all(&b[..n]).await?;
            add(&pane, 0, n as u64);
        }
    };
    let _ = tokio::try_join!(up, down);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_heads_parse_with_and_without_a_pane() {
        use base64::Engine as _;
        let auth = base64::engine::general_purpose::STANDARD.encode("pane-123:x");
        let h = format!("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic {auth}\r\n\r\n");
        assert_eq!(parse_connect(&h), Some(("api.anthropic.com:443".into(), "pane-123".into())));
        assert_eq!(parse_connect("CONNECT a.b:443 HTTP/1.1\r\n\r\n"), Some(("a.b:443".into(), String::new())));
        assert_eq!(parse_connect("GET http://a.b/ HTTP/1.1\r\n\r\n"), None);
        assert_eq!(port_for(9800), 9813);
    }

    #[tokio::test]
    async fn relays_and_counts_bytes_per_pane() {
        // Upstream echo server on loopback.
        let up = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let up_addr = up.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = up.accept().await.unwrap();
            let mut b = [0u8; 64];
            let n = s.read(&mut b).await.unwrap();
            s.write_all(&b[..n]).await.unwrap();
        });
        // Proxy on loopback, handling one connection.
        let px = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let px_addr = px.local_addr().unwrap();
        let counts: Counts = Arc::new(Mutex::new(HashMap::new()));
        let c2 = counts.clone();
        tokio::spawn(async move {
            let (s, _) = px.accept().await.unwrap();
            let _ = handle(s, c2).await;
        });
        use base64::Engine as _;
        let auth = base64::engine::general_purpose::STANDARD.encode("pane-t:x");
        let mut c = TcpStream::connect(px_addr).await.unwrap();
        c.write_all(format!("CONNECT {up_addr} HTTP/1.1\r\nProxy-Authorization: Basic {auth}\r\n\r\n").as_bytes()).await.unwrap();
        let mut resp = [0u8; 39];
        c.read_exact(&mut resp).await.unwrap();
        assert!(String::from_utf8_lossy(&resp).starts_with("HTTP/1.1 200"));
        c.write_all(b"hello").await.unwrap();
        let mut echo = [0u8; 5];
        c.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"hello");
        tokio::time::sleep(Duration::from_millis(50)).await;
        let m = counts.lock().unwrap();
        assert_eq!(m.get("pane-t"), Some(&(5, 5)));
    }
}
