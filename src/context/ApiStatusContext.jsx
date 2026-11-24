import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client.js';

const ApiStatusContext = createContext(null);

const WAKING_AFTER_MS = 2_500; // slower than this → assume the free-tier server is booting
const GIVE_UP_AFTER_MS = 100_000;
const RETRY_EVERY_MS = 4_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Checks /api/health on load (which also wakes a sleeping Render instance)
 * and exposes what the UI can rely on.
 *
 * phase: checking → (waking) → online | degraded (DB down) | offline
 */
export function ApiStatusProvider({ children }) {
  const [state, setState] = useState({
    phase: 'checking',
    database: false,
    dbHint: null,
    gemini: false,
    model: null,
  });
  const runId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++runId.current;
    const started = Date.now();
    setState((s) => ({ ...s, phase: 'checking' }));
    const wakeTimer = setTimeout(() => {
      if (runId.current === id) setState((s) => (s.phase === 'checking' ? { ...s, phase: 'waking' } : s));
    }, WAKING_AFTER_MS);

    try {
      while (runId.current === id) {
        try {
          const health = await api.health();
          if (runId.current !== id) return;
          const dbUp = health?.database?.status === 'up';
          setState({
            phase: dbUp ? 'online' : 'degraded',
            database: dbUp,
            dbHint: dbUp ? null : health?.database?.hint || null,
            gemini: Boolean(health?.engines?.geminiLive?.available),
            model: health?.engines?.geminiLive?.model || null,
          });
          return;
        } catch {
          if (Date.now() - started > GIVE_UP_AFTER_MS) break;
          setState((s) => ({ ...s, phase: 'waking' }));
          await sleep(RETRY_EVERY_MS);
        }
      }
      if (runId.current === id) {
        setState({ phase: 'offline', database: false, dbHint: null, gemini: false, model: null });
      }
    } finally {
      clearTimeout(wakeTimer);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      ...state,
      loading: state.phase === 'checking' || state.phase === 'waking',
      waking: state.phase === 'waking',
      online: state.phase === 'online' || state.phase === 'degraded',
      refresh,
    }),
    [state, refresh],
  );
  return <ApiStatusContext.Provider value={value}>{children}</ApiStatusContext.Provider>;
}

export const useApiStatus = () => {
  const ctx = useContext(ApiStatusContext);
  if (!ctx) throw new Error('useApiStatus must be used inside <ApiStatusProvider>');
  return ctx;
};
