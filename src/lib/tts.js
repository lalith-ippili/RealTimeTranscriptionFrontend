/**
 * Text-to-speech for code-switched Hindi–English text.
 * The text is split into script runs so Devanagari is read by a Hindi voice
 * and Latin-script words by an English voice.
 *
 * Providers
 *   'mms'     – Meta MMS-TTS (open-source VITS models) running on-device in a worker
 *   'browser' – the Web Speech Synthesis voices installed on the system
 */
import { scriptRuns } from './script.js';

export const TTS_PROVIDERS = [
  {
    id: 'browser',
    label: 'Browser voice',
    hint: 'Starts instantly with the voices installed on your system.',
  },
  {
    id: 'mms',
    label: 'Open-source voice',
    hint: 'Meta MMS-TTS running on this device. Downloads two small models the first time.',
  },
];

// Split long runs at sentence ends so no single utterance gets too long.
const splitLong = (text, max = 180) => {
  if (text.length <= max) return [text];
  const parts = text.match(/[^.!?।॥]+[.!?।॥]*\s*/gu) || [text];
  const out = [];
  let buf = '';
  for (const part of parts) {
    if ((buf + part).length > max && buf) {
      out.push(buf.trim());
      buf = '';
    }
    buf += part;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
};

const pieces = (text) =>
  scriptRuns(text).flatMap((run) => splitLong(run.text).map((t) => ({ script: run.script, text: t })));

// ── Browser speech synthesis ──────────────────────────────────────────────
let voicesPromise = null;
const loadVoices = () => {
  if (!voicesPromise) {
    voicesPromise = new Promise((resolve) => {
      const synth = window.speechSynthesis;
      const ready = synth.getVoices();
      if (ready.length) return resolve(ready);
      const timer = setTimeout(() => resolve(synth.getVoices()), 1500);
      synth.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timer);
          resolve(synth.getVoices());
        },
        { once: true },
      );
    });
  }
  return voicesPromise;
};

const pickVoice = (voices, prefixes) => {
  for (const prefix of prefixes) {
    const match = voices.find((v) => v.lang?.replace('_', '-').toLowerCase().startsWith(prefix));
    if (match) return match;
  }
  return null;
};

async function speakWithBrowser(text, { signal, onStart }) {
  const synth = window.speechSynthesis;
  if (!synth) throw new Error('This browser cannot read text aloud. Try the open-source voice.');
  synth.cancel();

  const voices = await loadVoices();
  const hindi = pickVoice(voices, ['hi-in', 'hi']);
  const english = pickVoice(voices, ['en-in', 'en-gb', 'en-us', 'en']);
  const runs = pieces(text);

  const warning =
    !hindi && runs.some((r) => r.script === 'deva')
      ? 'No Hindi voice is installed on this device, so Hindi words may be skipped. Switch to the open-source voice to hear them.'
      : null;

  await new Promise((resolve, reject) => {
    if (!runs.length || signal.aborted) return resolve();
    signal.addEventListener('abort', () => {
      synth.cancel();
      resolve();
    });
    runs.forEach((run, i) => {
      const utterance = new SpeechSynthesisUtterance(run.text);
      const voice = run.script === 'deva' ? hindi : english;
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || (run.script === 'deva' ? 'hi-IN' : 'en-IN');
      if (i === 0) utterance.onstart = () => onStart?.();
      if (i === runs.length - 1) utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        if (event.error === 'interrupted' || event.error === 'canceled') resolve();
        else reject(new Error(`Could not read the text aloud (${event.error}).`));
      };
      synth.speak(utterance);
    });
  });

  return { warning };
}

// ── Open-source MMS-TTS (worker) ──────────────────────────────────────────
let ttsWorker = null;
let jobSeq = 0;
const jobs = new Map();
const progressListeners = new Set();

const getTtsWorker = () => {
  if (ttsWorker) return ttsWorker;
  ttsWorker = new Worker(new URL('../workers/tts.worker.js', import.meta.url), { type: 'module' });
  ttsWorker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      progressListeners.forEach((fn) => fn(data));
      return;
    }
    const job = jobs.get(data.jobId);
    if (!job) return;
    jobs.delete(data.jobId);
    if (data.type === 'audio') job.resolve(data);
    else job.reject(new Error(`Open-source voice failed: ${data.message}`));
  };
  ttsWorker.onerror = (event) => {
    jobs.forEach((job) => job.reject(new Error(event.message || 'Voice worker crashed')));
    jobs.clear();
    ttsWorker = null;
  };
  return ttsWorker;
};

const synthesize = (script, text) =>
  new Promise((resolve, reject) => {
    const jobId = ++jobSeq;
    jobs.set(jobId, { resolve, reject });
    getTtsWorker().postMessage({ type: 'speak', jobId, script, text });
  });

async function speakWithMms(text, { signal, onStart, onProgress }) {
  const runs = pieces(text);
  if (!runs.length) return {};

  const files = new Map();
  const listener = (p) => {
    files.set(p.file, p);
    let loaded = 0;
    let total = 0;
    files.forEach((f) => {
      loaded += f.loaded || 0;
      total += f.total || 0;
    });
    onProgress?.({ loaded, total, ratio: total ? loaded / total : 0 });
  };
  progressListeners.add(listener);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx();
  const sources = [];
  let cursor = 0;
  let started = false;

  try {
    // Synthesis of the next run overlaps with playback of the current one.
    for (const run of runs) {
      if (signal.aborted) break;
      const { audio, samplingRate } = await synthesize(run.script, run.text);
      if (signal.aborted) break;
      onProgress?.(null);

      const buffer = context.createBuffer(1, audio.length, samplingRate);
      buffer.copyToChannel(audio, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      if (context.state === 'suspended') await context.resume();
      const startAt = Math.max(cursor, context.currentTime + 0.05);
      source.start(startAt);
      sources.push(source);
      cursor = startAt + buffer.duration + 0.08;
      if (!started) {
        started = true;
        onStart?.();
      }
    }

    // Wait for playback to finish (or abort).
    await new Promise((resolve) => {
      const remaining = Math.max(0, cursor - context.currentTime) * 1000;
      const timer = setTimeout(resolve, remaining);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    progressListeners.delete(listener);
    sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    });
    await context.close().catch(() => {});
  }
  return {};
}

/**
 * Read `text` aloud. Resolves when playback ends or `signal` aborts.
 * @returns {Promise<{ warning?: string|null }>}
 */
export function speakText(text, { provider = 'browser', signal, onStart, onProgress } = {}) {
  const ctrlSignal = signal || new AbortController().signal;
  if (provider === 'mms') return speakWithMms(text, { signal: ctrlSignal, onStart, onProgress });
  return speakWithBrowser(text, { signal: ctrlSignal, onStart });
}
