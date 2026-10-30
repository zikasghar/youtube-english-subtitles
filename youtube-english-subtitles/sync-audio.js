const SAMPLE_RATE = 16000;
const CONTEXT_SAMPLES = SAMPLE_RATE * 18;
const MAX_MODEL_SAMPLES = SAMPLE_RATE * 30;
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

// Discard the context's captions and shift new timestamps back to this section.
// A boundary-spanning sentence cannot be split safely without word alignment:
// request current-only inference rather than replaying old text or dropping speech.
function currentSectionResult(result, contextSeconds) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  if (!chunks.length) return clean(result?.text) ? null : { text: "", chunks: [] };
  const current = [];
  for (const chunk of chunks) {
    if (!clean(chunk.text)) continue;
    const [start, end] = chunk.timestamp || [];
    if (!Number.isFinite(start)) return null;
    if (Number.isFinite(end) && end <= contextSeconds) continue;
    if (start < contextSeconds) return null;
    current.push({ ...chunk, timestamp: [start - contextSeconds,
      Number.isFinite(end) ? end - contextSeconds : null] });
  }
  return { ...result, text: current.map((chunk) => chunk.text).join(" "), chunks: current };
}

export function synchronizedCues(result, { start, end, rate }) {
  const duration = (end - start) / rate;
  const chunks = (Array.isArray(result?.chunks) ? result.chunks : [])
    .filter((chunk) => clean(chunk.text) && Number.isFinite(chunk.timestamp?.[0]))
    .sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  const cues = chunks.map((chunk, index) => {
    const from = Math.max(0, chunk.timestamp[0]);
    const until = Number.isFinite(chunk.timestamp[1])
      ? chunk.timestamp[1]
      : (chunks[index + 1]?.timestamp[0] ?? duration);
    return {
      text: clean(chunk.text),
      start: start + Math.min(duration, from) * rate,
      end: start + Math.min(duration, Math.max(from, until)) * rate,
    };
  }).filter((cue) => cue.end > cue.start);
  if (cues.length) return { cues, timing: "model timestamps" };
  const text = clean(result?.text);
  return {
    cues: text ? [{ start, end, text }] : [],
    timing: text ? "estimated whole-section timing" : "no speech recognized",
  };
}

// Only one model call runs at a time. Epochs invalidate results after a seek.
export class SynchronizedAudio {
  constructor({ transcribe, onSegment, onError, onMute }) {
    Object.assign(this, { transcribe, onSegment, onError, onMute });
    this.epoch = -1;
    this.state = "idle";
    this.frames = [];
    this.length = 0;
    this.queue = Promise.resolve();
  }

  command(message) {
    const { action, epoch } = message;
    if (!Number.isSafeInteger(epoch) || epoch < this.epoch) return;
    if (action === "cancel") {
      this.history = null;
      this.epoch = epoch;
      this.state = "idle";
      this.frames = [];
      this.length = 0;
      this.playing = false;
      this.onMute(false);
      return;
    }
    if (action === "begin") {
      if (!Number.isFinite(message.start) || !Number.isFinite(message.rate) || message.rate <= 0) {
        throw new Error("Invalid synchronized section position or playback speed.");
      }
      if (this.history && (Math.abs(this.history.end - message.start) > 0.05 ||
          this.history.rate !== message.rate || this.history.epoch + 1 !== epoch)) {
        this.history = null;
      }
      this.epoch = epoch;
      this.section = { start: message.start, rate: message.rate };
      this.frames = [];
      this.length = 0;
      this.playing = false;
      this.state = "collecting";
      this.onMute(true);
      return;
    }
    if (epoch !== this.epoch) return;
    if (action === "clock") {
      this.playing = this.state === "collecting" && message.playing === true;
    } else if (action === "replay") {
      this.state = "replaying";
      this.playing = false;
      this.onMute(false);
    } else if (action === "finish" && this.state === "collecting") {
      const section = { ...this.section, end: message.end, epoch };
      if (!Number.isFinite(section.end) || section.end <= section.start) {
        throw new Error("The synchronized section has no playable duration.");
      }
      this.state = "processing";
      this.playing = false;
      const expected = Math.ceil((section.end - section.start) / section.rate * SAMPLE_RATE);
      const audio = new Float32Array(Math.min(expected, this.length));
      let offset = 0;
      for (const frame of this.frames) {
        const count = Math.min(frame.length, audio.length - offset);
        if (count <= 0) break;
        audio.set(frame.subarray(0, count), offset);
        offset += count;
      }
      this.frames = [];
      this.length = 0;
      this.queue = this.queue.then(async () => {
        if (epoch !== this.epoch) return;
        // Silence still produces a playable section, not a stuck waiting state.
        let energy = 0;
        for (const sample of audio) energy += sample * sample;
        if (!audio.length) throw new Error("No audio was captured for this section. Check video playback and retry.");
        let result = { text: "" };
        const prior = this.history;
        const contextLength = Math.min(prior?.samples.length || 0, Math.max(0, MAX_MODEL_SAMPLES - audio.length));
        const input = new Float32Array(contextLength + audio.length);
        if (contextLength) input.set(prior.samples.subarray(prior.samples.length - contextLength));
        input.set(audio, contextLength);
        // Test only NEW audio for silence; previous speech must not manufacture
        // subtitles over a silent current interval.
        if (Math.sqrt(energy / audio.length) >= 0.004) {
          result = await this.transcribe(input);
          if (epoch !== this.epoch) return;
          if (contextLength) {
            result = currentSectionResult(result, contextLength / SAMPLE_RATE);
            if (result === null) result = await this.transcribe(audio);
          }
        }
        if (epoch !== this.epoch) return;
        this.history = { samples: input.slice(-CONTEXT_SAMPLES), end: section.end,
          rate: section.rate, epoch };
        this.state = "ready";
        this.onSegment({ ...section, ...synchronizedCues(result, section) });
      }).catch((error) => {
        if (epoch !== this.epoch) return;
        this.state = "error";
        this.history = null;
        this.onMute(false);
        this.onError(error);
      });
    }
  }

  append(samples, epoch) {
    if (epoch !== undefined && epoch !== this.epoch) return;
    if (this.state !== "collecting" || (!this.playing && epoch !== this.epoch)) return;
    if (this.length + samples.length > SAMPLE_RATE * 60) {
      this.state = "error";
      this.frames = [];
      this.length = 0;
      this.history = null;
      this.onMute(false);
      this.onError(new Error("The section exceeded the audio buffer. Seek or restart synchronized translation."));
      return;
    }
    this.frames.push(samples.slice());
    this.length += samples.length;
  }
}
