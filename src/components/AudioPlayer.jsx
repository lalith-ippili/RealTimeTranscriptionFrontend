import { useRef } from 'react';
import { AudioLines, Download } from 'lucide-react';
import { audioUrl } from '../api/client.js';
import { formatDuration } from '../lib/format.js';

const formatSize = (bytes = 0) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Plays the audio recording saved with a transcription, with a download link. */
export default function AudioPlayer({ id, audio }) {
  const ref = useRef(null);

  // Chrome's MediaRecorder writes WebM files without a total length, so the
  // player can't show the duration or seek. Jumping to the end once makes the
  // browser measure it; then we jump back to the start.
  const measureDuration = () => {
    const el = ref.current;
    if (!el || Number.isFinite(el.duration)) return;
    const backToStart = () => {
      el.removeEventListener('timeupdate', backToStart);
      el.currentTime = 0;
    };
    el.addEventListener('timeupdate', backToStart);
    el.currentTime = Number.MAX_SAFE_INTEGER;
  };

  return (
    <section className="recording" aria-label="Audio recording">
      <div className="recording__head">
        <span className="recording__title">
          <AudioLines size={16} aria-hidden="true" /> Audio recording
        </span>
        <span className="recording__meta">
          {audio.durationMs ? `${formatDuration(audio.durationMs)}, ` : ''}
          {formatSize(audio.sizeBytes)}
        </span>
      </div>
      <audio
        ref={ref}
        className="recording__player"
        controls
        preload="metadata"
        src={audioUrl(id)}
        onLoadedMetadata={measureDuration}
      >
        Your browser can&apos;t play this recording.
      </audio>
      <a className="recording__download" href={audioUrl(id, { download: true })} download>
        <Download size={16} aria-hidden="true" /> Download audio
      </a>
    </section>
  );
}
