/**
 * Turns Gemini's transcript events into clean text, without repeating words.
 *
 * How gemini-3.5-transcribe-live reports a turn (what you say until a longer
 * pause):
 *  • interim text is the growing hypothesis of the turn;
 *  • final text arrives at every short pause and is CUMULATIVE: each final
 *    repeats the whole turn so far, often with corrections, and the same
 *    final can arrive more than once:
 *      "Yeah, hi. I am am audible to you?"
 *      "Yeah, hi. I am am audible to you? But"      ← same turn, longer
 *      "Yeah, hi. I am audible to you? But"         ← same turn, corrected
 *      "We again" → "Way again again again" → "Why again again again displayed?"
 *  • the next turn starts from scratch.
 *
 * Appending every final therefore repeats sentences. Instead, the last
 * committed segment stays open: a final that is a newer version of it
 * REPLACES it (`onFinal(text, { replace: true })`), a repeat of it is ignored,
 * and anything else starts a new segment. Interim text that repeats the
 * committed words only shows the new words.
 *
 * Word-by-word pieces (" कल", " office") are still supported: they are joined.
 */

const norm = (t) => t.replace(/\s+/gu, ' ').trim();
const firstWord = (t) => norm(t).split(' ')[0] || '';

// Letters + combining marks (Devanagari matras/virama), digits, apostrophes.
const WORD_RE = /[\p{L}\p{M}\p{N}']+/gu;
export const toWords = (t) => (t.toLowerCase().match(WORD_RE) || []);

/** A final this similar (0–1) to the open segment is a newer version of it. */
const REVISION_SCORE = 0.6;
/** A shorter repeat of the open segment within this window is a re-send. */
const REPEAT_WINDOW_MS = 6_000;
/** Finals this close together with no interim between are word pieces. */
const PIECE_WINDOW_MS = 800;

const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/** Does `next` look like a newer version of the same phrase as `prev`? */
export const looksLikeRevision = (prev, next) => {
  const a = norm(prev);
  const b = norm(next);
  if (!a || !b) return true;
  if (b.startsWith(a) || a.startsWith(b)) return true;
  if (firstWord(a) === firstWord(b)) return true;
  return commonPrefix(a, b) >= Math.min(4, a.length);
};

/** Append a piece of text, adding a space only where one is needed. */
export const joinPiece = (prev, piece) => {
  if (!prev) return piece.replace(/^\s+/u, '');
  if (/^\s/u.test(piece) || /\s$/u.test(prev)) return prev + piece;
  if (/^[,.!?।॥;:)\]]/u.test(piece)) return prev + piece; // punctuation sticks to the word
  return `${prev} ${piece}`;
};

/** Character edit distance between two (short) words. */
const editDistance = (a, b) => {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

/** 0 for the same word, up to 1 for unrelated words ("way" vs "why" ≈ 0.33). */
const wordCost = (a, b) => (a === b ? 0 : editDistance(a, b) / Math.max(a.length, b.length));

/**
 * How well do the words `a` match the beginning of the words `b`?
 * Word-level edit distance where similar words cost less than different ones.
 * @returns {{ score: number, end: number }} score 0–1 and how many words of
 *   `b` the match covers (the rest of `b` is new).
 */
export const alignPrefix = (a, b) => {
  const n = a.length;
  const m = b.length;
  if (!n) return { score: 1, end: 0 };
  let same = 0;
  while (same < n && same < m && a[same] === b[same]) same += 1;
  if (same === n) return { score: 1, end: n }; // fast path: `b` extends `a`

  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + wordCost(a[i - 1], b[j - 1]));
    }
    prev = cur;
  }
  let best = Infinity;
  let end = 0;
  for (let j = 0; j <= m; j++) {
    if (prev[j] < best - 1e-9) {
      best = prev[j];
      end = j;
    }
  }
  return { score: Math.max(0, 1 - best / n), end };
};

/** The part of `text` after its first `count` words ("…to you? But" → "But"). */
const textAfterWords = (text, count) => {
  if (count <= 0) return norm(text);
  let seen = 0;
  for (const match of text.matchAll(WORD_RE)) {
    seen += 1;
    if (seen === count) {
      return norm(text.slice(match.index + match[0].length).replace(/^[^\p{L}\p{M}\p{N}]+/u, ''));
    }
  }
  return '';
};

/**
 * @param {{
 *   onInterim: (text: string) => void,
 *   onFinal: (text: string, opts?: { raw?: boolean, replace?: boolean }) => void,
 *   now?: () => number,
 * }} handlers
 */
export function createAssembler({ onInterim, onFinal, now = () => Date.now() }) {
  let interim = ''; // current hypothesis (the whole turn when cumulative)
  let style = 'unknown'; // 'cumulative' | 'delta' (how interim text arrives)
  let deltaVotes = 0;
  let lastFinalAt = 0;

  // The last committed text, which a later final may still revise.
  let segment = '';
  let segmentWords = [];
  let segmentAt = 0;

  const openSegment = (text) => {
    segment = text;
    segmentWords = toWords(text);
    segmentAt = now();
  };

  /** How does `text` relate to the open segment? */
  const relate = (text) => {
    if (!segmentWords.length) return { kind: 'new' };
    const words = toWords(text);
    if (!words.length) return { kind: 'new' };
    const forward = alignPrefix(segmentWords, words); // continues / corrects the segment
    if (forward.score >= REVISION_SCORE) return { kind: 'revision', end: forward.end };
    const backward = alignPrefix(words, segmentWords); // restarts the segment from its beginning
    if (backward.score >= REVISION_SCORE) return { kind: 'repeat' };
    return { kind: 'new' };
  };

  const showInterim = () => {
    if (!interim.trim()) {
      onInterim('');
      return;
    }
    const rel = relate(interim);
    if (rel.kind === 'revision') onInterim(textAfterWords(interim, rel.end));
    else if (rel.kind === 'repeat') onInterim('');
    else onInterim(interim);
  };

  const commit = (text, { piece = false } = {}) => {
    const clean = norm(text);
    if (!clean) return;
    const rel = relate(clean);

    if (rel.kind === 'revision') {
      if (clean !== norm(segment)) onFinal(clean, { replace: true });
      openSegment(clean);
      return;
    }
    if (rel.kind === 'repeat' && now() - segmentAt < REPEAT_WINDOW_MS) return; // re-sent start of the turn

    if (piece && segment) {
      // A word piece ("Ho" + "w") continues the open segment as is.
      onFinal(text, { raw: true });
      openSegment(segment + text);
      return;
    }
    onFinal(clean);
    openSegment(clean);
  };

  return {
    get pending() {
      return interim;
    },
    get style() {
      return style;
    },

    addInterim(text) {
      if (typeof text !== 'string') return;
      if (!interim) {
        interim = text.replace(/^\s+/u, '');
      } else if (style === 'delta') {
        interim = joinPiece(interim, text);
      } else if (looksLikeRevision(interim, text)) {
        const a = norm(interim);
        const b = norm(text);
        if (b.length > a.length && b.startsWith(a)) style = 'cumulative';
        interim = text;
      } else {
        // Unrelated text: a new piece (or the next phrase) – keep both.
        deltaVotes += 1;
        if (deltaVotes >= 2 && style !== 'cumulative') style = 'delta';
        interim = joinPiece(interim, text);
      }
      showInterim();
    },

    addFinal(text) {
      if (typeof text !== 'string' || !text.trim()) return;
      const hadInterim = Boolean(interim.trim());
      let finalText = text;
      if (hadInterim && style !== 'cumulative') {
        // With piece-style interim text the final may be just the last piece.
        const complete = looksLikeRevision(interim, text) || norm(text).length >= norm(interim).length * 0.7;
        if (!complete) finalText = joinPiece(interim, text);
      }
      interim = '';
      onInterim('');

      const t = now();
      const piece = !hadInterim && t - lastFinalAt < PIECE_WINDOW_MS;
      lastFinalAt = t;
      commit(finalText, { piece });
    },

    /** Commit whatever is still pending (on stop / reconnect). */
    flush() {
      const pending = interim;
      interim = '';
      onInterim('');
      if (pending.trim()) commit(pending);
    },
  };
}
