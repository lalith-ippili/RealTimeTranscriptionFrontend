import { memo, useEffect, useRef } from 'react';
import { LoaderCircle, Mic, Square, X } from 'lucide-react';

/**
 * The big record button. While listening, its halo grows with your voice:
 * the level is written to a CSS variable once per frame (no React renders).
 */
function RecordButton({ status, engineName, onClick, subscribe }) {
  const ref = useRef(null);
  const isActive = status !== 'idle';
  const starting = status === 'loading' || status === 'connecting';
  const stopping = status === 'stopping';

  useEffect(() => {
    const el = ref.current;
    if (!el || status !== 'listening') return undefined;
    let frame = 0;
    let latest = 0;
    const unsubscribe = subscribe((value) => {
      latest = value;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          el.style.setProperty('--level', latest.toFixed(3));
        });
      }
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      el.style.setProperty('--level', '0');
    };
  }, [status, subscribe]);

  const label = starting ? 'Cancel' : isActive ? 'Stop recording' : `Start recording with ${engineName}`;

  return (
    <button
      ref={ref}
      type="button"
      className={`record${isActive ? ' record--on' : ''}${status === 'listening' ? ' record--live' : ''}`}
      onClick={onClick}
      disabled={stopping}
      aria-label={label}
      title={label}
    >
      {stopping ? (
        <LoaderCircle size={30} className="spin" aria-hidden="true" />
      ) : starting ? (
        <X size={30} aria-hidden="true" />
      ) : isActive ? (
        <Square size={24} fill="currentColor" aria-hidden="true" />
      ) : (
        <Mic size={30} aria-hidden="true" />
      )}
    </button>
  );
}

export default memo(RecordButton);
