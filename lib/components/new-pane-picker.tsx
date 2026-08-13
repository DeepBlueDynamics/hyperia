import React from 'react';

import rpc from '../rpc';

import UrlPicker from './url-picker';

const isWindows = ['Windows', 'Win16', 'Win32', 'WinCE'].includes(navigator.platform) || process.platform === 'win32';

// A shell whose path is a Windows path (.exe / backslashes / "C:") only fits a
// Windows host, and vice-versa — a config synced between machines can carry the
// other platform's shells, which we hide here. (Mirrors the helper in term.tsx.)
const profileFitsPlatform = (p: any): boolean => {
  const shell = String(p?.config?.shell || '');
  if (!shell) return true;
  // Hide a profile ONLY when its shell path clearly belongs to the OTHER platform
  // (e.g. a config synced from Windows onto macOS carries `C:\...\pwsh.exe`). A
  // bare command like `ssh`, `wsl`, or `docker` — no extension, no absolute path —
  // is valid on any platform and MUST stay visible. The old check required a
  // Windows-looking path to show on Windows, which silently dropped every
  // user-created `ssh` shell from the list.
  const looksWindows = /\.exe$|\\|^[A-Za-z]:/.test(shell);
  const looksUnix = /^\//.test(shell);
  return isWindows ? !looksUnix : !looksWindows;
};

// Built-in agent names that live under "New Agent", not the shell list. These
// mirror the harness catalog in app/config/detect.ts (the agents nemesis8 knows
// how to install) — detected profiles arrive under exactly these names.
const AGENT_NAMES = new Set([
  'claude code',
  'nemesis8',
  'nemesis8 danger',
  'antigravity',
  'codex',
  'opencode',
  'grok',
  'hermes',
  'pi'
]);

// Install instructions per harness — shown in the picker's "install an agent"
// view. Nothing here auto-runs: the user copies the command or opens a shell
// with it pre-typed (never submitted). Mirrors app/config/detect.ts AGENT_DEFS
// (the catalog nemesis8 supports, ../nemesis8/providers/*.toml).
interface InstallEntry {
  name: string;
  /** POSIX (macOS/Linux) install command. */
  unix?: string;
  /** Windows (PowerShell) install command. */
  win?: string;
  /** Free-text note when there's no command for this platform. */
  note?: string;
  /** Configured (not installed) — shows a "configure" action opening its modal. */
  configure?: boolean;
}

const INSTALL_CATALOG: InstallEntry[] = [
  {
    name: 'Hyperia',
    note: "Hyperia's built-in agent — configure it to enable.",
    configure: true
  },
  {
    name: 'Nemesis8',
    unix: 'curl -fsSL https://nemesis8.nuts.services/install.sh | sh',
    win: 'irm https://nemesis8.nuts.services/install.ps1 | iex'
  },
  {
    name: 'Claude Code',
    unix: 'npm install -g @anthropic-ai/claude-code',
    win: 'npm install -g @anthropic-ai/claude-code'
  },
  {
    name: 'Antigravity',
    note: "Installs via Google's official Antigravity CLI installer (provides the `agy` binary)."
  },
  {name: 'Codex', unix: 'npm install -g @openai/codex', win: 'npm install -g @openai/codex'},
  {name: 'OpenCode', unix: 'npm install -g opencode-ai', win: 'npm install -g opencode-ai'},
  {
    name: 'Grok',
    unix: 'curl -fsSL https://x.ai/cli/install.sh | sh',
    note: 'macOS/Linux installer — on Windows run it inside WSL.'
  },
  {
    name: 'Hermes',
    unix: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | sh',
    note: 'macOS/Linux installer — on Windows run it inside WSL.'
  },
  {
    name: 'Pi',
    unix: 'npm install -g @earendil-works/pi-coding-agent --ignore-scripts',
    win: 'npm install -g @earendil-works/pi-coding-agent --ignore-scripts'
  }
];

// Persisted picker defaults — what the S / A hotkeys launch. Written on every
// explicit shell/agent selection, read once when the picker mounts, so the
// quick keys keep working across sessions.
const LS_DEFAULT_SHELL = 'hyperia.picker.defaultShell';
const LS_DEFAULT_AGENT = 'hyperia.picker.defaultAgent';
const readStoredDefault = (key: string): string | undefined => {
  try {
    return window.localStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
};
const writeStoredDefault = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
};

// Self-update command shown in the picker footer. Like the install catalog,
// it never auto-runs: [run] opens a shell with it typed but NOT submitted.
const UPDATE_COMMAND = isWindows
  ? 'powershell -c "irm https://hyperia.nuts.services/install.ps1 | iex"'
  : 'curl -fsSL https://hyperia.nuts.services/install.sh | sh';

// Version strings compare with or without a leading "v" ("0.15.11" == "v0.15.11").
const normalizeVersion = (v?: string): string => (v || '').trim().replace(/^v/i, '');

// Icon per agent harness.
const agentIconClass = (name: string): {icon: string; style?: React.CSSProperties} => {
  const n = name.toLowerCase().replace(/^install /, '');
  if (n === 'hyperia') return {icon: 'ti ti-ghost', style: {color: 'var(--info-text)'}};
  if (n === 'claude code') return {icon: 'ti ti-sparkles', style: {color: 'var(--info-text)'}};
  if (n === 'antigravity') return {icon: 'ti ti-rocket', style: {color: 'var(--info-text)'}};
  if (n === 'nemesis8') return {icon: 'ti ti-robot', style: {color: 'var(--danger-text)'}};
  if (n === 'nemesis8 danger') return {icon: 'ti ti-shield-off', style: {color: 'var(--danger-text)'}};
  if (n === 'codex' || n === 'opencode') return {icon: 'ti ti-code', style: {color: 'var(--info-text)'}};
  if (n === 'grok') return {icon: 'ti ti-planet', style: {color: 'var(--info-text)'}};
  if (n === 'hermes') return {icon: 'ti ti-feather', style: {color: 'var(--info-text)'}};
  if (n === 'pi') return {icon: 'ti ti-math-pi', style: {color: 'var(--info-text)'}};
  return {icon: 'ti ti-robot'};
};

// Pick a Tabler icon class for a shell profile from its name.
const shellIconClass = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes('powershell') || n.includes('pwsh')) return 'ti ti-terminal-2';
  if (n.includes('wsl') || n.includes('ubuntu') || n.includes('debian')) return 'ti ti-brand-debian';
  if (n.includes('bash') || n.includes('git')) return 'ti ti-brand-git';
  if (n.includes('cmd') || n.includes('command')) return 'ti ti-terminal';
  if (n.includes('azure') || n.includes('cloud')) return 'ti ti-cloud';
  return 'ti ti-terminal-2';
};

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// InlineCombobox: a type-to-filter text input backed by a dropdown list. Used
// once for shells and once for agents. It owns its own text/open/highlight
// state; the parent supplies the item list, the default text, and the "add"/
// "create" fallbacks.
// ---------------------------------------------------------------------------

interface ComboItem {
  // `key` is the launch identity (usually the profile name); also matched when
  // filtering so typing the raw profile name works even if the label differs.
  key: string;
  label: string;
  iconClass?: string;
  iconStyle?: React.CSSProperties;
  onSelect: () => void;
  // Custom (user-saved) profiles get a gear that opens the edit modal (which
  // itself holds Delete). Replaces the old right-click-to-delete affordance.
  onEdit?: () => void;
  // Rows with a config surface (Hyperia) get a gear button on the right.
  onConfigure?: () => void;
}

interface ComboboxProps {
  label: string;
  // Static glyph shown at the left of the box (like the URL box's globe).
  leadingIcon: string;
  items: ComboItem[];
  // Field value when the user hasn't typed anything (e.g. last-used shell).
  defaultText: string;
  placeholder: string;
  // First dropdown row — always present (e.g. "add a shell").
  addLabel: string;
  // Bottom row shown only when the typed text matches nothing (e.g. "create
  // new shell"). Both this and the add row route to the parent's `onAdd`.
  createLabel: string;
  onAdd: () => void;
  isGlimmerActive?: boolean;
  // Hotkey chip (e.g. "S") shown next to the label; `keyHintTitle` explains
  // what pressing the key launches.
  keyHint?: string;
  keyHintTitle?: string;
}

interface ComboboxState {
  text: string;
  open: boolean;
  // `dirty` = the user has typed since focusing. We only FILTER the list once
  // dirty — otherwise opening the field (pre-filled with the default name)
  // would filter the dropdown down to just that one default and hide every
  // other shell/agent. Focused-but-clean shows the whole list.
  dirty: boolean;
  // Index into rows(); -1 means "nothing highlighted, resolve from text".
  focusedIndex: number;
}

type ComboRow = {type: 'add'} | {type: 'item'; item: ComboItem} | {type: 'create'};

const comboRowStyle = (focused: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 10px',
  cursor: 'pointer',
  background: focused ? 'var(--info-bg)' : undefined
});

// Shared layout so New Webpane / New Shell / New Agent are the SAME width and
// look: a fixed-width left label (wide enough for the W/S/A hotkey chip), then
// a flex box capped at the same maxWidth.
const PICKER_ROW_MAX = '446px';
const PICKER_BOX_MAX = '340px';
const pickerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-10)',
  width: '100%',
  maxWidth: PICKER_ROW_MAX
};
const pickerLabelStyle: React.CSSProperties = {
  width: '96px',
  flexShrink: 0,
  fontSize: '11px',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-sans)',
  fontWeight: 500
};
// Matches the URL box container verbatim (url-picker.tsx).
const pickerBoxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-8)',
  background: 'var(--bg-primary)',
  border: '0.5px solid var(--border-neutral)',
  borderRadius: 'var(--radius-6)',
  padding: '0 var(--space-10)',
  height: '36px',
  width: '100%',
  boxSizing: 'border-box'
};
const pickerInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  height: '100%',
  padding: 0,
  minWidth: 0
};
// The inline "enter" badge inside the box — identical to the URL box's.
const pickerEnterBadgeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 600,
  padding: 'var(--space-2) var(--space-4)',
  border: '0.5px solid var(--border-neutral)',
  borderRadius: 'var(--radius-3)',
  color: 'var(--text-tertiary)',
  userSelect: 'none',
  lineHeight: '1.2',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  flexShrink: 0
};
// Small hotkey chip ("W" / "S" / "A") next to each section label — same look
// as the inline enter badge, sized down to fit the label column.
const pickerKeyHintStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
  fontWeight: 600,
  padding: '1px var(--space-4)',
  border: '0.5px solid var(--border-neutral)',
  borderRadius: 'var(--radius-3)',
  color: 'var(--text-tertiary)',
  userSelect: 'none',
  lineHeight: '1.2',
  flexShrink: 0
};
const pickerDropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + var(--space-4))',
  left: 0,
  right: 0,
  zIndex: 20,
  border: '0.5px solid var(--border-neutral)',
  borderRadius: 'var(--radius-6)',
  overflow: 'hidden',
  background: 'var(--bg-primary)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)'
};

class InlineCombobox extends React.Component<ComboboxProps, ComboboxState> {
  inputRef = React.createRef<HTMLInputElement>();
  state: ComboboxState = {text: this.props.defaultText, open: false, dirty: false, focusedIndex: -1};

  componentDidUpdate(prev: ComboboxProps) {
    // Refresh the field when the caller's default changes (e.g. "last used"
    // updated after a launch) — but never while the user is actively editing.
    if (prev.defaultText !== this.props.defaultText && !this.state.open) {
      this.setState({text: this.props.defaultText});
    }
  }

  // Case-insensitive substring filter on both label and launch key. Only applied
  // once the user has actually typed (dirty) — a clean/just-focused field shows
  // the ENTIRE list even though it displays the default name.
  private filteredItems(): ComboItem[] {
    const q = this.state.text.trim().toLowerCase();
    if (!this.state.dirty || !q) return this.props.items;
    return this.props.items.filter(
      (it) => it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q)
    );
  }

  // Show the "create new …" fallback only when the user has typed something
  // that matches no existing item (mirrors the URL box's search fallback).
  private showCreate(): boolean {
    return this.state.dirty && this.state.text.trim() !== '' && this.filteredItems().length === 0;
  }

  private rows(): ComboRow[] {
    const rows: ComboRow[] = [{type: 'add'}];
    for (const item of this.filteredItems()) rows.push({type: 'item', item});
    if (this.showCreate()) rows.push({type: 'create'});
    return rows;
  }

  // Closing resets the field back to the default name so a half-typed, un-
  // committed value never lingers.
  private close = () => this.setState({open: false, dirty: false, focusedIndex: -1, text: this.props.defaultText});

  // Enter / badge with no explicit highlight: resolve from typed text. Exact
  // name match wins; else the first substring (type-ahead) match; else the text
  // matched nothing → route to the add/create flow.
  private commitText = () => {
    const q = this.state.text.trim().toLowerCase();
    if (q) {
      const exact = this.props.items.find((it) => it.label.toLowerCase() === q || it.key.toLowerCase() === q);
      if (exact) {
        this.close();
        exact.onSelect();
        return;
      }
      const match = this.props.items.find(
        (it) => it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q)
      );
      if (match) {
        this.close();
        match.onSelect();
        return;
      }
    }
    this.close();
    this.props.onAdd();
  };

  private commitRow = (row: ComboRow) => {
    this.close();
    if (row.type === 'item') row.item.onSelect();
    else this.props.onAdd(); // 'add' and 'create' both open the custom modal
  };

  private commit = () => {
    const rows = this.rows();
    const {focusedIndex} = this.state;
    if (focusedIndex >= 0 && focusedIndex < rows.length) this.commitRow(rows[focusedIndex]);
    else this.commitText();
  };

  render() {
    const {label, leadingIcon, addLabel, createLabel, placeholder, keyHint, keyHintTitle} = this.props;
    const rows = this.rows();
    const {text, open, focusedIndex} = this.state;

    return (
      <div style={pickerRowStyle}>
        <div style={{...pickerLabelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-4)'}} title={keyHintTitle}>
          <span>{label}</span>
        </div>

        <div style={{position: 'relative', flex: 1, minWidth: 0, maxWidth: PICKER_BOX_MAX}}>
          <div style={pickerBoxStyle}>
            <i
              className={leadingIcon}
              style={{fontSize: '14px', color: 'var(--text-tertiary)', flexShrink: 0}}
              aria-hidden="true"
            />
            <input
              ref={this.inputRef}
              type="text"
              value={text}
              placeholder={placeholder}
              // Focus opens the full list (dirty:false) and selects the text so
              // the first keystroke replaces the default rather than appending.
              onFocus={(e) => {
                e.target.select();
                this.setState({open: true, dirty: false, focusedIndex: -1});
              }}
              // Blur closes the dropdown; row clicks use onMouseDown +
              // preventDefault so the selection fires before this blur.
              onBlur={() => this.close()}
              onChange={(e) => this.setState({text: e.target.value, open: true, dirty: true, focusedIndex: -1})}
              onContextMenu={(e) => {
                // Don't let a right-click bubble to the chooser's glimmer flash.
                e.preventDefault();
                e.stopPropagation();
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  this.setState({open: true, focusedIndex: Math.min(focusedIndex + 1, rows.length - 1)});
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  this.setState({focusedIndex: Math.max(focusedIndex - 1, -1)});
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  this.commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  this.close();
                  this.inputRef.current?.blur();
                }
              }}
              style={pickerInputStyle}
            />
            <span
              // Inline "enter" badge inside the box, exactly like the URL box.
              // Keep input focus (preventDefault) so the highlight/text survives.
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={() => this.commit()}
              style={pickerEnterBadgeStyle}
            >
              {keyHint ? keyHint.toLowerCase() : 'enter'}
            </span>
          </div>

          {open && rows.length > 0 && (
            <div style={pickerDropdownStyle}>
              <div style={{maxHeight: '208px', overflowY: 'auto'}}>
                {rows.map((row, i) => {
                  const isFocused = i === focusedIndex;

                  if (row.type === 'add' || row.type === 'create') {
                    const isAdd = row.type === 'add';
                    return (
                      <div
                        key={isAdd ? '__add' : '__create'}
                        onMouseDown={(ev) => {
                          ev.preventDefault();
                          this.commitRow(row);
                        }}
                        onMouseEnter={() => this.setState({focusedIndex: i})}
                        style={comboRowStyle(isFocused)}
                      >
                        <i
                          className={isAdd ? 'ti ti-plus' : 'ti ti-sparkles'}
                          style={{fontSize: '13px', color: 'var(--info-text)', flexShrink: 0}}
                          aria-hidden="true"
                        />
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: '11px',
                            color: 'var(--info-text)',
                            fontFamily: 'var(--font-sans)'
                          }}
                        >
                          {isAdd ? addLabel : `${createLabel} “${text.trim()}”`}
                        </span>
                      </div>
                    );
                  }

                  const it = row.item;
                  return (
                    <div
                      key={it.key}
                      // Left-click only launches. A right/middle click must never
                      // fire the row (that was the "right-click just opens a
                      // terminal" bug); edit/delete now live on the gear.
                      onMouseDown={(ev) => {
                        if (ev.button !== 0) return;
                        ev.preventDefault();
                        this.commitRow(row);
                      }}
                      onMouseEnter={() => this.setState({focusedIndex: i})}
                      onContextMenu={(ev) => {
                        // Swallow the OS menu; no right-click actions on rows.
                        ev.preventDefault();
                        ev.stopPropagation();
                      }}
                      style={comboRowStyle(isFocused)}
                    >
                      <i
                        className={it.iconClass || 'ti ti-terminal-2'}
                        style={{fontSize: '13px', flexShrink: 0, ...(it.iconStyle || {})}}
                        aria-hidden="true"
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: '11px',
                          color: 'var(--text-primary)',
                          fontFamily: 'var(--font-sans)'
                        }}
                      >
                        {it.label}
                      </span>
                      {it.onEdit && (
                        <i
                          className="ti ti-settings"
                          title="Edit"
                          onMouseDown={(ev) => {
                            if (ev.button !== 0) return;
                            // Open the edit modal, not the row's launch.
                            ev.preventDefault();
                            ev.stopPropagation();
                            this.close();
                            it.onEdit!();
                          }}
                          style={{fontSize: '13px', color: 'var(--text-tertiary)', flexShrink: 0, cursor: 'pointer'}}
                          aria-hidden="true"
                        />
                      )}
                      {it.onConfigure && (
                        <i
                          className="ti ti-settings"
                          title="Configure"
                          onMouseDown={(ev) => {
                            if (ev.button !== 0) return;
                            // Fire the config action, not the row's launch.
                            ev.preventDefault();
                            ev.stopPropagation();
                            this.close();
                            it.onConfigure!();
                          }}
                          style={{fontSize: '13px', color: 'var(--text-tertiary)', flexShrink: 0, cursor: 'pointer'}}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------

export interface NewPanePickerProps {
  profiles?: any[];
  defaultProfile?: string;
  groupUid: string;
  uid: string;
  sessionCwd?: string;
  cwd?: string;
  setWebPaneUrl?: (groupUid: string, url: string) => void;

  // Picker state (owned by Term).
  urlInput?: string;
  urlError?: string;
  pickerZoom: number;
  isGlimmerActive?: boolean;

  // Gate for the W/S/A pane hotkeys — true only while this pane is the active
  // session and nothing (e.g. the custom-profile modal) covers the picker.
  hotkeysEnabled?: boolean;

  // Callbacks into Term.
  onUrlChange: (value: string) => void;
  onSubmitUrl: (url?: string) => void;
  onTriggerGlimmer: () => void;
  onOpenCustomModal: (kind: 'shell' | 'agent') => void;
  // Open the custom-profile modal pre-filled to EDIT an existing profile.
  onEditProfile: (kind: 'shell' | 'agent', profile: any) => void;
}

interface NewPanePickerState {
  // Remembered defaults (what the S / A hotkeys launch, and what the combo-
  // boxes pre-fill). Seeded from localStorage and re-persisted on every
  // explicit selection, so they survive across sessions.
  lastUsedShell?: string;
  lastUsedAgent?: string;
  // Running Hyperia version (sidecar /api/status) and the latest published
  // one (hyperia.nuts.services/version) — drives the footer's update row.
  currentVersion?: string;
  latestVersion?: string;
  // 'install' swaps the picker content for the agent install-instructions view.
  view?: 'main' | 'install';
  // Which install command was just copied (flash feedback).
  copiedInstall?: string;
  // Whether the Hyperia agent is configured (provider+model+key) — adds it to
  // the agent pulldown. Fetched from the sidecar on mount.
  hyperiaConfigured?: boolean;
}

// The "New Webpane" chooser shown when a pane has the synthetic `picker`
// profile. Top→bottom: title, URL entry, a New Shell combobox, a New Agent
// combobox. No dividers between sections.
export class NewPanePicker extends React.Component<NewPanePickerProps, NewPanePickerState> {
  state: NewPanePickerState = {
    lastUsedShell: readStoredDefault(LS_DEFAULT_SHELL),
    lastUsedAgent: readStoredDefault(LS_DEFAULT_AGENT)
  };

  // The picker's own focusable root. We pull keyboard focus here on mount so the
  // W/S/A hotkeys fire immediately — otherwise focus sits on the previous pane's
  // (or this pane's hidden) xterm <textarea>, and handleHotkey's typing-guard
  // swallows the letters until you click the pane.
  private rootRef = React.createRef<HTMLDivElement>();
  private focusTimer: ReturnType<typeof setTimeout> | undefined;

  componentDidMount() {
    // Is the Hyperia agent configured? (provider+model+key in config.agent.*)
    const port = process.env.HYPERIA_PORT || '9800';
    fetch(`http://localhost:${port}/api/agent/config`)
      .then((r) => r.json())
      .then((j) => this.setState({hyperiaConfigured: !!j?.configured}))
      .catch(() => {});

    // Footer: the running version (sidecar) and the latest published one.
    fetch(`http://localhost:${port}/api/status`)
      .then((r) => r.json())
      .then((j) => {
        if (j?.version) this.setState({currentVersion: String(j.version)});
      })
      .catch(() => {});
    // The endpoint may return plain text ("0.15.11") or JSON ({version: …}).
    fetch('https://hyperia.nuts.services/version')
      .then((r) => r.text())
      .then((t) => {
        let v = t.trim();
        try {
          const j = JSON.parse(v);
          if (j && typeof j === 'object' && j.version) v = String(j.version).trim();
        } catch {
          /* plain text */
        }
        // Accept ONLY a strict version string — the endpoint may not exist
        // yet and can return an HTML error page / arbitrary file content,
        // which previously rendered as garbage in the footer.
        if (/^v?\d+\.\d+(\.\d+)?$/.test(v)) this.setState({latestVersion: v});
      })
      .catch(() => {});

    // W/S/A quick-launch hotkeys — window-level; gated on this pane being the
    // active session (hotkeysEnabled) and on focus not being in a text field.
    window.addEventListener('keydown', this.handleHotkey);

    // Take focus onto the picker root so the hotkeys work without a click first.
    // Deferred so it lands after Term's mount-time focus pass; skipped if the
    // user is already typing in one of the picker's own inputs (URL / combo box).
    this.focusTimer = setTimeout(() => {
      const el = this.rootRef.current;
      if (!el) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== el && el.contains(active)) return; // user is in a field
      el.focus({preventScroll: true});
    }, 70);
  }

  componentDidUpdate(prevProps: NewPanePickerProps) {
    // Saving a custom profile reloads the config, which pushes a new `profiles`
    // list here. saveCustomProfile has already written the remembered-default
    // localStorage key, so re-seed lastUsedShell/Agent from it — that makes the
    // just-saved profile what the S / A quick-key launches.
    if (prevProps.profiles !== this.props.profiles) {
      const shell = readStoredDefault(LS_DEFAULT_SHELL);
      const agent = readStoredDefault(LS_DEFAULT_AGENT);
      this.setState((s) => ({
        lastUsedShell: shell || s.lastUsedShell,
        lastUsedAgent: agent || s.lastUsedAgent
      }));
    }
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this.handleHotkey);
    if (this.focusTimer) clearTimeout(this.focusTimer);
  }

  // W/S/A quick paths. Only in the main view (the hints live on its section
  // labels), never while typing in an input, and never with modifiers held.
  private handleHotkey = (e: KeyboardEvent) => {
    if (!this.props.hotkeysEnabled) return;
    if ((this.state.view || 'main') !== 'main') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    const key = e.key.toLowerCase();
    if (key === 'w') {
      e.preventDefault();
      e.stopPropagation();
      this.openGuidePane();
    } else if (key === 's') {
      e.preventDefault();
      e.stopPropagation();
      this.launchDefaultShell();
    } else if (key === 'a') {
      e.preventDefault();
      e.stopPropagation();
      this.launchDefaultAgent();
    }
  };

  // W: swap THIS picker pane into a web pane on the sidecar-served guide —
  // the same exit + setWebPaneUrl pattern the URL box and agent config use.
  private openGuidePane = () => {
    const {groupUid, uid, setWebPaneUrl} = this.props;
    if (!setWebPaneUrl || !groupUid) return;
    const port = process.env.HYPERIA_PORT || '9800';
    rpc.emit('exit', {uid});
    setWebPaneUrl(groupUid, `http://localhost:${port}/guide`);
  };

  // S: the remembered default shell; falls back to the same resolution the
  // combobox displays (configured defaultProfile, then the first shell).
  private launchDefaultShell = () => {
    const item = this.resolveDefaultShell(this.buildShellItems());
    item?.onSelect();
  };

  // A: the remembered default agent; with nothing remembered (or the agent
  // gone), the Hyperia Agent path is the fallback.
  private launchDefaultAgent = () => {
    const items = this.buildAgentItems();
    const remembered = this.state.lastUsedAgent && items.find((i) => i.key === this.state.lastUsedAgent);
    if (remembered) remembered.onSelect();
    else this.launchHyperiaShell();
  };

  // Open the Hyperia Agent configuration pane (sidecar-served) in this pane.
  private openAgentConfig = () => {
    const {groupUid, uid, setWebPaneUrl} = this.props;
    if (!setWebPaneUrl || !groupUid) return;
    const port = process.env.HYPERIA_PORT || '9800';
    rpc.emit('exit', {uid});
    setWebPaneUrl(groupUid, `http://localhost:${port}/agent/config`);
  };

  private newWithProfile = (profile: string) => {
    const {groupUid, uid, sessionCwd, cwd} = this.props;
    rpc.emit('new', {
      isNewGroup: false,
      cwd: sessionCwd || cwd,
      activeUid: uid,
      profile,
      groupUid
    });
  };

  private launchShell = (name: string) => {
    this.setState({lastUsedShell: name});
    writeStoredDefault(LS_DEFAULT_SHELL, name);
    this.newWithProfile(name);
  };

  private launchAgent = (name: string) => {
    this.setState({lastUsedAgent: name});
    writeStoredDefault(LS_DEFAULT_AGENT, name);
    this.newWithProfile(name);
  };

  // Hyperia Agent always gets its OWN tab (labeled "Hyperia Agent"; focuses
  // the existing one if open) — routed through the shared 'open web pane req'
  // handler in lib/index.tsx. The picker pane closes itself. Remembered under
  // the agent item's key ('Hyperia') so the A hotkey resolves back to it.
  private launchHyperiaShell = () => {
    const {uid} = this.props;
    const port = process.env.HYPERIA_PORT || '9800';
    const shellUrl = `http://localhost:${port}/shell`;
    this.setState({lastUsedAgent: 'Hyperia'});
    writeStoredDefault(LS_DEFAULT_AGENT, 'Hyperia');
    rpc.emitter.emit('open web pane req', {url: shellUrl});
    rpc.emit('exit', {uid});
  };

  // "Open in shell" from the install view: open the default shell in this pane
  // with the install command TYPED at the prompt but NOT submitted — the user
  // reviews it and presses Enter themselves.
  private openInstallShell = (command: string) => {
    const {groupUid, uid, sessionCwd, cwd} = this.props;
    rpc.emit('new', {
      isNewGroup: false,
      cwd: sessionCwd || cwd,
      activeUid: uid,
      groupUid,
      prefillCommand: command
    } as any);
  };

  private copyInstall = (command: string) => {
    try {
      void navigator.clipboard.writeText(command);
    } catch {
      /* clipboard unavailable */
    }
    this.setState({copiedInstall: command});
    setTimeout(() => {
      if (this.state.copiedInstall === command) this.setState({copiedInstall: undefined});
    }, 1200);
  };

  // The install-instructions view: every harness in the catalog with its
  // platform install command. Nothing auto-runs.
  private renderInstallView() {
    const {profiles, pickerZoom} = this.props;
    const profileList: any[] = profiles || [];
    const installedNames = new Set(profileList.map((p: any) => String(p.name).toLowerCase()));

    return (
      <div className="term_pickerContainer" style={{zoom: pickerZoom, overflowY: 'auto'}}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: 'var(--space-10) 0',
            gap: 'var(--space-8)',
            width: '100%',
            flexShrink: 0
          }}
        >
          <div style={{...pickerRowStyle, alignItems: 'center'}}>
            <span
              onClick={() => this.setState({view: 'main'})}
              style={{
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                fontSize: '11px',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-sans)'
              }}
            >
              <i className="ti ti-arrow-left" style={{fontSize: '13px'}} aria-hidden="true" />
              Back
            </span>
            <div
              style={{
                flex: 1,
                textAlign: 'center',
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-sans)'
              }}
            >
              Install an Agent
            </div>
            {/* spacer to balance the back button */}
            <span style={{width: '48px'}} />
          </div>

          {INSTALL_CATALOG.map((entry) => {
            const {icon, style} = agentIconClass(entry.name);
            const installed = installedNames.has(entry.name.toLowerCase());
            const command = isWindows ? entry.win : entry.unix;
            // On Windows a unix-only installer is shown as reference text (run
            // it in WSL) — no "open in shell" for a command pwsh can't run.
            const referenceOnly = !command && !!entry.unix;
            const shown = command || entry.unix;
            const copied = this.state.copiedInstall === shown;
            return (
              <div
                key={entry.name}
                style={{
                  ...pickerRowStyle,
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: 'var(--space-4)',
                  padding: 'var(--space-6) 0'
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 'var(--space-8)'}}>
                  <i className={icon} style={{fontSize: '14px', flexShrink: 0, ...(style || {})}} aria-hidden="true" />
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-sans)'
                    }}
                  >
                    {entry.name}
                  </span>
                  {installed && (
                    <span style={{fontSize: '10px', color: 'var(--success-text, #3fb950)', fontFamily: 'var(--font-sans)'}}>
                      ✓ installed
                    </span>
                  )}
                  <span style={{flex: 1}} />
                  {entry.configure && (
                    <span
                      onClick={() => this.openAgentConfig()}
                      title="Configure the Hyperia agent"
                      style={{...pickerEnterBadgeStyle, cursor: 'pointer', color: 'var(--info-text)'}}
                    >
                      configure
                    </span>
                  )}
                  {(command || referenceOnly) && (
                    <span
                      onClick={() => shown && this.copyInstall(shown)}
                      title="Copy command"
                      style={{...pickerEnterBadgeStyle, cursor: 'pointer'}}
                    >
                      {copied ? 'copied ✓' : 'copy'}
                    </span>
                  )}
                  {command && (
                    <span
                      onClick={() => this.openInstallShell(command)}
                      title="Open a shell with this command typed — press Enter yourself"
                      style={{...pickerEnterBadgeStyle, cursor: 'pointer', color: 'var(--info-text)'}}
                    >
                      open in shell
                    </span>
                  )}
                </div>
                {shown && (
                  <div
                    style={{
                      background: 'var(--bg-primary)',
                      border: '0.5px solid var(--border-neutral)',
                      borderRadius: 'var(--radius-6)',
                      padding: 'var(--space-6) var(--space-10)',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-primary)',
                      overflowX: 'auto',
                      whiteSpace: 'nowrap',
                      userSelect: 'text'
                    }}
                  >
                    {shown}
                  </div>
                )}
                {entry.note && (
                  <div style={{fontSize: '10.5px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)'}}>
                    {entry.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>
    );
  }

  // --- Shell items (everything that isn't an agent, platform-filtered) ---
  // Shared by render() and the S hotkey.
  private buildShellItems(): ComboItem[] {
    const profileList: any[] = this.props.profiles || [];
    const shellProfiles = profileList
      .filter((p: any) => {
        const n = p.name.toLowerCase();
        if (AGENT_NAMES.has(n) || p.kind === 'agent') return false;
        return profileFitsPlatform(p);
      })
      // Stock (system-detected) shells first, user-added custom shells after.
      .sort((a: any, b: any) => (a.kind ? 1 : 0) - (b.kind ? 1 : 0));

    return shellProfiles.map((p: any) => {
      const displayName = capitalize(p.name);
      return {
        key: p.name,
        label: displayName,
        iconClass: shellIconClass(p.name),
        onSelect: () => this.launchShell(p.name),
        // Custom shells get a gear → edit modal (Delete lives inside it).
        onEdit: p.kind ? () => this.props.onEditProfile('shell', p) : undefined
      };
    });
  }

  // Default shell: configured defaultProfile → remembered last-used → first
  // shell. The CONFIGURED default wins over the last-used shell — setting a
  // default profile (e.g. PowerShell 7) must stick, so merely having last
  // launched another profile (e.g. an SSH-into-a-box shell) can't quietly
  // become what a new pane opens. Last-used is only a fallback when no valid
  // default is configured.
  private resolveDefaultShell(shellItems: ComboItem[]): ComboItem | undefined {
    const {defaultProfile} = this.props;
    return (
      (defaultProfile && shellItems.find((i) => i.key === defaultProfile)) ||
      (this.state.lastUsedShell && shellItems.find((i) => i.key === this.state.lastUsedShell)) ||
      shellItems[0]
    );
  }

  // --- Agent items — detection-driven (app/config/detect.ts catalog) ---
  // INSTALLED harnesses arrive as profiles named exactly per AGENT_NAMES
  // (Nemesis8 installed also brings "Nemesis8 Danger" = `nemesis8 --danger`).
  // Missing ones are NOT listed — the "install an agent" row opens the
  // instruction view instead. Shared by render() and the A hotkey.
  private buildAgentItems(): ComboItem[] {
    const profileList: any[] = this.props.profiles || [];
    const agentItems: ComboItem[] = [];
    for (const p of profileList) {
      const n = p.name.toLowerCase();
      if (!AGENT_NAMES.has(n)) continue;
      const {icon, style} = agentIconClass(p.name);
      agentItems.push({
        key: p.name,
        label: p.name,
        iconClass: icon,
        iconStyle: style,
        onSelect: () => this.launchAgent(p.name)
      });
    }
    // Hyperia's own agent — only once CONFIGURED (provider+model+key via the
    // config pane). Launches the agent shell; reconfigure via the install view.
    if (this.state.hyperiaConfigured) {
      agentItems.push({
        key: 'Hyperia',
        label: 'Hyperia',
        iconClass: 'ti ti-ghost',
        iconStyle: {color: 'var(--info-text)'},
        onSelect: () => this.launchHyperiaShell(),
        onConfigure: () => this.openAgentConfig()
      });
    }
    // Hyperia (when configured) then both Nemesis8 entries lead the list;
    // everything else keeps detect order.
    const agentRank = (label: string): number => {
      const n = label.toLowerCase();
      if (n === 'hyperia') return 0;
      if (n === 'nemesis8') return 1;
      if (n === 'nemesis8 danger') return 2;
      return 3;
    };
    agentItems.sort((a, b) => agentRank(a.label) - agentRank(b.label));
    // NOTE: the Hyperia agent is intentionally NOT a launchable entry — it isn't
    // "installed" yet. It lives in the install view with a configure flow
    // (launchHyperiaShell kept for that flow to reuse).
    // Custom agents the user saved (kind 'agent').
    for (const p of profileList.filter((p: any) => p.kind === 'agent' && profileFitsPlatform(p))) {
      agentItems.push({
        key: p.name,
        label: p.name,
        iconClass: 'ti ti-robot',
        onSelect: () => this.launchAgent(p.name),
        onEdit: () => this.props.onEditProfile('agent', p)
      });
    }
    return agentItems;
  }

  render() {
    const {urlInput, urlError, pickerZoom, isGlimmerActive} = this.props;

    const shellItems = this.buildShellItems();
    const defaultShellItem = this.resolveDefaultShell(shellItems);
    const shellDefaultText = defaultShellItem ? defaultShellItem.label : '';

    const agentItems = this.buildAgentItems();
    const rememberedAgentItem =
      this.state.lastUsedAgent && agentItems.find((i) => i.key === this.state.lastUsedAgent);
    const defaultAgentItem = rememberedAgentItem || agentItems[0];
    const agentDefaultText = defaultAgentItem ? defaultAgentItem.label : '';

    // Footer version status. "Up to date" only when BOTH versions resolved and
    // match — an unreachable check leaves the run button enabled.
    const {currentVersion, latestVersion} = this.state;
    const upToDate =
      !!currentVersion && !!latestVersion && normalizeVersion(currentVersion) === normalizeVersion(latestVersion);
    const updateCopied = this.state.copiedInstall === UPDATE_COMMAND;

    if (this.state.view === 'install') {
      return this.renderInstallView();
    }

    return (
      <div
        ref={this.rootRef}
        // Focusable (but not tab-stop) so the picker can hold keyboard focus for
        // its W/S/A hotkeys without a visible focus ring.
        tabIndex={-1}
        className="term_pickerContainer"
        // Content pinned to the TOP (no vertical centering) and the whole pane
        // scrolls when it's too short to show everything.
        style={{zoom: pickerZoom, overflowY: 'auto', outline: 'none'}}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          this.props.onTriggerGlimmer();
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: 'var(--space-10) 0',
            gap: 'var(--space-10)',
            width: '100%',
            flexShrink: 0
          }}
        >
          <div
            style={{
              fontSize: '14px',
              fontWeight: 700,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              letterSpacing: '0.2px',
              marginBottom: 'var(--space-2)'
            }}
          >
            Webpanes, Shells and Agents. Pick one.
          </div>

          {/* New Webpane row — "New Webpane" label left of the URL box, same
              width/shape as the shell + agent rows below it. */}
          <div style={pickerRowStyle}>
            <div style={{...pickerLabelStyle, display: 'flex', alignItems: 'center', gap: 'var(--space-4)'}} title="Press W — open the Hyperia guide">
              <span>New Webpane</span>
            </div>
            <div style={{flex: 1, minWidth: 0, maxWidth: PICKER_BOX_MAX}}>
              <UrlPicker
                value={urlInput || ''}
                onChange={(v) => this.props.onUrlChange(v)}
                onNavigate={(url) => this.props.onSubmitUrl(url)}
              />
              {urlError && (
                <div
                  style={{
                    fontSize: '11px',
                    color: '#ff3b30',
                    marginTop: 'var(--space-4)',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans)'
                  }}
                >
                  {urlError}
                </div>
              )}
            </div>
          </div>

          {/* New Shell combobox. */}
          <InlineCombobox
            label="New Shell"
            leadingIcon="ti ti-terminal-2"
            items={shellItems}
            defaultText={shellDefaultText}
            placeholder="Type to filter shells…"
            addLabel="add a shell"
            createLabel="create new shell"
            onAdd={() => this.props.onOpenCustomModal('shell')}
            isGlimmerActive={isGlimmerActive}
            keyHint="S"
            keyHintTitle={`Press S — launch ${shellDefaultText || 'the default shell'}`}
          />

          {/* New Agent combobox. "install an agent" opens the instruction view
              (install commands shown, never auto-run) — NOT the custom-profile
              modal, which stays a shell-only affordance. */}
          <InlineCombobox
            label="New Agent"
            leadingIcon="ti ti-robot"
            items={agentItems}
            defaultText={agentDefaultText}
            placeholder="Type to filter agents…"
            addLabel="install an agent"
            createLabel="install an agent:"
            onAdd={() => this.setState({view: 'install'})}
            isGlimmerActive={isGlimmerActive}
            keyHint="A"
            keyHintTitle={`Press A — launch ${
              rememberedAgentItem ? rememberedAgentItem.label : 'the Hyperia Agent'
            }`}
          />

          {/* Footer — running version + self-update command. Like the install
              view, [run] opens a shell with the command TYPED but not
              submitted; nothing here auto-runs. */}
          <div
            style={{
              ...pickerRowStyle,
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 'var(--space-4)',
              marginTop: 'var(--space-10)'
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 'var(--space-8)'}}>
              <span style={{fontSize: '10.5px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)'}}>
                {currentVersion ? `Hyperia v${normalizeVersion(currentVersion)}` : 'Hyperia'}
              </span>
              {upToDate ? (
                <span
                  style={{fontSize: '10px', color: 'var(--success-text, #3fb950)', fontFamily: 'var(--font-sans)'}}
                >
                  ✓ up to date
                </span>
              ) : latestVersion ? (
                <span style={{fontSize: '10px', color: 'var(--info-text)', fontFamily: 'var(--font-sans)'}}>
                  v{normalizeVersion(latestVersion)} available
                </span>
              ) : null}
              <span style={{flex: 1}} />
              <span
                onClick={() => this.copyInstall(UPDATE_COMMAND)}
                title="Copy the update command"
                style={{...pickerEnterBadgeStyle, cursor: 'pointer'}}
              >
                {updateCopied ? 'copied ✓' : 'copy'}
              </span>
              {upToDate ? (
                <span
                  title="Already up to date"
                  style={{...pickerEnterBadgeStyle, cursor: 'default', opacity: 0.45}}
                >
                  run
                </span>
              ) : (
                <span
                  onClick={() => this.openInstallShell(UPDATE_COMMAND)}
                  title="Open a shell with the update command typed — press Enter yourself"
                  style={{...pickerEnterBadgeStyle, cursor: 'pointer', color: 'var(--info-text)'}}
                >
                  run
                </span>
              )}
            </div>
            <div
              style={{
                background: 'var(--bg-primary)',
                border: '0.5px solid var(--border-neutral)',
                borderRadius: 'var(--radius-6)',
                padding: 'var(--space-6) var(--space-10)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)',
                overflowX: 'auto',
                whiteSpace: 'nowrap',
                userSelect: 'text'
              }}
            >
              {UPDATE_COMMAND}
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default NewPanePicker;
