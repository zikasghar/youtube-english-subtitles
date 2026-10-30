import assert from "node:assert/strict";
import { test } from "node:test";
import "./sync-playback.js";
import { SynchronizedAudio } from "./sync-audio.js";

class Video extends EventTarget {
  constructor({ time = 100, duration = 200, paused = false } = {}) {
    super();
    Object.assign(this, { time, duration, paused, playbackRate: 1, seeking: false, ended: false, isConnected: true });
  }
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value;
    this.seeking = true;
    this.ended = false;
    this.dispatchEvent(new Event("seeking"));
    queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event("seeked"));
    });
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  async play() {
    const paused = this.paused;
    this.paused = false;
    if (paused) this.dispatchEvent(new Event("play"));
    if (!this.paused) this.dispatchEvent(new Event("playing"));
  }
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(options = {}) {
  const video = options.video || new Video();
  const commands = [], statuses = [], captions = [], failures = [], progress = [], completions = [];
  let cleared = false;
  const controller = new globalThis.YtesSyncPlayback({
    video,
    sourceOnly: options.sourceOnly || false,
    playVideo: options.playVideo,
    initialEpoch: options.initialEpoch || 0,
    onPreparedSegment: options.onPreparedSegment,
    onSourceComplete: options.onSourceComplete,
    preparationSeconds: options.preparationSeconds || 0,
    onProgress: (value) => progress.push(value),
    onComplete: (text) => completions.push(text),
    send: async (message) => { commands.push(message); return options.send ? options.send(message) : { ok: true }; },
    showStatus: (text) => statuses.push(text),
    showCue: (text) => captions.push(text),
    hide: () => captions.push(""),
    onFailure: (text) => failures.push(text),
    setInterval: () => 1,
    clearInterval: () => { cleared = true; },
  });
  return { controller, video, commands, statuses, captions, failures, progress, completions, cleared: () => cleared };
}

test("preparation pauses for inference and replay renders cues by video time, including pause", async () => {
  const { controller, video, commands, captions } = setup();
  assert.equal(video.paused, true);
  controller.modelReady();
  await flush();
  assert.equal(controller.state, "collecting");
  assert.equal(video.paused, false);
  video.time = 112;
  await controller.finish();
  assert.equal(video.paused, true);
  assert.equal(commands.at(-1).action, "finish");
  await controller.segment({
    epoch: controller.epoch, end: 112, timing: "model timestamps",
    cues: [{ start: 101, end: 103, text: "Timed English" }],
  });
  await flush();
  assert.equal(video.currentTime, 100);
  assert.equal(controller.state, "replaying");
  video.time = 101.5;
  controller.tick();
  assert.equal(captions.at(-1), "Timed English");
  video.pause();
  controller.tick();
  assert.equal(captions.at(-1), "Timed English");
  video.time = 103;
  controller.tick();
  assert.equal(captions.at(-1), "");
  controller.stop();
  assert.equal(video.paused, true, "stop must preserve a user pause");
});

test("seek discards old inference and cannot rewind playback to an obsolete position", async () => {
  const { controller, video } = setup();
  controller.modelReady();
  await flush();
  video.time = 112;
  await controller.finish();
  const oldEpoch = controller.epoch;
  video.currentTime = 50;
  await flush();
  await controller.segment({ epoch: oldEpoch, end: 112, cues: [{ start: 100, end: 110, text: "Stale" }] });
  assert.equal(video.currentTime, 50);
  assert.equal(controller.state, "collecting");
  assert.ok(controller.epoch > oldEpoch);
  assert.deepEqual(controller.cues, []);
  controller.stop();
});

test("playback speed changes restart capture, rather than reuse old timestamp mappings", async () => {
  const { controller, video, commands } = setup();
  controller.modelReady();
  await flush();
  const oldEpoch = controller.epoch;
  video.playbackRate = 2;
  video.dispatchEvent(new Event("ratechange"));
  await flush();
  assert.ok(controller.epoch > oldEpoch);
  assert.equal(commands.findLast((message) => message.action === "begin").rate, 2);
  controller.stop();
});

test("stop releases an extension-owned model-wait pause and removes timer control", () => {
  const { controller, video, cleared } = setup();
  controller.stop();
  assert.equal(video.paused, false);
  assert.equal(cleared(), true);
  assert.equal(controller.state, "stopped");
});

test("preparation playback failure is reported instead of collecting forever", async () => {
  const app = setup({
    sourceOnly: true,
    playVideo: async () => { throw new Error("YouTube playback could not start. Press Play."); },
  });
  app.controller.modelReady();
  await flush();
  assert.equal(app.controller.state, "stopped");
  assert.equal(app.failures.length, 1);
  assert.match(app.failures[0], /Press Play/);
  assert.equal(app.video.paused, true);
});

test("native timer callbacks retain the global receiver during startup and stop", () => {
  let cleared = false;
  const video = new Video();
  const controller = new globalThis.YtesSyncPlayback({
    video,
    send: async () => ({ ok: true }),
    showStatus() {},
    showCue() {},
    hide() {},
    setInterval: function () {
      assert.equal(this, globalThis, "native timer creation requires the Window receiver");
      return 7;
    },
    clearInterval: function (id) {
      assert.equal(this, globalThis, "not the playback controller");
      assert.equal(id, 7);
      cleared = true;
    },
  });
  assert.doesNotThrow(() => controller.stop());
  assert.equal(cleared, true);
  assert.equal(video.paused, false);
});

test("user cannot accidentally play ahead while waiting for inference", async () => {
  const { controller, video } = setup();
  controller.modelReady();
  await flush();
  video.time = 112;
  await controller.finish();
  await video.play();
  assert.equal(video.paused, true);
  controller.stop();
});

test("a short final section replays once and completes without an infinite preparation loop", async () => {
  const { controller, video } = setup({ video: new Video({ duration: 105 }) });
  controller.modelReady();
  await flush();
  assert.equal(controller.section.end, 105);
  video.time = 105;
  await controller.finish();
  await controller.segment({ epoch: controller.epoch, end: 105, cues: [], timing: "no speech recognized" });
  await flush();
  video.time = 105;
  video.ended = true;
  video.dispatchEvent(new Event("ended"));
  controller.tick();
  assert.equal(controller.state, "complete");
  controller.stop();
});

test("non-seekable live streams fail explicitly and release playback", async () => {
  const { controller, video, failures } = setup({ video: new Video({ duration: Infinity }) });
  controller.modelReady();
  await flush();
  assert.equal(controller.state, "stopped");
  assert.equal(video.paused, false);
  assert.match(failures[0], /not a live stream/);
});

test("real synchronized audio buffer and playback controller complete a translated replay", async () => {
  let controller;
  const muted = [];
  const engine = new SynchronizedAudio({
    transcribe: async () => ({ chunks: [{ text: "Hello from Turkish", timestamp: [0.2, 1.5] }] }),
    onSegment: (message) => { void controller.segment(message); },
    onMute: (value) => muted.push(value),
    onError: (error) => assert.fail(error.message),
  });
  const app = setup({ send: async (message) => { engine.command(message); return { ok: true }; } });
  controller = app.controller;
  controller.modelReady();
  await flush();
  engine.append(new Float32Array(32000).fill(0.1));
  app.video.time = 102;
  await controller.finish();
  await engine.queue;
  await flush();
  app.video.time = 100.5;
  controller.tick();
  assert.equal(app.captions.at(-1), "Hello from Turkish");
  assert.equal(controller.state, "replaying");
  assert.equal(muted.at(-1), false);
  controller.stop();
});

async function prepareSection(app, text = "Prepared English") {
  const { controller, video } = app;
  const { start, end } = controller.section;
  video.time = end;
  await controller.finish();
  await controller.segment({
    epoch: controller.epoch, end, timing: "model timestamps",
    cues: text ? [{ start, end, text }] : [],
  });
  await flush();
}

for (const minutes of [1, 3, 5]) {
  test(`${minutes}-minute preparation translates the whole interval before one uninterrupted replay`, async () => {
    const app = setup({ preparationSeconds: minutes * 60, video: new Video({ duration: 1000 }) });
    const { controller, video, commands, progress, completions } = app;
    controller.modelReady();
    await flush();
    const count = minutes * 5;
    for (let part = 0; part < count; part++) {
      assert.equal(controller.state, "collecting");
      await prepareSection(app, `Section ${part + 1}`);
      if (part < count - 1) {
        assert.equal(commands.some((entry) => entry.action === "replay"), false);
        assert.equal(video.currentTime, 100 + (part + 1) * 12);
      }
    }
    assert.equal(controller.state, "replaying");
    assert.equal(video.currentTime, 100);
    assert.equal(controller.cues.length, count);
    assert.equal(commands.filter((entry) => entry.action === "replay").length, 1);
    assert.equal(progress.at(-1).preparedSeconds, minutes * 60);
    assert.equal(progress.at(-1).totalSeconds, minutes * 60);
    video.time = 126;
    controller.tick();
    assert.equal(app.captions.at(-1), "Section 3");
    assert.equal(commands.filter((entry) => entry.action === "begin").length, count);
    video.time = 100 + minutes * 60;
    controller.tick();
    assert.equal(video.paused, true);
    assert.equal(controller.state, "stopped");
    assert.equal(completions.length, 1);
    assert.equal(controller.plan, null);
  });
}

test("a shorter remaining video caps preparation; seeking within prepared subtitles does not retranslate", async () => {
  const app = setup({ preparationSeconds: 60, video: new Video({ duration: 120 }) });
  app.controller.modelReady();
  await flush();
  await prepareSection(app, "First");
  await prepareSection(app, "Second");
  assert.equal(app.progress.at(-1).totalSeconds, 20);
  const calls = app.commands.length;
  app.video.pause();
  app.video.currentTime = 114;
  await flush();
  app.controller.tick();
  assert.equal(app.controller.state, "replaying");
  assert.equal(app.captions.at(-1), "Second");
  assert.equal(app.video.paused, true);
  app.video.playbackRate = 2;
  app.video.dispatchEvent(new Event("ratechange"));
  assert.equal(app.commands.length, calls);
  app.controller.stop();
});

test("a seek outside the prepared range clears old cues and prepares a fresh selected interval", async () => {
  const app = setup({ preparationSeconds: 60, video: new Video({ duration: 1000 }) });
  app.controller.modelReady();
  await flush();
  await prepareSection(app);
  const oldEpoch = app.controller.epoch;
  app.video.currentTime = 500;
  await flush();
  await app.controller.segment({ epoch: oldEpoch, end: 124, cues: [{ start: 112, end: 124, text: "Stale" }] });
  assert.equal(app.controller.plan.start, 500);
  assert.equal(app.controller.plan.end, 560);
  assert.deepEqual(app.controller.plan.cues, []);
  assert.equal(app.video.currentTime, 500);
  app.controller.stop();
});

test("silence still completes preparation and stopping during preparation discards its cache", async () => {
  const app = setup({ preparationSeconds: 60, video: new Video({ duration: 110 }) });
  app.controller.modelReady();
  await flush();
  await prepareSection(app, "");
  assert.equal(app.controller.state, "replaying");
  assert.equal(app.video.paused, false);
  assert.equal(app.controller.plan.ready, true);
  app.controller.stop();
  assert.equal(app.controller.plan, null);
});

test("preparing at the video's end fails explicitly rather than waiting forever", async () => {
  const app = setup({ preparationSeconds: 60, video: new Video({ time: 100, duration: 100, paused: true }) });
  app.controller.modelReady();
  await flush();
  assert.equal(app.controller.state, "stopped");
  assert.match(app.failures[0], /video is at the end/);
});

test("preparation-tab source translates consecutive sections without replaying or rewinding", async () => {
  const sections = [];
  let done = 0;
  const app = setup({ sourceOnly: true, initialEpoch: 1000000,
    video: new Video({ time: 0, duration: 20 }),
    onPreparedSegment: async (section) => sections.push(section),
    onSourceComplete: () => { done++; },
  });
  app.controller.modelReady();
  await flush();
  app.video.time = 12;
  await app.controller.finish();
  await app.controller.segment({ epoch: app.controller.epoch, start: 0, end: 12, cues: [] });
  assert.equal(app.video.currentTime, 12);
  assert.equal(app.controller.state, "collecting");
  app.video.time = 20;
  await app.controller.finish();
  await app.controller.segment({ epoch: app.controller.epoch, start: 12, end: 20, cues: [] });
  assert.equal(app.controller.state, "complete");
  assert.equal(done, 1);
  assert.equal(sections.length, 2);
  assert.equal(app.commands.some(({ action }) => action === "replay"), false);
  assert.ok(app.commands[0].epoch > 1000000);
  app.controller.stop();
  assert.equal(app.video.paused, true);
});

test("source media reset fails explicitly, pauses the helper, and clears controller ownership", async () => {
  const app = setup({ sourceOnly: true });
  app.controller.modelReady();
  await flush();
  app.video.duration = NaN;
  app.video.readyState = 0;
  app.controller.tick();
  assert.equal(app.controller.state, "stopped");
  assert.equal(app.video.paused, true);
  assert.equal(app.cleared(), true);
  assert.match(app.failures[0], /lost its media stream/);
});
