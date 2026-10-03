// Microphone AudioWorklet processor.
//
// Receives Float32 mono samples at the device sample rate (e.g. 44100/48000),
// resamples to 16 kHz with linear interpolation, converts to signed 16-bit PCM,
// and posts small Int16 chunks to the main thread for Gemini Live.
//
// Gemini Live expects: raw PCM, 16-bit, mono, 16 kHz, little-endian.

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    // Leftover input samples carried between blocks so resampling stays continuous.
    this._leftover = new Float32Array(0);
  }

  // Downsample one Float32 mono block to 16 kHz Int16 with linear interpolation.
  resampleTo16k(input, inputSampleRate) {
    if (inputSampleRate === this.targetRate) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = Math.round(s * 32767);
      }
      this._leftover = new Float32Array(0);
      return out;
    }
    // Prepend leftover from the previous block for continuity.
    let combined;
    if (this._leftover.length > 0) {
      combined = new Float32Array(this._leftover.length + input.length);
      combined.set(this._leftover, 0);
      combined.set(input, this._leftover.length);
    } else {
      combined = input;
    }
    const ratio = inputSampleRate / this.targetRate;
    const outLen = Math.floor(combined.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = combined[idx];
      const b = idx + 1 < combined.length ? combined[idx + 1] : a;
      const sample = a + (b - a) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = Math.round(clamped * 32767);
    }
    // Keep unconsumed tail for the next block.
    const consumed = Math.floor(outLen * ratio);
    this._leftover = combined.slice(consumed);
    // Bound memory in pathological cases.
    if (this._leftover.length > 4096) {
      this._leftover = this._leftover.slice(this._leftover.length - 4096);
    }
    return out;
  }

  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      try {
        const pcm16 = this.resampleTo16k(channel, sampleRate);
        if (pcm16.length > 0) {
          // Transfer a copy to the main thread.
          this.port.postMessage({ pcm16: pcm16.buffer }, [pcm16.buffer]);
        }
      } catch (e) {
        // Never throw inside process(); it would kill the audio graph.
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor('mic-processor', MicProcessor);
