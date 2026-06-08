import React from 'react';

// Shared URL picker — used by the pane "Chooser" (and reusable by the web-pane
// toolbar). Input + a history dropdown (favicon · title · url), de-duped on a
// normalized key, keyboard-navigable. Self-contained: reads the same history
// store the web pane writes (localStorage 'web_pane_history').

interface HistoryEntry {
  kind: string;
  value: string;
  visitedAt: number;
  titleAtVisit?: string;
}

// "x.com", "x.com/", "https://x.com/" → one key.
function normalizeUrlKey(u: string): string {
  try {
    const p = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    return `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, '')}${p.search}${p.hash}`;
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/, '');
  }
}

// Collapse key: scheme://host + full path, truncated at the first "special"
// character (! ? @ # & = ; , ~ * + and more). Query strings and fragments live
// in .search/.hash so they're already excluded; the path truncation also folds
// in-path noise like google.com/maps/@lat,lng or /!bangs. Distinct pages keep
// their full path and stay separate (article/123 ≠ article/456) — only variants
// of the SAME page collapse together.
function rootKeyForUrl(u: string): string {
  try {
    const p = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    let path = p.pathname;
    const m = path.match(/[!?@#&=;,~*+$%^]/);
    if (m && m.index !== undefined && m.index > 0) path = path.slice(0, m.index);
    return `${p.protocol}//${p.host}${path}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return u.split(/[!?@#&=;,~*+$%^]/)[0].trim().toLowerCase();
  }
}

function faviconForUrl(u: string): string {
  try {
    const p = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    return `${p.protocol}//${p.host}/favicon.ico`;
  } catch {
    return '';
  }
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem('web_pane_history');
    if (!raw) return [];
    const arr = JSON.parse(raw) as HistoryEntry[];
    const seen = new Set<string>();
    const out: HistoryEntry[] = [];
    for (const e of arr) {
      if (!e || e.kind !== 'url' || !e.value) continue;
      const k = normalizeUrlKey(e.value);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

interface Props {
  value: string;
  placeholder?: string;
  autoFocus?: boolean;
  onChange: (v: string) => void;
  onNavigate: (url: string) => void;
}

interface State {
  focusedIndex: number;
  focused: boolean;
  expandedRoots: {[key: string]: boolean};
}

type Row =
  | {type: 'single' | 'child'; entry: HistoryEntry}
  | {type: 'root'; key: string; label: string; entries: HistoryEntry[]};

export default class UrlPicker extends React.Component<Props, State> {
  inputRef = React.createRef<HTMLInputElement>();
  state: State = {focusedIndex: -1, focused: false, expandedRoots: {}};

  componentDidMount() {
    if (this.props.autoFocus) {
      // Defer so the surrounding pane/picker has mounted and won't steal focus.
      setTimeout(() => this.inputRef.current?.focus(), 60);
    }
  }

  private toggleRoot = (key: string) => {
    this.setState((s) => ({expandedRoots: {...s.expandedRoots, [key]: !s.expandedRoots[key]}}));
  };

  // The dropdown opens when you CLICK IN (focus). URLs sharing a root (e.g. all
  // the google.com/maps/@... entries) collapse into one expandable row so a
  // map-spammed history stays tidy; typing filters and auto-expands matches.
  private visibleRows(): Row[] {
    if (!this.state.focused) return [];
    const q = this.props.value.trim().toLowerCase();
    const all = loadHistory();
    const filtered = q
      ? all.filter((e) => e.value.toLowerCase().includes(q) || (e.titleAtVisit || '').toLowerCase().includes(q))
      : all;
    const order: string[] = [];
    const groups: {[k: string]: HistoryEntry[]} = {};
    for (const e of filtered) {
      const k = rootKeyForUrl(e.value);
      if (!groups[k]) {
        groups[k] = [];
        order.push(k);
      }
      groups[k].push(e);
    }
    const rows: Row[] = [];
    for (const k of order.slice(0, 10)) {
      const entries = groups[k];
      if (entries.length === 1) {
        rows.push({type: 'single', entry: entries[0]});
      } else {
        rows.push({type: 'root', key: k, label: k.replace(/^https?:\/\//, ''), entries});
        if (this.state.expandedRoots[k] || !!q) {
          for (const e of entries) rows.push({type: 'child', entry: e});
        }
      }
    }
    return rows;
  }

  render() {
    const {value, placeholder, onChange, onNavigate} = this.props;
    const rows = this.visibleRows();
    const {focusedIndex} = this.state;

    return (
      <div style={{display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '340px'}}>
        <div
          style={{
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
          }}
        >
          <i className="ti ti-world" style={{fontSize: '14px', color: 'var(--text-tertiary)', flexShrink: 0}} aria-hidden="true" />
          <input
            ref={this.inputRef}
            type="text"
            value={value}
            placeholder={placeholder || 'Click to browse history, or type a URL'}
            onFocus={() => this.setState({focused: true})}
            onBlur={() => this.setState({focused: false, focusedIndex: -1})}
            onContextMenu={(e) => {
              // Right-click → edit menu (Paste etc.). stopPropagation so it does
              // NOT bubble to the chooser container, which would otherwise fire
              // its pick-a-pane glimmer (the whole-screen flash).
              e.preventDefault();
              e.stopPropagation();
              try {
                this.inputRef.current?.focus();
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const {Menu, MenuItem} = require('@electron/remote');
                const menu = new Menu();
                menu.append(new MenuItem({role: 'cut'}));
                menu.append(new MenuItem({role: 'copy'}));
                menu.append(new MenuItem({role: 'paste'}));
                menu.append(new MenuItem({type: 'separator'}));
                menu.append(new MenuItem({role: 'selectAll'}));
                menu.popup();
              } catch (err) {
                console.error('url picker context menu failed:', err);
              }
            }}
            onChange={(e) => {
              onChange(e.target.value);
              this.setState({focusedIndex: -1});
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.setState({focusedIndex: Math.min(focusedIndex + 1, rows.length - 1)});
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.setState({focusedIndex: Math.max(focusedIndex - 1, -1)});
              } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const r = focusedIndex >= 0 ? rows[focusedIndex] : undefined;
                if (r && r.type === 'root') this.toggleRoot(r.key);
                else if (r) onNavigate(r.entry.value);
                else if (value.trim()) onNavigate(value.trim());
              }
            }}
            style={{
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
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              fontWeight: 600,
              padding: 'var(--space-2) var(--space-4)',
              border: '0.5px solid var(--border-neutral)',
              borderRadius: 'var(--radius-3)',
              color: 'var(--text-tertiary)',
              userSelect: 'none',
              lineHeight: '1.2',
              whiteSpace: 'nowrap'
            }}
          >
            enter
          </span>
        </div>

        {rows.length > 0 && (
          <div
            style={{
              marginTop: 'var(--space-6)',
              border: '0.5px solid var(--border-neutral)',
              borderRadius: 'var(--radius-6)',
              overflow: 'hidden',
              background: 'var(--bg-primary)'
            }}
          >
            <div style={{maxHeight: '208px', overflowY: 'auto'}}>
              {rows.map((row, i) => {
                const isFocused = i === focusedIndex;
                if (row.type === 'root') {
                  const expanded = !!this.state.expandedRoots[row.key];
                  return (
                    <div
                      key={`root-${row.key}`}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        // Ctrl/Cmd-click reveals the collapsed ?/#/@ variants; a
                        // plain click navigates to the latest visit of this page.
                        if (ev.ctrlKey || ev.metaKey) {
                          this.toggleRoot(row.key);
                        } else {
                          this.setState({focusedIndex: -1});
                          onNavigate(row.entries[0].value);
                        }
                      }}
                      onMouseEnter={() => this.setState({focusedIndex: i})}
                      title={`${row.entries.length} versions · Ctrl-click to show`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 10px',
                        cursor: 'pointer',
                        background: isFocused ? 'var(--info-bg)' : undefined
                      }}
                    >
                      <i
                        className={expanded ? 'ti ti-chevron-down' : 'ti ti-chevron-right'}
                        style={{fontSize: '12px', color: 'var(--text-tertiary)', flexShrink: 0}}
                        aria-hidden="true"
                      />
                      <span style={{position: 'relative', width: '14px', height: '14px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}>
                        <i className="ti ti-world" style={{fontSize: '13px', color: 'var(--text-tertiary)'}} aria-hidden="true" />
                        <img
                          src={faviconForUrl(row.entries[0].value)}
                          width={14}
                          height={14}
                          alt=""
                          style={{position: 'absolute', inset: 0, borderRadius: '2px', objectFit: 'contain'}}
                          onError={(ev) => {
                            (ev.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      </span>
                      <span
                        style={{flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)'}}
                      >
                        {row.label}
                      </span>
                      <span style={{fontSize: '10px', color: 'var(--text-tertiary)', flexShrink: 0}}>{row.entries.length}</span>
                    </div>
                  );
                }
                const e = row.entry;
                return (
                  <div
                    key={e.value + e.visitedAt}
                    onMouseDown={(ev) => {
                      // Click a URL row → navigate straight there (preventDefault
                      // keeps the input from blurring + closing the dropdown
                      // before this fires). No second Enter needed.
                      ev.preventDefault();
                      this.setState({focusedIndex: -1});
                      onNavigate(e.value);
                    }}
                    onMouseEnter={() => this.setState({focusedIndex: i})}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: row.type === 'child' ? '5px 10px 5px 28px' : '6px 10px',
                      cursor: 'pointer',
                      background: isFocused ? 'var(--info-bg)' : undefined
                    }}
                  >
                    <span
                      style={{
                        position: 'relative',
                        width: '14px',
                        height: '14px',
                        flexShrink: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      <i className="ti ti-world" style={{fontSize: '13px', color: 'var(--text-tertiary)'}} aria-hidden="true" />
                      <img
                        src={faviconForUrl(e.value)}
                        width={14}
                        height={14}
                        alt=""
                        style={{position: 'absolute', inset: 0, borderRadius: '2px', objectFit: 'contain'}}
                        onError={(ev) => {
                          (ev.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    </span>
                    {e.titleAtVisit ? (
                      <span
                        title={e.titleAtVisit}
                        style={{
                          flex: '0 1 auto',
                          maxWidth: '45%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: '11px',
                          fontWeight: 600,
                          color: 'var(--text-primary)'
                        }}
                      >
                        {e.titleAtVisit}
                      </span>
                    ) : null}
                    <span
                      title={e.value}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '10px',
                        color: 'var(--text-tertiary)',
                        fontFamily: 'var(--font-mono)'
                      }}
                    >
                      {e.value}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }
}
