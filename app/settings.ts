// Settings chat window — token setup, config editing, nemesis8 install.
// Opens instead of a JSON editor when user clicks Preferences.

import {spawn} from 'child_process';
import {readFileSync, writeFileSync, mkdirSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {BrowserWindow, ipcMain, screen, shell} from 'electron';

import {cfgPath, defaultCfg} from './config/paths';

let settingsWindow: BrowserWindow | null = null;

export function hasAgentToken(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const model = String(cfg.config?.agentModel || '');
    if (model.startsWith('ollama:')) return true;
    return !!(cfg.config?.agentToken && model);
  } catch {
    return false;
  }
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  const width = 520;
  const height = 700;
  const x = Math.round(display.workArea.x + display.workArea.width / 2 - width / 2);
  const y = Math.round(display.workArea.y + display.workArea.height / 2 - height / 2);

  settingsWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    backgroundColor: '#0a0a12',
    title: 'Hyperia Settings',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const html = buildSettingsHtml();

  const settingsDir = join(tmpdir(), 'hyperia-settings');
  try {
    mkdirSync(settingsDir, {recursive: true});
  } catch {
    // exists
  }
  const tmpFile = join(settingsDir, 'settings.html');
  writeFileSync(tmpFile, html, 'utf8');
  void settingsWindow.loadFile(tmpFile);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

function buildSettingsHtml(): string {
  let cfg: Record<string, any> = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    cfg = {};
  }
  const currentModel = String(cfg.config?.agentModel || '');
  const hasToken = !!cfg.config?.agentToken || currentModel.startsWith('ollama:');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Hyperia Settings</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body { overflow-y: auto; }
  body {
    background: #0a0a12;
    color: #c8d0e0;
    font-family: 'Segoe UI', -apple-system, sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
  }

  .titlebar {
    height: 32px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    -webkit-app-region: drag;
    flex-shrink: 0;
    background: #0e0e18;
    border-bottom: 1px solid #1a1a2e;
    user-select: none;
  }
  .titlebar-text {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 1px;
    color: #468cff;
    text-transform: uppercase;
  }
  .titlebar-btn {
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 4px;
    cursor: pointer;
    -webkit-app-region: no-drag;
    font-size: 14px;
    color: #666;
    transition: all 0.2s;
  }
  .titlebar-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
  .close-btn:hover { background: rgba(255,60,60,0.3); color: #ff6060; }

  .actions {
    padding: 16px;
    display: flex;
    gap: 8px;
    flex-shrink: 0;
    border-bottom: 1px solid #1a1a2e;
  }
  .action-btn {
    flex: 1;
    padding: 10px 12px;
    background: #12121e;
    border: 1px solid #1a1a2e;
    border-radius: 8px;
    color: #a0a8c0;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .action-btn:hover {
    background: #1a1a2e;
    border-color: #468cff40;
    color: #e0e4f0;
    box-shadow: 0 0 12px rgba(70,140,255,0.1);
  }

  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .chat::-webkit-scrollbar { width: 6px; }
  .chat::-webkit-scrollbar-track { background: transparent; }
  .chat::-webkit-scrollbar-thumb { background: #1a1a2e; border-radius: 3px; }

  .msg {
    max-width: 90%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.5;
    animation: fadeIn 0.2s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .msg.system {
    background: #12121e;
    border: 1px solid #1a1a2e;
    align-self: flex-start;
    color: #a0a8c0;
  }
  .msg.success {
    background: #0a1a0a;
    border: 1px solid #1dc12140;
    align-self: flex-start;
    color: #80c080;
  }
  .msg.error {
    background: #1a0a0a;
    border: 1px solid #c51e1440;
    align-self: flex-start;
    color: #e08080;
  }
  .msg.user {
    background: #1a2a4a;
    border: 1px solid #468cff30;
    align-self: flex-end;
    color: #d0d8f0;
  }
  .msg code {
    background: rgba(255,255,255,0.08);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
  }

  .config-preview {
    padding: 8px 12px;
    background: #080810;
    border: 1px solid #1a1a2e;
    border-radius: 6px;
    margin-top: 6px;
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 11px;
    color: #666;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .input-area {
    padding: 12px 16px;
    border-top: 1px solid #1a1a2e;
    background: #0e0e18;
    flex-shrink: 0;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .model-select {
    background: #12121e;
    border: 1px solid #1a1a2e;
    border-radius: 8px;
    padding: 10px 10px;
    color: #a0a8c0;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    min-width: 140px;
    transition: border-color 0.2s;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
  }
  .model-select:focus { border-color: #468cff60; }
  .model-select option { background: #12121e; color: #a0a8c0; }

  .input-area input {
    flex: 1;
    background: #12121e;
    border: 1px solid #1a1a2e;
    border-radius: 8px;
    padding: 10px 14px;
    color: #e0e4f0;
    font-size: 13px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s;
  }
  .input-area input:focus {
    border-color: #468cff60;
    box-shadow: 0 0 8px rgba(70,140,255,0.15);
  }
  .input-area input::placeholder { color: #444; }
  .set-btn {
    background: #468cff20;
    border: 1px solid #468cff40;
    border-radius: 8px;
    color: #468cff;
    padding: 0 16px;
    height: 38px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.2s;
    white-space: nowrap;
  }
  .set-btn:hover {
    background: #468cff40;
    box-shadow: 0 0 12px rgba(70,140,255,0.2);
  }

  .tool-pill { display:flex; align-items:center; gap:6px; align-self:flex-start;
    padding:4px 10px; border-radius:6px; font-size:11px; color:#556; }
  .pill-emoji.running { animation:pulse-emoji .8s ease-in-out infinite; }
  @keyframes pulse-emoji { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.2)} }
  .shivvr-widget { background:#12121e; border:1px solid #1a1a2e; border-radius:10px;
    padding:12px 14px; align-self:flex-start; max-width:95%; display:flex;
    flex-direction:column; gap:8px; animation:fadeIn .2s ease; }
  .shivvr-widget label { font-size:11px; color:#668; text-transform:uppercase; letter-spacing:.5px; }
  .shivvr-widget input { background:#0a0a14; border:1px solid #2a2a3e; border-radius:6px;
    padding:8px 10px; color:#c8d0e0; font-size:13px; font-family:inherit; outline:none; }
  .shivvr-widget input:focus { border-color:#468cff60; }
  .shivvr-widget .widget-btn { align-self:flex-end; background:#468cff20; border:1px solid #468cff40;
    border-radius:6px; color:#468cff; padding:6px 14px; cursor:pointer; font-size:12px; }
  .shivvr-widget .widget-btn:hover { background:#468cff40; }
  .shivvr-widget.confirmed { border-color:#1dc12140; background:#0a1a0a; }
  .shivvr-widget .confirmed-text { color:#80c080; font-size:12px; }
</style>
</head>
<body>
  <div class="titlebar">
    <span class="titlebar-text">Settings</span>
    <span class="titlebar-btn close-btn" id="closeBtn">&times;</span>
  </div>

  <!--
    The action button row that used to live here has been removed. The same
    actions are reachable by typing the exact command in the chat input
    below — case- and separator-insensitive ("edit config", "Edit_Config",
    "editconfig" all match):
       edit config          → opens hyperia.json in your system editor
       factory reset        → wipes config + Ferricula memory
       install nemesis8     → runs the official installer script
    Type "help" to see the full list.
  -->

  <div class="chat" id="chat">
    <div class="msg system">
      ${
        hasToken
          ? 'Settings agent ready. Type below to configure Hyperia.'
          : 'Set a model token so the agent can help you with configuration. Pick a model and enter your API key below.'
      }
    </div>
  </div>

  <div class="input-area" id="tokenArea" style="${hasToken ? 'display:none' : ''}">
    <select class="model-select" id="modelSelect">
      <option value="" disabled ${!currentModel ? 'selected' : ''}>Select model...</option>
      <optgroup label="Local (Ollama)">
        <option value="ollama:gemma4:e2b" ${currentModel === 'ollama:gemma4:e2b' ? 'selected' : ''}>Gemma4 e2b — local, fast (default)</option>
        <option value="ollama:gemma4:31b-cloud" ${currentModel === 'ollama:gemma4:31b-cloud' ? 'selected' : ''}>Gemma4 31b — local proxy</option>
      </optgroup>
      <optgroup label="Anthropic">
        <option value="claude-haiku-4-5-20251001" ${currentModel === 'claude-haiku-4-5-20251001' ? 'selected' : ''}>Claude Haiku 4.5 (fast)</option>
        <option value="claude-sonnet-4-6" ${currentModel === 'claude-sonnet-4-6' ? 'selected' : ''}>Claude Sonnet 4.6</option>
        <option value="claude-opus-4-6" ${currentModel === 'claude-opus-4-6' ? 'selected' : ''}>Claude Opus 4.6</option>
      </optgroup>
      <optgroup label="Other">
        <option value="openai" ${currentModel === 'openai' ? 'selected' : ''}>OpenAI</option>
        <option value="google" ${currentModel === 'google' ? 'selected' : ''}>Google</option>
        <option value="openrouter" ${currentModel === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
      </optgroup>
    </select>
    <input type="password" id="tokenInput" placeholder="Enter token...">
    <button class="set-btn" id="setTokenBtn">Set</button>
  </div>

  <!--
    The static "change model" dropdown and shivvr URL inputs that used to live
    here have been removed. Tell the settings agent in chat:
      "change my model"   → provider picker + model picker via show_picker
      "set shivvr to <url>"  → handled via settings_set
    The agent walks you through it inline; no more divergent UI paths.
  -->

  <div class="input-area" id="chatArea" style="${hasToken ? '' : 'display:none'}">
    <input type="text" id="chatInput" placeholder="Ask about settings...">
    <button id="settingsSendBtn" class="set-btn">Send</button>
  </div>

<script>
  const SIDECAR_URL = 'http://localhost:9800';
  const chat = document.getElementById('chat');

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // addMsg defined first — onerror and everything else depends on it
  function addMsg(text, type) {
    if (!chat) return;
    const div = document.createElement('div');
    div.className = 'msg ' + (type || 'system');
    div.innerHTML = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // Tiny markdown → HTML converter. Escapes HTML first (safety), then
  // applies the common patterns: fenced code, inline code, bold, italic,
  // links, lists, headings. Good enough for chat-style content; not a
  // full CommonMark implementation.
  function renderMarkdown(src) {
    if (src == null) return '';
    let s = String(src);
    // Escape HTML first so model output can't inject tags
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Fenced code blocks \`\`\` ... \`\`\`
    s = s.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(_, body) {
      return '<pre><code>' + body.replace(/^\\n/, '') + '</code></pre>';
    });
    // Inline code \`...\`
    s = s.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    // Bold **text**
    s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
    // Italic *text* or _text_  (single-star, not part of bold)
    s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\\n]+)_(?!_)/g, '$1<em>$2</em>');
    // Links [text](url) — url-encoded safely against quote injection
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function(_, label, url) {
      const safe = url.replace(/"/g, '&quot;');
      return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + label + '</a>';
    });
    // Headings (line-anchored)
    s = s.replace(/^######\\s+(.+)$/gm, '<h6>$1</h6>');
    s = s.replace(/^#####\\s+(.+)$/gm, '<h5>$1</h5>');
    s = s.replace(/^####\\s+(.+)$/gm, '<h4>$1</h4>');
    s = s.replace(/^###\\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^##\\s+(.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^#\\s+(.+)$/gm, '<h1>$1</h1>');
    // Bulleted lists — group consecutive "- " lines into a <ul>
    s = s.replace(/(?:^|\\n)((?:[-*]\\s+.+(?:\\n|$))+)/g, function(_, group) {
      const items = group.trim().split(/\\n/).map(function(line) {
        return '<li>' + line.replace(/^[-*]\\s+/, '') + '</li>';
      }).join('');
      return '<ul>' + items + '</ul>';
    });
    // Paragraph breaks on blank lines
    s = s.split(/\\n{2,}/).map(function(p) {
      // Don't wrap block-level elements in <p>
      if (/^<(h[1-6]|ul|ol|pre|li)/.test(p.trim())) return p;
      return '<p>' + p.replace(/\\n/g, '<br>') + '</p>';
    }).join('');
    return s;
  }

  // Surface JS errors in the chat area — must come after addMsg
  window.onerror = function(msg, src, line) {
    addMsg('[Error] ' + msg + ' (' + (src || '') + ':' + line + ')', 'error');
    return false;
  };
  window.addEventListener('unhandledrejection', function(e) {
    addMsg('[Error] ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)), 'error');
  });

  // require() calls deferred until after DOM+error-handler setup
  const fs = require('fs');
  const cfgPath = ${JSON.stringify(cfgPath)};

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch { return {}; }
  }

  function saveConfig(cfg) {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  function onModelSelectChange(sel) {
    const isOllama = sel.value.startsWith('ollama:');
    const tokenInput = document.getElementById('tokenInput');
    const setBtn = document.querySelector('#tokenArea .set-btn');
    if (isOllama) {
      tokenInput.style.display = 'none';
      tokenInput.value = '';
      if (setBtn) setBtn.textContent = 'Enable';
    } else {
      tokenInput.style.display = '';
      if (setBtn) setBtn.textContent = 'Set';
    }
  }

  function setToken() {
    const model = document.getElementById('modelSelect').value;
    const token = document.getElementById('tokenInput').value.trim();
    const isOllama = model.startsWith('ollama:');

    if (!model) {
      addMsg('Please select a model first.', 'error');
      return;
    }
    if (!isOllama && !token) {
      addMsg('Please enter an API token.', 'error');
      return;
    }

    const cfg = readConfig();
    if (!cfg.config) cfg.config = {};
    cfg.config.agentModel = model;
    if (!isOllama) cfg.config.agentToken = token;
    saveConfig(cfg);

    document.getElementById('tokenInput').value = '';
    if (isOllama) {
      addMsg('Model set to <code>' + model + '</code>. Using local Ollama — no token needed.', 'success');
    } else {
      addMsg('Token set for <code>' + model + '</code>. Settings agent ready.', 'success');
    }
    // Swap to chat input — the agent handles everything else from here.
    document.getElementById('tokenArea').style.display = 'none';
    document.getElementById('chatArea').style.display = '';
    document.getElementById('chatInput').focus();
  }

  function editConfig() {
    try {
      const {ipcRenderer} = require('electron');
      ipcRenderer.send('edit-config-external');
      addMsg('Opened config in system editor.', 'success');
    } catch (e) {
      addMsg('Could not open editor: ' + e.message, 'error');
    }
  }

  function factoryReset() {
    if (!confirm('This will wipe all Hyperia settings AND Ferricula memory (tool history, remembered facts, parrot colors — all of it). Your agent API token will be preserved. Restart Hyperia after. Continue?')) return;
    addMsg('Factory Reset', 'user');
    try {
      const {ipcRenderer} = require('electron');
      ipcRenderer.send('factory-reset-config');
      ipcRenderer.once('factory-reset-done', (event, ok) => {
        if (ok) {
          addMsg('Config and memory wiped. Your API token was preserved. Restart Hyperia to complete the reset.', 'success');
        } else {
          addMsg('Factory reset failed.', 'error');
        }
      });
    } catch (e) {
      addMsg('Factory reset error: ' + e.message, 'error');
    }
  }

  function installNemesis8() {
    addMsg('Install Nemesis8', 'user');
    addMsg('Running official Nemesis8 installer...');

    let exec;
    try {
      exec = require('child_process').exec;
    } catch (e) {
      addMsg('Cannot run installer: ' + e.message, 'error');
      return;
    }
    const isWin = process.platform === 'win32';

    // Use official installation script from nemesis8.nuts.services
    const installCmd = isWin
      ? 'powershell -c "irm https://nemesis8.nuts.services/install.ps1 | iex"'
      : 'curl -fsSL https://nemesis8.nuts.services/install.sh | bash';

    exec(installCmd, {timeout: 300000}, (err, stdout, stderr) => {
      if (err) {
        addMsg('Installation failed: <code>' + err.message.replace(/</g, '&lt;') + '</code>', 'error');
        if (stderr) {
          addMsg('Error details: <code>' + stderr.replace(/</g, '&lt;').substring(0, 500) + '</code>', 'error');
        }
        return;
      }

      addMsg('Installation complete. Setting up profile...');

      // Verify installation by checking if nemesis8 is now in PATH
      // On macOS/Linux, also check ~/.local/bin/nemesis8 directly (installer default location)
      const checkCmd = isWin ? 'where nemesis8' : 'which nemesis8 || echo $HOME/.local/bin/nemesis8';

      exec(checkCmd, (err2, binaryPath) => {
        // On macOS/Linux, verify the path exists if which failed
        if (err2 && !isWin) {
          const {existsSync} = require('fs');
          const home = process.env.HOME || process.env.USERPROFILE || '';
          const fallbackPath = '\${home}/.local/bin/nemesis8';

          if (existsSync(fallbackPath)) {
            binaryPath = fallbackPath + '\\n';
          } else {
            addMsg('Nemesis8 installed, but could not find binary in PATH. Try restarting Hyperia or add ~/.local/bin to your PATH.', 'error');
            return;
          }
        } else if (err2) {
          addMsg('Nemesis8 installed, but could not find binary in PATH. Try restarting Hyperia.', 'error');
          return;
        }

        const cfg = readConfig();
        if (!cfg.config) cfg.config = {};
        if (!cfg.config.profiles) cfg.config.profiles = [];
        const existing = cfg.config.profiles.findIndex(p => p.name === 'Nemesis8');

        // Use full path if we found it via fallback, otherwise just 'nemesis8'
        const resolvedBinary = binaryPath.trim();
        const nemesisCmd = isWin ? 'nemesis8 interactive' : '\${resolvedBinary} interactive';

        const profile = {
          name: 'Nemesis8',
          config: {
            shell: isWin ? 'C:\\\\Windows\\\\System32\\\\cmd.exe' : '/bin/bash',
            shellArgs: isWin
              ? ['/c', 'nemesis8 interactive']
              : ['-c', nemesisCmd]
          }
        };

        if (existing >= 0) cfg.config.profiles[existing] = profile;
        else cfg.config.profiles.push(profile);
        saveConfig(cfg);

        // Get installed version (use resolved binary path)
        const versionCmd = isWin ? 'nemesis8 -V' : '\${resolvedBinary} -V';
        exec(versionCmd, {timeout: 5000}, (err3, stdout3) => {
          const version = err3 ? 'unknown' : stdout3.trim();
          addMsg('Nemesis8 <code>' + version + '</code> installed and added as a profile. Restart Hyperia to use it.', 'success');
        });
      });
    });
  }

  function openNemesis8Site() {
    try {
      require('electron').shell.openExternal('https://nemesis8.nuts.services');
    } catch (e) {
      addMsg('Could not open browser: ' + e.message, 'error');
    }
  }

  // Wire all buttons and inputs — script is at bottom of body so DOM is already available
  (function wireHandlers() {
    document.getElementById('closeBtn')?.addEventListener('click', function() { window.close(); });
    document.getElementById('setTokenBtn')?.addEventListener('click', setToken);
    // Edit Config / Install Nemesis8 / Factory Reset buttons removed —
    // reachable via slash-style commands typed in the chat input (see
    // tryCommandDispatch). The functions are still defined and wired
    // through that dispatch.
    document.getElementById('settingsSendBtn')?.addEventListener('click', sendChat);
    document.getElementById('modelSelect')?.addEventListener('change', function() { onModelSelectChange(this); });
    document.getElementById('tokenInput')?.addEventListener('keydown', function(e) { if (e.key === 'Enter') setToken(); });
    document.getElementById('chatInput')?.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendChat(); });
  })();

  const activeWidgets = {};

  function addToolPill(name, id) {
    const div = document.createElement('div');
    div.className = 'tool-pill'; div.id = 'tool-' + id;
    const pending = { set_shivvr_endpoint: 'configuring shivvr\u2026', read_config: 'reading config\u2026' };
    div.innerHTML = '<span class="pill-emoji running">\u{1F527}</span>'
      + '<span>' + escapeHtml(pending[name] || name + '\u2026') + '</span>';
    chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
  }

  function renderShivvrWidget(id, defaultUrl) {
    const div = document.createElement('div');
    div.className = 'shivvr-widget'; div.id = 'tool-' + id;
    div.innerHTML = '<label>Shivvr Endpoint URL</label>'
      + '<input type="text" id="wi-' + id + '" value="' + escapeHtml(defaultUrl || 'shivvr.nuts.services') + '">'
      + '<button class="widget-btn" onclick="confirmWidget(\\'' + id + '\\')">Set</button>';
    chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
    document.getElementById('wi-' + id).addEventListener('keydown', function(e) {
      if (e.key === 'Enter') confirmWidget(id);
    });
    activeWidgets[id] = { confirmed: false };
  }

  function confirmWidget(id) {
    if (activeWidgets[id] && activeWidgets[id].confirmed) return;
    const url = (document.getElementById('wi-' + id)?.value || '').trim();
    const cfg = readConfig();
    if (!cfg.config) cfg.config = {};
    if (url) { if (!cfg.config.shivvr) cfg.config.shivvr = {}; cfg.config.shivvr.url = url; }
    else { delete cfg.config.shivvr; }
    saveConfig(cfg);
    if (activeWidgets[id]) activeWidgets[id].confirmed = true;
    const widgetDiv = document.getElementById('tool-' + id);
    if (widgetDiv) {
      widgetDiv.classList.add('confirmed');
      widgetDiv.innerHTML = '<span class="confirmed-text">\u2713 ' + escapeHtml(url || '(cleared)') + '</span>';
    }
    // Old shivvrInput field was removed when the static config UI was
    // dropped — no syncing needed any more.
  }

    let settingsSending = false;

  // Local "slash commands" — exact-match (case + separator insensitive)
  // dispatch table. Keys are normalized (lowercase, no _ - or whitespace).
  // Wins over the agent so users can run config actions even when the
  // agent isn't reachable (no token, model broken, network down).
  const COMMAND_TABLE = {
    'editconfig': editConfig,
    'editsettings': editConfig,
    'config': editConfig,
    'factoryreset': factoryReset,
    'reset': factoryReset,
    'installnemesis8': installNemesis8,
    'installnemesis': installNemesis8,
    'opennemesissite': openNemesis8Site,
    'nemesissite': openNemesis8Site,
    'help': function help() {
      addMsg(
        '<b>Available commands</b> (type exactly, case and separators don\\'t matter):'
        + '<ul>'
        + '<li><code>edit config</code> — opens hyperia.json in your system editor</li>'
        + '<li><code>factory reset</code> — wipes config and Ferricula memory (preserves your token)</li>'
        + '<li><code>install nemesis8</code> — runs the official Nemesis8 installer script</li>'
        + '<li><code>nemesis site</code> — opens nemesis8.nuts.services in a browser</li>'
        + '<li><code>help</code> — this list</li>'
        + '</ul>'
        + 'Anything else gets routed to the settings agent.',
        'system'
      );
    },
  };

  function normalizeCommand(s) {
    return String(s || '').toLowerCase().replace(/[\\s_\\-]+/g, '');
  }

  function tryCommandDispatch(text) {
    const key = normalizeCommand(text);
    const handler = COMMAND_TABLE[key];
    if (handler) { handler(); return true; }
    return false;
  }

  async function sendChat() {
    if (settingsSending) return;
    const inputEl = document.getElementById('chatInput');
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    addMsg(renderMarkdown(text), 'user');

    // Local slash-command fast path. Runs the action immediately and
    // never touches the agent — works even with no token configured.
    if (tryCommandDispatch(text)) return;

    settingsSending = true;
    const sendBtn = document.getElementById('settingsSendBtn');
    if (sendBtn) sendBtn.disabled = true;

    let assistantDiv = null;
    let assistantText = '';

    try {
      const resp = await fetch(SIDECAR_URL + '/api/settings/chat', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: text})
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        addMsg('Agent error ' + resp.status + ': ' + (body || resp.statusText), 'error');
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const event = JSON.parse(data);
            switch (event.type) {
              case 'text_delta':
                if (!assistantDiv) {
                  assistantDiv = document.createElement('div');
                  assistantDiv.className = 'msg system'; chat.appendChild(assistantDiv);
                }
                assistantText += event.text;
                // Re-render the accumulated text as markdown on every
                // delta. Cheap for typical message sizes; keeps formatting
                // live as the model streams.
                assistantDiv.innerHTML = renderMarkdown(assistantText);
                chat.scrollTop = chat.scrollHeight; break;
              case 'tool_start':
                if (assistantDiv) { assistantDiv = null; assistantText = ''; }
                if (event.name === 'set_shivvr_endpoint') renderShivvrWidget(event.id, 'shivvr.nuts.services');
                else addToolPill(event.name, event.id); break;
              case 'tool_result':
                if (event.name === 'set_shivvr_endpoint') {
                  const m = (event.output || '').match(/ACTION:set_shivvr url=(.*)$/);
                  const url = m ? m[1].trim() : (event.input && event.input.url || '');
                  const wi = document.getElementById('wi-' + event.id);
                  if (wi && url) wi.value = url;
                  confirmWidget(event.id);
                } else {
                  const d = document.getElementById('tool-' + event.id);
                  if (d) {
                    const emoji = d.querySelector('.pill-emoji'); if (emoji) emoji.classList.remove('running');
                    const spans = d.querySelectorAll('span'); if (spans[1]) spans[1].textContent = event.name + ': done';
                  }
                } break;
              case 'done':
                if (assistantDiv) { assistantDiv = null; assistantText = ''; } break;
              case 'error':
                addMsg('Error: ' + event.message, 'error'); break;
              case 'retrying':
                addMsg('Retrying in ' + event.wait_secs + 's\u2026', 'system'); break;
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      addMsg('Could not reach agent: ' + e.message + '. Is sidecar running?', 'error');
    } finally {
      settingsSending = false;
      if (sendBtn) sendBtn.disabled = false;
      if (assistantDiv) assistantDiv.classList.remove('streaming');
    }
  }
</script>
</body>
</html>`;
}

export function initSettings() {
  ipcMain.on('open-settings', () => {
    openSettings();
  });

  ipcMain.on('set-default-profile', (event, name: string) => {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (!cfg.config) cfg.config = {};
      cfg.config.defaultProfile = String(name || '');
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      event.sender.send('set-default-profile-done', {ok: true, name});
    } catch (e) {
      event.sender.send('set-default-profile-done', {ok: false, error: String(e)});
    }
  });

  ipcMain.on('edit-config-external', () => {
    // Try VS Code first, fall back to TextEdit on Mac or system default
    if (process.platform === 'darwin') {
      // macOS: try VS Code, then TextEdit, then default app
      spawn('open', ['-a', 'Visual Studio Code', cfgPath]).on('error', () => {
        spawn('open', ['-e', cfgPath]).on('error', () => {
          void shell.openPath(cfgPath); // Final fallback
        });
      });
    } else {
      // Windows/Linux: try VS Code, fall back to system default
      spawn('code', [cfgPath]).on('error', () => {
        void shell.openPath(cfgPath);
      });
    }
  });

  ipcMain.on('factory-reset-config', (event) => {
    try {
      // Read current config to preserve agent token
      let agentToken = '';
      let agentModel = '';
      try {
        const current = JSON.parse(readFileSync(cfgPath, 'utf8'));
        agentToken = current?.config?.agentToken || '';
        agentModel = current?.config?.agentModel || '';
      } catch {
        // no existing config
      }

      // Copy default config
      const defaults = readFileSync(defaultCfg, 'utf8');
      const cfg = JSON.parse(defaults);

      // Restore agent token if it was set
      if (agentToken) {
        cfg.config.agentToken = agentToken;
        cfg.config.agentModel = agentModel;
      }

      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

      // Purge Ferricula memory from disk
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const memDir = join(home, '.hyperia', 'memory');
      try {
        rmSync(memDir, {recursive: true, force: true});
      } catch {
        // non-fatal — may not exist
      }

      // Best-effort: tell sidecar to reset ghost session (in-memory state)
      const port = process.env.HYPERIA_PORT || '9800';
      fetch(`http://localhost:${port}/api/ghost/reset`, {
        method: 'POST'
      }).catch(() => {});

      event.reply('factory-reset-done', true);
    } catch (e) {
      event.reply('factory-reset-done', false);
    }
  });
}

export {openSettings};
