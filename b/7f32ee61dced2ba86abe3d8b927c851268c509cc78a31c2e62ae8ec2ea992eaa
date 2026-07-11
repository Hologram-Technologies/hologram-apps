// holo-retro-audio-worklet.js — the AudioWorklet processor (the consumer end of the
// κ-audio ring). Browser-only: loaded via audioContext.audioWorklet.addModule().
//
// It runs on the audio render thread and pops exactly one quantum (128 stereo frames)
// from the SharedArrayBuffer ring each call — lock-free, never allocating, never
// blocking the emulation worker. An empty ring outputs silence (a counted underrun on
// the producer side); a full ring drops on the producer side. Tight bounded latency.
//
// The reader is inlined (no imports) because AudioWorklet module scope is isolated; it
// mirrors AudioRing.pop in holo-retro-audio.js exactly.

const HEADER_I32 = 2;   // i32[0]=read, i32[1]=write (stereo-frame indices)
const CH = 2;

class HoloRetroAudioProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const sab = opts.processorOptions.sab;
    this.i32 = new Int32Array(sab, 0, HEADER_I32);
    this.f32 = new Float32Array(sab, HEADER_I32 * 4);
    this.capFrames = (this.f32.length / CH) | 0;
    this.underruns = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const frames = L.length;                          // 128
    const r = Atomics.load(this.i32, 0), w = Atomics.load(this.i32, 1);
    const have = Math.min(frames, w - r);
    for (let i = 0; i < have; i++) {
      const slot = ((r + i) % this.capFrames) * CH;
      L[i] = this.f32[slot]; R[i] = this.f32[slot + 1];
    }
    for (let i = have; i < frames; i++) { L[i] = 0; R[i] = 0; }
    if (have < frames) this.underruns += frames - have;
    Atomics.store(this.i32, 0, r + have);
    return true;                                      // keep the node alive
  }
}

registerProcessor("holo-retro-audio", HoloRetroAudioProcessor);
