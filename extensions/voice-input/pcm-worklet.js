// Mixed audio (any context rate) -> 16 kHz mono s16le, batched ~150 ms, posted to the main thread (transferred).
// Averaging decimation with a fractional phase accumulator, so 44.1 kHz works as well as 48 kHz.
const OUT_RATE = 16000;
const BATCH = 2400; // samples = 150 ms

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(BATCH);
    this.n = 0;
    this.acc = 0;
    this.cnt = 0;
    this.phase = 0;
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return;
      if (this.n > 0) { const out = this.buf.slice(0, this.n).buffer; this.n = 0; this.port.postMessage(out, [out]); }
      this.port.postMessage({ flushed: true });
    };
  }

  process(inputs) {
    const chans = inputs[0];
    const frames = chans && chans.length ? chans[0].length : 128;
    const nch = chans ? chans.length : 0;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < nch; c++) s += chans[c][i];
      this.acc += nch ? s / nch : 0; // no input connected = silence, keep the stream going
      this.cnt++;
      this.phase += OUT_RATE;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.buf[this.n++] = v < 0 ? v * 32768 : v * 32767;
        this.acc = 0; this.cnt = 0;
        if (this.n === BATCH) {
          const out = this.buf.buffer;
          this.buf = new Int16Array(BATCH);
          this.n = 0;
          this.port.postMessage(out, [out]);
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
