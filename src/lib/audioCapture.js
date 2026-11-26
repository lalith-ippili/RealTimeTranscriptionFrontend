/**
 * Records what the microphone hears during a dictation, so the audio can be
 * saved to history next to the text.
 *
 * Every engine opens the microphone through lib/microphone.js, which connects
 * the mic to this capture. The microphone feeds a MediaStreamAudioDestinationNode
 * and one MediaRecorder records that node's stream. Pressing stop pauses the
 * recorder and pressing record again resumes it, so all parts of one dictation
 * end up in a single, playable file (Opus in WebM or Ogg; AAC in MP4 on Safari).
 *
 * Lifecycle: connect() on each recording · snapshot() when saving ·
 * discard() on "Start over" or when the page closes.
 */

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
const BITS_PER_SECOND = 32_000; // speech-quality Opus, about 0.25 MB a minute
const TIMESLICE_MS = 1000;

let session = null;

const log = (...args) => console.info('[Bolo · Audio]', ...args);

export const isAudioCaptureSupported = () =>
  typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';

const pickMimeType = () => MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || '';

function createSession(context) {
  const destination = context.createMediaStreamDestination();
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(destination.stream, {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond: BITS_PER_SECOND,
  });
  const created = {
    context,
    destination,
    recorder,
    chunks: [],
    mimeType: recorder.mimeType || mimeType || 'audio/webm',
    accumulatedMs: 0,
    since: 0,
    sources: new Set(),
  };
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) created.chunks.push(event.data);
  });
  recorder.addEventListener('error', (event) => log('recorder error', event.error?.message || event));
  log(`recording as ${created.mimeType}`);
  return created;
}

const markRunning = (s) => {
  if (!s.since) s.since = performance.now();
};
const markPaused = (s) => {
  if (s.since) {
    s.accumulatedMs += performance.now() - s.since;
    s.since = 0;
  }
};

/**
 * Record `source` (a microphone node) into the current dictation's file.
 * Returns a function that stops recording this source (the recorder pauses).
 */
export function connectToCapture(context, source) {
  if (!isAudioCaptureSupported()) return () => {};
  try {
    // A new AudioContext (rare) can't feed the old recorder: start a new file.
    if (session && session.context !== context) discardAudioCapture();
    if (!session) session = createSession(context);
    const s = session;
    source.connect(s.destination);
    s.sources.add(source);
    if (s.recorder.state === 'inactive') s.recorder.start(TIMESLICE_MS);
    else if (s.recorder.state === 'paused') s.recorder.resume();
    markRunning(s);

    return () => {
      try {
        source.disconnect(s.destination);
      } catch {
        /* already disconnected */
      }
      s.sources.delete(source);
      if (s === session && s.sources.size === 0 && s.recorder.state === 'recording') {
        s.recorder.pause();
        markPaused(s);
      }
    };
  } catch (err) {
    log('could not record audio:', err.message);
    return () => {};
  }
}

/**
 * The recording so far as one file, without ending it (more can be added).
 * @returns {Promise<null | { blob: Blob, mimeType: string, durationMs: number }>}
 */
export async function snapshotAudioCapture() {
  const s = session;
  if (!s) return null;
  if (s.recorder.state !== 'inactive') {
    // Flush what the recorder still buffers (also works while paused).
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      s.recorder.addEventListener(
        'dataavailable',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      try {
        s.recorder.requestData();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  const blob = new Blob(s.chunks, { type: s.mimeType });
  if (!blob.size) return null;
  const runningMs = s.since ? performance.now() - s.since : 0;
  return { blob, mimeType: s.mimeType, durationMs: Math.round(s.accumulatedMs + runningMs) };
}

/** Throw the current recording away (Start over, leaving the page). */
export function discardAudioCapture() {
  const s = session;
  session = null;
  if (!s) return;
  for (const source of s.sources) {
    try {
      source.disconnect(s.destination);
    } catch {
      /* already disconnected */
    }
  }
  try {
    if (s.recorder.state !== 'inactive') s.recorder.stop();
  } catch {
    /* ignore */
  }
  s.destination.stream.getTracks().forEach((track) => track.stop());
}
