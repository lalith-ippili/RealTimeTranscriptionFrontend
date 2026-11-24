import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { speakText } from '../lib/tts.js';
import { useToast } from './ToastContext.jsx';

const SpeakerContext = createContext(null);
const STORAGE_KEY = 'bolo.ttsProvider';

const readProvider = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'browser';
  } catch {
    return 'browser';
  }
};

/** One shared player so only one text is read aloud at a time. */
export function SpeakerProvider({ children }) {
  const toast = useToast();
  const [provider, setProviderState] = useState(readProvider);
  const [speakingId, setSpeakingId] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | preparing | speaking
  const [progress, setProgress] = useState(null);
  const controllerRef = useRef(null);

  const setProvider = useCallback((value) => {
    setProviderState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setSpeakingId(null);
    setPhase('idle');
    setProgress(null);
  }, []);

  const speak = useCallback(
    async (id, text) => {
      if (!text?.trim()) return;
      stop();
      const controller = new AbortController();
      controllerRef.current = controller;
      setSpeakingId(id);
      setPhase('preparing');
      try {
        const result = await speakText(text, {
          provider,
          signal: controller.signal,
          onStart: () => setPhase('speaking'),
          onProgress: setProgress,
        });
        if (result?.warning) toast.show(result.warning, { tone: 'warning', duration: 7000 });
      } catch (err) {
        toast.show(err.message, { tone: 'error' });
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setSpeakingId(null);
          setPhase('idle');
          setProgress(null);
        }
      }
    },
    [provider, stop, toast],
  );

  useEffect(() => stop, [stop]);

  const value = useMemo(
    () => ({ provider, setProvider, speak, stop, speakingId, phase, progress }),
    [provider, setProvider, speak, stop, speakingId, phase, progress],
  );

  return <SpeakerContext.Provider value={value}>{children}</SpeakerContext.Provider>;
}

export const useSpeaker = () => {
  const ctx = useContext(SpeakerContext);
  if (!ctx) throw new Error('useSpeaker must be used inside <SpeakerProvider>');
  return ctx;
};
