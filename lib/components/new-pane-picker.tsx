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

export interface NewPanePickerProps {
  profiles?: any[];
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

// The "New Pane" chooser shown when a pane has the synthetic `picker` profile.
// Extracted verbatim from term.tsx; behavior-identical except: the URL input now
// sits at the TOP (right under the title) and there's a dedicated Antigravity
// agent button. All classNames/styles map to the global CSS in term.tsx.
export class NewPanePicker extends React.PureComponent<NewPanePickerProps> {
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

  render() {
    const {profiles, groupUid, uid, urlInput, urlError, pickerZoom, isGlimmerActive, setWebPaneUrl} = this.props;
    const profileList: any[] = profiles || [];
    const hasAntigravity = profileList.some((p: any) => p.name.toLowerCase() === 'antigravity');

    return (
      <div
        className="term_pickerContainer"
        style={{zoom: pickerZoom}}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          this.props.onTriggerGlimmer();
        }}
      >
        <div
          style={{
            margin: 'auto 0',
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
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)'
            }}
          >
            New Pane
          </div>

          {/* URL input — moved to the TOP, right under the title. */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              maxWidth: '340px'
            }}
          >
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

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-10)',
              width: '100%',
              maxWidth: '560px'
            }}
          >
            <div
              style={{
                flex: 1,
                height: '0.5px',
                background: 'var(--border-neutral)'
              }}
            />
            <div
              style={{
                fontSize: '11px',
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-sans)'
              }}
            >
              pick a shell
            </div>
            <div
              style={{
                flex: 1,
                height: '0.5px',
                background: 'var(--border-neutral)'
              }}
            />
          </div>

          <div className="term_pickerGrid_rev">
            {profileList
              .filter((p: any) => {
                const n = p.name.toLowerCase();
                // Agents live under "pick an agent", not the shell grid:
                // built-in agent names + any custom profile saved as kind 'agent'.
                // Antigravity gets its own dedicated agent button below.
                if (n === 'claude code' || n === 'nemesis8' || n === 'antigravity' || p.kind === 'agent')
                  return false;
                // Don't show shells that belong to another OS (synced config).
                return profileFitsPlatform(p);
              })
              // Stock (system-detected, no `kind`) shells first; user-added
              // custom shells (kind:'shell') after. Stable, so each group
              // keeps its own order.
              .sort((a: any, b: any) => (a.kind ? 1 : 0) - (b.kind ? 1 : 0))
              .map((p: any) => {
                const profileNameLower = p.name.toLowerCase();
                let iconClass = 'ti ti-terminal-2';
                if (profileNameLower.includes('powershell') || profileNameLower.includes('pwsh'))
                  iconClass = 'ti ti-terminal-2';
                else if (
                  profileNameLower.includes('wsl') ||
                  profileNameLower.includes('ubuntu') ||
                  profileNameLower.includes('debian')
                )
                  iconClass = 'ti ti-brand-debian';
                else if (profileNameLower.includes('bash') || profileNameLower.includes('git'))
                  iconClass = 'ti ti-brand-git';
                else if (profileNameLower.includes('cmd') || profileNameLower.includes('command'))
                  iconClass = 'ti ti-terminal';
                else if (profileNameLower.includes('azure') || profileNameLower.includes('cloud'))
                  iconClass = 'ti ti-cloud';

                const displayName = p.name.charAt(0).toUpperCase() + p.name.slice(1);

                return (
                  <button
                    key={p.name}
                    className={'term_pickerButton_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
                    title={p.kind ? `${displayName} — right-click to delete` : undefined}
                    onClick={() => this.newWithProfile(p.name)}
                    onContextMenu={
                      p.kind
                        ? (e) => {
                            // Custom shells only: right-click to delete.
                            e.preventDefault();
                            void (async () => {
                              const confirmed = await ipcRenderer.invoke('confirm-remove-profile', {
                                type: 'shell',
                                displayName
                              });
                              if (confirmed) {
                                ipcRenderer.send('remove-profile', p.name);
                              }
                            })();
                          }
                        : undefined
                    }
                  >
                    <i className={iconClass} style={{fontSize: '14px'}} aria-hidden="true" />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {displayName}
                    </span>
                  </button>
                );
              })}
            <button
              className={'term_pickerButton_rev term_pickerButton_custom_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
              onClick={() => this.props.onOpenCustomModal('shell')}
            >
              <i className="ti ti-plus" style={{fontSize: '14px'}} aria-hidden="true" />
              <span>Custom…</span>
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-10)',
              width: '100%',
              maxWidth: '560px',
              marginTop: 'var(--space-4)'
            }}
          >
            <div
              style={{
                flex: 1,
                height: '0.5px',
                background: 'var(--border-neutral)'
              }}
            />
            <div
              style={{
                fontSize: '11px',
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-sans)'
              }}
            >
              or pick an agent
            </div>
            <div
              style={{
                flex: 1,
                height: '0.5px',
                background: 'var(--border-neutral)'
              }}
            />
          </div>

          <div className="term_pickerGrid_rev">
            <button
              className={'term_pickerButton_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
              onClick={() => this.newWithProfile('Claude Code')}
            >
              <i className="ti ti-sparkles" style={{fontSize: '14px', color: 'var(--info-text)'}} aria-hidden="true" />
              <span>Claude Code</span>
            </button>
            {hasAntigravity && (
              <button
                className={'term_pickerButton_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
                onClick={() => this.newWithProfile('Antigravity')}
              >
                <i
                  className="ti ti-rocket"
                  style={{fontSize: '14px', color: 'var(--info-text)'}}
                  aria-hidden="true"
                />
                <span>Antigravity</span>
              </button>
            )}
            {profileList.some((p: any) => p.name.toLowerCase() === 'nemesis8') && (
              <button
                className={'term_pickerButton_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
                onClick={() => {
                  // Starts in the picked directory, then runs `n8` — its launcher
                  // comes up and the user picks the agent there.
                  this.newWithProfile('Nemesis8');
                }}
              >
                <i className="ti ti-robot" style={{fontSize: '14px', color: 'var(--danger-text)'}} aria-hidden="true" />
                <span>Nemesis8</span>
              </button>
            )}
            <button
              className={'term_pickerButton_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
              onClick={() => {
                const port = process.env.HYPERIA_PORT || '9800';
                const shellUrl = `http://localhost:${port}/shell`;
                if (setWebPaneUrl && groupUid) {
                  rpc.emit('exit', {uid});
                  setWebPaneUrl(groupUid, shellUrl);
                }
              }}
            >
              <i className="ti ti-robot" style={{fontSize: '14px'}} aria-hidden="true" />
              <span>Hyperia Shell</span>
            </button>
            {/* Custom agents the user saved (kind 'agent') */}
            {profileList
              .filter((p: any) => p.kind === 'agent' && profileFitsPlatform(p))
              .map((p: any) => (
                <button
                  key={p.name}
                  className={'term_pickerButton_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
                  title={`${p.name} — right-click to delete`}
                  onClick={() => this.newWithProfile(p.name)}
                  onContextMenu={(e) => {
                    // Custom agents: right-click to delete.
                    e.preventDefault();
                    void (async () => {
                      const confirmed = await ipcRenderer.invoke('confirm-remove-profile', {
                        type: 'agent',
                        displayName: p.name
                      });
                      if (confirmed) {
                        ipcRenderer.send('remove-profile', p.name);
                      }
                    })();
                  }}
                >
                  <i className="ti ti-robot" style={{fontSize: '14px'}} aria-hidden="true" />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {p.name}
                  </span>
                </button>
              ))}
            <button
              className={'term_pickerButton_rev term_pickerButton_custom_rev ' + (isGlimmerActive ? 'term_glimmer' : '')}
              onClick={() => this.props.onOpenCustomModal('agent')}
            >
              <i className="ti ti-plus" style={{fontSize: '14px'}} aria-hidden="true" />
              <span>Custom…</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default NewPanePicker;
