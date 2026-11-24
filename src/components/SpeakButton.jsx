import { LoaderCircle, Square, Volume2 } from 'lucide-react';
import { useSpeaker } from '../context/SpeakerContext.jsx';

/** Play / stop text-to-speech for one piece of text. */
export default function SpeakButton({ id, text, variant = 'icon', disabled }) {
  const { speak, stop, speakingId, phase, progress } = useSpeaker();
  const isMine = speakingId === id;
  const preparing = isMine && phase === 'preparing';
  const label = isMine ? 'Stop reading' : 'Read aloud';
  const percent = preparing && progress?.ratio ? ` ${Math.round(progress.ratio * 100)}%` : '';

  const Icon = preparing ? LoaderCircle : isMine ? Square : Volume2;
  const onClick = () => (isMine ? stop() : speak(id, text));

  if (variant === 'icon') {
    return (
      <button
        type="button"
        className={`icon-btn${isMine ? ' icon-btn--on' : ''}`}
        onClick={onClick}
        disabled={disabled || !text?.trim()}
        aria-label={label}
        title={label}
      >
        <Icon size={18} className={preparing ? 'spin' : undefined} aria-hidden="true" />
      </button>
    );
  }

  return (
    <button type="button" className="btn btn--ghost" onClick={onClick} disabled={disabled || !text?.trim()}>
      <Icon size={18} className={preparing ? 'spin' : undefined} aria-hidden="true" />
      {preparing ? `Preparing voice${percent}` : isMine ? 'Stop' : 'Listen'}
    </button>
  );
}
