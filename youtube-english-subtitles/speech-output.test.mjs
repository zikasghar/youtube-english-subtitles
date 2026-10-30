import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSpeechResult } from "./speech-output.js";
import { synchronizedCues, SynchronizedAudio } from "./sync-audio.js";

test("standalone subscribe output is removed with case and punctuation variations", () => {
  for (const text of ["Subscribe", "SUBSCRIBE!", " Subscribe… ", "[Subscribe]", "Please subscribe.", "Ｓｕｂｓｃｒｉｂｅ"]) {
    const result = filterSpeechResult({ text });
    assert.equal(result.text, "", text);
  }
});

test("real sentences containing subscribe are preserved", () => {
  for (const text of ["You can subscribe to the newsletter.", "I do not subscribe to that view.", "Subscribed", "Hello, how are you?"]) {
    assert.equal(filterSpeechResult({ text }).text, text);
  }
});

test("repeated subscribe artifacts are removed, including separate timestamp chunks", () => {
  for (const text of ["Subscribe! ".repeat(100), "Please subscribe. ".repeat(30), "Subscribe, please subscribe! Subscribe!"]) {
    const result = filterSpeechResult({
      text,
      chunks: Array.from({ length: 30 }, (_, index) => ({
        text: " Subscribe!", timestamp: [index / 3, (index + 1) / 3],
      })),
    });
    assert.equal(result.text, "");
    assert.deepEqual(result.chunks, []);
    assert.deepEqual(synchronizedCues(result, { start: 0, end: 12, rate: 1 }).cues, []);
  }
});

test("word and phrase loops collapse without changing surrounding speech or timestamps", () => {
  for (const [text, expected] of [
    ["Hello hello hello hello.", "Hello."],
    ["We begin. Thank you! Thank you! Thank you! We continue.", "We begin. Thank you! We continue."],
    ["The the answer is yes.", "The the answer is yes."],
  ]) {
    const result = filterSpeechResult({ text, chunks: [{ text, timestamp: [2, 8] }] });
    assert.equal(result.text, expected);
    assert.equal(result.chunks[0].text, expected);
    assert.deepEqual(result.chunks[0].timestamp, [2, 8]);
  }
});

test("removing a timed artifact preserves other cue text and exact timestamps", () => {
  const original = {
    text: "Hello. Subscribe! We continue.",
    chunks: [
      { text: "Hello.", timestamp: [0, 2] },
      { text: "Subscribe!", timestamp: [3, 5] },
      { text: "We continue.", timestamp: [6, 8] },
    ],
  };
  const result = filterSpeechResult(original);
  assert.equal(result.text, "Hello. We continue.");
  assert.deepEqual(result.chunks, [original.chunks[0], original.chunks[2]]);
  assert.equal(original.chunks.length, 3, "do not mutate the model's original result");
  assert.deepEqual(synchronizedCues(result, { start: 100, end: 112, rate: 1 }).cues, [
    { text: "Hello.", start: 100, end: 102 },
    { text: "We continue.", start: 106, end: 108 },
  ]);
});

test("filtered chunks cannot reappear through whole-section fallback text", () => {
  for (const timestamp of [undefined, [0, 8]]) {
    const result = filterSpeechResult({
      text: "Subscribe!",
      chunks: [{ text: "Subscribe!", timestamp }],
    });
    assert.deepEqual(result.chunks, []);
    assert.equal(result.text, "");
    const segment = synchronizedCues(result, { start: 100, end: 112, rate: 1 });
    assert.deepEqual(segment.cues, []);
  }
});

test("empty or absent model output remains harmless", () => {
  assert.equal(filterSpeechResult(null), null);
  assert.equal(filterSpeechResult(undefined), undefined);
  assert.deepEqual(filterSpeechResult({ text: "", chunks: [] }), { text: "", chunks: [] });
});

test("an entirely filtered result still completes its prepared interval", async () => {
  const segments = [], errors = [];
  const engine = new SynchronizedAudio({
    transcribe: async () => filterSpeechResult({ text: "Subscribe!", chunks: [{ text: "Subscribe!", timestamp: [0, 0.1] }] }),
    onSegment: (segment) => segments.push(segment),
    onError: (error) => errors.push(error),
    onMute: () => {},
  });
  engine.command({ action: "begin", epoch: 1, start: 100, rate: 1 });
  engine.command({ action: "clock", epoch: 1, playing: true });
  engine.append(new Float32Array(1600).fill(0.1));
  engine.command({ action: "finish", epoch: 1, end: 100.1 });
  await engine.queue;
  assert.deepEqual(errors, []);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 100);
  assert.equal(segments[0].end, 100.1);
  assert.deepEqual(segments[0].cues, []);
});
