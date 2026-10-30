// Runs on Chrome's audio rendering thread, without DOM or extension APIs.
class YouTubeAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(4096);
    this.offset = 0;
    this.syncEpoch = null;
    this.recording = true;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== "SYNC_CAPTURE" || !Number.isSafeInteger(data.epoch)) return;
      if (data.epoch !== this.syncEpoch) {
        this.offset = 0;
        this.samples = new Float32Array(4096);
      } else if (this.recording && !data.playing && this.offset) {
        this.postBatch(this.samples.slice(0, this.offset));
        this.offset = 0;
      }
      this.syncEpoch = data.epoch;
      this.recording = data.playing === true;
    };
  }

  postBatch(samples) {
    const data = this.syncEpoch === null ? samples : { samples, epoch: this.syncEpoch };
    this.port.postMessage(data, [samples.buffer]);
  }

  process(inputs, outputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;

    // tabCapture mutes normal playback: route the captured audio to speakers.
    const output = outputs[0] || [];
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].set(channels[Math.min(channel, channels.length - 1)]);
    }
    if (!this.recording) return true;

    for (let frame = 0; frame < channels[0].length; frame++) {
      let mono = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        mono += channels[channel][frame] / channels.length;
      }
      this.samples[this.offset++] = mono;
      if (this.offset === this.samples.length) {
        this.postBatch(this.samples);
        this.samples = new Float32Array(4096);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("youtube-audio-capture", YouTubeAudioCapture);
