//! fsbrowse — a tight cross-platform TUI directory browser.
//!
//! Linux/macOS: roots at `/`. Windows: roots at the drive listing (A:..Z:)
//! and descends into the standard `C:\` POSIX-ish layout from there.

use std::{env, fs, io, path::PathBuf};

use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    prelude::*,
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
};

struct Entry {
    name: String,
    path: PathBuf,
    is_dir: bool,
    size: u64,
}

struct App {
    cwd: PathBuf,
    entries: Vec<Entry>,
    state: ListState,
    drives: bool,
    err: Option<String>,
}

impl App {
    fn new() -> Self {
        let cwd = env::current_dir().unwrap_or_else(|_| {
            if cfg!(windows) { PathBuf::from("C:\\") } else { PathBuf::from("/") }
        });
        let mut app = Self {
            cwd,
            entries: Vec::new(),
            state: ListState::default(),
            drives: false,
            err: None,
        };
        app.refresh();
        app
    }

    fn refresh(&mut self) {
        self.entries.clear();
        self.err = None;

        if self.drives {
            // Probe A:\ .. Z:\ — only existing roots show up.
            for c in b'A'..=b'Z' {
                let s = format!("{}:\\", c as char);
                let p = PathBuf::from(&s);
                if p.exists() {
                    self.entries.push(Entry { name: s, path: p, is_dir: true, size: 0 });
                }
            }
        } else {
            match fs::read_dir(&self.cwd) {
                Ok(rd) => {
                    for e in rd.flatten() {
                        let Ok(m) = e.metadata() else { continue };
                        self.entries.push(Entry {
                            name: e.file_name().to_string_lossy().into_owned(),
                            path: e.path(),
                            is_dir: m.is_dir(),
                            size: m.len(),
                        });
                    }
                    self.entries.sort_by(|a, b| {
                        b.is_dir
                            .cmp(&a.is_dir)
                            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                    });
                }
                Err(e) => self.err = Some(e.to_string()),
            }
        }

        self.state.select((!self.entries.is_empty()).then_some(0));
    }

    fn enter(&mut self) {
        let Some(i) = self.state.selected() else { return };
        let e = &self.entries[i];
        if !e.is_dir { return }
        self.cwd = e.path.clone();
        self.drives = false;
        self.refresh();
    }

    fn up(&mut self) {
        if self.drives { return }
        if let Some(p) = self.cwd.parent() {
            self.cwd = p.to_path_buf();
            self.refresh();
        } else if cfg!(windows) {
            // At a drive root like `C:\` — surface the drive list.
            self.drives = true;
            self.refresh();
        }
    }

    fn move_sel(&mut self, d: isize) {
        let n = self.entries.len() as isize;
        if n == 0 { return }
        let cur = self.state.selected().unwrap_or(0) as isize;
        self.state.select(Some((cur + d).rem_euclid(n) as usize));
    }
}

fn fmt_size(s: u64) -> String {
    const U: [&str; 5] = ["B", "K", "M", "G", "T"];
    let mut v = s as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 { v /= 1024.0; i += 1; }
    if i == 0 { format!("{}{}", s, U[0]) } else { format!("{:.1}{}", v, U[i]) }
}

fn ui(f: &mut Frame, app: &mut App) {
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .split(f.area());

    let path = if app.drives { "Drives".to_string() } else { app.cwd.display().to_string() };
    f.render_widget(
        Paragraph::new(path).block(Block::default().borders(Borders::ALL).title(" Location ")),
        chunks[0],
    );

    let items: Vec<ListItem> = app
        .entries
        .iter()
        .map(|e| {
            let mark = if e.is_dir { "/" } else { " " };
            let size = if e.is_dir { String::new() } else { fmt_size(e.size) };
            let name_style = if e.is_dir {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(Line::from(vec![
                Span::raw(format!(" {} ", mark)),
                Span::styled(format!("{:<48}", e.name), name_style),
                Span::styled(format!("{:>10}", size), Style::default().fg(Color::DarkGray)),
            ]))
        })
        .collect();

    let title = match &app.err {
        Some(e) => format!(" ERROR: {} ", e),
        None => format!(" {} item{} ", app.entries.len(), if app.entries.len() == 1 { "" } else { "s" }),
    };

    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(title))
        .highlight_style(Style::default().bg(Color::Blue).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    f.render_stateful_widget(list, chunks[1], &mut app.state);

    f.render_widget(
        Paragraph::new(" \u{2191}/\u{2193} or j/k: move    \u{2192}/Enter: open    \u{2190}/Bksp: up    q/Esc: quit ")
            .style(Style::default().fg(Color::DarkGray)),
        chunks[2],
    );
}

fn main() -> io::Result<()> {
    let mut app = App::new();

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let mut term = Terminal::new(CrosstermBackend::new(stdout))?;

    let res = (|| -> io::Result<()> {
        loop {
            term.draw(|f| ui(f, &mut app))?;
            if let Event::Key(k) = event::read()? {
                if k.kind != KeyEventKind::Press { continue }
                match k.code {
                    KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                    KeyCode::Down | KeyCode::Char('j') => app.move_sel(1),
                    KeyCode::Up   | KeyCode::Char('k') => app.move_sel(-1),
                    KeyCode::Enter | KeyCode::Right | KeyCode::Char('l') => app.enter(),
                    KeyCode::Backspace | KeyCode::Left | KeyCode::Char('h') => app.up(),
                    _ => {}
                }
            }
        }
    })();

    disable_raw_mode()?;
    execute!(term.backend_mut(), LeaveAlternateScreen)?;
    term.show_cursor()?;
    res
}
