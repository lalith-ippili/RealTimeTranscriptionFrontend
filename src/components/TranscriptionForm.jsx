import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import Modal from './Modal.jsx';
import MixBar from './MixBar.jsx';
import { LANGUAGE_LABELS } from '../lib/script.js';

const MAX_CONTENT = 50_000;

/** Create or edit a transcription. `initial` is null when creating. */
export default function TranscriptionForm({ open, initial, onClose, onSubmit }) {
  const editing = Boolean(initial);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [language, setLanguage] = useState(initial?.language ?? 'auto');
  const [isFavorite, setIsFavorite] = useState(initial?.isFavorite ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (!content.trim()) {
      setError('Add some text before saving.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const body = { title: title.trim(), content: content.trim(), isFavorite };
      if (language !== 'auto') body.language = language;
      if (!editing) {
        if (!body.title) delete body.title;
        body.engine = 'manual';
      }
      await onSubmit(body);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit transcription' : 'New transcription'}
      size="lg"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="transcription-form" className="btn btn--primary" disabled={submitting}>
            {submitting && <LoaderCircle size={18} className="spin" aria-hidden="true" />}
            {editing ? 'Save changes' : 'Create transcription'}
          </button>
        </>
      }
    >
      <form id="transcription-form" className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="tf-title">Title</label>
          <input
            id="tf-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            placeholder="Leave empty to use the first words"
          />
        </div>

        <div className="field">
          <label htmlFor="tf-content">Text</label>
          <textarea
            id="tf-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={9}
            maxLength={MAX_CONTENT}
            required
            aria-invalid={Boolean(error) && !content.trim()}
          />
          <div className="field__row">
            <MixBar text={content} showLegend />
            <span className="field__hint">
              {content.length.toLocaleString()} / {MAX_CONTENT.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="form__row">
          <div className="field">
            <label htmlFor="tf-language">Language</label>
            <select id="tf-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="auto">Detect from the text</option>
              {Object.entries(LANGUAGE_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={isFavorite} onChange={(e) => setIsFavorite(e.target.checked)} />
            Mark as favourite
          </label>
        </div>

        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
