import React from 'react';

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
      style={{
        position: 'absolute',
        top: top || '8px',
        right: '12px',
        zIndex: 10001,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-6)',
        background: 'var(--bg-secondary)',
        border: '0.5px solid var(--border-neutral)',
        borderRadius: 'var(--radius-6)',
        padding: '3px var(--space-8)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.28)'
      }}
    >
      <i
        className="ti ti-search"
        style={{fontSize: '12px', color: 'var(--text-tertiary)', flexShrink: 0}}
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="text"
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
        style={{
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--text-primary)',
          fontSize: '12px',
          fontFamily: 'var(--font-sans)',
          width: '160px'
        }}
      />
      <span
        style={{
          fontSize: '11px',
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
          minWidth: '40px',
          textAlign: 'right'
        }}
      >
        {value ? `${active}/${total}` : ''}
      </span>
      <span
        className="term_controlIcon"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPrev}
        title="Previous (Shift+Enter)"
        style={{cursor: 'pointer', display: 'flex', alignItems: 'center'}}
      >
        <i className="ti ti-chevron-up" style={{fontSize: '14px'}} aria-hidden="true" />
      </span>
      <span
        className="term_controlIcon"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onNext}
        title="Next (Enter)"
        style={{cursor: 'pointer', display: 'flex', alignItems: 'center'}}
      >
        <i className="ti ti-chevron-down" style={{fontSize: '14px'}} aria-hidden="true" />
      </span>
      <span
        className="term_controlIcon"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        title="Close (Esc)"
        style={{cursor: 'pointer', display: 'flex', alignItems: 'center'}}
      >
        <i className="ti ti-x" style={{fontSize: '13px'}} aria-hidden="true" />
      </span>
    </div>
  );
}
