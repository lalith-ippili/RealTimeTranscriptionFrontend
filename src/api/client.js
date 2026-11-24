// Thin fetch wrapper around the backend REST API with timeouts and retries.
// Render's free tier sleeps when idle; the first request can take ~30–60 s.

const PRODUCTION_API = 'https://real-time-transcription-i1g0.onrender.com';
const DEFAULT_API = import.meta.env.DEV ? 'http://localhost:5000' : PRODUCTION_API;

export const API_URL = (import.meta.env.VITE_API_URL || DEFAULT_API).replace(/\/+$/, '');

const DEFAULT_TIMEOUT_MS = 45_000;

export class ApiError extends Error {
  constructor(message, status, details, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Network failures and gateway errors (server waking up / redeploying) are worth one more try.
const isRetryable = (err) => err instanceof ApiError && (err.status === 0 || err.status === 502 || err.status === 504);

async function send(path, { method, body, query, signal, timeout }) {
  const url = new URL(`${API_URL}/api${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }

  // Combine the caller's AbortSignal with our timeout.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (signal?.aborted) throw err; // caller cancelled – not an error to show
    if (timedOut) {
      throw new ApiError('The server took too long to answer. If it was asleep, try again in a moment.', 0);
    }
    throw new ApiError(`Can't reach the server at ${API_URL}. Check your connection and try again.`, 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || `Request failed (${response.status})`;
    const details = data?.error?.details;
    const detailText = Array.isArray(details) && details.length ? `: ${details[0].message}` : '';
    throw new ApiError(`${message}${detailText}`, response.status, details, data);
  }
  return data;
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const retries = options.retries ?? (method === 'GET' ? 1 : 0);
  const opts = { ...options, method, timeout: options.timeout ?? DEFAULT_TIMEOUT_MS };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send(path, opts);
    } catch (err) {
      if (attempt < retries && isRetryable(err) && !options.signal?.aborted) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

export const api = {
  // /health answers 503 (with the same body) when the database is down.
  health: (opts = {}) =>
    request('/health', { timeout: 70_000, retries: 0, ...opts }).catch((err) => {
      if (err instanceof ApiError && err.status === 503 && err.data) return err.data;
      throw err;
    }),

  // body: { variant?: 'primary'|'fallback', apiVersion?: 'v1beta'|'v1alpha' }
  createLiveToken: (body = {}) => request('/live/token', { method: 'POST', body, timeout: 70_000 }),

  listTranscriptions: (query, opts) => request('/transcriptions', { query, ...opts }),
  getStats: (opts) => request('/transcriptions/stats', opts),
  getTranscription: (id) => request(`/transcriptions/${id}`),
  createTranscription: (body) => request('/transcriptions', { method: 'POST', body }),
  updateTranscription: (id, body) => request(`/transcriptions/${id}`, { method: 'PATCH', body }),
  deleteTranscription: (id) => request(`/transcriptions/${id}`, { method: 'DELETE' }),
  deleteTranscriptions: (ids) => request('/transcriptions', { method: 'DELETE', body: { ids } }),
};

export default api;
