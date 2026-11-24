/**
 * Pure helper behind the running transcript: appends committed text, or
 * replaces the last segment when an engine sends a newer version of it.
 *
 * state: { text, segmentStart } – segmentStart is where the last segment
 * begins in `text` (-1 when there is nothing that may be revised).
 *
 * opts:
 *   replace  – `chunk` is a newer version of the last segment
 *   raw      – append `chunk` exactly as sent (word pieces / deltas)
 *   newTurn  – with raw: `chunk` starts a new segment
 */
export function applyText(state, chunk, { raw = false, newTurn = false, replace = false } = {}) {
  const { text: prev, segmentStart: start } = state;
  if (!chunk) return state;

  if (replace && start >= 0 && start <= prev.length) {
    const clean = chunk.replace(/\s+/gu, ' ').trim();
    if (!clean) return state;
    const base = prev.slice(0, start);
    const sep = base && !/\s$/u.test(base) ? ' ' : '';
    return { text: `${base}${sep}${clean}`, segmentStart: base.length + sep.length };
  }

  if (raw) {
    if (!prev) return { text: chunk.trimStart(), segmentStart: 0 };
    const needsSpace = newTurn && !/\s$/u.test(prev) && !/^\s/u.test(chunk);
    const text = `${prev}${needsSpace ? ' ' : ''}${chunk}`;
    // A new turn opens a new segment; a continuation piece extends the open one.
    const segmentStart = newTurn || start < 0 ? text.length - chunk.trimStart().length : start;
    return { text, segmentStart };
  }

  const clean = chunk.replace(/\s+/gu, ' ').trim();
  if (!clean) return state;
  const base = prev ? `${prev.replace(/\s+$/u, '')} ` : '';
  return { text: base + clean, segmentStart: base.length };
}
