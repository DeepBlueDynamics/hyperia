import React, {useState, useEffect, useRef} from 'react';

type Callback = (url: string) => void;
let _show: ((cb: Callback) => void) | null = null;

export function showWebPaneDialog(cb: Callback): void {
  if (_show) {
    _show(cb);
  }
}

const WebPaneDialog = () => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const callbackRef = useRef<Callback | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    _show = (cb: Callback) => {
      callbackRef.current = cb;
      setValue('https://shivvr.nuts.services');
      setOpen(true);
    };
    return () => {
      _show = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
    callbackRef.current?.(url);
    setOpen(false);
  };

  const cancel = () => setOpen(false);

  if (!open) return null;

  return (
    <div className="wpd_backdrop" onMouseDown={cancel}>
      <div className="wpd_dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wpd_title">Open Browser</div>
        <div className="wpd_row">
          <svg className="wpd_globe" viewBox="0 0 16 16" width="16" height="16" fill="none">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
            <ellipse cx="8" cy="8" rx="2.6" ry="6.5" stroke="currentColor" strokeWidth="1" />
            <line x1="1.5" y1="6" x2="14.5" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="1.5" y1="10" x2="14.5" y2="10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="wpd_input"
            type="text"
            placeholder="https://example.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') cancel();
            }}
          />
        </div>
        <div className="wpd_actions">
          <button className="wpd_btn wpd_cancel" onClick={cancel}>
            Cancel
          </button>
          <button className="wpd_btn wpd_ok" onClick={submit}>
            OK
          </button>
        </div>
      </div>

      <style jsx>{`
        .wpd_backdrop {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .wpd_dialog {
          background: #0e0e16;
          border: 1px solid rgba(0, 150, 255, 0.3);
          border-radius: 8px;
          padding: 18px 20px 14px;
          width: 420px;
          box-shadow:
            0 0 24px rgba(0, 120, 255, 0.15),
            0 8px 32px rgba(0, 0, 0, 0.7);
        }

        .wpd_title {
          font-size: 13px;
          font-weight: 600;
          color: #aac8ff;
          margin-bottom: 12px;
          letter-spacing: 0.02em;
        }

        .wpd_row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 14px;
        }

        .wpd_globe {
          flex-shrink: 0;
          color: #5580cc;
        }

        .wpd_input {
          flex: 1;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(0, 150, 255, 0.25);
          border-radius: 4px;
          color: #ddeeff;
          font-size: 13px;
          padding: 6px 9px;
          outline: none;
          font-family: inherit;
          transition: border-color 0.15s;
        }

        .wpd_input:focus {
          border-color: rgba(0, 150, 255, 0.6);
          background: rgba(255, 255, 255, 0.09);
        }

        .wpd_input::placeholder {
          color: #445;
        }

        .wpd_actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }

        .wpd_btn {
          padding: 5px 16px;
          border-radius: 4px;
          font-size: 12px;
          font-family: inherit;
          cursor: pointer;
          border: 1px solid transparent;
          transition:
            background 0.15s,
            border-color 0.15s,
            color 0.15s;
        }

        .wpd_cancel {
          background: transparent;
          border-color: rgba(255, 255, 255, 0.1);
          color: #778;
        }

        .wpd_cancel:hover {
          background: rgba(255, 255, 255, 0.06);
          color: #aab;
        }

        .wpd_ok {
          background: rgba(0, 120, 255, 0.25);
          border-color: rgba(0, 150, 255, 0.4);
          color: #8af;
        }

        .wpd_ok:hover {
          background: rgba(0, 140, 255, 0.4);
          border-color: rgba(0, 180, 255, 0.6);
          color: #fff;
        }

        .wpd_ok:active {
          background: rgba(0, 140, 255, 0.55);
        }
      `}</style>
    </div>
  );
};

WebPaneDialog.displayName = 'WebPaneDialog';

export default WebPaneDialog;
