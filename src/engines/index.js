// Registry of speech-to-text engines. Each engine module is loaded on demand
// so the heavy SDKs (Gemini, transformers.js) stay out of the main bundle.

export const ENGINES = [
  {
    id: 'gemini-live',
    name: 'Gemini Live',
    kind: 'Cloud',
    description: "Google's real-time transcription. Words appear while you speak, Hindi and English in one sentence.",
  },
  {
    id: 'whisper',
    name: 'Whisper',
    kind: 'Open source, on this device',
    description: 'Runs in your browser after a one-time model download. Audio never leaves your device.',
  },
  {
    id: 'web-speech',
    name: 'Browser',
    kind: 'Built into Chrome and Edge',
    description: "Uses your browser's own recogniser. Nothing to download.",
  },
];

export async function loadEngineFactory(id) {
  switch (id) {
    case 'gemini-live':
      return (await import('./geminiLive.js')).createGeminiLiveEngine;
    case 'whisper':
      return (await import('./whisper.js')).createWhisperEngine;
    case 'web-speech':
      return (await import('./webSpeech.js')).createWebSpeechEngine;
    default:
      throw new Error(`Unknown engine: ${id}`);
  }
}

export const isWebSpeechSupported = () =>
  typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

export { SPOKEN_LANGUAGES, WHISPER_MODELS, engineLanguageOptions, languageHint } from './options.js';
