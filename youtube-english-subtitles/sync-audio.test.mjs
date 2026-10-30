import assert from "node:assert/strict";
import { test } from "node:test";
import { SynchronizedAudio, synchronizedCues } from "./sync-audio.js";

test("model timestamps are mapped to media time, clamped and scaled for playback speed", () => {
  const result = synchronizedCues({ chunks: [
    { text: "First", timestamp: [0.5, 2] },
    { text: "Final", timestamp: [3, null] },
    { text: "Out of bounds", timestamp: [10, 12] },
  ] }, { start: 40, end: 52, rate: 2 });
  assert.deepEqual(result.cues, [
    { text: "First", start: 41, end: 44 },
    { text: "Final", start: 46, end: 52 },
  ]);
  assert.equal(result.timing, "model timestamps");
});

test("missing timestamps are explicitly labeled estimated, not presented as exact timing", () => {
  assert.deepEqual(synchronizedCues({ text: "Hello there" }, { start: 4, end: 8, rate: 1 }), {
    cues: [{ start: 4, end: 8, text: "Hello there" }],
    timing: "estimated whole-section timing",
  });
});

function engine(transcribe = async () => ({ text: "English", chunks: [{ text: "English", timestamp: [0, 1] }] })) {
  const segments = [], errors = [], muted = [];
  const audio = new SynchronizedAudio({
    transcribe,
    onSegment: (segment) => segments.push(segment),
    onError: (error) => errors.push(error),
    onMute: (value) => muted.push(value),
  });
  return { audio, segments, errors, muted };
}

async function section(audio, epoch, start, { duration = 12, rate = 1, level = 0.1 } = {}) {
  audio.command({ action: "begin", epoch, start, rate });
  audio.command({ action: "clock", epoch, playing: true });
  audio.append(new Float32Array(Math.round(duration / rate * 16000)).fill(level));
  audio.command({ action: "finish", epoch, end: start + duration });
  await audio.queue;
}

test("consecutive sections retain two earlier tails, cap context at 18 seconds and never repeat prior captions", async () => {
  const lengths = [];
  const app = engine(async (samples) => {
    lengths.push(samples.length / 16000);
    const context = samples.length / 16000 - 12;
    return { text: "Old sentence. New sentence.", chunks: [
      ...(context ? [{ text: "Old sentence.", timestamp: [0, context] }] : []),
      { text: "New sentence.", timestamp: [context, context + 12] },
    ] };
  });
  await section(app.audio, 1, 100);
  await section(app.audio, 2, 112);
  await section(app.audio, 3, 124);
  await section(app.audio, 4, 136);
  assert.deepEqual(lengths, [12, 24, 30, 30]);
  assert.equal(app.audio.history.samples.length, 18 * 16000);
  assert.deepEqual(app.segments.map(({ cues }) => cues), [
    [{ text: "New sentence.", start: 100, end: 112 }],
    [{ text: "New sentence.", start: 112, end: 124 }],
    [{ text: "New sentence.", start: 124, end: 136 }],
    [{ text: "New sentence.", start: 136, end: 148 }],
  ]);
  assert.deepEqual(app.errors, []);
});

test("context preserves exact audio samples and maps timestamps correctly at faster playback", async () => {
  const inputs = [];
  const app = engine(async (samples) => {
    inputs.push(samples);
    return { chunks: [{ text: "Current", timestamp: inputs.length === 1 ? [0, 6] : [6, 12] }] };
  });
  await section(app.audio, 1, 40, { rate: 2, level: 0.1 });
  await section(app.audio, 2, 52, { rate: 2, level: 0.2 });
  assert.equal(inputs[1].length, 12 * 16000);
  assert.equal(inputs[1][0], inputs[0][0]);
  assert.equal(inputs[1][6 * 16000], Math.fround(0.2));
  assert.deepEqual(app.segments[1].cues, [{ text: "Current", start: 52, end: 64 }]);
});

test("unsafe boundary-spanning or untimed context output retries only new audio", async () => {
  for (const unsafe of [
    { text: "Old and new combined", chunks: [{ text: "Old and new combined", timestamp: [10, 24] }] },
    { text: "Old and new combined" },
    { text: "Unknown timestamp", chunks: [{ text: "Unknown timestamp", timestamp: [null, 24] }] },
  ]) {
    const lengths = [];
    const app = engine(async (samples) => {
      lengths.push(samples.length / 16000);
      return samples.length === 24 * 16000 ? unsafe : { text: "Current only" };
    });
    await section(app.audio, 1, 0);
    await section(app.audio, 2, 12);
    assert.deepEqual(lengths, [12, 24, 12]);
    assert.deepEqual(app.segments[1].cues, [{ text: "Current only", start: 12, end: 24 }]);
  }
});

test("previous speech never becomes subtitles over a silent new section", async () => {
  let calls = 0;
  const app = engine(async () => { calls++; return { text: "Speech" }; });
  await section(app.audio, 1, 0);
  await section(app.audio, 2, 12, { level: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(app.segments[1].cues, []);
});

test("seeks, epoch discontinuities, speed changes and cancel clear retained audio", async () => {
  for (const change of ["seek", "epoch", "speed", "cancel"]) {
    const lengths = [];
    const app = engine(async (samples) => { lengths.push(samples.length / 16000); return { text: "Current" }; });
    await section(app.audio, 1, 0);
    if (change === "cancel") app.audio.command({ action: "cancel", epoch: 2 });
    await section(app.audio, change === "epoch" || change === "cancel" ? 3 : 2,
      change === "seek" ? 100 : 12, { rate: change === "speed" ? 2 : 1 });
    assert.deepEqual(lengths, [12, change === "speed" ? 6 : 12], change);
  }
});

test("only playing preparation audio is recorded; pauses and replay are excluded", async () => {
  let captured;
  const { audio, segments, muted } = engine(async (samples) => {
    captured = samples;
    return { text: "Translated" };
  });
  const samples = new Float32Array(16000).fill(0.25);
  audio.command({ action: "begin", epoch: 1, start: 100, rate: 1 });
  audio.append(samples);
  assert.equal(audio.length, 0);
  audio.command({ action: "clock", epoch: 1, playing: true });
  audio.append(samples);
  audio.command({ action: "clock", epoch: 1, playing: false });
  audio.append(samples);
  audio.command({ action: "finish", epoch: 1, end: 101 });
  await audio.queue;
  assert.equal(captured.length, 16000);
  assert.equal(captured[0], 0.25);
  assert.equal(segments[0].start, 100);
  audio.command({ action: "replay", epoch: 1 });
  audio.append(samples);
  assert.equal(audio.length, 0);
  assert.deepEqual(muted, [true, false]);
});

test("seeking invalidates in-flight inference and serializes the next model call", async () => {
  let release;
  let calls = 0;
  let active = 0;
  let peak = 0;
  const { audio, segments } = engine(async () => {
    calls++;
    peak = Math.max(peak, ++active);
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    active--;
    return { text: "Only the new position" };
  });
  const samples = new Float32Array(16000).fill(0.1);
  const begin = (epoch, start) => {
    audio.command({ action: "begin", epoch, start, rate: 1 });
    audio.command({ action: "clock", epoch, playing: true });
    audio.append(samples);
    audio.command({ action: "finish", epoch, end: start + 1 });
  };
  begin(1, 0);
  await Promise.resolve();
  audio.command({ action: "cancel", epoch: 2 });
  begin(3, 90);
  release();
  await audio.queue;
  assert.equal(peak, 1);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].epoch, 3);
  assert.equal(segments[0].start, 90);
});

test("silence returns a section for replay, while missing captured samples fail explicitly", async () => {
  let calls = 0;
  const { audio, segments, errors } = engine(async () => { calls++; });
  audio.command({ action: "begin", epoch: 1, start: 0, rate: 1 });
  audio.command({ action: "clock", epoch: 1, playing: true });
  audio.append(new Float32Array(16000));
  audio.command({ action: "finish", epoch: 1, end: 1 });
  await audio.queue;
  assert.equal(calls, 0);
  assert.equal(segments[0].cues.length, 0);
  audio.command({ action: "begin", epoch: 2, start: 10, rate: 1 });
  audio.command({ action: "finish", epoch: 2, end: 11 });
  await audio.queue;
  assert.match(errors[0].message, /No audio/);
});

test("cancel restores audible playback and old commands cannot mute a newer section", () => {
  const { audio, muted } = engine();
  audio.command({ action: "begin", epoch: 3, start: 10, rate: 1 });
  audio.command({ action: "cancel", epoch: 4 });
  audio.command({ action: "begin", epoch: 2, start: 0, rate: 1 });
  assert.equal(audio.state, "idle");
  assert.deepEqual(muted, [true, false]);
});

test("queued worklet batches from before a seek never enter the new speech buffer", () => {
  const { audio } = engine();
  const samples = new Float32Array(16000).fill(0.2);
  audio.command({ action: "begin", epoch: 4, start: 50, rate: 1 });
  audio.command({ action: "clock", epoch: 4, playing: true });
  audio.append(samples, 2);
  assert.equal(audio.length, 0);
  audio.append(samples, 4);
  assert.equal(audio.length, 16000);
  audio.command({ action: "clock", epoch: 4, playing: false });
  audio.append(samples.subarray(0, 128), 4);
  assert.equal(audio.length, 16128, "a tagged final partial batch survives a user pause");
});
