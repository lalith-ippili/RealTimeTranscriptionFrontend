/**
 * Web Worker running OpenAI Whisper (open-source, MIT licence) fully in the
 * browser through transformers.js + ONNX Runtime (WebGPU when available,
 * otherwise WebAssembly). Audio never leaves the device.
 *
 * Protocol
 *   in : { type: 'load', model }
 *        { type: 'transcribe', jobId, model, audio: Float32Array(16 kHz), language }
 *   out: { type: 'progress', file, loaded, total, status }
 *        { type: 'ready', model, device }
 *        { type: 'result', jobId, text }
 *        { type: 'error', jobId?, message }
 */
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

let current = { model: null, device: null, transcriber: null, loading: null };

const hasWebGPU = async () => {
  try {
    if (!self.navigator?.gpu) return false;
    return Boolean(await self.navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
};

const progress = (event) => {
  if (event.status === 'progress' || event.status === 'initiate' || event.status === 'done') {
    self.postMessage({
      type: 'progress',
      status: event.status,
      file: event.file,
      loaded: event.loaded ?? 0,
      total: event.total ?? 0,
    });
  }
};

const create = (model, device) =>
  pipeline('automatic-speech-recognition', model, {
    device,
    dtype:
      device === 'webgpu'
        ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
        : { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: progress,
  });

async function load(model) {
  if (current.model === model && current.transcriber) return current;
  if (current.model === model && current.loading) return current.loading;

  if (current.transcriber) {
    await current.transcriber.dispose?.().catch(() => {});
  }

  const loading = (async () => {
    let device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
    let transcriber;
    try {
      transcriber = await create(model, device);
    } catch (err) {
      if (device !== 'webgpu') throw err;
      device = 'wasm'; // WebGPU present but unusable – fall back to WASM.
      transcriber = await create(model, device);
    }
    // Warm-up run compiles shaders / kernels so the first phrase is fast.
    await transcriber(new Float32Array(16000), { language: 'english', task: 'transcribe' }).catch(() => {});
    current = { model, device, transcriber, loading: null };
    self.postMessage({ type: 'ready', model, device });
    return current;
  })();

  current = { model, device: null, transcriber: null, loading };
  try {
    return await loading;
  } catch (err) {
    current = { model: null, device: null, transcriber: null, loading: null };
    throw err;
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data.model);
      return;
    }

    if (data.type === 'transcribe') {
      const { transcriber } = await load(data.model);
      const output = await transcriber(data.audio, {
        language: data.language || null, // null → auto-detect per phrase
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = Array.isArray(output) ? output.map((o) => o.text).join(' ') : output.text;
      self.postMessage({ type: 'result', jobId: data.jobId, text: text || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', jobId: data.jobId, message: err?.message || String(err) });
  }
};
