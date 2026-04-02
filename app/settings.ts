// Settings chat window — token setup, config editing, nemesis8 install.
// Opens instead of a JSON editor when user clicks Preferences.

import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {BrowserWindow, ipcMain, screen, shell} from 'electron';

import {cfgPath, defaultCfg} from './config/paths';

let settingsWindow: BrowserWindow | null = null;

export function hasAgentToken(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return !!(cfg.config?.agentToken && cfg.config?.agentModel);
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

  const width = 480;
  const height = 580;
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
  const hasToken = !!cfg.config?.agentToken;
  const currentModel = cfg.config?.agentModel || '';
  const cfgPathEscaped = JSON.stringify(cfgPath.replace(/\\/g, '\\\\'));

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Hyperia Settings</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
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
</style>
</head>
<body>
  <div class="titlebar">
    <span class="titlebar-text">Settings</span>
    <span class="titlebar-btn close-btn" onclick="window.close()">&times;</span>
  </div>

  <div class="actions">
    <div class="action-btn" onclick="editConfig()">
      <span>{}</span>
      <span>Edit Config</span>
    </div>
    <div class="action-btn" onclick="installNemesis8()">
      <span>N</span>
      <span>Install Nemesis8</span>
    </div>
    <div class="action-btn" onclick="openNemesis8Site()" style="flex:0;padding:10px;min-width:36px" title="nemesis8.nuts.services">
      <span>&#x2197;</span>
    </div>
    <div class="action-btn" onclick="factoryReset()">
      <span>!</span>
      <span>Factory Reset</span>
    </div>
  </div>

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
      <option value="anthropic" ${currentModel === 'anthropic' ? 'selected' : ''}>Anthropic</option>
      <option value="openai" ${currentModel === 'openai' ? 'selected' : ''}>OpenAI</option>
      <option value="google" ${currentModel === 'google' ? 'selected' : ''}>Google</option>
      <option value="openrouter" ${currentModel === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
    </select>
    <input type="password" id="tokenInput" placeholder="Enter token..." onkeydown="if(event.key==='Enter')setToken()">
    <button class="set-btn" onclick="setToken()">Set</button>
  </div>

  <div class="input-area" id="chatArea" style="${hasToken ? '' : 'display:none'}">
    <input type="text" id="chatInput" placeholder="Ask about settings..."
           onkeydown="if(event.key==='Enter')sendChat()">
    <button class="set-btn" onclick="sendChat()">Send</button>
  </div>

<script>
  const fs = require('fs');
  const cfgPath = ${cfgPathEscaped};
  const chat = document.getElementById('chat');

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch { return {}; }
  }

  function saveConfig(cfg) {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  function addMsg(text, type) {
    const div = document.createElement('div');
    div.className = 'msg ' + (type || 'system');
    div.innerHTML = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  function setToken() {
    const model = document.getElementById('modelSelect').value;
    const token = document.getElementById('tokenInput').value.trim();

    if (!model) {
      addMsg('Please select a model first.', 'error');
      return;
    }
    if (!token) {
      addMsg('Please enter an API token.', 'error');
      return;
    }

    const cfg = readConfig();
    if (!cfg.config) cfg.config = {};
    cfg.config.agentModel = model;
    cfg.config.agentToken = token;
    saveConfig(cfg);

    document.getElementById('tokenInput').value = '';
    addMsg('Token set for <code>' + model + '</code>. Settings agent ready.', 'success');
    // Swap to chat input
    document.getElementById('tokenArea').style.display = 'none';
    document.getElementById('chatArea').style.display = '';
    document.getElementById('chatInput').focus();
  }

  function editConfig() {
    const {ipcRenderer} = require('electron');
    ipcRenderer.send('edit-config-external');
    addMsg('Opened config in system editor.', 'success');
  }

  function factoryReset() {
    addMsg('Factory Reset', 'user');
    addMsg('This will restore all settings to defaults. Your agent token will be preserved. Restart Hyperia after.', 'system');
    const {ipcRenderer} = require('electron');
    ipcRenderer.send('factory-reset-config');
    ipcRenderer.once('factory-reset-done', (event, ok) => {
      if (ok) {
        addMsg('Config restored to factory defaults. Restart Hyperia to apply.', 'success');
      } else {
        addMsg('Factory reset failed.', 'error');
      }
    });
  }

  function installNemesis8() {
    addMsg('Install Nemesis8', 'user');
    addMsg('Cloning nemesis8 from GitHub...');

    const {exec} = require('child_process');
    const home = require('os').homedir();
    const path = require('path');
    const installDir = path.join(home, '.hyperia', 'packages', 'nemesis8');

    exec('git clone https://github.com/DeepBlueDynamics/nemesis8.git "' + installDir + '"', (err) => {
      if (err && !err.message.includes('already exists')) {
        addMsg('Clone failed: <code>' + err.message.replace(/</g, '&lt;') + '</code>', 'error');
        return;
      }
      addMsg('Building nemesis8 (this may take a minute)...');
      exec('cd "' + installDir + '" && cargo build --release', {timeout: 300000}, (err2) => {
        if (err2) {
          addMsg('Build failed: <code>' + err2.message.replace(/</g, '&lt;') + '</code>', 'error');
          return;
        }
        const cfg = readConfig();
        if (!cfg.config) cfg.config = {};
        if (!cfg.config.profiles) cfg.config.profiles = [];
        const existing = cfg.config.profiles.findIndex(p => p.name === 'Nemesis8');
        const isWin = process.platform === 'win32';
        const profile = {
          name: 'Nemesis8',
          config: {
            shell: isWin ? 'C:\\\\Windows\\\\System32\\\\cmd.exe' : '/bin/bash',
            shellArgs: isWin
              ? ['/c', 'cd "' + installDir + '" && .\\\\target\\\\release\\\\nemisis8.exe interactive']
              : ['-c', 'cd "' + installDir + '" && ./target/release/nemisis8 interactive']
          }
        };
        if (existing >= 0) cfg.config.profiles[existing] = profile;
        else cfg.config.profiles.push(profile);
        saveConfig(cfg);

        // Get installed version
        const binary = isWin
          ? path.join(installDir, 'target', 'release', 'nemisis8.exe')
          : path.join(installDir, 'target', 'release', 'nemisis8');
        exec('"' + binary + '" -V', {timeout: 5000}, (err3, stdout3) => {
          const version = err3 ? 'unknown' : stdout3.trim();
          addMsg('Nemesis8 <code>' + version + '</code> installed and added as a profile. Restart Hyperia to use it.', 'success');
        });
      });
    });
  }

  function openNemesis8Site() {
    require('electron').shell.openExternal('https://nemesis8.nuts.services');
  }

  function sendChat() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg(text, 'user');
    // TODO: wire to sidecar settings agent when available
    addMsg('Settings agent coming soon. For now, use <b>Edit Config</b> to change settings or right-click <b>New Hyperia</b> for the full agent.', 'system');
  }
</script>
</body>
</html>`;
}

export function initSettings() {
  ipcMain.on('open-settings', () => {
    openSettings();
  });

  ipcMain.on('edit-config-external', () => {
    void shell.openPath(cfgPath);
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
      event.reply('factory-reset-done', true);
    } catch (e) {
      event.reply('factory-reset-done', false);
    }
  });
}

export {openSettings};
