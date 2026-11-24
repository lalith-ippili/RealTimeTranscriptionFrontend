import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';

const ICONS = { success: CircleCheck, error: CircleAlert, warning: TriangleAlert, info: Info };

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message, { tone = 'info', duration = 4000, action } = {}) => {
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-3), { id, message, tone, action }]);
      if (duration) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {toasts.map((t) => {
          const Icon = ICONS[t.tone] || Info;
          return (
          <div key={t.id} className={`toast toast--${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            <Icon className="toast__icon" size={18} aria-hidden="true" />
            <span className="toast__message">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="icon-btn icon-btn--small" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
};
