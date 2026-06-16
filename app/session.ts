import {randomBytes} from 'crypto';
import {app} from 'electron';
import {EventEmitter} from 'events';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join, resolve} from 'path';
import {StringDecoder} from 'string_decoder';

import defaultShell from 'default-shell';
import type {IPty, IWindowsPtyForkOptions, spawn as npSpawn} from 'node-pty';
import osLocale from 'os-locale';
import shellEnv from 'shell-env';

import * as config from './config';
import {cliScriptPath} from './config/paths';
import {productName, version} from './package.json';
import {getDecoratedEnv} from './plugins';
import {getFallBackShellConfig} from './utils/shell-fallback';

const createNodePtyError = () =>
  new Error(
    '`node-pty` failed to load. Typically this means that it was built incorrectly. Please check the `readme.md` to more info.'
  );

let spawn: typeof npSpawn;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  spawn = require('node-pty').spawn;
} catch (err) {
  throw createNodePtyError();
}

const useConpty = config.getConfig().useConpty;

// Max duration to batch session data before sending it to the renderer process.
const BATCH_DURATION_MS = 16;

// Max size of a session data batch. Note that this value can be exceeded by ~4k
// (chunk sizes seem to be 4k at the most)
const BATCH_MAX_SIZE = 200 * 1024;

// Data coming from the pty is sent to the renderer process for further
// vt parsing and rendering. This class batches data to minimize the number of
// IPC calls. It also reduces GC pressure and CPU cost: each chunk is prefixed
// with the window ID which is then stripped on the renderer process and this
// overhead is reduced with batching.
class DataBatcher extends EventEmitter {
  uid: string;
  decoder: StringDecoder;
  data!: string;
  timeout!: NodeJS.Timeout | null;
  constructor(uid: string) {
    super();
    this.uid = uid;
    this.decoder = new StringDecoder('utf8');

    this.reset();
  }

  reset() {
    this.data = this.uid;
    this.timeout = null;
  }

  write(chunk: Buffer | string) {
    if (this.data.length + chunk.length >= BATCH_MAX_SIZE) {
      // We've reached the max batch size. Flush it and start another one
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      this.flush();
    }

    this.data += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    if (!this.timeout) {
      this.timeout = setTimeout(() => this.flush(), BATCH_DURATION_MS);
    }
  }

  flush() {
    // Reset before emitting to allow for potential reentrancy
    const data = this.data;
    this.reset();

    this.emit('flush', data);
  }
}

interface SessionOptions {
  uid: string;
  rows?: number;
  cols?: number;
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  profile: string;
}
export default class Session extends EventEmitter {
  pty: IPty | null;
  batcher: DataBatcher | null;
  shell: string | null;
  ended: boolean;
  initTimestamp: number;
  profile!: string;
  cwd!: string;
  shellState?: {
    state: 'idle' | 'running';
    lastExit?: number;
    app?: {
      name: string;
      path: string;
      cmdline: string;
      pid: number;
    };
  };
  // Per-pane identity token injected into the PTY env as HYPERIA_AGENT_TOKEN.
  // An agent running in this pane forwards it to the sidecar (MCP Authorization
  // header) so it's identified as THIS pane — gets consent prompts instead of
  // being anonymous. Registered with the sidecar in SessionRegister. This is a
  // low-privilege pane token (NOT the system bypass token).
  agentToken = '';
  constructor(options: SessionOptions) {
    super();
    this.pty = null;
    this.batcher = null;
    this.shell = null;
    this.ended = false;
    this.initTimestamp = new Date().getTime();
    this.init(options);
  }

  init({uid, rows, cols, cwd, shell: _shell, shellArgs: _shellArgs, profile}: SessionOptions) {
    this.profile = profile;
    this.cwd = cwd || '';
    if (profile === 'picker') {
      this.pty = null;
      this.batcher = new DataBatcher(uid);
      this.batcher.on('flush', (data: string) => {
        this.emit('data', data);
      });
      this.shell = null;
      this.ended = false;
      return;
    }
    this.shellState = { state: 'idle' };

    const envFromConfig = config.getProfileConfig(profile).env || {};
    const defaultShellArgs = ['--login'];

    let shell = _shell || defaultShell;
    let shellArgs = _shellArgs ? [..._shellArgs] : defaultShellArgs;

    // Mint this pane's identity token and inject it so an in-pane agent can
    // present it to the sidecar (via its MCP Authorization header).
    this.agentToken = `hyp_pane_${randomBytes(16).toString('hex')}`;
    // Connection contract for tools/orchestrators launched from this pane (e.g.
    // nemesis8 wiring a container agent): the MCP endpoint and this pane's uid.
    const hyperiaPort = process.env.HYPERIA_PORT || '9800';

    const cleanEnv =
      process.env['APPIMAGE'] && process.env['APPDIR'] ? shellEnv.sync(shell) : process.env;
    const baseEnv: Record<string, string> = {
      ...cleanEnv,
      LANG: `${osLocale.sync().replace(/-/, '_')}.UTF-8`,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: productName,
      TERM_PROGRAM_VERSION: version,
      HYPERIA_AGENT_TOKEN: this.agentToken,
      HYPERIA_MCP_URL: `http://localhost:${hyperiaPort}/mcp`,
      HYPERIA_PANE: uid,
      ...envFromConfig
    };

    const userConfig = config.getConfig();
    const shellIntegrationEnabled = userConfig.shellIntegration !== false;
    const integrationDir = resolve(__dirname, 'static/shell-integration');
    const ctlDir = join(app.getPath('userData'), 'panes', uid);

    mkdirSync(ctlDir, { recursive: true });

    if (shellIntegrationEnabled) {
      baseEnv.HYPERIA_SHELL_INTEGRATION = '1';
      baseEnv.HYPERIA_INTEGRATION_DIR = integrationDir;
      baseEnv.HYPERIA_CTL_DIR = ctlDir;

      const shellLower = shell.toLowerCase();
      const isBash = shellLower.endsWith('bash') || shellLower.endsWith('bash.exe');
      const isZsh = shellLower.endsWith('zsh') || shellLower.endsWith('zsh.exe');
      const isFish = shellLower.endsWith('fish') || shellLower.endsWith('fish.exe');
      const isPwsh = shellLower.endsWith('pwsh') || shellLower.endsWith('pwsh.exe') || shellLower.endsWith('powershell.exe');

      if (isZsh) {
        const zdotdir = join(ctlDir, 'zdotdir');
        mkdirSync(zdotdir, { recursive: true });
        const oldZdotdir = baseEnv.ZDOTDIR || process.env.HOME || '';
        baseEnv.OLD_ZDOTDIR = oldZdotdir;
        baseEnv.ZDOTDIR = zdotdir;
        writeFileSync(join(zdotdir, '.zshrc'), `
if [ -f "$OLD_ZDOTDIR/.zshrc" ]; then
  ZDOTDIR="$OLD_ZDOTDIR"
  source "$OLD_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  ZDOTDIR="$HOME"
  source "$HOME/.zshrc"
else
  ZDOTDIR="$HOME"
fi
if [ -f "$HYPERIA_INTEGRATION_DIR/hyperia.zsh" ]; then
  source "$HYPERIA_INTEGRATION_DIR/hyperia.zsh"
fi
`);
      } else if (isBash) {
        const bashrcPath = join(ctlDir, 'bashrc');
        writeFileSync(bashrcPath, `
if [ -f /etc/bash.bashrc ]; then
  source /etc/bash.bashrc
fi
if [ -f ~/.bashrc ]; then
  source ~/.bashrc
fi
if [ -f "$HYPERIA_INTEGRATION_DIR/hyperia.bash" ]; then
  source "$HYPERIA_INTEGRATION_DIR/hyperia.bash"
fi
`);
        shellArgs = ['--rcfile', bashrcPath];
      } else if (isFish) {
        shellArgs = ['--init-command', `source "${join(integrationDir, 'hyperia.fish')}"`].concat(_shellArgs || []);
      } else if (isPwsh) {
        shellArgs = ['-NoExit', '-Command', `. "${join(integrationDir, 'hyperia.ps1')}"`].concat(_shellArgs || []);
      }
    }

    const options: IWindowsPtyForkOptions = {
      cols,
      rows,
      cwd,
      env: getDecoratedEnv(baseEnv)
    };

    // if config do not set the useConpty, it will be judged by the node-pty
    if (typeof useConpty === 'boolean') {
      options.useConpty = useConpty;
    }

    try {
      this.pty = spawn(shell, shellArgs, options);
    } catch (_err) {
      const err = _err as {message: string};
      if (/is not a function/.test(err.message)) {
        throw createNodePtyError();
      }
      // node-pty's WindowsPtyAgent throws "File not found" when the cwd can't be
      // resolved on this host (e.g. an agent in a container passed /workspace/...).
      // Retry once without the cwd so the pane still opens instead of crashing
      // the main process with an uncaught exception.
      if (options.cwd) {
        try {
          delete (options as {cwd?: string}).cwd;
          this.cwd = '';
          this.pty = spawn(shell, shellArgs, options);
        } catch {
          throw err;
        }
      } else {
        throw err;
      }
    }

    this.batcher = new DataBatcher(uid);
    let oscBuffer = '';
    this.pty.onData((chunk) => {
      if (this.ended) {
        return;
      }

      // Parse OSC 7, 133, and 697 sequences. The control
      // characters (ESC \x1b, BEL \x07) are an intrinsic part of the OSC
      // wire format, so no-control-regex is intentionally disabled here.
      oscBuffer += chunk;
      let match;
      // RegExp to match OSC sequences: \x1b] (code) ; (content) BEL or ST
      // eslint-disable-next-line no-control-regex
      const oscRegex = /\x1b\](7|133|697);(.*?)(?:\x07|\x1b\\)/g;

      let lastIndex = 0;
      while ((match = oscRegex.exec(oscBuffer)) !== null) {
        const code = match[1];
        const content = match[2];
        lastIndex = oscRegex.lastIndex;

        if (code === '7') {
          // eslint-disable-next-line no-control-regex
          const fileMatch = /^file:\/\/[^/\x07\x1b]*(.*)/.exec(content);
          if (fileMatch) {
            const uriPath = fileMatch[1];
            try {
              let rawPath = decodeURIComponent(uriPath);
              if (process.platform === 'win32') {
                if (/^\/[a-zA-Z]:/.test(rawPath)) {
                  rawPath = rawPath.slice(1);
                }
                rawPath = rawPath.replace(/\//g, '\\');
              }
              if (rawPath && rawPath !== this.cwd) {
                this.cwd = rawPath;
                this.emit('cwd', rawPath);
              }
            } catch (e) {
              console.error('Failed to decode OSC 7 URI:', uriPath, e);
            }
          }
        } else if (code === '133') {
          const parts = content.split(';');
          const action = parts[0].trim();
          if (action === 'A' || action === 'B') {
            this.shellState = {
              state: 'idle',
              lastExit: this.shellState?.lastExit
            };
            this.emit('shellstate', this.shellState);
          } else if (action === 'C') {
            this.shellState = {
              state: 'running',
              lastExit: this.shellState?.lastExit
            };
            this.emit('shellstate', this.shellState);
          } else if (action === 'D') {
            const exitCodeStr = parts[1]?.trim();
            const lastExit = exitCodeStr ? parseInt(exitCodeStr, 10) : undefined;
            this.shellState = {
              state: 'idle',
              lastExit: !isNaN(lastExit as any) ? lastExit : this.shellState?.lastExit,
              app: undefined
            };
            this.emit('shellstate', this.shellState);
          }
        } else if (code === '697') {
          const pairs = content.split(';');
          const data: Record<string, string> = {};
          for (const pair of pairs) {
            const idx = pair.indexOf('=');
            if (idx !== -1) {
              const k = pair.substring(0, idx).trim();
              const v = pair.substring(idx + 1).trim();
              data[k] = v;
            }
          }

          const decodeBase64 = (s: string | undefined): string => {
            if (!s) return '';
            try {
              return Buffer.from(s, 'base64').toString('utf8');
            } catch {
              return '';
            }
          };

          const cmd = decodeBase64(data['cmd']);
          const appPath = decodeBase64(data['app']);
          const argv0 = decodeBase64(data['argv0']);
          const pid = data['pid'] ? parseInt(data['pid'], 10) : undefined;

          let name = argv0 || '';
          if (!name && appPath) {
            name = appPath.split(/[/\\]/).pop() || '';
          }

          this.shellState = {
            state: this.shellState?.state || 'idle',
            lastExit: this.shellState?.lastExit,
            app: appPath || cmd || name ? {
              name,
              path: appPath,
              cmdline: cmd,
              pid: pid || 0
            } : undefined
          };
          this.emit('shellstate', this.shellState);
        }
      }

      if (lastIndex > 0) {
        oscBuffer = oscBuffer.slice(lastIndex);
      }
      if (oscBuffer.length > 16384) {
        oscBuffer = oscBuffer.slice(-16384);
      }

      this.batcher?.write(chunk);
    });

    this.batcher.on('flush', (data: string) => {
      this.emit('data', data);
    });

    this.pty.onExit((e) => {
      if (!this.ended) {
        // fall back to default shell config if the shell exits within 1 sec with non zero exit code
        // this will inform users in case there are errors in the config instead of instant exit
        const runDuration = new Date().getTime() - this.initTimestamp;
        if (e.exitCode > 0 && runDuration < 1000) {
          const fallBackShellConfig = getFallBackShellConfig(shell, shellArgs, defaultShell, defaultShellArgs);
          if (fallBackShellConfig) {
            const msg = `
shell exited in ${runDuration} ms with exit code ${e.exitCode}
please check the shell config: ${JSON.stringify({shell, shellArgs}, undefined, 2)}
using fallback shell config: ${JSON.stringify(fallBackShellConfig, undefined, 2)}
`;
            console.warn(msg);
            this.batcher?.write(msg.replace(/\n/g, '\r\n'));
            this.init({
              uid,
              rows,
              cols,
              cwd,
              shell: fallBackShellConfig.shell,
              shellArgs: fallBackShellConfig.shellArgs,
              profile
            });
          } else {
            const msg = `
shell exited in ${runDuration} ms with exit code ${e.exitCode}
No fallback available, please check the shell config.
`;
            console.warn(msg);
            this.batcher?.write(msg.replace(/\n/g, '\r\n'));
          }
        } else {
          this.ended = true;
          this.emit('exit');
        }
      }
    });

    this.shell = shell;
  }

  exit() {
    this.destroy();
  }

  write(data: string) {
    if (this.pty) {
      this.pty.write(data);
    } else {
      console.warn('Warning: Attempted to write to a session with no pty');
    }
  }

  resize({cols, rows}: {cols: number; rows: number}) {
    if (this.pty) {
      try {
        this.pty.resize(cols, rows);
      } catch (_err) {
        const err = _err as {stack: any};
        console.error(err.stack);
      }
    } else {
      console.warn('Warning: Attempted to resize a session with no pty');
    }
  }

  destroy() {
    if (this.pty) {
      try {
        this.pty.kill();
      } catch (_err) {
        const err = _err as {stack: any};
        console.error('exit error', err.stack);
      }
    } else {
      console.warn('Warning: Attempted to destroy a session with no pty');
    }
    this.emit('exit');
    this.ended = true;
  }
}
