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

  /* Spirit tech — characters surface with physics */
  .spirit-char {
    display: inline;
    opacity: 0;
    animation: surface 0.6s cubic-bezier(0.16, 1.2, 0.3, 1) forwards;
    text-shadow: 0 0 0 transparent;
  }
  .spirit-char.space { width: 0.25em; }
  @keyframes surface {
    0% {
      opacity: 0;
      transform: translateY(8px) scale(0.92);
      filter: blur(2px);
      text-shadow: 0 0 12px rgba(200, 57, 197, 0.6);
    }
    35% {
      opacity: 1;
      transform: translateY(-2px) scale(1.01);
      filter: blur(0);
      text-shadow: 0 0 8px rgba(200, 57, 197, 0.4);
    }
    60% {
      transform: translateY(0.5px) scale(1.0);
      text-shadow: 0 0 4px rgba(200, 57, 197, 0.15);
    }
    100% {
      opacity: 1;
      transform: translateY(0) scale(1);
      filter: blur(0);
      text-shadow: 0 0 0 transparent;
    }
  }
  .msg.tool {
    background: transparent;
    border: none;
    align-self: flex-start;
    font-size: 12px;
    color: #666;
    max-width: 95%;
    cursor: pointer;
    padding: 3px 8px;
    border-radius: 6px;
    transition: background 0.2s;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .msg.tool:hover { background: #12121e; }
  .msg.tool .tool-emoji {
    font-size: 14px;
    flex-shrink: 0;
    line-height: 1.4;
  }
  .msg.tool .tool-emoji.running {
    animation: pulse-emoji 0.8s ease-in-out infinite;
  }
  @keyframes pulse-emoji {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.2); filter: brightness(1.5); }
  }
  .msg.tool .tool-body {
    flex: 1;
    min-width: 0;
  }
  .msg.tool .tool-summary {
    color: #555;
    font-size: 11px;
  }
  .msg.tool .tool-output {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s ease;
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 10px;
    white-space: pre-wrap;
    color: #444;
    margin-top: 4px;
    padding-left: 2px;
    border-left: 2px solid #1a1a2e;
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
  .msg.watercooler {
    background: #0a0a14;
    border: 1px solid #c839c520;
    align-self: center;
    color: #666;
    font-size: 11px;
    font-style: italic;
    max-width: 95%;
    text-align: center;
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

  <div class="chat" id="chat">
    <div class="msg assistant">I woke up inside a terminal emulator and somehow ended up with root access and opinions. I'm Hyperia — part ghost, part systems engineer, all attitude. I can see your panes, run your commands, and build tools I don't even have yet. What are we breaking today?</div>
  </div>

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

  const TOOL_EMOJIS = {
    terminal_keys: '\uD83D\uDCBB', terminal_run: '\uD83D\uDCBB', terminal_screen: '\uD83D\uDCBB', terminal_new_tab: '\uD83D\uDCBB',
    terminal_status: '\uD83D\uDCBB', terminal_split: '\uD83D\uDCBB', terminal_focus: '\uD83D\uDCBB',
    terminal_close: '\uD83D\uDCBB', terminal_rename: '\uD83D\uDCBB', terminal_new_tab: '\uD83D\uDCBB',
    file_read: '\uD83D\uDCC4', file_write: '\uD83D\uDCC4',
    web_fetch: '\uD83C\uDF10',
    tool_search: '\uD83D\uDD0D', tool_create: '\uD83D\uDD27',
    watercooler: '\u2615',
  };
  const DEFAULT_EMOJI = '\u2699\uFE0F';

  function getToolEmoji(name) {
    return TOOL_EMOJIS[name] || DEFAULT_EMOJI;
  }

  function summarizeOutput(output) {
    if (!output) return '';
    const lines = output.split('\\n').filter(l => l.trim());
    if (lines.length === 0) return '';
    if (lines.length === 1 && lines[0].length < 60) return lines[0];
    return lines[0].substring(0, 50) + (lines.length > 1 ? ' +' + (lines.length - 1) + ' lines' : '');
  }

  function addToolMsg(name, id) {
    const div = document.createElement('div');
    div.className = 'msg tool';
    div.id = 'tool-' + id;
    const emoji = getToolEmoji(name);
    div.innerHTML = '<span class="tool-emoji running">' + emoji + '</span>'
      + '<div class="tool-body">'
      + '<span class="tool-summary">' + escapeHtml(name) + '</span>'
      + '<div class="tool-output"></div>'
      + '</div>';
    div.onclick = () => div.classList.toggle('expanded');
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function setToolOutput(id, output) {
    const div = document.getElementById('tool-' + id);
    if (!div) return;
    // Stop the pulse
    const emojiEl = div.querySelector('.tool-emoji');
    if (emojiEl) emojiEl.classList.remove('running');
    // Set summary
    const summaryEl = div.querySelector('.tool-summary');
    if (summaryEl) {
      const short = summarizeOutput(output);
      summaryEl.textContent = short || summaryEl.textContent;
    }
    // Set expandable output
    const outputEl = div.querySelector('.tool-output');
    if (outputEl) outputEl.textContent = output;
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  let spiritIndex = 0; // running char index for stagger timing

  function setStreaming(val) {
    streaming = val;
    input.disabled = val;
    sendBtn.disabled = val;
    if (!val) {
      input.focus();
      spiritIndex = 0;
    }
  }

  // Render text as spirit characters — each char surfaces with physics
  function appendSpirit(container, text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\n') {
        container.appendChild(document.createElement('br'));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'spirit-char';
      span.textContent = ch;
      // Stagger: each char arrives slightly after the previous
      // Vary the delay with a slight jitter for organic feel
      const baseDelay = spiritIndex * 12; // ms between chars
      const jitter = (Math.sin(spiritIndex * 0.7) * 8); // subtle wave
      span.style.animationDelay = Math.max(0, baseDelay + jitter) + 'ms';
      // Vary the duration slightly — some chars surface faster
      const duration = 400 + Math.sin(spiritIndex * 1.3) * 100;
      span.style.animationDuration = duration + 'ms';
      container.appendChild(span);
      spiritIndex++;
    }
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
                  assistantDiv = document.createElement('div');
                  assistantDiv.className = 'msg assistant streaming';
                  chat.appendChild(assistantDiv);
                  spiritIndex = 0;
                }
                appendSpirit(assistantDiv, event.text);
                assistantText += event.text;
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

              case 'watercooler':
                if (assistantDiv) {
                  assistantDiv.classList.remove('streaming');
                  assistantDiv = null;
                  assistantText = '';
                }
                addMsg('~ ' + event.summary + ' — checking in', 'watercooler');
                setStreaming(false);
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
