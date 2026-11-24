/**
 * Gemini Live engine – real-time, multilingual (Hindi + English) transcription.
 *
 *  1. The microphone opens first and audio is buffered, so you can start
 *     speaking while the connection is still being set up.
 *  2. 16 kHz PCM is streamed through our backend's WebSocket relay, which
 *     talks to the Live API with the server's API key. If the relay is not
 *     available, the browser connects directly with a single-use ephemeral token.
 *
 * Models (chosen by the backend):
 *  • transcribe mode – gemini-3.5-transcribe-live: `interimInputTranscription`
 *    updates while you talk; `inputTranscription` arrives at each pause and
 *    repeats the whole turn so far (see lib/transcriptAssembler.js, which
 *    replaces the turn instead of appending it again).
 *  • agent mode – gemini-3.1-flash-live-preview (fallback): `inputTranscription`
 *    arrives as append-only pieces after each utterance.
 *
 * Reliability:
 *  • tries model/API-version combinations in order (remembering what worked);
 *    a session that dies before producing anything counts as a failed attempt
 *    and the next combination is tried;
 *  • the whole start-up is capped, so the UI never hangs on "connecting";
 *  • time-limit / dropped sessions reconnect without stopping the microphone.
 * Text: interim and final events are run through a transcript assembler that
 * works whether Gemini sends cumulative turns, whole phrases or word pieces,
 * and never shows the same words twice.
 *
 * Open the browser console and filter by "[Bolo · Gemini]" to see each step.
 */
import api, { ApiError, liveRelayUrl } from '../api/client.js';
import { connectLive, liveLog } from '../lib/liveSocket.js';
import { createAssembler } from '../lib/transcriptAssembler.js';
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
const START_DEADLINE_MS = 30_000; // give up connecting after this
const EARLY_FAILURE_MS = 15_000; // a session that dies this soon without output failed
const MAX_QUICK_RECONNECTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LANGUAGE_CODES = { english: ['en-IN'], hindi: ['hi-IN'] };
const NO_TEXT_WARNING_MS = 7_000; // voiced audio sent without any text back

const comboKey = (a) => `${a.via}:${a.variant}:${a.apiVersion || ''}`;

const readCombo = () => {
  try {
    return localStorage.getItem(COMBO_KEY);
  } catch {
    return null;
  }
};
const saveCombo = (combo) => {
  try {
    if (combo) localStorage.setItem(COMBO_KEY, comboKey(combo));
    else localStorage.removeItem(COMBO_KEY);
  } catch {
    /* storage unavailable */
  }
};

/**
 * Connection attempts in order of preference:
 *  1. our server relay (API key stays on the server, standard Live endpoint),
 *  2. direct browser connections with an ephemeral token.
 * With a language hint the transcription model is tried with the hint first
 * and then without it. The combination that worked last time goes first.
 */
const orderedAttempts = ({ relay, withLanguage }) => {
  const list = [];
  if (relay) {
    if (withLanguage) list.push({ via: 'relay', variant: 'primary', lang: true });
    list.push({ via: 'relay', variant: 'primary' }, { via: 'relay', variant: 'fallback' });
  }
  if (withLanguage) list.push({ via: 'direct', variant: 'primary', apiVersion: 'v1beta', lang: true });
  list.push(...ATTEMPTS.map((a) => ({ via: 'direct', ...a })));
  const saved = readCombo();
  const preferred = list.filter((a) => comboKey(a) === saved);
  return [...preferred, ...list.filter((a) => !preferred.includes(a))];
};

export function createGeminiLiveEngine(callbacks, options = {}) {
  const { onStatus, onText, onInterim, onLevel, onError, onMicIssue, onWarning } = callbacks;

  let mic = null;
  let session = null;
  let activeId = 0;
  let sessionSeq = 0;
  let combo = null;
  let remaining = []; // attempts not tried yet (for early-failure fallback)
  let mode = 'transcribe';
  let stopping = false;
  let reconnecting = false;
  let quickReconnects = 0;
  let sessionStartedAt = 0;
  let buffer = [];

  let newTurn = true;
  const assemblers = new Map(); // session id → transcript assembler
  const retired = new Set(); // sessions replaced by a reconnect
  let sawInputTranscription = false;
  const languageCodes = LANGUAGE_CODES[options.language] || null;
  let lastTranscriptAt = 0;

  // Client-side voice detection (adaptive noise floor) – used for the
  // "Gemini returns no text" warning, not to control the stream.
  let noiseFloor = 0.008;
  let speaking = false;
  let voicedMs = 0;
  let silenceMs = 0;
  let voicedSinceText = 0; // ms of speech sent since Gemini last returned text
  let warned = false;
  let loggedMessages = 0;

  const meta = {};

  let loggedTexts = 0;
  const logText = (kind, text) => {
    if (loggedTexts >= 40) return;
    loggedTexts += 1;
    liveLog(`${kind}: "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`);
  };

  const gotText = () => {
    voicedSinceText = 0;
    lastTranscriptAt = Date.now();
    if (warned) {
      warned = false;
      onWarning?.(null);
    }
  };

  // ── Transcript handling ────────────────────────────────────────────────
  const assemblerFor = (id) => {
    if (!assemblers.has(id)) {
      assemblers.set(
        id,
        createAssembler({
          onInterim: (text) => {
            if (id === activeId) onInterim(text);
          },
          onFinal: (text, opts) => onText(text, opts),
        }),
      );
    }
    return assemblers.get(id);
  };

  // Commit a session's unfinished text (used when it will never be finalised).
  const commitInterim = (id) => {
    if (mode === 'transcribe') assemblers.get(id)?.flush();
    assemblers.delete(id);
    if (id === activeId) onInterim('');
  };

  const handleMessage = (id, message) => {
    if (retired.has(id)) return;
    if (loggedMessages < 8) {
      loggedMessages += 1;
      const content = message.serverContent ? Object.keys(message.serverContent).join(', ') : '';
      liveLog(`message: ${Object.keys(message).join(', ')}${content ? ` → ${content}` : ''}`);
    }
    if (message.goAway) {
      if (id === activeId) reconnect('session time limit reached');
      return;
    }
    const content = message.serverContent;
    if (!content) return;

    if (mode === 'transcribe') {
      const assembler = assemblerFor(id);
      const interim = content.interimInputTranscription;
      if (interim && typeof interim.text === 'string') {
        logText('interim', interim.text);
        assembler.addInterim(interim.text);
        if (interim.text.trim()) gotText();
      }
      let final = content.inputTranscription?.text;
      if (final) sawInputTranscription = true;
      // Safety net: if the model ever answers with text parts instead of
      // transcription fields, show those words rather than nothing.
      if (!final && !sawInputTranscription && content.modelTurn?.parts) {
        final = content.modelTurn.parts.map((p) => p.text || '').join('').trim();
      }
      if (final) {
        logText('final', final);
        assembler.addFinal(final);
        gotText();
      }
      return;
    }

    // agent mode: append-only deltas, phrase boundaries at turn ends
    const transcription = content.inputTranscription;
    if (transcription?.text) {
      onText(transcription.text, { raw: true, newTurn });
      newTurn = false;
      gotText();
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
      if (session?.isOpen && !reconnecting) {
        voicedSinceText += CHUNK_MS;
        if (!warned && voicedSinceText >= NO_TEXT_WARNING_MS) {
          warned = true;
          liveLog('speech was sent but Gemini has not returned any text yet');
          onWarning?.(
            "Gemini is receiving your voice but hasn't returned any text yet. If nothing appears soon, stop and use the Browser engine.",
          );
        }
      }
      if (!speaking && voicedMs >= SPEECH_START_MS) speaking = true;
    } else if (!speaking) {
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      voicedMs = 0;
    } else {
      silenceMs += CHUNK_MS;
      if (silenceMs >= END_OF_SPEECH_MS) {
        // Pause detected. We deliberately do NOT send audioStreamEnd here:
        // some models stop transcribing after it. Gemini's own voice
        // detection finalises the phrase; audioStreamEnd is sent on stop.
        speaking = false;
        voicedMs = 0;
      }
    }
  };

  // ── Sessions ──────────────────────────────────────────────────────────
  const openSession = async (attempt) => {
    const id = ++sessionSeq;
    const common = {
      onMessage: (message) => handleMessage(id, message), // old sessions may still deliver last words
      onClose: (info) => {
        if (id === activeId && !stopping) handleUnexpectedClose(s, info.reason);
      },
    };
    let s;

    if (attempt.via === 'relay') {
      const url = liveRelayUrl({ variant: attempt.variant, lang: attempt.lang ? options.language : null });
      liveLog(`connecting through the server relay (${attempt.variant}${attempt.lang ? `, ${options.language}` : ''})`);
      s = await connectLive({ url, setup: {}, ...common });
      const info = s.info || {};
      const live = {
        model: info.model || (attempt.variant === 'fallback' ? 'gemini-3.1-flash-live-preview' : 'gemini-3.5-transcribe-live'),
        mode: info.mode || (attempt.variant === 'fallback' ? 'agent' : 'transcribe'),
        apiVersion: 'relay',
      };
      return { s, id, live, attempt };
    }

    liveLog(`requesting token (${attempt.variant}, ${attempt.apiVersion})`);
    const live = await api.createLiveToken({ variant: attempt.variant, apiVersion: attempt.apiVersion });
    liveLog(`token ok → connecting to ${live.model} (${live.apiVersion})`);
    let setup = live.setup;
    if (attempt.lang && languageCodes && live.mode === 'transcribe') {
      setup = { ...setup, inputAudioTranscription: { ...setup.inputAudioTranscription, languageCodes } };
      liveLog(`language hint: ${languageCodes.join(', ')}`);
    }
    s = await connectLive({ token: live.token, apiVersion: live.apiVersion, setup, ...common });
    return { s, id, live, attempt };
  };

  const adopt = ({ s, id, live, attempt }) => {
    session = s;
    activeId = id;
    combo = attempt;
    mode = live.mode;
    sessionStartedAt = Date.now();
    newTurn = true;
    meta.model = live.model;
    meta.mode = live.mode;
    meta.apiVersion = live.apiVersion;
    flush();
  };

  /** Try attempts in order until one connects, within an overall deadline. */
  const connectWithFallback = async (attempts) => {
    const errors = [];
    const deadline = Date.now() + START_DEADLINE_MS;
    for (let i = 0; i < attempts.length; i++) {
      if (stopping) return null;
      if (Date.now() > deadline) {
        errors.push('took too long to connect');
        break;
      }
      const attempt = attempts[i];
      onStatus(
        'connecting',
        i === 0 ? 'Connecting… you can start speaking' : `Trying another Gemini setup (${i + 1} of ${attempts.length})…`,
      );
      try {
        const result = await openSession(attempt);
        remaining = attempts.slice(i + 1);
        saveCombo(attempt);
        return result;
      } catch (err) {
        // Problems a different model or API version will not fix.
        if (err instanceof ApiError && [0, 429, 503].includes(err.status)) throw err;
        liveLog(`attempt ${comboKey(attempt)} failed: ${err.message}`);
        errors.push(err.message);
      }
    }
    saveCombo(null);
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

  const giveUp = async (message) => {
    onError(new Error(message));
    await shutdown();
    onStatus('idle');
  };

  const switchSession = (oldId, old) => {
    // Keep the phrase that was in progress, in the right order, then retire the
    // old session so a late final from it cannot duplicate the text.
    commitInterim(oldId);
    retired.add(oldId);
    old?.close();
  };

  /** The active session closed on its own. */
  const handleUnexpectedClose = async (closed, reason) => {
    const diedEarly = !closed.gotContent && Date.now() - sessionStartedAt < EARLY_FAILURE_MS;
    if (!diedEarly) {
      reconnect(reason);
      return;
    }
    // This model / API version does not really work → move on to the next one.
    liveLog(`session ended before any transcript (${reason}); trying the next setup`);
    if (stopping || reconnecting) return;
    reconnecting = true;
    session = null;
    try {
      if (!remaining.length) throw new Error(reason);
      const result = await connectWithFallback(remaining);
      if (!result || stopping) {
        result?.s.close();
        return;
      }
      reconnecting = false;
      adopt(result);
      onStatus('listening');
    } catch (err) {
      reconnecting = false;
      if (!stopping) await giveUp(`Gemini Live could not start: ${err.message}`);
    }
  };

  /** Replace the session with a fresh one (same model/API version). */
  const reconnect = async (reason) => {
    if (stopping || reconnecting || !combo) return;

    quickReconnects = Date.now() - sessionStartedAt < 10_000 ? quickReconnects + 1 : 1;
    if (quickReconnects > MAX_QUICK_RECONNECTS) {
      await giveUp(`Gemini Live keeps disconnecting: ${reason}`);
      return;
    }

    liveLog(`reconnecting (${reason})`);
    reconnecting = true;
    const old = session;
    const oldId = activeId;
    session = null;
    switchSession(oldId, old);

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
      if (!stopping) await giveUp(`Gemini Live disconnected: ${err.message}`);
    }
  };

  return {
    id: 'gemini-live',
    meta,

    async start() {
      stopping = false;
      onStatus('connecting', 'Opening the microphone…');
      const opened = await openMicrophone({ onLevel, onChunk, onIssue: onMicIssue, deviceId: options.deviceId });
      meta.mic = opened.label;
      if (stopping) {
        await opened.stop();
        return;
      }
      mic = opened; // audio is buffered from here on

      let result;
      try {
        result = await connectWithFallback(
          orderedAttempts({ relay: Boolean(options.relay), withLanguage: Boolean(languageCodes) }),
        );
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
          (Date.now() - lastTranscriptAt < DRAIN_QUIET_MS || assemblers.get(activeId)?.pending)
        ) {
          await sleep(100);
        }
      }
      // Never lose words that were only shown as interim text.
      for (const id of [...assemblers.keys()]) commitInterim(id);
      onInterim('');
      session?.close();
      session = null;
      buffer = [];
      onStatus('idle');
    },
  };
}
