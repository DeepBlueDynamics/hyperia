import React from 'react';

import './find-bar.css';

// Shared find bar — used by BOTH the web pane (find-in-page) and the terminal
// (xterm search). Floats top-right of the pane; same look, placement, and
// behavior in both. The host owns the query + match counts and the actual
// search engine; this is purely the presentation + key handling.
export interface FindBarProps {
  value: string;
  active: number; // 1-based index of the current match (0 = none)
  total: number;
  placeholder?: string;
  top?: string; // distance from the top of the positioned ancestor (default 8px)
  inputRef?: React.RefObject<HTMLInputElement>;
  onChange: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export default function FindBar(props: FindBarProps) {
  const {value, active, total, placeholder, top, inputRef, onChange, onNext, onPrev, onClose} = props;
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="hy-find-bar"
      style={top ? ({'--hy-find-top': top} as React.CSSProperties) : undefined}
    >
      <i className="ti ti-search hy-find-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        // The bar mounts when Ctrl+F opens it; autoFocus reliably grabs the
        // cursor (the manual ref.focus in openFind races with the native view
        // stealing focus back). Select any existing query so you can retype.
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={value}
        placeholder={placeholder || 'Find'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        className="hy-find-input"
      />
      <span className="hy-find-count">{value ? `${active}/${total}` : ''}</span>
      <span
        className="term_controlIcon hy-find-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPrev}
        title="Previous (Shift+Enter)"
      >
        <i className="ti ti-chevron-up hy-find-btn-icon" aria-hidden="true" />
      </span>
      <span
        className="term_controlIcon hy-find-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onNext}
        title="Next (Enter)"
      >
        <i className="ti ti-chevron-down hy-find-btn-icon" aria-hidden="true" />
      </span>
      <span
        className="term_controlIcon hy-find-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        title="Close (Esc)"
      >
        <i className="ti ti-x hy-find-btn-icon-close" aria-hidden="true" />
      </span>
    </div>
  );
}
