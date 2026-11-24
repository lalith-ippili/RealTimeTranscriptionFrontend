/**
 * Whisper engine – open-source speech recognition running on this device.
 *
 * Near-real-time strategy:
 *  • the microphone delivers 100 ms chunks at 16 kHz;
 *  • a small energy-based voice-activity detector (adaptive noise floor)
 *    finds where a phrase starts and ends;
 *  • while a phrase is being spoken we re-transcribe it every ~1.2 s and show
 *    the result as live (interim) text;
 *  • after ~0.8 s of silence (or 12 s of continuous speech) the phrase is
 *    transcribed one last time and committed.
 */
import { openMicrophone } from '../lib/microphone.js';
import { WHISPER_MODELS } from './options.js';


const CHUNK_MS = 100;
const PRE_ROLL_CHUNKS = 3;
const SILENCE_HANG_MS = 700;
const MIN_SPEECH_MS = 300;
const MAX_PHRASE_MS = 10_000;
const INTERIM_EVERY_MS = 900; // minimum; stretched on slow devices

// One worker for the whole app so a downloaded model stays loaded.
let worker = null;
let jobSeq = 0;
const jobs = new Map(); // jobId → { resolve, reject }
const progressListeners = new Set();
const readyModels = new Set();

const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/whisper.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      progressListeners.forEach((fn) => fn(data));
    } else if (data.type === 'ready') {
      // The worker keeps one model in memory at a time.
      readyModels.clear();
      readyModels.add(data.model);
      progressListeners.forEach((fn) => fn(data));
    } else if (data.type === 'result') {
      jobs.get(data.jobId)?.resolve(data.text);
      jobs.delete(data.jobId);
    } else if (data.type === 'error') {
      if (data.jobId !== undefined && jobs.has(data.jobId)) {
        jobs.get(data.jobId).reject(new Error(data.message));
        jobs.delete(data.jobId);
      } else {
        progressListeners.forEach((fn) => fn(data));
      }
    }
  };
  worker.onerror = (event) => {
    const err = new Error(event.message || 'Whisper worker crashed');
    jobs.forEach((job) => job.reject(err));
    jobs.clear();
    progressListeners.forEach((fn) => fn({ type: 'error', message: err.message }));
    worker = null;
    readyModels.clear();
  };
  return worker;
};

const transcribe = (model, audio, language) =>
  new Promise((resolve, reject) => {
    const jobId = ++jobSeq;
    jobs.set(jobId, { resolve, reject });
    getWorker().postMessage({ type: 'transcribe', jobId, model, audio, language }, [audio.buffer]);
  });

const loadModel = (model, onProgress) =>
  new Promise((resolve, reject) => {
    if (readyModels.has(model)) return resolve();
    const files = new Map();
    const listener = (event) => {
      if (event.type === 'progress' && event.file) {
        files.set(event.file, { loaded: event.loaded, total: event.total });
        let loaded = 0;
        let total = 0;
        files.forEach((f) => {
          loaded += f.loaded;
          total += f.total;
        });
        onProgress?.({ loaded, total, ratio: total ? loaded / total : 0 });
      } else if (event.type === 'ready' && event.model === model) {
        progressListeners.delete(listener);
        resolve(event.device);
      } else if (event.type === 'error') {
        progressListeners.delete(listener);
        reject(
          new Error(
            `Could not download the Whisper model (${event.message}). Check your internet connection and try again.`,
          ),
        );
      }
    };
    progressListeners.add(listener);
    getWorker().postMessage({ type: 'load', model });
  });

const concat = (chunks) => {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

// Whisper sometimes "hears" captions in noise: [Music], (laughs) …
const cleanText = (text = '') =>
  text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const isMeaningful = (text) => /[\p{L}\p{N}]/u.test(text);

export function createWhisperEngine(callbacks, options = {}) {
  const { onStatus, onText, onInterim, onLevel, onError, onProgress } = callbacks;
  const model = options.model || WHISPER_MODELS[1].id;
  const language = options.language || '';

  let mic = null;
  let running = false;
  let cancelled = false;

  // Voice-activity detection state
  let noiseFloor = 0.008;
  let speaking = false;
  let phrase = [];
  let phraseMs = 0;
  let voicedMs = 0;
  let silenceMs = 0;
  let sinceInterimMs = 0;
  let preRoll = [];
  let phraseId = 0;

  // Work queue (one job at a time; finals always win over interims)
  const finals = [];
  let interimWanted = false;
  let busy = false;
  let lastInferenceMs = 0; // how long the device needs per pass
  let interimOwner = 0;
  let idleWaiters = [];

  const settleIfIdle = () => {
    if (!busy && finals.length === 0) {
      idleWaiters.forEach((fn) => fn());
      idleWaiters = [];
    }
  };

  const pump = async () => {
    if (busy) return;
    let job = null;
    if (finals.length) {
      job = finals.shift();
    } else if (interimWanted && speaking && phrase.length) {
      interimWanted = false;
      job = { kind: 'interim', id: phraseId, audio: concat(phrase) };
    }
    if (!job) return settleIfIdle();

    busy = true;
    const startedAt = performance.now();
    try {
      const text = cleanText(await transcribe(model, job.audio, language));
      lastInferenceMs = performance.now() - startedAt;
      if (job.kind === 'final') {
        if (isMeaningful(text)) onText(text);
        if (interimOwner === job.id) {
          interimOwner = 0;
          onInterim('');
        }
      } else if (job.id === phraseId && speaking) {
        interimOwner = job.id;
        onInterim(text);
      }
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
      pump();
    }
  };

  const finishPhrase = () => {
    if (!speaking) return;
    speaking = false;
    if (voicedMs >= MIN_SPEECH_MS) {
      finals.push({ kind: 'final', id: phraseId, audio: concat(phrase) });
    } else if (interimOwner === phraseId) {
      interimOwner = 0;
      onInterim('');
    }
    phrase = [];
    phraseMs = 0;
    voicedMs = 0;
    silenceMs = 0;
    pump();
  };

  const onChunk = (samples, rms) => {
    if (!running) return;
    const threshold = Math.max(0.012, noiseFloor * 3);
    const voiced = rms > threshold;

    if (!speaking) {
      // Track background noise while nobody is talking.
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      preRoll.push(samples);
      if (preRoll.length > PRE_ROLL_CHUNKS) preRoll.shift();
      if (voiced) {
        speaking = true;
        phraseId += 1;
        phrase = [...preRoll];
        phraseMs = phrase.length * CHUNK_MS;
        voicedMs = CHUNK_MS;
        silenceMs = 0;
        sinceInterimMs = 0;
        preRoll = [];
      }
      return;
    }

    phrase.push(samples);
    phraseMs += CHUNK_MS;
    sinceInterimMs += CHUNK_MS;
    if (voiced) {
      voicedMs += CHUNK_MS;
      silenceMs = 0;
    } else {
      silenceMs += CHUNK_MS;
    }

    if (silenceMs >= SILENCE_HANG_MS || phraseMs >= MAX_PHRASE_MS) {
      finishPhrase();
    } else if (sinceInterimMs >= Math.max(INTERIM_EVERY_MS, lastInferenceMs * 1.3) && voicedMs >= MIN_SPEECH_MS) {
      sinceInterimMs = 0;
      interimWanted = true;
      pump();
    }
  };

  return {
    id: 'whisper',
    meta: { model, language: language || 'auto' },

    async start() {
      cancelled = false;
      if (!readyModels.has(model)) {
        onStatus('loading', 'Downloading the Whisper model (first time only)…');
        await loadModel(model, onProgress);
        onProgress?.(null);
      }
      if (cancelled) return;
      onStatus('connecting', 'Opening the microphone…');
      const opened = await openMicrophone({
        onLevel,
        onChunk: (samples) => {
          let sum = 0;
          for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
          onChunk(samples, Math.sqrt(sum / samples.length));
        },
      });
      if (cancelled) {
        await opened.stop();
        return;
      }
      mic = opened;
      running = true;
      onStatus('listening');
    },

    async stop() {
      cancelled = true;
      running = false;
      onStatus('stopping', 'Transcribing the last phrase…');
      await mic?.stop();
      mic = null;
      finishPhrase();
      if (busy || finals.length) {
        await new Promise((resolve) => idleWaiters.push(resolve));
      }
      onInterim('');
      onStatus('idle');
    },
  };
}
