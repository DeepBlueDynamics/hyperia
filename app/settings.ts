// Settings IPC handlers. The separate Preferences/settings window was
// removed — configuration now lives in the Hyperia shell. These handlers
// remain for the actions the rest of the app still fires: set the default
// shell profile, open the raw config in an external editor, and factory
// reset. No window is created here.

import {spawn} from 'child_process';
import {readFileSync, writeFileSync, rmSync} from 'fs';
import {join} from 'path';

import {ipcMain, shell} from 'electron';

import {cfgPath, defaultCfg} from './config/paths';

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

export function initSettings() {
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

  ipcMain.on('show-about', () => {
    const {dialog} = require('electron');
    dialog.showMessageBoxSync({
      title: `About Hyperia`,
      message: `Hyperia 0.10.8 (stable)`,
      detail: `by Kord Campbell\nCopyright © 2026 Deep Blue Dynamics\n\nBased on Hyper, Copyright © 2022 Vercel, Inc.`,
      buttons: ['OK']
    });
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

  ipcMain.handle('has-agent-token', () => {
    return hasAgentToken();
  });
}
