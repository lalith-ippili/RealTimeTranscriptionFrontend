import { memo, useEffect, useState } from 'react';
import { formatDuration } from '../lib/format.js';

/** mm:ss clock. Only this small component re-renders while recording. */
function RecordingTimer({ timing }) {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!timing.since) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [timing.since]);

  const ms = timing.accumulatedMs + (timing.since ? Date.now() - timing.since : 0);
  return (
    <span className="recorder__time" role="timer" aria-label="Recording time">
      {formatDuration(ms)}
    </span>
  );
}

export default memo(RecordingTimer);
