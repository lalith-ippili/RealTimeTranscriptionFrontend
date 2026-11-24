// Script-aware helpers for Hindi–English (code-switched) text.

const DEVANAGARI = /\p{Script=Devanagari}/u;
const LATIN = /\p{Script=Latin}/u;

/** 'deva' | 'latin' | 'neutral' (numbers, punctuation) for a single word. */
export const scriptOf = (word) => {
  if (DEVANAGARI.test(word)) return 'deva';
  if (LATIN.test(word)) return 'latin';
  return 'neutral';
};

/**
 * Split text into words annotated with their script, keeping whitespace so
 * the original text can be rendered faithfully.
 * @returns {{ text: string, script: 'deva'|'latin'|'neutral'|'space' }[]}
 */
export const tokenize = (text = '') =>
  (String(text).match(/\s+|[^\s]+/gu) || []).map((part) => ({
    text: part,
    script: /^\s+$/u.test(part) ? 'space' : scriptOf(part),
  }));

/**
 * Group text into runs of the same script (neutral words join the
 * surrounding run). Used to pick a Hindi or English voice for TTS.
 * @returns {{ script: 'deva'|'latin', text: string }[]}
 */
export const scriptRuns = (text = '') => {
  const runs = [];
  for (const token of tokenize(text)) {
    if (token.script === 'space') {
      if (runs.length) runs[runs.length - 1].text += ' ';
      continue;
    }
    const current = runs[runs.length - 1];
    const script = token.script === 'neutral' ? current?.script ?? 'latin' : token.script;
    if (current && current.script === script) {
      current.text += token.text;
    } else if (current && token.script === 'neutral') {
      current.text += token.text;
    } else {
      runs.push({ script, text: token.text });
    }
  }
  return runs.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
};

/** Share of Devanagari vs Latin words – drives the language mix bar. */
export const scriptMix = (text = '') => {
  let deva = 0;
  let latin = 0;
  for (const token of tokenize(text)) {
    if (token.script === 'deva') deva += 1;
    else if (token.script === 'latin') latin += 1;
  }
  const total = deva + latin;
  return {
    deva,
    latin,
    total,
    devaShare: total ? deva / total : 0,
    latinShare: total ? latin / total : 0,
  };
};

export const countWords = (text = '') =>
  tokenize(text).filter((t) => t.script === 'deva' || t.script === 'latin').length;

export const LANGUAGE_LABELS = {
  hi: 'Hindi',
  en: 'English',
  mixed: 'Hindi + English',
  other: 'Other',
};

export const ENGINE_LABELS = {
  'gemini-live': 'Gemini Live',
  whisper: 'Whisper',
  'web-speech': 'Browser',
  manual: 'Typed',
};
