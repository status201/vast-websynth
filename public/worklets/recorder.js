// Passive capture node. Receives the master output, and while armed copies
// each render quantum's stereo frames to the main thread via postMessage.
// Has zero outputs, so it is a pure sink — it never doubles audio into the
// destination. Only buffers/posts while `recording` is true.

class RecorderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [];
  }

  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === 'start') this.recording = true;
      else if (cmd === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const srcL = input[0];
    const srcR = input[1] || input[0];
    if (!srcL || srcL.length === 0) return true;

    // The render buffer is reused by the engine, so copy before transferring.
    const l = new Float32Array(srcL.length);
    const r = new Float32Array(srcR.length);
    l.set(srcL);
    r.set(srcR);
    this.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
