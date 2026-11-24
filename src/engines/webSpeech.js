/**
 * Browser engine – the Web Speech API built into Chrome, Edge and Safari.
 *
 * Chrome ends a recognition session by itself after a pause or about a minute.
 * To keep dictation running we:
 *  • restart after a short delay (an immediate restart is often refused),
 *    retrying with a fresh recogniser if needed;
 *  • keep words that were still interim when a session ended;
 *  • watch the microphone: if you are clearly speaking but no results arrive
 *    for a few seconds, the recogniser is restarted.
 */
import { openMicrophone } from '../lib/microphone.js';

const RESTART_DELAY_MS = 250;
const MAX_RESTART_FAILURES = 6;
const STALL_SPEECH_MS = 4_000; // this much speech with no results → restart

export const isWebSpeechSupported = () =>
  typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

const log = (...args) => console.info('[Bolo · Browser]', ...args);

const ERROR_MESSAGES = {
  'not-allowed': 'Microphone access is blocked. Allow it from the address bar, then press record again.',
  'service-not-allowed': 'Speech recognition is disabled in this browser.',
  'audio-capture': 'No microphone was found.',
  network: "The browser's speech service could not be reached. Check your internet connection.",
  'language-not-supported': 'This browser does not support the selected language.',
};

export function createWebSpeechEngine(callbacks, options = {}) {
  const { onStatus, onText, onInterim, onLevel, onError, onMicIssue } = callbacks;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const lang = options.language || 'en-IN';

  let recognition = null;
  let meter = null;
  let active = false;
  let cancelled = false;
  let restartTimer = 0;
  let restartFailures = 0;
  let pendingInterim = '';
  let voicedSinceResult = 0; // ms of speech heard since the last result
  let watchdog = 0;

  const meta = { language: lang };

  let finished = false;
  const finishIdle = async () => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    clearTimeout(restartTimer);
    await meter?.stop();
    meter = null;
    onStatus('idle');
  };

  const scheduleRestart = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restart, RESTART_DELAY_MS * (restartFailures + 1));
  };

  const restart = () => {
    if (!active) return;
    try {
      recognition.start();
    } catch (err) {
      restartFailures += 1;
      log(`restart refused (${err?.name || err}); attempt ${restartFailures}`);
      if (restartFailures > MAX_RESTART_FAILURES) {
        active = false;
        onError(new Error('The browser stopped listening. Press record to continue.'));
        finishIdle();
        return;
      }
      recognition = build(); // a fresh instance usually starts fine
      scheduleRestart();
    }
  };

  function build() {
    const rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalized = 0; // results of this session already committed (never commit one twice)

    rec.onstart = () => {
      restartFailures = 0;
      voicedSinceResult = 0;
      finalized = 0;
    };

    rec.onresult = (event) => {
      voicedSinceResult = 0;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript || '';
        if (result.isFinal) {
          if (i >= finalized) {
            onText(transcript);
            finalized = i + 1;
          }
        } else {
          interim += transcript;
        }
      }
      pendingInterim = interim;
      onInterim(interim);
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return; // onend restarts
      if (event.error === 'network') {
        log('network error – will retry');
        return; // transient: onend → restart
      }
      active = false;
      onError(new Error(ERROR_MESSAGES[event.error] || `Speech recognition error: ${event.error}`));
    };

    rec.onend = () => {
      // Keep words that were never finalised before the session ended.
      if (pendingInterim.trim()) onText(pendingInterim);
      pendingInterim = '';
      onInterim('');
      if (active) {
        log('session ended – restarting');
        scheduleRestart();
      } else {
        finishIdle();
      }
    };
    return rec;
  }

  // Restart a recogniser that went quiet while the person is clearly talking.
  // Speech is counted in 100 ms chunks, so normal pauses don't reset it.
  const handleLevel = (rms) => {
    onLevel?.(rms);
    if (active && rms > 0.02) voicedSinceResult += 100;
  };

  const checkStall = () => {
    if (!active || !recognition || voicedSinceResult < STALL_SPEECH_MS) return;
    log('speech heard but no results – restarting the recogniser');
    voicedSinceResult = 0;
    try {
      recognition.abort(); // → onend → restart
    } catch {
      recognition = build();
      scheduleRestart();
    }
  };

  return {
    id: 'web-speech',
    meta,

    async start() {
      if (!Recognition) {
        throw new Error('This browser has no built-in speech recognition. Use Chrome or Edge, or pick another engine.');
      }
      cancelled = false;
      finished = false;
      onStatus('connecting', 'Starting the browser recogniser…');
      // A separate audio tap powers the level meter and the stall check.
      meter = await openMicrophone({ onLevel: handleLevel, onIssue: onMicIssue }).catch(() => null);
      if (meter) meta.mic = meter.label;
      if (cancelled) {
        await meter?.stop();
        meter = null;
        return;
      }
      recognition = build();
      active = true;
      recognition.start();
      watchdog = setInterval(checkStall, 1_000);
      log(`listening (${lang})`);
      onStatus('listening');
    },

    async stop() {
      cancelled = true;
      active = false;
      clearTimeout(restartTimer);
      onStatus('stopping', 'Finishing the last words…');
      if (!recognition) {
        await finishIdle();
        return;
      }
      try {
        recognition.stop(); // onend → finishIdle
      } catch {
        /* already stopped */
      }
      // Between sessions there may be no onend – don't leave the mic open.
      setTimeout(finishIdle, 1_500);
    },
  };
}
