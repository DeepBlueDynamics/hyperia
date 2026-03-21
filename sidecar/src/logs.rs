use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Mutex};

/// Shared log buffer — ring buffer of formatted log lines.
pub type LogBuffer = Arc<Mutex<VecDeque<String>>>;

const MAX_LINES: usize = 1000;

pub fn new_log_buffer() -> LogBuffer {
    Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LINES)))
}

/// Writer that captures tracing output into a shared buffer.
pub struct LogBufferWriter {
    buffer: LogBuffer,
}

impl Write for LogBufferWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let s = String::from_utf8_lossy(buf);
        let mut buffer = self.buffer.lock().unwrap();
        for line in s.lines() {
            if !line.trim().is_empty() {
                if buffer.len() >= MAX_LINES {
                    buffer.pop_front();
                }
                buffer.push_back(line.to_string());
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// MakeWriter implementation for tracing_subscriber.
#[derive(Clone)]
pub struct LogBufferMakeWriter {
    buffer: LogBuffer,
}

impl LogBufferMakeWriter {
    pub fn new(buffer: LogBuffer) -> Self {
        Self { buffer }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBufferMakeWriter {
    type Writer = LogBufferWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogBufferWriter {
            buffer: self.buffer.clone(),
        }
    }
}
