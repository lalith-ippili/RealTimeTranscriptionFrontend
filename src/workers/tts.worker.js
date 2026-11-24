/**
 * Web Worker: open-source text-to-speech with Meta's MMS-TTS (VITS) models,
 * run in the browser via transformers.js. One model per script:
 *   Devanagari → Xenova/mms-tts-hin,  Latin → Xenova/mms-tts-eng
 *
 * in : { type: 'speak', jobId, script: 'deva'|'latin', text }
 * out: { type: 'progress', loaded, total, file }
 *      { type: 'audio', jobId, audio: Float32Array, samplingRate }
 *      { type: 'error', jobId, message }
 */
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

const MODELS = {
  deva: 'Xenova/mms-tts-hin',
  latin: 'Xenova/mms-tts-eng',
};

const synths = {};

const progress = (event) => {
  if (event.status === 'progress') {
    self.postMessage({ type: 'progress', file: event.file, loaded: event.loaded, total: event.total });
  }
};

const getSynth = (script) => {
  if (!synths[script]) {
    synths[script] = pipeline('text-to-speech', MODELS[script] || MODELS.latin, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: progress,
    }).catch((err) => {
      delete synths[script];
      throw err;
    });
  }
  return synths[script];
};

self.onmessage = async ({ data }) => {
  if (data.type !== 'speak') return;
  try {
    const synth = await getSynth(data.script);
    const output = await synth(data.text);
    const audio = output.audio instanceof Float32Array ? output.audio : new Float32Array(output.audio);
    self.postMessage(
      { type: 'audio', jobId: data.jobId, audio, samplingRate: output.sampling_rate },
      [audio.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'error', jobId: data.jobId, message: err?.message || String(err) });
  }
};
