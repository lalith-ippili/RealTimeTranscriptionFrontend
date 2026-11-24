import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPrefix, createAssembler, toWords } from './transcriptAssembler.js';
import { applyText } from './transcriptText.js';

/** Feeds events through the assembler into a transcript, like the app does. */
function harness() {
  let clock = 0;
  let state = { text: '', segmentStart: -1 };
  let interim = '';
  const assembler = createAssembler({
    now: () => clock,
    onInterim: (t) => {
      interim = t;
    },
    onFinal: (t, opts) => {
      state = applyText(state, t, opts);
    },
  });
  return {
    interimEvent(text, after = 300) {
      clock += after;
      assembler.addInterim(text);
    },
    finalEvent(text, after = 300) {
      clock += after;
      assembler.addFinal(text);
    },
    flush: () => assembler.flush(),
    get text() {
      return state.text;
    },
    get interim() {
      return interim;
    },
  };
}

test('cumulative finals of one turn replace each other instead of repeating', () => {
  // The exact pattern from a real session: each pause re-sends the whole turn.
  const h = harness();
  h.interimEvent('Yeah, hi. I am am audible');
  h.finalEvent('Yeah, hi. I am am audible to you?');
  h.interimEvent('Yeah, hi. I am am audible to you? But');
  assert.equal(h.interim, 'But', 'interim shows only the new words');
  h.finalEvent('Yeah, hi. I am am audible to you? But');
  h.finalEvent('Yeah, hi. I am am audible to you? But', 1000);
  h.finalEvent('Yeah, hi. I am am audible to you? But', 1000);
  h.finalEvent('Yeah, hi. I am audible to you? But', 1000);
  assert.equal(h.text, 'Yeah, hi. I am audible to you? But');

  // Next turn, revised several times.
  h.interimEvent('We', 1500);
  h.finalEvent('We again');
  h.interimEvent('Way again again again');
  h.finalEvent('Way again again again');
  h.finalEvent('Way again again again displayed.');
  h.finalEvent('Way again again again displayed.', 1000);
  h.finalEvent('Why again again again displayed?', 1000);
  assert.equal(h.text, 'Yeah, hi. I am audible to you? But Why again again again displayed?');
});

test('separate phrases are appended', () => {
  const h = harness();
  h.interimEvent('मुझे कल');
  h.interimEvent('मुझे कल office');
  h.finalEvent('मुझे कल office जाना है।');
  h.interimEvent('for the', 1500);
  h.interimEvent('for the client meeting');
  h.finalEvent('for the client meeting');
  h.finalEvent('Please send the slides.', 2000);
  assert.equal(h.text, 'मुझे कल office जाना है। for the client meeting Please send the slides.');
});

test('a new turn that starts with similar words is still appended', () => {
  const h = harness();
  h.finalEvent('So I went home.');
  h.finalEvent('So then we left early.', 3000);
  assert.equal(h.text, 'So I went home. So then we left early.');
});

test('word pieces are joined, and a repeated short final is ignored', () => {
  const h = harness();
  h.finalEvent('Ho');
  h.finalEvent('w are you', 200);
  assert.equal(h.text, 'How are you');

  const r = harness();
  r.finalEvent('Hello everyone, welcome to the meeting.');
  r.finalEvent('Hello everyone,', 500); // the start of the same turn re-sent
  assert.equal(r.text, 'Hello everyone, welcome to the meeting.');
});

test('piece-style interim text is joined and kept when the final is only the last piece', () => {
  const h = harness();
  h.interimEvent('मुझे');
  h.interimEvent(' कल');
  h.interimEvent(' office');
  h.finalEvent(' जाना है');
  assert.equal(h.text, 'मुझे कल office जाना है');
});

test('flush commits pending interim text as a revision of the open turn', () => {
  const h = harness();
  h.finalEvent('I am speaking');
  h.interimEvent('I am speaking in English and');
  assert.equal(h.interim, 'in English and');
  h.flush();
  assert.equal(h.text, 'I am speaking in English and');
  assert.equal(h.interim, '');
});

test('alignPrefix scores near-identical turns high and different ones low', () => {
  const a = toWords('Way again again again displayed.');
  assert.ok(alignPrefix(a, toWords('Why again again again displayed?')).score > 0.9);
  assert.ok(alignPrefix(toWords('We again'), toWords('Way again again again')).score >= 0.6);
  assert.ok(alignPrefix(toWords('Hello there'), toWords('Goodbye now')).score < 0.3);
  const { end } = alignPrefix(toWords('Yeah, hi. I am am audible to you?'), toWords('Yeah, hi. I am audible to you? But'));
  assert.equal(end, 7);
});

test('applyText replaces only the last segment', () => {
  let s = { text: 'Earlier text.', segmentStart: -1 };
  s = applyText(s, 'Hello', { replace: true }); // nothing to revise yet → appended
  assert.equal(s.text, 'Earlier text. Hello');
  s = applyText(s, 'Hello world', { replace: true });
  assert.equal(s.text, 'Earlier text. Hello world');
  s = applyText(s, 'Next one');
  s = applyText(s, 'Next one here', { replace: true });
  assert.equal(s.text, 'Earlier text. Hello world Next one here');
  s = applyText(s, ' piece', { raw: true });
  s = applyText(s, 'Next one here and more', { replace: true });
  assert.equal(s.text, 'Earlier text. Hello world Next one here and more');
});
