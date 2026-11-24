import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * transformers.js loads the ONNX Runtime WASM binary from the jsDelivr CDN at
 * runtime, but the bundler still copies a ~27 MB fallback copy into dist/.
 * Drop it so the Netlify deploy stays small.
 */
const dropOnnxWasm = () => ({
  name: 'drop-onnxruntime-wasm',
  apply: 'build',
  generateBundle(_options, bundle) {
    for (const fileName of Object.keys(bundle)) {
      if (/ort-wasm[^/]*\.wasm$/.test(fileName)) delete bundle[fileName];
    }
  },
});

export default defineConfig({
  plugins: [react(), dropOnnxWasm()],
  server: {
    port: 5173,
  },
  worker: {
    // Web Workers (Whisper STT + MMS TTS) are ES modules.
    format: 'es',
    plugins: () => [dropOnnxWasm()],
  },
  optimizeDeps: {
    // transformers.js ships its own WASM loader; let it load lazily in workers.
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
