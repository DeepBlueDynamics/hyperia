//! /render — markdown documents as live Hyperia tabs.
//!
//! The `render` MCP tool registers a document (a file path or inline content)
//! and opens `GET /render/{id}` in a new web-pane tab. The page renders full
//! markdown (tables, task lists, strikethrough, footnotes) PLUS a minified
//! highlight extension for joint human+agent analysis:
//!
//!   ==text==            yellow highlight (default)
//!   =={red}text==       named color: yellow red green blue purple orange pink cyan
//!   =={#7af}text==      any hex color
//!
//! File-backed documents LIVE-RELOAD: the page polls a version endpoint every
//! 1.5 s and reloads when the file changes — so an agent editing highlights
//! into the file updates the analysis in place while the human watches.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use pulldown_cmark::{html, Options, Parser};
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub enum RenderSource {
    File(PathBuf),
    Inline(String),
}

pub struct RenderDoc {
    pub title: String,
    pub source: RenderSource,
}

#[derive(Clone)]
pub struct RenderStore {
    inner: Arc<Mutex<HashMap<String, RenderDoc>>>,
}

impl Default for RenderStore {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderStore {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn insert(&self, doc: RenderDoc) -> String {
        let id = crate::util::random_token(5).await;
        self.inner.lock().await.insert(id.clone(), doc);
        id
    }

    async fn read(&self, id: &str) -> Option<(String, String, u64)> {
        let guard = self.inner.lock().await;
        let doc = guard.get(id)?;
        match &doc.source {
            RenderSource::Inline(md) => {
                let v = content_hash(md);
                Some((doc.title.clone(), md.clone(), v))
            }
            RenderSource::File(path) => {
                let md = std::fs::read_to_string(path)
                    .unwrap_or_else(|e| format!("# Unreadable source\n\n`{}`\n\n{}", path.display(), e));
                let v = file_version(path).unwrap_or_else(|| content_hash(&md));
                Some((doc.title.clone(), md, v))
            }
        }
    }

    async fn version(&self, id: &str) -> Option<u64> {
        let guard = self.inner.lock().await;
        let doc = guard.get(id)?;
        match &doc.source {
            RenderSource::Inline(md) => Some(content_hash(md)),
            RenderSource::File(path) => {
                Some(file_version(path).unwrap_or_else(|| {
                    content_hash(&std::fs::read_to_string(path).unwrap_or_default())
                }))
            }
        }
    }
}

fn content_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn file_version(path: &PathBuf) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let ms = mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(ms ^ (meta.len() << 1))
}

// ---------------------------------------------------------------------------
// Highlight markup — ==text== / =={color}text== outside code
// ---------------------------------------------------------------------------

const NAMED_COLORS: &[&str] = &["yellow", "red", "green", "blue", "purple", "orange", "pink", "cyan"];

/// Preprocess the highlight extension into inline HTML `<mark>` tags, skipping
/// fenced code blocks and inline code spans so literal `==` in code survives.
fn apply_highlights(md: &str) -> String {
    let mut out = String::with_capacity(md.len() + 128);
    let mut in_fence = false;
    for line in md.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_fence {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        // Inline-code guard: only transform segments OUTSIDE backticks.
        let parts: Vec<&str> = line.split('`').collect();
        let transformed: Vec<String> = parts
            .iter()
            .enumerate()
            .map(|(i, seg)| if i % 2 == 0 { transform_segment(seg) } else { (*seg).to_string() })
            .collect();
        out.push_str(&transformed.join("`"));
        out.push('\n');
    }
    out
}

/// Replace `==...==` and `=={color}...==` in one non-code text segment.
fn transform_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    let mut rest = seg;
    while let Some(start) = rest.find("==") {
        // Text before the opener passes through.
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        // Optional {color} directly after the opener.
        let (color, body_start) = if let Some(stripped) = after_open.strip_prefix('{') {
            match stripped.find('}') {
                Some(cend) => {
                    let c = &stripped[..cend];
                    let valid = NAMED_COLORS.contains(&c.to_ascii_lowercase().as_str())
                        || (c.starts_with('#')
                            && c.len() >= 4
                            && c.len() <= 9
                            && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()));
                    if valid {
                        (Some(c.to_string()), cend + 3) // skip "{color}" incl braces, relative to after_open
                    } else {
                        (None, 0)
                    }
                }
                None => (None, 0),
            }
        } else {
            (None, 0)
        };
        let body_and_rest = &after_open[body_start..];
        match body_and_rest.find("==") {
            Some(end) if end > 0 => {
                let body = &body_and_rest[..end];
                match &color {
                    Some(c) if c.starts_with('#') => {
                        out.push_str(&format!("<mark style=\"background:{}66\">{}</mark>", c, body));
                    }
                    Some(c) => {
                        out.push_str(&format!("<mark class=\"hl-{}\">{}</mark>", c.to_ascii_lowercase(), body));
                    }
                    None => {
                        out.push_str(&format!("<mark>{}</mark>", body));
                    }
                }
                rest = &body_and_rest[end + 2..];
            }
            _ => {
                // No closer — emit the opener literally and move on.
                out.push_str("==");
                rest = after_open;
            }
        }
    }
    out.push_str(rest);
    out
}

fn md_to_html(md: &str) -> String {
    let pre = apply_highlights(md);
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    let parser = Parser::new_ext(&pre, opts);
    let mut out = String::with_capacity(pre.len() * 2);
    html::push_html(&mut out, parser);
    out
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn get_render_page(
    State(state): State<crate::AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    let Some((title, md, version)) = state.render.read(&id).await else {
        return (StatusCode::NOT_FOUND, Html("<h1>No such render</h1>".to_string())).into_response();
    };
    let body = md_to_html(&md);
    let page = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{title}</title><style>
:root {{ color-scheme: dark; }}
body {{ margin:0; background:#101014; color:#e6e6ea; font:15px/1.65 -apple-system,'Segoe UI',system-ui,sans-serif; }}
main {{ max-width:880px; margin:0 auto; padding:36px 28px 80px; }}
h1,h2,h3,h4 {{ line-height:1.25; margin:1.6em 0 .55em; }} h1 {{ font-size:1.9em; border-bottom:1px solid #2a2a33; padding-bottom:.3em; }}
h2 {{ font-size:1.45em; border-bottom:1px solid #22222a; padding-bottom:.25em; }}
a {{ color:#7aa2f7; }} hr {{ border:0; border-top:1px solid #2a2a33; margin:2em 0; }}
code {{ background:#1c1c24; padding:2px 5px; border-radius:4px; font-size:.9em; }}
pre {{ background:#16161c; border:1px solid #24242c; border-radius:8px; padding:14px 16px; overflow-x:auto; }}
pre code {{ background:none; padding:0; }}
blockquote {{ border-left:3px solid #3a3a46; margin:1em 0; padding:.1em 1.1em; color:#b9b9c2; }}
table {{ border-collapse:collapse; margin:1em 0; }} th,td {{ border:1px solid #2c2c36; padding:6px 12px; }} th {{ background:#191921; }}
mark {{ background:rgba(255,220,0,.30); color:inherit; padding:0 3px; border-radius:3px; }}
mark.hl-yellow {{ background:rgba(255,220,0,.30); }}
mark.hl-red    {{ background:rgba(255,85,85,.34); }}
mark.hl-green  {{ background:rgba(80,220,120,.30); }}
mark.hl-blue   {{ background:rgba(90,160,255,.32); }}
mark.hl-purple {{ background:rgba(190,120,255,.32); }}
mark.hl-orange {{ background:rgba(255,160,60,.32); }}
mark.hl-pink   {{ background:rgba(255,110,190,.32); }}
mark.hl-cyan   {{ background:rgba(70,220,220,.30); }}
footer {{ position:fixed; bottom:0; left:0; right:0; display:flex; gap:10px; align-items:center; padding:6px 14px;
  background:#14141aee; border-top:1px solid #24242c; font-size:11.5px; color:#8a8a94; backdrop-filter:blur(4px); }}
.dot {{ width:7px; height:7px; border-radius:50%; background:#3fb950; animation:pulse 2.2s ease-in-out infinite; }}
@keyframes pulse {{ 0%,100% {{ opacity:1 }} 50% {{ opacity:.35 }} }}
</style></head><body><main>{body}</main>
<footer><span class="dot"></span><span>live · {title}</span></footer>
<script>
let v = "{version}";
setInterval(async () => {{
  try {{
    const r = await fetch('/api/render/{id}/version'); const j = await r.json();
    if (String(j.v) !== v) location.reload();
  }} catch (_e) {{}}
}}, 1500);
</script></body></html>"#
    );
    Html(page).into_response()
}

pub async fn get_render_version(
    State(state): State<crate::AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    match state.render.version(&id).await {
        Some(v) => (StatusCode::OK, format!("{{\"v\":\"{v}\"}}")),
        None => (StatusCode::NOT_FOUND, "{\"error\":\"no such render\"}".to_string()),
    }
}
