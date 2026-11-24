// Microphone capture → 16 kHz mono Float32 chunks (via an AudioWorklet).

export const TARGET_SAMPLE_RATE = 16000;

const WORKLET_URL = `${import.meta.env.BASE_URL}worklets/pcm-recorder.js`;

const friendlyMicError = (err) => {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow it from the address bar, then press record again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and press record again.';
    case 'NotReadableError':
      return 'The microphone is being used by another app. Close it and try again.';
    default:
      return err?.message || 'Could not start the microphone.';
  }
};

/**
 * @param {{ onChunk?: (samples: Float32Array) => void, onLevel?: (rms: number) => void }} handlers
 * @returns {Promise<{ stop: () => Promise<void>, sampleRate: number }>}
 */
export async function openMicrophone({ onChunk, onLevel } = {}) {
  if (!window.isSecureContext) {
    throw new Error('The microphone only works on HTTPS or localhost.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access a microphone.');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    throw new Error(friendlyMicError(err));
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx({ latencyHint: 'interactive' });

  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await context.close();
    throw new Error(`Audio processor failed to load: ${err.message}`);
  }

  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, 'pcm-recorder', {
    processorOptions: { targetRate: TARGET_SAMPLE_RATE, chunkSize: 1600 },
  });

  recorder.port.onmessage = ({ data }) => {
    onLevel?.(data.rms);
    onChunk?.(data.samples);
  };

  // Keep the graph pulled without making the mic audible.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(recorder);
  recorder.connect(mute);
  mute.connect(context.destination);

  if (context.state === 'suspended') await context.resume();

  let stopped = false;
  return {
    sampleRate: TARGET_SAMPLE_RATE,
    async stop() {
      if (stopped) return;
      stopped = true;
      recorder.port.onmessage = null;
      try {
        source.disconnect();
        recorder.disconnect();
        mute.disconnect();
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((t) => t.stop());
      await context.close().catch(() => {});
    },
  };
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
