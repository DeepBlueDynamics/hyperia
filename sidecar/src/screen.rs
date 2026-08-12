use serde::{Deserialize, Serialize};
use vt100::Parser;

/// Wrapper around vt100::Parser with diff detection
pub struct ScreenBuffer {
    parser: Parser,
    last_snapshot: Option<ScreenDump>,
}

impl ScreenBuffer {
    /// Create a new screen buffer
    pub fn new(rows: u16, cols: u16, scrollback: usize) -> Self {
        Self {
            parser: Parser::new(rows, cols, scrollback),
            last_snapshot: None,
        }
    }

    /// Process PTY output bytes
    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    /// Get current screen dimensions
    #[allow(dead_code)]
    pub fn size(&self) -> (u16, u16) {
        let screen = self.parser.screen();
        (screen.size().0, screen.size().1)
    }

    /// Bytes that reproduce the CURRENT visible screen when fed to a fresh vt100
    /// — seeds a raw-PTY stream client (xterm.js) so it boots showing the screen.
    pub fn contents_formatted(&self) -> Vec<u8> {
        self.parser.screen().contents_formatted()
    }

    /// Dump the current screen state
    pub fn screen_dump(&self) -> ScreenDump {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let cursor = screen.cursor_position();

        let mut lines = Vec::new();
        for row in 0..rows {
            let mut text = String::new();
            let mut cells = Vec::new();

            for col in 0..cols {
                let cell = screen.cell(row, col);
                if let Some(cell) = cell {
                    let contents = cell.contents();

                    // Extract color/attribute info
                    let attr = CellAttr {
                        fg: format!("{:?}", cell.fgcolor()),
                        bg: format!("{:?}", cell.bgcolor()),
                        bold: cell.bold(),
                        italic: cell.italic(),
                        underline: cell.underline(),
                    };

                    if contents.is_empty() {
                        // Wide-char continuation or empty cell — emit a space
                        text.push(' ');
                    } else {
                        text.push_str(&contents);
                        // Wide chars occupy 2+ columns; pad attrs for extra columns
                        let char_width = unicode_width(&contents);
                        for _ in 1..char_width {
                            cells.push(attr.clone());
                        }
                    }
                    cells.push(attr);
                } else {
                    text.push(' ');
                    cells.push(CellAttr::default());
                }
            }

            // Trim trailing spaces for efficiency
            let text = text.trim_end().to_string();

            lines.push(ScreenLine {
                row,
                text,
                attrs: cells,
            });
        }

        ScreenDump {
            rows,
            cols,
            cursor: CursorPosition {
                row: cursor.0,
                col: cursor.1,
            },
            lines,
            title: screen.title().to_string(),
        }
    }

    /// Detect changed rows since last snapshot
    #[allow(dead_code)]
    pub fn diff(&mut self) -> ScreenDiff {
        let current = self.screen_dump();
        let changed_rows = if let Some(ref last) = self.last_snapshot {
            // Compare line by line
            current
                .lines
                .iter()
                .zip(last.lines.iter())
                .enumerate()
                .filter_map(|(idx, (cur, prev))| {
                    if cur.text != prev.text {
                        Some(idx as u16)
                    } else {
                        None
                    }
                })
                .collect()
        } else {
            // First snapshot: all rows changed
            (0..current.rows).collect()
        };

        let cursor_changed = self
            .last_snapshot
            .as_ref()
            .map(|last| last.cursor != current.cursor)
            .unwrap_or(true);

        self.last_snapshot = Some(current.clone());

        ScreenDiff {
            changed_rows,
            cursor_changed,
            current,
        }
    }

    /// Resize the screen buffer
    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.set_size(rows, cols);
        self.last_snapshot = None; // Invalidate snapshot on resize
    }
}

/// Serializable screen dump
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScreenDump {
    pub rows: u16,
    pub cols: u16,
    pub cursor: CursorPosition,
    pub lines: Vec<ScreenLine>,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CursorPosition {
    pub row: u16,
    pub col: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ScreenLine {
    pub row: u16,
    pub text: String,
    pub attrs: Vec<CellAttr>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[allow(dead_code)]
pub struct CellAttr {
    pub fg: String,
    pub bg: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}

impl Default for CellAttr {
    fn default() -> Self {
        Self {
            fg: "Default".to_string(),
            bg: "Default".to_string(),
            bold: false,
            italic: false,
            underline: false,
        }
    }
}

/// Screen diff result
#[allow(dead_code)]
pub struct ScreenDiff {
    pub changed_rows: Vec<u16>,
    pub cursor_changed: bool,
    pub current: ScreenDump,
}

/// Estimate display width of a string (handles wide/fullwidth Unicode)
fn unicode_width(s: &str) -> usize {
    s.chars()
        .map(|c| {
            // CJK, fullwidth, and most box-drawing/block elements are 1 cell wide
            // True fullwidth (CJK) characters are 2 cells
            let cp = c as u32;
            if (0x1100..=0x115F).contains(&cp)     // Hangul Jamo
                || (0x2E80..=0x303E).contains(&cp)  // CJK Radicals
                || (0x3040..=0x33BF).contains(&cp)  // CJK & Kana
                || (0x3400..=0x4DBF).contains(&cp)  // CJK Ext A
                || (0x4E00..=0x9FFF).contains(&cp)  // CJK Unified
                || (0xF900..=0xFAFF).contains(&cp)  // CJK Compat
                || (0xFE30..=0xFE6F).contains(&cp)  // CJK Compat Forms
                || (0xFF01..=0xFF60).contains(&cp)   // Fullwidth Forms
                || (0xFFE0..=0xFFE6).contains(&cp)   // Fullwidth Signs
                || (0x20000..=0x2FFFF).contains(&cp) // CJK Ext B+
                || (0x30000..=0x3FFFF).contains(&cp) // CJK Ext G+
            {
                2
            } else {
                1
            }
        })
        .sum()
}
