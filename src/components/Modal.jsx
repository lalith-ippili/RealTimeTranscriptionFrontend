import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * Accessible modal built on the native <dialog> element
 * (focus trapping, Esc to close and backdrop come for free).
 */
export default function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal modal--${size}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on backdrop
      }}
      aria-labelledby="modal-title"
    >
      {open && (
        <div className="modal__inner">
          <header className="modal__header">
            <h2 id="modal-title">{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <div className="modal__body">{children}</div>
          {footer && <footer className="modal__footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
