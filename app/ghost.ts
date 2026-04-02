// Hyperia — agent chat window powered by the sidecar Hyperia module.
// If no agent token is configured, redirects to Settings.

import {writeFileSync, mkdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {BrowserWindow, ipcMain, screen} from 'electron';

import {hasAgentToken, openSettings} from './settings';

let ghostWindow: BrowserWindow | null = null;

function openHyperia() {
  if (!hasAgentToken()) {
    openSettings();
    return;
  }

  if (ghostWindow && !ghostWindow.isDestroyed()) {
    ghostWindow.focus();
    return ghostWindow;
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  const width = 520;
  const height = 700;
  const x = Math.round(display.workArea.x + display.workArea.width / 2 - width / 2);
  const y = Math.round(display.workArea.y + display.workArea.height / 2 - height / 2);

  ghostWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    backgroundColor: '#08080f',
    title: 'Hyperia',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const html = buildHyperiaHtml();

  const ghostDir = join(tmpdir(), 'hyperia-ghost');
  try {
    mkdirSync(ghostDir, {recursive: true});
  } catch {
    // exists
  }
  const tmpFile = join(ghostDir, 'ghost.html');
  writeFileSync(tmpFile, html, 'utf8');
  void ghostWindow.loadFile(tmpFile);

  ghostWindow.on('closed', () => {
    ghostWindow = null;
  });

  return ghostWindow;
}

function buildHyperiaHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Hyperia</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    background: #08080f;
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
    background: #0a0a14;
    border-bottom: 1px solid #1a1a2e;
    user-select: none;
  }
  .titlebar-text {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 2px;
    color: #c839c5;
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
  .reset-btn:hover { background: rgba(200,57,197,0.2); color: #c839c5; }

  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
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
    animation: fadeIn 0.15s ease;
    white-space: pre-wrap;
    word-break: break-word;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .msg.user {
    background: #1a2a4a;
    border: 1px solid #468cff30;
    align-self: flex-end;
    color: #d0d8f0;
  }
  .msg.assistant {
    background: #12121e;
    border: 1px solid #1a1a2e;
    align-self: flex-start;
    color: #c8d0e0;
  }
  .msg.assistant.streaming {
    border-color: #c839c530;
  }
  .msg.tool {
    background: #0a0a14;
    border: 1px solid #1a1a2e;
    align-self: flex-start;
    font-size: 11px;
    color: #888;
    max-width: 95%;
    cursor: pointer;
  }
  .msg.tool .tool-header {
    color: #c839c5;
    font-weight: 500;
    font-size: 12px;
    margin-bottom: 2px;
  }
  .msg.tool .tool-output {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s ease;
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    color: #666;
    margin-top: 4px;
  }
  .msg.tool.expanded .tool-output {
    max-height: 300px;
    overflow-y: auto;
  }
  .msg.error {
    background: #1a0a0a;
    border: 1px solid #c51e1440;
    align-self: flex-start;
    color: #e08080;
  }

  .status-indicator {
    align-self: flex-start;
    color: #555;
    font-size: 11px;
    padding: 2px 8px;
  }

  .input-area {
    padding: 12px 16px;
    border-top: 1px solid #1a1a2e;
    background: #0a0a14;
    flex-shrink: 0;
    display: flex;
    gap: 8px;
  }
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
    border-color: #c839c540;
    box-shadow: 0 0 8px rgba(200,57,197,0.15);
  }
  .input-area input::placeholder { color: #333; }
  .input-area input:disabled { opacity: 0.5; }
  .send-btn {
    background: #c839c520;
    border: 1px solid #c839c540;
    border-radius: 8px;
    color: #c839c5;
    padding: 0 16px;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.2s;
  }
  .send-btn:hover {
    background: #c839c540;
    box-shadow: 0 0 12px rgba(200,57,197,0.2);
  }
  .send-btn:disabled { opacity: 0.4; cursor: default; }
</style>
</head>
<body>
  <div class="titlebar">
    <span class="titlebar-text">Hyperia</span>
    <span class="titlebar-btn close-btn" onclick="window.close()" title="Close">&times;</span>
  </div>

  <div class="chat" id="chat"></div>

  <div class="input-area">
    <input type="text" id="input" placeholder="Ask Hyperia anything..."
           onkeydown="if(event.key==='Enter'&&!event.shiftKey)send()" autofocus>
    <button class="send-btn" id="sendBtn" onclick="send()">Send</button>
  </div>

<script>
  const SIDECAR_URL = 'http://localhost:9800';
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  let streaming = false;

  function addMsg(content, type) {
    const div = document.createElement('div');
    div.className = 'msg ' + type;
    div.textContent = content;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function addToolMsg(name, id) {
    const div = document.createElement('div');
    div.className = 'msg tool';
    div.id = 'tool-' + id;
    div.innerHTML = '<div class="tool-header">' + escapeHtml(name) + '</div><div class="tool-output"></div>';
    div.onclick = () => div.classList.toggle('expanded');
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function setToolOutput(id, output) {
    const div = document.getElementById('tool-' + id);
    if (div) {
      const outputEl = div.querySelector('.tool-output');
      if (outputEl) outputEl.textContent = output;
    }
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function setStreaming(val) {
    streaming = val;
    input.disabled = val;
    sendBtn.disabled = val;
    if (!val) input.focus();
  }

  async function send() {
    if (streaming) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    addMsg(text, 'user');
    setStreaming(true);

    let assistantDiv = null;
    let assistantText = '';

    try {
      const resp = await fetch(SIDECAR_URL + '/api/ghost/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });

      if (!resp.ok) {
        if (resp.status === 404) {
          addMsg('Agent not available. Set your API token in Settings (Ctrl+,) and restart Hyperia.', 'error');
        } else {
          const body = await resp.text().catch(() => '');
          addMsg('Error ' + resp.status + ': ' + (body || resp.statusText), 'error');
        }
        setStreaming(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
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
                  assistantDiv = addMsg('', 'assistant streaming');
                }
                assistantText += event.text;
                assistantDiv.textContent = assistantText;
                chat.scrollTop = chat.scrollHeight;
                break;

              case 'tool_start':
                // Finalize any pending assistant text
                if (assistantDiv) {
                  assistantDiv.classList.remove('streaming');
                  assistantDiv = null;
                  assistantText = '';
                }
                addToolMsg(event.name, event.id);
                break;

              case 'tool_result':
                setToolOutput(event.id, event.output);
                break;

              case 'done':
                if (assistantDiv) {
                  assistantDiv.classList.remove('streaming');
                  assistantDiv = null;
                  assistantText = '';
                }
                setStreaming(false);
                break;

              case 'error':
                addMsg('Error: ' + event.message, 'error');
                setStreaming(false);
                break;
            }
          } catch (e) {
            // Ignore parse errors on partial data
          }
        }
      }
    } catch (e) {
      addMsg('Cannot reach sidecar. Make sure Hyperia is running and restart if needed.', 'error');
    }

    setStreaming(false);
  }
</script>
</body>
</html>`;
}

export function initHyperia() {
  ipcMain.on('open-ghost', () => {
    openHyperia();
  });
}

export {openHyperia};
