import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadEngineFactory } from '../engines/index.js';
import { applyText } from '../lib/transcriptText.js';

/**
 * Drives one speech-to-text engine and keeps the running transcript.
 *
 * status: idle → (loading) → connecting → listening → stopping → idle
 * Engines report text through:
 *   onText(text)                    committed text, starts a new segment
 *   onText(text, { replace: true }) a newer version of the last segment
 *                                   (Gemini re-sends the whole turn at each pause)
 *   onText(text, { raw, newTurn })  append-only deltas (raw = no spacing changes)
 *   onInterim(text)                 provisional text for the current phrase
 *
 * The transcript lives in a ref (the source of truth for engine callbacks) and
 * is mirrored to state for rendering, so updates stay pure under StrictMode.
 *
 * Performance: the microphone level (10×/s) and the running clock are NOT React
 * state. Levels go through a tiny pub/sub that components paint directly, and
 * the clock is derived from `timing`, which only changes on start/stop – so the
 * page re-renders only when text or status actually change.
 */
export function useTranscriber() {
  const [status, setStatus] = useState('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [transcript, setTranscriptState] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [timing, setTiming] = useState({ accumulatedMs: 0, since: 0 });
  const [enginesUsed, setEnginesUsed] = useState([]);
  const [lastMeta, setLastMeta] = useState({});
  const [speaking, setSpeaking] = useState(false);
  const [micIssue, setMicIssue] = useState(null); // null | 'no-audio' | 'silent' | 'ended'
  const [warning, setWarning] = useState(null); // engine-specific hint (e.g. Gemini returns no text)

  const engineRef = useRef(null);
  const textRef = useRef('');
  const segmentStartRef = useRef(-1); // where the revisable last segment starts (-1: none)
  const timingRef = useRef({ accumulatedMs: 0, since: 0 });
  const levelListeners = useRef(new Set());
  const voice = useRef({ on: false, lastVoiceAt: 0 });

  const subscribeLevel = useCallback((listener) => {
    levelListeners.current.add(listener);
    return () => levelListeners.current.delete(listener);
  }, []);

  const emitLevel = useCallback((value) => {
    levelListeners.current.forEach((fn) => fn(value));
  }, []);

  const getElapsedMs = useCallback(() => {
    const { accumulatedMs, since } = timingRef.current;
    return accumulatedMs + (since ? Date.now() - since : 0);
  }, []);

  const updateTiming = useCallback((next) => {
    timingRef.current = next;
    setTiming(next);
  }, []);

  const writeTranscript = useCallback((next) => {
    textRef.current = next;
    setTranscriptState(next);
  }, []);

  /** Manual edits (and reset): the old segment can no longer be revised. */
  const setTranscript = useCallback(
    (next) => {
      segmentStartRef.current = -1;
      writeTranscript(typeof next === 'function' ? next(textRef.current) : next);
    },
    [writeTranscript],
  );

  const appendText = useCallback(
    (text, opts) => {
      const current = { text: textRef.current, segmentStart: segmentStartRef.current };
      const next = applyText(current, text, opts);
      if (next === current) return;
      segmentStartRef.current = next.segmentStart;
      if (next.text !== current.text) writeTranscript(next.text);
    },
    [writeTranscript],
  );

  const handleStatus = useCallback(
    (next, detail = '') => {
      const current = timingRef.current;
      if (next === 'listening' && !current.since) {
        updateTiming({ accumulatedMs: current.accumulatedMs, since: Date.now() });
      } else if (next !== 'listening' && current.since) {
        updateTiming({ accumulatedMs: current.accumulatedMs + (Date.now() - current.since), since: 0 });
      }
      if (next === 'idle') {
        engineRef.current = null;
        voice.current.on = false;
        setSpeaking(false);
        setMicIssue(null);
        setWarning(null);
        emitLevel(0);
        setInterim('');
        setProgress(null);
      }
      setStatus(next);
      setStatusDetail(detail);
    },
    [emitLevel, updateTiming],
  );

  // `speaking` flips only when speech starts or stops (≈700 ms hang time),
  // so it can drive a "hearing you" indicator without re-rendering per chunk.
  const handleLevel = useCallback(
    (rms) => {
      emitLevel(Math.min(1, Math.sqrt(rms) * 2.4));
      const now = Date.now();
      const state = voice.current;
      if (rms > 0.008) {
        state.lastVoiceAt = now;
        if (!state.on) {
          state.on = true;
          setSpeaking(true);
        }
      } else if (state.on && now - state.lastVoiceAt > 700) {
        state.on = false;
        setSpeaking(false);
      }
    },
    [emitLevel],
  );

  const start = useCallback(
    async (engineId, options = {}) => {
      if (engineRef.current) return;
      segmentStartRef.current = -1; // a new recording never rewrites earlier text
      setError(null);
      setMicIssue(null);
      setWarning(null);
      setStatus('connecting');
      setStatusDetail('Preparing…');
      try {
        const factory = await loadEngineFactory(engineId);
        const engine = factory(
          {
            onStatus: handleStatus,
            onText: appendText,
            onInterim: setInterim,
            onLevel: handleLevel,
            onProgress: setProgress,
            onMicIssue: setMicIssue,
            onWarning: setWarning,
            onError: (err) => setError(err?.message || String(err)),
          },
          options,
        );
        engineRef.current = engine;
        await engine.start();
        setEnginesUsed((list) => (list.includes(engineId) ? list : [...list, engineId]));
        setLastMeta({ engine: engineId, ...engine.meta });
      } catch (err) {
        setError(err?.message || String(err));
        engineRef.current = null;
        handleStatus('idle');
      }
    },
    [appendText, handleLevel, handleStatus],
  );

  const stop = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      await engine.stop();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      if (engineRef.current === engine) handleStatus('idle');
    }
  }, [handleStatus]);

  const reset = useCallback(() => {
    if (engineRef.current) return;
    setTranscript('');
    setInterim('');
    setError(null);
    setEnginesUsed([]);
    setLastMeta({});
    updateTiming({ accumulatedMs: 0, since: 0 });
  }, [setTranscript, updateTiming]);

  const clearError = useCallback(() => setError(null), []);

  // Stop the microphone if the page unmounts mid-recording.
  useEffect(
    () => () => {
      engineRef.current?.stop().catch(() => {});
    },
    [],
  );

  return useMemo(
    () => ({
      status,
      statusDetail,
      isActive: status !== 'idle',
      isListening: status === 'listening',
      speaking,
      micIssue,
      warning,
      transcript,
      setTranscript,
      interim,
      error,
      clearError,
      progress,
      timing,
      getElapsedMs,
      subscribeLevel,
      enginesUsed,
      lastMeta,
      start,
      stop,
      reset,
    }),
    [
      status,
      statusDetail,
      speaking,
      micIssue,
      warning,
      transcript,
      setTranscript,
      interim,
      error,
      clearError,
      progress,
      timing,
      getElapsedMs,
      subscribeLevel,
      enginesUsed,
      lastMeta,
      start,
      stop,
      reset,
    ],
  );
}
