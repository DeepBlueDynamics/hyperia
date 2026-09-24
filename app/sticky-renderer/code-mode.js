// Read-only file/code note (query param file=).
'use strict';

const LANG_MAP = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  ps1: 'powershell',
  md: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql'
};

function start(ctx) {
  const {doc, persist, syntax} = ctx;
  const filePath = ctx.state.filePath;
  let fileContent = '';
  const fileName = persist.path.basename(filePath);
  const fileExt = persist.path.extname(filePath).slice(1).toLowerCase();
  try {
    fileContent = persist.fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    fileContent = 'Error reading file: ' + e.message;
  }

  ctx.els.titleText.textContent = fileName;
  ctx.els.linesBtn.style.display = '';

  const lang = LANG_MAP[fileExt] || fileExt;
  const pre = doc.createElement('pre');
  pre.id = 'codeBlock';
  pre.className = 'with-lines';
  const code = doc.createElement('code');
  code.className = lang ? 'language-' + lang : '';
  code.dataset.raw = fileContent;
  pre.appendChild(code);
  ctx.els.content.appendChild(pre);

  syntax.applyHighlight(fileContent, code);
  if (ctx.state.highlightMode !== 'agent') syntax.wrapCodeLines(code);

  ctx.els.linesBtn.addEventListener('click', () => {
    pre.classList.toggle('with-lines');
  });
}

module.exports = {start, LANG_MAP};
