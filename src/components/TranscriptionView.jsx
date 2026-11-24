import { Copy, Download, Pencil } from 'lucide-react';
import Modal from './Modal.jsx';
import MixBar from './MixBar.jsx';
import ScriptText from './ScriptText.jsx';
import SpeakButton from './SpeakButton.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { ENGINE_LABELS, LANGUAGE_LABELS } from '../lib/script.js';
import { formatDate, formatDuration } from '../lib/format.js';

/** Read-only view of one transcription with listen / copy / download. */
export default function TranscriptionView({ item, onClose, onEdit }) {
  const toast = useToast();
  if (!item) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.content);
      toast.show('Copied to clipboard', { tone: 'success' });
    } catch {
      toast.show('Copy failed: the browser blocked clipboard access.', { tone: 'error' });
    }
  };

  const download = () => {
    const blob = new Blob([`${item.title}\n\n${item.content}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60) || 'transcription'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={item.title}
      size="lg"
      footer={
        <>
          <SpeakButton id={`view-${item.id}`} text={item.content} variant="button" />
          <button type="button" className="btn btn--ghost" onClick={copy}>
            <Copy size={18} aria-hidden="true" /> Copy
          </button>
          <button type="button" className="btn btn--ghost" onClick={download}>
            <Download size={18} aria-hidden="true" /> Download .txt
          </button>
          <button type="button" className="btn btn--primary" onClick={() => onEdit(item)}>
            <Pencil size={18} aria-hidden="true" /> Edit
          </button>
        </>
      }
    >
      <dl className="facts">
        <div>
          <dt>Language</dt>
          <dd>{LANGUAGE_LABELS[item.language] || item.language}</dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>{ENGINE_LABELS[item.engine] || item.engine}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>
            {item.wordCount} words{item.durationMs ? `, ${formatDuration(item.durationMs)} of speech` : ''}
          </dd>
        </div>
        <div>
          <dt>Saved</dt>
          <dd>
            {formatDate(item.createdAt)}
            {item.updatedAt !== item.createdAt && `, edited ${formatDate(item.updatedAt)}`}
          </dd>
        </div>
      </dl>
      <MixBar text={item.content} showLegend />
      <p className="transcript transcript--reading">
        <ScriptText text={item.content} />
      </p>
    </Modal>
  );
}
