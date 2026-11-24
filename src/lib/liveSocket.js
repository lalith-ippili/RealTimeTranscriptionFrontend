/**
 * Minimal Gemini Live API client speaking the WebSocket wire protocol directly
 * (no SDK: smaller bundle, and every server field – including
 * `interimInputTranscription` – reaches us untouched).
 *
 * Authenticates with a single-use ephemeral token from our backend.
 */

const WS_HOST = 'wss://generativelanguage.googleapis.com';
const decoder = new TextDecoder();

const describeClose = (event) => {
  const reason = event?.reason?.trim();
  if (reason) return reason;
  if (event?.code === 1006) return 'the connection was dropped (network or firewall)';
  return `the connection closed (code ${event?.code ?? 'unknown'})`;
};

/**
 * Opens a Live session and resolves once Gemini confirms the setup.
 *
 * @param {object} options
 * @param {string} options.token        ephemeral token ("auth_tokens/…")
 * @param {string} options.apiVersion   'v1beta' | 'v1alpha'
 * @param {object} options.setup        BidiGenerateContentSetup (wire format)
 * @param {(msg: object) => void} options.onMessage
 * @param {(info: { code: number, reason: string }) => void} [options.onClose]
 * @param {number} [options.timeoutMs]
 */
export function connectLive({ token, apiVersion, setup, onMessage, onClose, timeoutMs = 12_000 }) {
  return new Promise((resolve, reject) => {
    const url =
      `${WS_HOST}/ws/google.ai.generativelanguage.${apiVersion}` +
      `.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    ws.binaryType = 'arraybuffer'; // decode synchronously → messages stay in order

    let ready = false;
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('Gemini Live did not respond in time'), timeoutMs);

    const session = {
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

    ws.onopen = () => ws.send(JSON.stringify({ setup }));

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : decoder.decode(event.data));
      } catch {
        return;
      }
      if (!ready) {
        if (message.setupComplete) {
          ready = true;
          settled = true;
          clearTimeout(timer);
          resolve(session);
        }
        return;
      }
      onMessage(message);
    };

    ws.onerror = () => {
      /* the close event that follows carries the details */
    };

    ws.onclose = (event) => {
      if (!ready) fail(describeClose(event));
      else onClose?.({ code: event.code, reason: describeClose(event) });
    };
  });
}
