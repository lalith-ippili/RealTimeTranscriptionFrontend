/**
 * Browser engine – the Web Speech API built into Chrome, Edge and Safari.
 * `hi-IN` handles Hindi–English code-switching reasonably well.
 * Interim results update live; final results are committed per phrase.
 */
import { openMicrophone } from '../lib/microphone.js';

export const isWebSpeechSupported = () =>
  typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

const ERROR_MESSAGES = {
  'not-allowed': 'Microphone access is blocked. Allow it from the address bar, then press record again.',
  'service-not-allowed': 'Speech recognition is disabled in this browser.',
  'audio-capture': 'No microphone was found.',
  network: "The browser's speech service could not be reached. Check your connection.",
  'language-not-supported': 'This browser does not support the selected language.',
};

export function createWebSpeechEngine(callbacks, options = {}) {
  const { onStatus, onText, onInterim, onLevel, onError } = callbacks;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition = null;
  let meter = null;
  let active = false;
  let cancelled = false;

  const build = () => {
    const rec = new Recognition();
    rec.lang = options.language || 'hi-IN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript || '';
        if (result.isFinal) onText(transcript);
        else interim += transcript;
      }
      onInterim(interim);
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      active = false;
      onError(new Error(ERROR_MESSAGES[event.error] || `Speech recognition error: ${event.error}`));
    };

    // Browsers end recognition after a pause – restart while still recording.
    rec.onend = () => {
      onInterim('');
      if (active) {
        try {
          rec.start();
        } catch {
          /* start() throws if called too quickly; onend will fire again */
        }
      } else {
        meter?.stop();
        meter = null;
        onStatus('idle');
      }
    };
    return rec;
  };

  return {
    id: 'web-speech',
    meta: { language: options.language || 'hi-IN' },

    async start() {
      if (!Recognition) {
        throw new Error('This browser has no built-in speech recognition. Use Chrome or Edge, or pick another engine.');
      }
      cancelled = false;
      onStatus('connecting', 'Starting the browser recogniser…');
      // A separate audio tap only powers the level meter.
      meter = await openMicrophone({ onLevel }).catch(() => null);
      if (cancelled) {
        await meter?.stop();
        meter = null;
        return;
      }
      recognition = build();
      active = true;
      recognition.start();
      onStatus('listening');
    },

    async stop() {
      cancelled = true;
      active = false;
      onStatus('stopping', 'Finishing the last words…');
      if (!recognition) {
        await meter?.stop();
        meter = null;
        onStatus('idle');
        return;
      }
      try {
        recognition.stop();
      } catch {
        onStatus('idle');
      }
      await meter?.stop();
      meter = null;
    },
  };
}
