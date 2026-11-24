/**
 * Minimal Gemini Live API client speaking the WebSocket wire protocol directly
 * (no SDK: smaller bundle, and every server field – including
 * `interimInputTranscription` – reaches us untouched).
 *
 * Authenticates with a single-use ephemeral token from our backend.
 *
 * Readiness: like Google's SDK, we do NOT require `setupComplete` before
 * streaming (some models only send it once audio arrives). The session counts
 * as ready when `setupComplete` arrives, when the first server message
 * arrives, or when the socket stays open for a short grace period after the
 * setup message – whichever comes first. A close inside that window is a
 * failed attempt, so the caller can try the next model / API version.
 */

const WS_HOST = 'wss://generativelanguage.googleapis.com';
const decoder = new TextDecoder();

export const liveLog = (...args) => console.info('[Bolo · Gemini]', ...args);

const describeClose = (event) => {
  const reason = event?.reason?.trim();
  if (reason) return reason;
  if (event?.code === 1006) return 'the connection was dropped (network, firewall or an invalid token)';
  return `the connection closed (code ${event?.code ?? 'unknown'})`;
};

/**
 * @param {object} options
 * @param {string} [options.url]        full WebSocket URL (our server relay)
 * @param {string} [options.token]      ephemeral token ("auth_tokens/…") for a direct connection
 * @param {string} [options.apiVersion] 'v1beta' | 'v1alpha' (direct connection)
 * @param {object} options.setup        BidiGenerateContentSetup (wire format)
 * @param {(msg: object) => void} options.onMessage
 * @param {(info: { code: number, reason: string }) => void} [options.onClose]
 * @param {number} [options.openTimeoutMs]  max wait for the socket to open
 * @param {number} [options.graceMs]        open + quiet this long → ready
 */
export function connectLive({
  url: relayUrl,
  token,
  apiVersion,
  setup,
  onMessage,
  onClose,
  openTimeoutMs = 6_000,
  graceMs = 1_200,
}) {
  return new Promise((resolve, reject) => {
    const url =
      relayUrl ||
      `${WS_HOST}/ws/google.ai.generativelanguage.${apiVersion}` +
        `.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`;
    const label = relayUrl ? 'relay' : apiVersion;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    ws.binaryType = 'arraybuffer'; // decode synchronously → messages stay in order

    let settled = false;
    let graceTimer = 0;
    const openTimer = setTimeout(() => fail('Gemini did not answer (connection timed out)'), openTimeoutMs);

    const session = {
      info: null, // { model, mode } announced by our relay
      confirmed: false, // setupComplete received
      gotContent: false, // any transcript/server content received
      get isOpen() {
        return ws.readyState === WebSocket.OPEN;
      },
      sendAudio(base64) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } } }));
        }
      },
      /** Tells Gemini the speaker paused, so it finalises the transcript right away. */
      endAudio() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      },
      close() {
        try {
          ws.close(1000, 'done');
        } catch {
          /* already closed */
        }
      },
    };

    function fail(message) {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(graceTimer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      reject(new Error(message));
    }

    const succeed = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      clearTimeout(graceTimer);
      liveLog(`session ready (${why}) – ${session.info?.model || setup.model}, ${label}`);
      resolve(session);
    };

    ws.onopen = () => {
      clearTimeout(openTimer);
      ws.send(JSON.stringify({ setup }));
      graceTimer = setTimeout(() => succeed('socket open, no error'), graceMs);
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : decoder.decode(event.data));
      } catch {
        return;
      }
      if (message.relay) {
        session.info = message.relay; // our relay says which model it uses
        return;
      }
      if (message.setupComplete) {
        session.confirmed = true;
        succeed('setupComplete');
        return;
      }
      if (message.serverContent) session.gotContent = true;
      succeed('first message');
      onMessage(message);
    };

    ws.onerror = () => {
      /* the close event that follows carries the details */
    };

    ws.onclose = (event) => {
      const reason = describeClose(event);
      if (!settled) {
        liveLog(`connection refused – ${session.info?.model || setup.model}, ${label}: ${reason}`);
        fail(reason);
      } else {
        liveLog(`connection closed (${event.code}): ${reason}`);
        onClose?.({ code: event.code, reason });
      }
    };
  });
}
