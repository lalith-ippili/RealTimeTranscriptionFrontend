// Microphone capture → 16 kHz mono Float32 chunks (via an AudioWorklet).
//
// Reliability notes
//  • Browsers only let an AudioContext run if it is created/resumed during a
//    user gesture. Call `primeAudio()` synchronously in the click handler that
//    starts recording; `openMicrophone()` then reuses that running context.
//  • A watchdog reports when no audio arrives at all, or when the microphone
//    only delivers silence (muted / wrong device), via `onIssue`.
//  • Open the console and filter by "[Bolo · Mic]" to see the device and state.

export const TARGET_SAMPLE_RATE = 16000;

const WORKLET_URL = `${import.meta.env.BASE_URL}worklets/pcm-recorder.js`;
const log = (...args) => console.info('[Bolo · Mic]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sharedContext = null;
let workletContext = null; // context the worklet module was loaded into
let workletLoading = null;

const friendlyMicError = (err) => {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow it from the address bar (and in Windows: Settings → Privacy → Microphone), then press record again.';
    case 'NotFoundError':
      return 'No microphone was found. Connect one and press record again.';
    case 'NotReadableError':
      return 'The microphone is being used by another app or tab. Close it and try again.';
    default:
      return err?.message || 'Could not start the microphone.';
  }
};

/**
 * Create (or wake up) the shared AudioContext. Call this synchronously inside
 * the click handler that starts recording so the browser allows it to run.
 */
export function primeAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioCtx({ latencyHint: 'interactive' });
  }
  if (sharedContext.state !== 'running') sharedContext.resume().catch(() => {});
  return sharedContext;
}

const ensureWorklet = async (context) => {
  if (workletContext !== context) {
    workletContext = context;
    workletLoading = context.audioWorklet.addModule(WORKLET_URL).catch((err) => {
      workletContext = null;
      throw err;
    });
  }
  return workletLoading;
};

const ensureRunning = async (context) => {
  if (context.state === 'running') return true;
  try {
    await Promise.race([context.resume(), sleep(1500)]);
  } catch {
    /* ignored – checked below */
  }
  return context.state === 'running';
};

const getStream = async (deviceId) => {
  const audio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
    } catch (err) {
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
      log(`selected microphone is not available (${err.name}), using the default one`);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
};

export const MIC_ISSUES = {
  'no-audio':
    "Your browser isn't sending any audio from the microphone. Stop, then press record again. If it keeps happening, reload the page.",
  silent:
    "No sound is coming from your microphone. Check that it isn't muted (Windows: Settings → System → Sound → Input), or choose another microphone in the settings.",
  ended: 'The microphone was disconnected. Reconnect it, or choose another microphone, and press record again.',
};

/**
 * @param {{
 *   onChunk?: (samples: Float32Array) => void,
 *   onLevel?: (rms: number) => void,
 *   onIssue?: (issue: null | 'no-audio' | 'silent' | 'ended') => void,
 *   deviceId?: string,
 * }} options
 * @returns {Promise<{ stop: () => Promise<void>, sampleRate: number, label: string }>}
 */
export async function openMicrophone({ onChunk, onLevel, onIssue, deviceId } = {}) {
  if (!window.isSecureContext) {
    throw new Error('The microphone only works on HTTPS or localhost.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access a microphone.');
  }

  let stream;
  try {
    stream = await getStream(deviceId);
  } catch (err) {
    throw new Error(friendlyMicError(err));
  }

  const track = stream.getAudioTracks()[0];
  const label = track?.label || 'Default microphone';

  const context = primeAudio();
  if (!context) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('This browser does not support Web Audio.');
  }

  try {
    await ensureWorklet(context);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(`Audio processor failed to load: ${err.message}`);
  }

  const running = await ensureRunning(context);
  log(`using "${label}" – audio engine ${context.state} at ${context.sampleRate} Hz${running ? '' : ' (not running yet)'}`);

  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, 'pcm-recorder', {
    processorOptions: { targetRate: TARGET_SAMPLE_RATE, chunkSize: 1600 },
  });

  // ── Watchdog: no chunks at all, or only silence ──────────────────────
  let lastChunkAt = 0;
  let peakSince = 0; // loudest chunk in the current window
  let windowStart = Date.now();
  let currentIssue = null;
  const report = (issue) => {
    if (issue === currentIssue) return;
    currentIssue = issue;
    if (issue) log(`issue: ${issue}`);
    onIssue?.(issue);
  };

  recorder.port.onmessage = ({ data }) => {
    lastChunkAt = Date.now();
    if (data.rms > peakSince) peakSince = data.rms;
    if (data.rms > 0.002 && currentIssue) report(null);
    onLevel?.(data.rms);
    onChunk?.(data.samples);
  };

  const startedAt = Date.now();
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (!lastChunkAt || now - lastChunkAt > 1500) {
      // No audio frames: the audio engine is probably paused – try to wake it.
      context.resume().catch(() => {});
      if (now - startedAt > 3000) report('no-audio');
      return;
    }
    if (now - windowStart >= 5000) {
      // Digital silence for 5 s → muted or wrong input device.
      if (peakSince < 0.0015) report('silent');
      peakSince = 0;
      windowStart = now;
    }
  }, 1000);

  if (track) {
    track.onended = () => report('ended');
  }

  // Keep the graph pulled without making the mic audible.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(recorder);
  recorder.connect(mute);
  mute.connect(context.destination);

  let stopped = false;
  return {
    sampleRate: TARGET_SAMPLE_RATE,
    label,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(watchdog);
      recorder.port.onmessage = null;
      if (track) track.onended = null;
      try {
        source.disconnect();
        recorder.disconnect();
        mute.disconnect();
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((t) => t.stop());
      // Keep the shared context for the next recording, but let it sleep.
      if (context.state === 'running') context.suspend().catch(() => {});
    },
  };
}

/** Lists microphones (labels are only available after permission was granted). */
export async function listMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(
      (d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications',
    );
  } catch {
    return [];
  }
}

/** Float32 [-1, 1] → 16-bit little-endian PCM → base64 (for Gemini Live). */
export function float32ToPcm16Base64(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
