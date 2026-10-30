import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./audio-worklet.js", import.meta.url), "utf8");

function createProcessor() {
  const batches = [];
  let Processor;
  vm.runInNewContext(source, {
    Float32Array,
    AudioWorkletProcessor: class {
      port = {
        postMessage(samples, transfer) {
          // Model a transferred buffer, including detachment on the sender.
          batches.push(structuredClone(samples, { transfer }));
        },
      };
    },
    registerProcessor(name, implementation) {
      assert.equal(name, "youtube-audio-capture");
      Processor = implementation;
    },
  });
  return { processor: new Processor(), batches };
}

test("synchronized recording tags batches, flushes partial audio, and excludes paused/replay frames", () => {
  const { processor, batches } = createProcessor();
  const input = new Float32Array(128).fill(0.5);
  const process = () => processor.process([[input]], [[new Float32Array(128)]]);
  processor.port.onmessage({ data: { type: "SYNC_CAPTURE", epoch: 1, playing: false } });
  for (let i = 0; i < 40; i++) process();
  assert.equal(batches.length, 0);
  processor.port.onmessage({ data: { type: "SYNC_CAPTURE", epoch: 1, playing: true } });
  for (let i = 0; i < 33; i++) process();
  processor.port.onmessage({ data: { type: "SYNC_CAPTURE", epoch: 1, playing: false } });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].epoch, 1);
  assert.equal(batches[0].samples.length, 4096);
  assert.equal(batches[1].samples.length, 128);
  processor.port.onmessage({ data: { type: "SYNC_CAPTURE", epoch: 3, playing: true } });
  for (let i = 0; i < 32; i++) process();
  assert.equal(batches[2].epoch, 3);
});

test("preserves stereo playback and sends mono batches to the translator", () => {
  const { processor, batches } = createProcessor();
  const left = new Float32Array(128).fill(0.5);
  const right = new Float32Array(128).fill(-0.25);
  for (let i = 0; i < 32; i++) {
    const output = [new Float32Array(128), new Float32Array(128)];
    assert.equal(processor.process([[left, right]], [output]), true);
    assert.deepEqual(output[0], left);
    assert.deepEqual(output[1], right);
  }
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], new Float32Array(4096).fill(0.125));
});

test("keeps sample order across batch boundaries and duplicates mono playback", () => {
  const { processor, batches } = createProcessor();
  for (let i = 0; i < 64; i++) {
    const mono = Float32Array.from({ length: 128 }, (_, frame) => i * 128 + frame);
    const output = [new Float32Array(128), new Float32Array(128)];
    processor.process([[mono]], [output]);
    assert.deepEqual(output[0], mono);
    assert.deepEqual(output[1], mono);
  }
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], Float32Array.from({ length: 4096 }, (_, i) => i));
  assert.deepEqual(batches[1], Float32Array.from({ length: 4096 }, (_, i) => i + 4096));
});

test("empty input does not send samples or interrupt the processor", () => {
  const { processor, batches } = createProcessor();
  const output = [new Float32Array(128), new Float32Array(128)];
  assert.equal(processor.process([[]], [output]), true);
  assert.equal(batches.length, 0);
  assert.ok(output.every((channel) => channel.every((sample) => sample === 0)));
});
