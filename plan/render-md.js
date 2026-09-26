// Render a plan .md to a dark, self-contained .html next to it (marked via CDN, raw-text fallback).
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) throw new Error('usage: node plan/render-md.js <file.md>');
const md = fs.readFileSync(src, 'utf8');
const title = (md.match(/^# (.+)$/m) || [, path.basename(src)])[1];
const out = src.replace(/\.md$/i, '.html');
const esc = (s) => s.replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);

fs.writeFileSync(
  out,
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0b0f16;--panel:#111723;--border:#232c3b;--text:#d6deea;--muted:#8b97a8;--accent:#b18cff;--link:#6cc4ff;--code:#0f1520}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:26px;margin:0 0 6px;color:#fff}h2{font-size:19px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border);color:#fff}
h3{font-size:16px;margin:22px 0 8px;color:var(--accent)}a{color:var(--link)}em{color:var(--muted)}strong{color:#fff}
code{font:13px/1.4 ui-monospace,Consolas,monospace;background:var(--code);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:12px;overflow:auto}pre code{border:0;padding:0}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}th{background:var(--panel);color:#fff}
tr:nth-child(even) td{background:#0e131d}hr{border:0;border-top:1px solid var(--border);margin:28px 0}li{margin:4px 0}
</style></head><body><main id="out"><pre>${esc(md)}</pre></main>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script>const md=${JSON.stringify(md).replace(/</g, '\\u003c')};
if(window.marked)document.getElementById('out').innerHTML=marked.parse(md,{gfm:true});</script>
</body></html>`
);
console.log(out);
