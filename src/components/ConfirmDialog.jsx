import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import Modal from './Modal.jsx';

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={confirm} disabled={busy}>
            {busy && <LoaderCircle size={18} className="spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
