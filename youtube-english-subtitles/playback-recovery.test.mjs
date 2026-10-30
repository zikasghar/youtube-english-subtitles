import assert from "node:assert/strict";
import { test } from "node:test";
import "./playback-recovery.js";

test("ordinary playback needs no player recovery", async () => {
  let retries = 0;
  await globalThis.YtesPlayVideo({
    video: { play: async () => {} },
    requestRecovery: async () => { retries++; },
  });
  assert.equal(retries, 0);
});

test("rejected native play retries through YouTube then plays", async () => {
  let plays = 0, retries = 0;
  await globalThis.YtesPlayVideo({
    video: { play: async () => { if (++plays === 1) throw new Error("NotAllowedError"); } },
    requestRecovery: async () => { retries++; return { ok: true }; },
  });
  assert.equal(plays, 2);
  assert.equal(retries, 1);
});

test("a never-settling native play cannot buffer indefinitely", async () => {
  let plays = 0, retries = 0;
  await globalThis.YtesPlayVideo({
    video: { play: () => ++plays === 1 ? new Promise(() => {}) : Promise.resolve() },
    requestRecovery: async () => { retries++; return { ok: true }; },
    timeoutMs: 5,
  });
  assert.equal(plays, 2);
  assert.equal(retries, 1);
});

test("a delayed play retry cannot undo stop, seek or a manual pause", async () => {
  let active = true, retries = 0, rejectPlay;
  const playing = globalThis.YtesPlayVideo({
    video: { play: () => new Promise((_, reject) => { rejectPlay = reject; }) },
    requestRecovery: async () => { retries++; },
    shouldContinue: () => active,
  });
  await Promise.resolve();
  active = false;
  rejectPlay(new Error("interrupted"));
  await playing;
  assert.equal(retries, 0);
});

test("failed recovery reports an actionable error instead of hanging", async () => {
  await assert.rejects(globalThis.YtesPlayVideo({
    video: { play: async () => { throw new Error("blocked"); } },
    requestRecovery: async () => ({ ok: false, error: "player unavailable" }),
  }), /Open that video tab and press Play/);
});

test("invalidating the DOM playback ticket prevents a late native retry", async () => {
  const attributes = new Map();
  let release, plays = 0;
  const video = {
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: (key) => attributes.get(key),
    removeAttribute: (key) => attributes.delete(key),
    play: async () => { plays++; throw new Error("blocked"); },
  };
  const playing = globalThis.YtesPlayVideo({
    video,
    requestRecovery: () => new Promise((resolve) => { release = resolve; }),
  });
  while (!release) await Promise.resolve();
  attributes.delete("data-ytes-playback-request");
  release({ ok: true });
  await playing;
  assert.equal(plays, 1);
  assert.equal(attributes.size, 0);
});
