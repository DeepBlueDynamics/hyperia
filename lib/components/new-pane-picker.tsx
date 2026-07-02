import {ipcRenderer} from 'electron';
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
  const looksWindows = /\.exe$|\\|^[A-Za-z]:/.test(shell);
  return isWindows ? looksWindows : !looksWindows;
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
  // Custom (user-saved) profiles get a right-click-to-delete affordance.
  onDelete?: () => void;
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
// look: a fixed-width left label, then a flex box capped at the same maxWidth.
const PICKER_ROW_MAX = '430px';
const PICKER_BOX_MAX = '340px';
const pickerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-10)',
  width: '100%',
  maxWidth: PICKER_ROW_MAX
};
const pickerLabelStyle: React.CSSProperties = {
  width: '80px',
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
    const {label, leadingIcon, addLabel, createLabel, placeholder} = this.props;
    const rows = this.rows();
    const {text, open, focusedIndex} = this.state;

    return (
      <div style={pickerRowStyle}>
        <div style={pickerLabelStyle}>{label}</div>

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
              enter
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
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        this.commitRow(row);
                      }}
                      onMouseEnter={() => this.setState({focusedIndex: i})}
                      onContextMenu={
                        it.onDelete
                          ? (ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              it.onDelete!();
                            }
                          : undefined
                      }
                      title={it.onDelete ? `${it.label} — right-click to delete` : undefined}
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

  // Callbacks into Term.
  onUrlChange: (value: string) => void;
  onSubmitUrl: (url?: string) => void;
  onTriggerGlimmer: () => void;
  onOpenCustomModal: (kind: 'shell' | 'agent') => void;
}

interface NewPanePickerState {
  // Session-local "last used" so the combobox pre-fills the last choice. Not
  // persisted across sessions.
  lastUsedShell?: string;
  lastUsedAgent?: string;
  // 'install' swaps the picker content for the agent install-instructions view.
  view?: 'main' | 'install';
  // Which install command was just copied (flash feedback).
  copiedInstall?: string;
  // Configure-Hyperia-agent modal (placeholder — full config flow TBD).
  configureHyperiaOpen?: boolean;
}

// The "New Webpane" chooser shown when a pane has the synthetic `picker`
// profile. Top→bottom: title, URL entry, a New Shell combobox, a New Agent
// combobox. No dividers between sections.
export class NewPanePicker extends React.Component<NewPanePickerProps, NewPanePickerState> {
  state: NewPanePickerState = {};

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
    this.newWithProfile(name);
  };

  private launchAgent = (name: string) => {
    this.setState({lastUsedAgent: name});
    this.newWithProfile(name);
  };

  // Hyperia Shell isn't a profile launch — it swaps the pane for a web pane
  // pointed at the local shell UI. Preserved verbatim from the old button.
  private launchHyperiaShell = () => {
    const {groupUid, uid, setWebPaneUrl} = this.props;
    if (!setWebPaneUrl || !groupUid) return;
    const port = process.env.HYPERIA_PORT || '9800';
    const shellUrl = `http://localhost:${port}/shell`;
    this.setState({lastUsedAgent: 'Hyperia Shell'});
    rpc.emit('exit', {uid});
    setWebPaneUrl(groupUid, shellUrl);
  };

  private confirmDelete = (type: 'shell' | 'agent', name: string, displayName: string) => {
    void (async () => {
      const confirmed = await ipcRenderer.invoke('confirm-remove-profile', {type, displayName});
      if (confirmed) ipcRenderer.send('remove-profile', name);
    })();
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
                      onClick={() => this.setState({configureHyperiaOpen: true})}
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

        {/* Configure-Hyperia modal — placeholder shell; the real config flow
            (identity, model, permissions) lands with its own spec. */}
        {this.state.configureHyperiaOpen && (
          <div
            onClick={() => this.setState({configureHyperiaOpen: false})}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 30,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.45)'
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(360px, calc(100% - 32px))',
                background: 'var(--bg-elevated, var(--bg-secondary, #1c1c22))',
                border: '0.5px solid var(--border-neutral)',
                borderRadius: 'var(--radius-6)',
                padding: 'var(--space-12, 14px)',
                boxShadow: '0 10px 24px rgba(0,0,0,0.45)',
                fontFamily: 'var(--font-sans)'
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 'var(--space-8)', marginBottom: 'var(--space-8)'}}>
                <i className="ti ti-ghost" style={{fontSize: '15px', color: 'var(--info-text)'}} aria-hidden="true" />
                <span style={{fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)'}}>
                  Configure Hyperia Agent
                </span>
              </div>
              <div style={{fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: 'var(--space-10)'}}>
                Configuration options for the built-in Hyperia agent are coming here.
              </div>
              <div style={{display: 'flex', justifyContent: 'flex-end'}}>
                <span
                  onClick={() => this.setState({configureHyperiaOpen: false})}
                  style={{...pickerEnterBadgeStyle, cursor: 'pointer'}}
                >
                  close
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  render() {
    const {profiles, defaultProfile, urlInput, urlError, pickerZoom, isGlimmerActive} = this.props;
    const profileList: any[] = profiles || [];

    // --- Shell items (everything that isn't an agent, platform-filtered) ---
    const shellProfiles = profileList
      .filter((p: any) => {
        const n = p.name.toLowerCase();
        if (AGENT_NAMES.has(n) || p.kind === 'agent') return false;
        return profileFitsPlatform(p);
      })
      // Stock (system-detected) shells first, user-added custom shells after.
      .sort((a: any, b: any) => (a.kind ? 1 : 0) - (b.kind ? 1 : 0));

    const shellItems: ComboItem[] = shellProfiles.map((p: any) => {
      const displayName = capitalize(p.name);
      return {
        key: p.name,
        label: displayName,
        iconClass: shellIconClass(p.name),
        onSelect: () => this.launchShell(p.name),
        onDelete: p.kind ? () => this.confirmDelete('shell', p.name, displayName) : undefined
      };
    });

    // Default text: last used → configured defaultProfile (if it's a shell) →
    // first shell.
    const defaultShellItem =
      (this.state.lastUsedShell && shellItems.find((i) => i.key === this.state.lastUsedShell)) ||
      (defaultProfile && shellItems.find((i) => i.key === defaultProfile)) ||
      shellItems[0];
    const shellDefaultText = defaultShellItem ? defaultShellItem.label : '';

    // --- Agent items — detection-driven (app/config/detect.ts catalog) ---
    // INSTALLED harnesses arrive as profiles named exactly per AGENT_NAMES
    // (Nemesis8 installed also brings "Nemesis8 Danger" = `nemesis8 --danger`).
    // Missing ones are NOT listed — the "install an agent" row opens the
    // instruction view instead.
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
    // Nemesis8 (both entries) leads the list; everything else keeps detect order.
    const agentRank = (label: string): number => {
      const n = label.toLowerCase();
      if (n === 'nemesis8') return 0;
      if (n === 'nemesis8 danger') return 1;
      return 2;
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
        onDelete: () => this.confirmDelete('agent', p.name, p.name)
      });
    }

    const defaultAgentItem =
      (this.state.lastUsedAgent && agentItems.find((i) => i.key === this.state.lastUsedAgent)) || agentItems[0];
    const agentDefaultText = defaultAgentItem ? defaultAgentItem.label : '';

    if (this.state.view === 'install') {
      return this.renderInstallView();
    }

    return (
      <div
        className="term_pickerContainer"
        // Content pinned to the TOP (no vertical centering) and the whole pane
        // scrolls when it's too short to show everything.
        style={{zoom: pickerZoom, overflowY: 'auto'}}
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
            <div style={pickerLabelStyle}>New Webpane</div>
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
          />
        </div>
      </div>
    );
  }
}

export default NewPanePicker;
