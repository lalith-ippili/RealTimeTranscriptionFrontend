/**
 * Gemini Live engine – real-time, multilingual (Hindi + English) transcription.
 *
 *  1. The microphone opens first and audio is buffered, so you can start
 *     speaking while the connection is still being set up.
 *  2. Our backend issues a single-use ephemeral token (the API key stays secret).
 *  3. The browser connects straight to the Live API and streams 16 kHz PCM.
 *
 * Models (chosen by the backend):
 *  • transcribe mode – gemini-3.5-transcribe-live: `interimInputTranscription`
 *    updates while you talk, `inputTranscription` is the final text per phrase.
 *  • agent mode – gemini-3.1-flash-live-preview (fallback): `inputTranscription`
 *    arrives after each utterance.
 *
 * Speed-ups: a small client-side voice detector sends `audioStreamEnd` as soon
 * as you pause, so Gemini finalises the phrase immediately ("hybrid VAD").
 * Robustness: automatic fallback across model / API version, and seamless
 * reconnection when a session hits Google's time limit or drops.
 */
import api, { ApiError } from '../api/client.js';
import { connectLive } from '../lib/liveSocket.js';
import { float32ToPcm16Base64, openMicrophone } from '../lib/microphone.js';

const COMBO_KEY = 'bolo.geminiCombo';
const ATTEMPTS = [
  { variant: 'primary', apiVersion: 'v1beta' },
  { variant: 'primary', apiVersion: 'v1alpha' },
  { variant: 'fallback', apiVersion: 'v1beta' },
  { variant: 'fallback', apiVersion: 'v1alpha' },
];

const CHUNK_MS = 100;
const MAX_BUFFERED_CHUNKS = 150; // ≈15 s kept while connecting / reconnecting
const SPEECH_START_MS = 200;
const END_OF_SPEECH_MS = 700;
const DRAIN_QUIET_MS = 800;
const DRAIN_MAX_MS = 3_000;
const MAX_QUICK_RECONNECTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readCombo = () => {
  try {
    return JSON.parse(localStorage.getItem(COMBO_KEY));
  } catch {
    return null;
  }
};
const saveCombo = (combo) => {
  try {
    localStorage.setItem(COMBO_KEY, JSON.stringify(combo));
  } catch {
    /* storage unavailable */
  }
};
// Try the combination that worked last time first.
const orderedAttempts = () => {
  const saved = readCombo();
  const first = saved && ATTEMPTS.find((a) => a.variant === saved.variant && a.apiVersion === saved.apiVersion);
  return first ? [first, ...ATTEMPTS.filter((a) => a !== first)] : ATTEMPTS;
};

export function createGeminiLiveEngine(callbacks) {
  const { onStatus, onText, onInterim, onLevel, onError } = callbacks;

  let mic = null;
  let session = null;
  let activeId = 0;
  let sessionSeq = 0;
  let combo = null;
  let mode = 'transcribe';
  let stopping = false;
  let reconnecting = false;
  let quickReconnects = 0;
  let sessionStartedAt = 0;
  let buffer = [];

  let newTurn = true;
  const interims = new Map(); // session id → interim text not yet finalised
  const retired = new Set(); // sessions replaced by a reconnect
  let lastTranscriptAt = 0;

  // Client-side voice detection (adaptive noise floor)
  let noiseFloor = 0.008;
  let speaking = false;
  let voicedMs = 0;
  let silenceMs = 0;
  let endSent = true;

  const meta = {};

  // ── Transcript handling ────────────────────────────────────────────────
  // Commit a session's interim text (used when it will never be finalised).
  const commitInterim = (id) => {
    const text = interims.get(id);
    interims.delete(id);
    if (mode === 'transcribe' && text?.trim()) onText(text);
    if (id === activeId) onInterim('');
  };

  const handleMessage = (id, message) => {
    if (retired.has(id)) return;
    if (message.goAway) {
      if (id === activeId) reconnect('session time limit reached');
      return;
    }
    const content = message.serverContent;
    if (!content) return;

    if (mode === 'transcribe') {
      const interim = content.interimInputTranscription;
      if (interim && typeof interim.text === 'string') {
        interims.set(id, interim.text);
        if (id === activeId) onInterim(interim.text);
        lastTranscriptAt = Date.now();
      }
      const final = content.inputTranscription?.text;
      if (final) {
        interims.delete(id);
        onText(final);
        if (id === activeId) onInterim('');
        lastTranscriptAt = Date.now();
      }
      return;
    }

    // agent mode: append-only deltas, phrase boundaries at turn ends
    const transcription = content.inputTranscription;
    if (transcription?.text) {
      onText(transcription.text, { raw: true, newTurn });
      newTurn = false;
      lastTranscriptAt = Date.now();
    }
    if (transcription?.finished || content.turnComplete || content.interrupted) newTurn = true;
  };

  // ── Audio pipeline ────────────────────────────────────────────────────
  const sendChunk = (base64) => {
    if (session?.isOpen && !reconnecting) {
      session.sendAudio(base64);
    } else {
      buffer.push(base64);
      if (buffer.length > MAX_BUFFERED_CHUNKS) buffer.shift();
    }
  };

  const flush = () => {
    while (buffer.length && session?.isOpen) session.sendAudio(buffer.shift());
  };

  const onChunk = (samples) => {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);

    sendChunk(float32ToPcm16Base64(samples));

    // Hybrid VAD: tell Gemini the moment the speaker pauses.
    const threshold = Math.max(0.012, noiseFloor * 3);
    if (rms > threshold) {
      voicedMs += CHUNK_MS;
      silenceMs = 0;
      if (!speaking && voicedMs >= SPEECH_START_MS) {
        speaking = true;
        endSent = false;
      }
    } else if (!speaking) {
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      voicedMs = 0;
    } else {
      silenceMs += CHUNK_MS;
      if (silenceMs >= END_OF_SPEECH_MS) {
        speaking = false;
        voicedMs = 0;
        if (!endSent && session?.isOpen && !reconnecting) {
          endSent = true;
          session.endAudio();
        }
      }
    }
  };

  // ── Sessions ──────────────────────────────────────────────────────────
  const openSession = async (attempt) => {
    const live = await api.createLiveToken(attempt);
    const id = ++sessionSeq;
    const s = await connectLive({
      token: live.token,
      apiVersion: live.apiVersion,
      setup: live.setup,
      onMessage: (message) => handleMessage(id, message), // old sessions may still deliver their last words
      onClose: (info) => {
        if (id === activeId && !stopping) reconnect(info.reason);
      },
    });
    return { s, id, live };
  };

  const adopt = ({ s, id, live }) => {
    session = s;
    activeId = id;
    mode = live.mode;
    sessionStartedAt = Date.now();
    newTurn = true;
    meta.model = live.model;
    meta.mode = live.mode;
    meta.apiVersion = live.apiVersion;
    flush();
  };

  const connectWithFallback = async () => {
    const errors = [];
    for (const attempt of orderedAttempts()) {
      if (stopping) return null;
      onStatus(
        'connecting',
        attempt.variant === 'primary' ? 'Connecting… you can start speaking' : 'Trying the backup Gemini model…',
      );
      try {
        const result = await openSession(attempt);
        combo = attempt;
        saveCombo(attempt);
        return result;
      } catch (err) {
        // Problems a different model or API version will not fix.
        if (err instanceof ApiError && [0, 429, 503].includes(err.status)) throw err;
        errors.push(err.message);
      }
    }
    throw new Error(`Gemini Live could not start: ${errors[0] || 'unknown error'}`);
  };

  const shutdown = async () => {
    const m = mic;
    mic = null;
    await m?.stop();
    session?.close();
    session = null;
    buffer = [];
  };

  const reconnect = async (reason) => {
    if (stopping || reconnecting || !combo) return;

    quickReconnects = Date.now() - sessionStartedAt < 10_000 ? quickReconnects + 1 : 1;
    if (quickReconnects > MAX_QUICK_RECONNECTS) {
      onError(new Error(`Gemini Live keeps disconnecting: ${reason}`));
      await shutdown();
      onStatus('idle');
      return;
    }

    reconnecting = true;
    const old = session;
    const oldId = activeId;
    session = null;
    // Keep the phrase that was in progress, in the right order, then retire the
    // old session so a late final from it cannot duplicate the text.
    commitInterim(oldId);
    retired.add(oldId);
    old?.close();

    try {
      const result = await openSession(combo);
      if (stopping) {
        result.s.close();
        return;
      }
      reconnecting = false;
      adopt(result);
    } catch (err) {
      reconnecting = false;
      if (stopping) return;
      onError(new Error(`Gemini Live disconnected: ${err.message}`));
      await shutdown();
      onStatus('idle');
    }
  };

  return {
    id: 'gemini-live',
    meta,

    async start() {
      stopping = false;
      onStatus('connecting', 'Opening the microphone…');
      const opened = await openMicrophone({ onLevel, onChunk });
      if (stopping) {
        await opened.stop();
        return;
      }
      mic = opened; // audio is buffered from here on

      let result;
      try {
        result = await connectWithFallback();
      } catch (err) {
        await shutdown();
        if (stopping) return; // user cancelled while connecting
        throw err;
      }
      if (!result || stopping) {
        result?.s.close();
        return;
      }
      adopt(result);
      onStatus('listening');
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      onStatus('stopping', 'Finishing the last words…');

      const m = mic;
      mic = null;
      await m?.stop();

      if (session?.isOpen) {
        session.endAudio();
        const started = Date.now();
        lastTranscriptAt = Math.max(lastTranscriptAt, started);
        while (
          session?.isOpen &&
          Date.now() - started < DRAIN_MAX_MS &&
          (Date.now() - lastTranscriptAt < DRAIN_QUIET_MS || interims.get(activeId))
        ) {
          await sleep(100);
        }
      }
      // Never lose words that were only shown as interim text.
      for (const id of [...interims.keys()]) commitInterim(id);
      onInterim('');
      session?.close();
      session = null;
      buffer = [];
      onStatus('idle');
    },
  };
}
