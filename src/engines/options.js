// Engine options shared by the UI and the engines (kept tiny so the heavy
// engine modules can stay in their own lazily-loaded chunks).

export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-tiny', label: 'Tiny', hint: 'fastest, smallest download' },
  { id: 'onnx-community/whisper-base', label: 'Base', hint: 'good balance' },
  { id: 'onnx-community/whisper-small', label: 'Small', hint: 'most accurate for Hindi, larger download' },
];

export const WHISPER_LANGUAGES = [
  { id: '', label: 'Detect automatically' },
  { id: 'hindi', label: 'Hindi (Devanagari)' },
  { id: 'english', label: 'English' },
];

export const WEB_SPEECH_LANGUAGES = [
  { id: 'hi-IN', label: 'Hindi + English (hi-IN)' },
  { id: 'en-IN', label: 'English, India (en-IN)' },
  { id: 'en-US', label: 'English, US (en-US)' },
];
