// Engine options shared by the UI and the engines (kept tiny so the heavy
// engine modules can stay in their own lazily-loaded chunks).

export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-tiny', label: 'Tiny', hint: 'fastest, smallest download' },
  { id: 'onnx-community/whisper-base', label: 'Base', hint: 'good balance' },
  { id: 'onnx-community/whisper-small', label: 'Small', hint: 'most accurate for Hindi, larger download' },
];

/** One language choice for every engine. */
export const SPOKEN_LANGUAGES = [
  { id: 'mixed', label: 'Mixed', title: 'Hindi and English together' },
  { id: 'english', label: 'English', title: 'Mostly English' },
  { id: 'hindi', label: 'हिंदी', title: 'Mostly Hindi' },
];

/** Translate the shared choice into each engine's own setting. */
export const engineLanguageOptions = (engine, language) => {
  if (engine === 'whisper') {
    return { language: language === 'english' ? 'english' : language === 'hindi' ? 'hindi' : '' };
  }
  if (engine === 'web-speech') {
    // Chrome has no mixed mode; hi-IN is the closest (it writes English in Devanagari).
    return { language: language === 'english' ? 'en-IN' : 'hi-IN' };
  }
  return { language }; // Gemini Live: 'mixed' | 'english' | 'hindi'
};

/** One line explaining what the chosen language means for the chosen engine. */
export const languageHint = (engine, language) => {
  if (engine === 'web-speech') {
    if (language === 'english') return 'English (India). Hindi words will be written in English letters.';
    if (language === 'hindi') return 'Hindi (India), written in Devanagari.';
    return "The Browser engine has no true mixed mode, so English words come out in Devanagari. Pick English if you mostly speak English, or use Gemini Live for mixed speech.";
  }
  if (engine === 'whisper') {
    if (language === 'english') return 'Whisper will expect English.';
    if (language === 'hindi') return 'Whisper will expect Hindi and write it in Devanagari.';
    return 'Whisper detects the language of each phrase.';
  }
  if (language === 'english') return 'Gemini will expect mostly English.';
  if (language === 'hindi') return 'Gemini will expect mostly Hindi.';
  return 'Gemini writes Hindi in Devanagari and English in English letters, even within one sentence.';
};
