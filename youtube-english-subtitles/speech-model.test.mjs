import assert from "node:assert/strict";
import { test } from "node:test";
import { SPEECH_MODEL_ID, loadSpeechModel } from "./speech-model.js";

test("CPU loads multilingual Small rather than Tiny or an English-only model", async () => {
  const calls = [];
  const transcriber = {};
  const progressCallback = () => {};
  const result = await loadSpeechModel(async (...args) => {
    calls.push(args);
    return transcriber;
  }, { progressCallback });
  assert.equal(result, transcriber);
  assert.equal(SPEECH_MODEL_ID, "onnx-community/whisper-small");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["automatic-speech-recognition", SPEECH_MODEL_ID, {
    device: "wasm", dtype: "q8", progress_callback: progressCallback,
  }]);
});

test("GPU failure retries Small on CPU without reverting to Tiny", async () => {
  const calls = [];
  let fallbacks = 0;
  await loadSpeechModel(async (_task, id, options) => {
    calls.push({ id, ...options });
    if (options.device === "webgpu") throw new Error("GPU not available");
    return {};
  }, { gpuAvailable: true, onCpuFallback: () => fallbacks++ });
  assert.equal(fallbacks, 1);
  assert.deepEqual(calls.map(({ id, device, dtype }) => ({ id, device, dtype })), [
    { id: SPEECH_MODEL_ID, device: "webgpu", dtype: "fp16" },
    { id: SPEECH_MODEL_ID, device: "wasm", dtype: "q8" },
  ]);
});

test("successful GPU load does not also start a CPU model", async () => {
  let calls = 0;
  await loadSpeechModel(async (_task, id, options) => {
    calls++;
    assert.equal(id, SPEECH_MODEL_ID);
    assert.equal(options.device, "webgpu");
    return {};
  }, { gpuAvailable: true });
  assert.equal(calls, 1);
});

test("both runtime failures surface the loading error instead of silently using Tiny", async () => {
  await assert.rejects(loadSpeechModel(async () => {
    throw new Error("Not enough memory for Small");
  }, { gpuAvailable: true }), /Not enough memory/);
});
