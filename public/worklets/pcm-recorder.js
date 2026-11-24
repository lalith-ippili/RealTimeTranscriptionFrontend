/**
 * AudioWorklet: captures microphone audio at the device rate (44.1/48 kHz),
 * down-samples it to 16 kHz mono Float32 and posts ~100 ms chunks to the
 * main thread together with the chunk's RMS level (for the level meter).
 *
 * 16 kHz mono is what both Gemini Live (as 16-bit PCM) and Whisper expect.
 */
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSize = opts.chunkSize || 1600; // 100 ms at 16 kHz
    this.ratio = sampleRate / this.targetRate; // sampleRate is a worklet global

    this.chunk = new Float32Array(this.chunkSize);
    this.chunkOffset = 0;

    // Box-filter decimation state (averages input samples per output sample,
    // which doubles as a cheap anti-aliasing low-pass filter).
    this.acc = 0;
    this.accCount = 0;
    this.phase = 0;

    this.sumSquares = 0;
  }

  pushSample(value) {
    this.chunk[this.chunkOffset++] = value;
    this.sumSquares += value * value;

    if (this.chunkOffset === this.chunkSize) {
      const rms = Math.sqrt(this.sumSquares / this.chunkSize);
      const samples = this.chunk;
      this.port.postMessage({ samples, rms }, [samples.buffer]);
      this.chunk = new Float32Array(this.chunkSize);
      this.chunkOffset = 0;
      this.sumSquares = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      // Mix down to mono.
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      sample /= channels;

      this.acc += sample;
      this.accCount += 1;
      this.phase += 1;

      if (this.phase >= this.ratio) {
        this.pushSample(this.acc / this.accCount);
        this.phase -= this.ratio;
        this.acc = 0;
        this.accCount = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
