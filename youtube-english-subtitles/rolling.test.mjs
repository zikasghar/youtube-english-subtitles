import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import "./rolling-playback.js";
import { RollingSessions } from "./rolling-session.js";

class Video extends EventTarget {
  constructor(duration = 240) {
    super();
    Object.assign(this, { currentTime: 0, duration, paused: false, ended: false, isConnected: true });
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  async play() {
    if (!this.paused) return;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  seek(time) {
    this.currentTime = time;
    this.dispatchEvent(new Event("seeking"));
    this.dispatchEvent(new Event("seeked"));
  }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function viewer(minutes = 1, duration = 240, options = {}) {
  const video = new Video(duration), cues = [], statuses = [], seeks = [], failures = [];
  const { skipInitialWait = true, startCapture = true, ...controllerOptions } = options;
  let clock = 1000000;
  let done = 0, cleared = 0, ad = false;
  const controller = new globalThis.YtesRollingPlayback({
    video, preparationWaitSeconds: minutes * 60, generation: 1, now: () => clock,
    showStatus: (text) => statuses.push(text), showCue: (text) => cues.push(text), hide: () => cues.push(""),
    onSeek: async (time) => seeks.push(time), onComplete: () => { done++; },
    onFailure: (text) => failures.push(text), hasAd: () => ad,
    setInterval: () => 1, clearInterval: () => { cleared++; },
    seekDelay: 0,
    ...controllerOptions,
  });
  if (startCapture) controller.startPreparation(clock);
  if (skipInitialWait) clock += minutes * 60000;
  const add = (start, end, generation = 1) => controller.addSegment({
    start, end, cues: [{ start, end, text: `English ${start}` }],
  }, generation);
  return { video, controller, add, cues, statuses, seeks, failures,
    advance(seconds) { clock += seconds * 1000; controller.tick(); },
    startCapture() { controller.startPreparation(clock); },
    done: () => done, cleared: () => cleared, showAd: () => { ad = true; } };
}

for (const minutes of [1, 3, 5]) {
  test(`${minutes}-minute initial wait measures elapsed time, not translated video duration`, () => {
    const app = viewer(minutes, 1200, { skipInitialWait: false });
    assert.equal(app.video.paused, true);
    app.add(0, 12);
    app.advance(minutes * 60 - 1);
    assert.equal(app.video.paused, true);
    assert.match(app.statuses.at(-1), /1 seconds of initial wait/);
    app.advance(1);
    assert.equal(app.video.paused, false);
    app.add(12, 24);
    app.video.currentTime = 14;
    app.controller.tick();
    assert.equal(app.video.paused, false);
    assert.equal(app.cues.at(-1), "English 12");
    app.controller.stop();
  });
}

test("preparation instructions clear on playback, including gaps without a subtitle cue", () => {
  const app = viewer(1, 240, { skipInitialWait: false });
  app.controller.addSegment({ start: 0, end: 12, cues: [] }, 1);
  assert.match(app.statuses.at(-1), /initial wait/);
  app.advance(60);
  assert.equal(app.video.paused, false);
  assert.equal(app.statuses.at(-1), "");
  app.video.currentTime = 12;
  app.controller.tick();
  assert.equal(app.video.paused, true);
  assert.match(app.statuses.at(-1), /catching up/);
  app.add(12, 24);
  assert.equal(app.video.paused, false);
  assert.equal(app.statuses.at(-1), "");
  assert.equal(app.cues.at(-1), "English 12");
  app.controller.stop(false);
});

test("permission waiting does not consume the timer, and an elapsed timer cannot play untranslated audio", () => {
  const progress = [];
  const app = viewer(1, 240, { skipInitialWait: false, startCapture: false,
    onProgress: (value) => progress.push(value) });
  app.advance(120);
  assert.equal(app.video.paused, true);
  assert.equal(progress.at(-1).waitRemainingSeconds, null);
  app.startCapture();
  app.advance(59);
  assert.equal(app.video.paused, true);
  app.advance(1);
  assert.equal(app.video.paused, true, "wait expired but no translated section is ready");
  assert.equal(progress.at(-1).initialWaiting, false);
  app.add(0, 12);
  assert.equal(app.video.paused, false);
  app.controller.stop(false);
});

test("already prepared subtitles cannot bypass the initial countdown or restart it", () => {
  const app = viewer(3, 1200, { skipInitialWait: false });
  app.add(0, 300);
  app.advance(179);
  assert.equal(app.video.paused, true);
  app.startCapture(); // Duplicate start notification must not reset the deadline.
  app.advance(1);
  assert.equal(app.video.paused, false);
  app.controller.stop(false);
});

test("a seek during preparation preserves the original countdown", async () => {
  const app = viewer(1, 240, { skipInitialWait: false });
  app.add(0, 12);
  app.advance(30);
  app.video.seek(120);
  await flush();
  app.controller.reset(120, 2, app.controller.seekId);
  app.add(120, 132, 2);
  app.advance(29);
  assert.equal(app.video.paused, true);
  app.advance(1);
  assert.equal(app.video.paused, false);
  app.controller.stop(false);
});

test("ready subtitles with blocked playback report the reason without losing the prepared buffer", async () => {
  const progress = [];
  const app = viewer(1, 240, {
    playVideo: async () => { throw new Error("Open the viewing tab and press Play."); },
    onProgress: (value) => progress.push(value),
  });
  app.add(0, 60);
  await flush();
  app.controller.lastReport = 0;
  app.controller.tick();
  assert.equal(progress.at(-1).phase, "playback-blocked");
  assert.match(progress.at(-1).playbackError, /press Play/);
  assert.equal(app.controller.preparedEnd, 60);
  // An explicit native Play clears the error and resumes cached subtitles.
  await app.video.play();
  assert.equal(app.controller.playbackError, "");
  assert.equal(app.video.paused, false);
  app.controller.stop(false);
});

test("YouTube media buffering is distinct from subtitle buffering", () => {
  const progress = [];
  const app = viewer(1, 240, { onProgress: (value) => progress.push(value) });
  app.video.readyState = 2;
  app.add(0, 60);
  app.controller.lastReport = 0;
  app.controller.tick();
  assert.equal(progress.at(-1).phase, "media-buffering");
  assert.equal(progress.at(-1).requiredSeconds, 12);
  app.controller.stop(false);
});

test("lag pauses native playback and only resumes after a refill; user pause remains respected", async () => {
  const app = viewer();
  app.add(0, 60);
  app.video.currentTime = 59.8;
  app.controller.tick();
  assert.equal(app.video.paused, true);
  app.add(60, 72);
  assert.equal(app.video.paused, false);
  app.video.pause();
  app.add(72, 84);
  await flush();
  assert.equal(app.video.paused, true);
  app.controller.stop(false);
});

test("pause to buffer retains current time, accumulates more cues and only resumes on request", () => {
  const progress = [];
  const app = viewer(1, 240, { onProgress: (value) => progress.push(value) });
  app.add(0, 12);
  app.video.currentTime = 5;
  app.controller.setBufferPause(true);
  assert.equal(app.video.paused, true);
  assert.equal(app.controller.pausedForBuffer, true);
  app.add(12, 24);
  app.add(24, 36);
  app.advance(2);
  assert.equal(app.video.currentTime, 5);
  assert.equal(app.video.paused, true);
  assert.equal(progress.at(-1).aheadSeconds, 31);
  assert.equal(progress.at(-1).phase, "paused-buffering");
  assert.equal(app.statuses.at(-1), "", "manual pause must not leave a video status tag");
  app.controller.setBufferPause(false);
  assert.equal(app.video.paused, false);
  assert.equal(app.controller.pausedForBuffer, false);
  assert.equal(app.controller.preparedEnd, 36);
  app.controller.stop(false);
});

test("manual buffering can outlast the initial timer and resume cannot bypass missing subtitles", () => {
  const app = viewer(1, 240, { skipInitialWait: false });
  app.controller.setBufferPause(true);
  app.advance(70);
  app.add(0, 12);
  assert.equal(app.video.paused, true);
  app.controller.setBufferPause(false);
  assert.equal(app.video.paused, false);
  app.video.currentTime = 11.9;
  app.controller.tick();
  app.controller.setBufferPause(true);
  app.controller.setBufferPause(false);
  assert.equal(app.video.paused, true);
  app.add(12, 24);
  assert.equal(app.video.paused, false);
  app.controller.stop(false);
});

test("native pause builds buffer too, and native Play or explicit resume releases it", async () => {
  const app = viewer();
  app.add(0, 12);
  app.video.pause();
  assert.equal(app.controller.pausedForBuffer, true);
  app.add(12, 24);
  assert.equal(app.video.paused, true);
  await app.video.play();
  assert.equal(app.controller.pausedForBuffer, false);
  assert.equal(app.video.paused, false);
  app.controller.setBufferPause(true);
  app.controller.stop();
  assert.equal(app.video.paused, true, "Stop must respect an intentional user pause");
});

test("cached seeking needs no source restart; outside seeking invalidates until a new generation", async () => {
  const app = viewer();
  app.add(0, 72);
  app.video.seek(40);
  assert.equal(app.seeks.length, 0);
  assert.equal(app.video.paused, false);
  app.video.seek(150);
  await flush();
  assert.equal(app.video.paused, true);
  assert.deepEqual(app.seeks, [150]);
  app.add(72, 84);
  assert.equal(app.controller.preparedEnd, 84);
  app.controller.reset(150, 2);
  app.add(150, 162, 1);
  assert.equal(app.controller.preparedEnd, 150);
  app.add(150, 210, 2);
  assert.equal(app.video.paused, false);
  app.controller.stop(false);
});

test("cached forward/back skips resume immediately even with less than a refill section ahead", () => {
  const app = viewer();
  app.add(0, 72);
  app.video.seek(68);
  assert.equal(app.video.paused, false);
  assert.equal(app.cues.at(-1), "English 0");
  assert.equal(app.seeks.length, 0);
  app.video.pause();
  app.video.seek(20);
  assert.equal(app.video.paused, true);
  assert.equal(app.seeks.length, 0);
  app.controller.stop(false);
});

test("a skip buffers only the next section rather than repeating the selected five-minute wait", async () => {
  const app = viewer(5, 1200);
  app.add(0, 300);
  app.video.seek(600);
  await flush();
  app.controller.reset(600, 2, app.controller.seekId);
  app.add(600, 612, 2);
  assert.equal(app.video.paused, false);
  assert.equal(app.controller.refillSeconds, 12);
  app.controller.stop(false);
});

test("rapid skip requests coalesce and canceled seeks retain incoming cached sections", async () => {
  const timers = new Map();
  let nextTimer = 0;
  const app = viewer(1, 240, {
    seekDelay: 180,
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  app.add(0, 72);
  app.video.seek(150);
  app.add(72, 84);
  app.video.seek(40);
  assert.equal(timers.size, 0);
  assert.equal(app.video.paused, false);
  assert.equal(app.controller.preparedEnd, 84);
  app.add(84, 96);
  app.video.seek(150);
  app.video.seek(180);
  app.video.seek(200);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await flush();
  assert.deepEqual(app.seeks, [200]);
  app.controller.stop(false);
});

test("late reset and failed response from a superseded skip cannot stop the latest target", async () => {
  const pending = [];
  const app = viewer(1, 240, {
    onSeek: (time, seekId) => new Promise((resolve, reject) => pending.push({ time, seekId, resolve, reject })),
  });
  app.add(0, 72);
  app.video.seek(150);
  await flush();
  app.video.seek(190);
  await flush();
  assert.equal(app.controller.reset(150, 2, pending[0].seekId), false);
  assert.equal(app.controller.awaitingSeek, true);
  assert.equal(app.video.currentTime, 190);
  pending[0].reject(new Error("Old seek superseded"));
  await flush();
  assert.equal(app.failures.length, 0);
  assert.equal(app.controller.reset(190, 3, pending[1].seekId), true);
  pending[1].resolve();
  app.add(190, 202, 3);
  assert.equal(app.video.paused, false);
  assert.equal(app.failures.length, 0);
  app.controller.stop(false);
});

test("skipping to the end completes without asking the source to translate beyond the video", () => {
  const app = viewer();
  app.add(0, 60);
  app.video.seek(240);
  assert.equal(app.done(), 1);
  assert.equal(app.seeks.length, 0);
  assert.equal(app.video.paused, true);
});

test("short videos still honor elapsed initial wait and complete exactly once", () => {
  const app = viewer(5, 19, { skipInitialWait: false });
  app.add(0, 12);
  assert.equal(app.video.paused, true);
  app.add(12, 19);
  app.controller.sourceDone(1);
  app.advance(299);
  assert.equal(app.video.paused, true);
  app.advance(1);
  assert.equal(app.video.paused, false);
  app.video.currentTime = 19;
  app.video.ended = true;
  app.video.dispatchEvent(new Event("ended"));
  app.controller.tick();
  assert.equal(app.done(), 1);
  assert.equal(app.cleared(), 1);
});

test("ads and discontinuous source timestamps fail explicitly without playing untranslated audio", () => {
  const app = viewer();
  app.add(0, 60);
  app.showAd();
  app.controller.tick();
  assert.equal(app.video.paused, true);
  assert.match(app.failures[0], /ad interrupted/);
  const other = viewer();
  other.add(20, 32);
  assert.match(other.failures[0], /timeline changed/);
  assert.equal(other.video.paused, true);
});

function coordinator() {
  const store = {}, sent = [], capture = [], updates = [], removed = [];
  const playerIds = new Map(), pageReads = [];
  let processorReady = false;
  const tabs = new Map([
    [17, { id: 17, url: "https://www.youtube.com/watch?v=test", active: true }],
  ]);
  const chrome = {
    scripting: { executeScript: async (options) => {
      pageReads.push(options);
      const player = {
        getVideoData: () => ({ video_id: playerIds.get(options.target.tabId) || "" }),
      };
      const result = vm.runInNewContext(`(${options.func.toString()})()`, {
        document: { querySelector: () => player },
      });
      return [{ result }];
    } },
    tabCapture: { getMediaStreamId: async ({ targetTabId }) => {
      assert.equal(targetTabId, 18);
      assert.equal(processorReady, true);
      return "helper-stream";
    } },
    storage: { session: {
      get: async () => ({ ...store }),
      set: async (values) => Object.assign(store, values),
      remove: async (key) => { delete store[key]; },
    } },
    tabs: {
      get: async (id) => { if (!tabs.has(id)) throw new Error("Tab missing"); return tabs.get(id); },
      create: async (options) => {
        const tab = { id: 18, ...options };
        tabs.set(18, tab);
        return tab;
      },
      update: async (id, values) => { updates.push([id, values]); Object.assign(tabs.get(id), values); },
      remove: async (id) => { removed.push(id); tabs.delete(id); },
      sendMessage: async (tabId, message) => {
        sent.push([tabId, message]);
        if (message.type === "ROLLING_VIDEO_INFO") return { duration: 240, currentTime: 10, ad: false, live: false };
        if (message.event === "rolling-buffer-pause") return { ok: true, pausedForBuffer: message.paused };
        return { ok: true };
      },
    },
  };
  const controller = new RollingSessions({ chrome, ensureOverlay: async () => {},
    prepareCapture: async () => { processorReady = true; },
    hasCapture: async () => false, startCapture: async (message) => capture.push(message),
    stopCapture: async () => capture.push("stop") });
  return { store, sent, capture, updates, removed, tabs, controller, playerIds, pageReads };
}

test("watch_videos playlists prepare the actual playing item, not the first listed video", async () => {
  const app = coordinator();
  const url = "https://www.youtube.com/watch_videos?video_ids=4cZy3I-0B-8%2Cn6DTiZXXJes&type=0";
  app.tabs.get(17).url = url;
  app.playerIds.set(17, "n6DTiZXXJes");
  await app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 });
  const session = app.store.rollingSession;
  assert.equal(session.videoId, "n6DTiZXXJes");
  assert.equal(app.pageReads[0].world, "MAIN");
  assert.equal(new URL(app.tabs.get(18).url).searchParams.get("v"), "n6DTiZXXJes");
  assert.equal(session.start, 10);
  await app.controller.start({ sessionId: session.id });
  assert.equal(app.capture[0].silentCapture, true);
  await app.controller.tabChanged(17, url);
  assert.ok(app.store.rollingSession, "same playlist video must not stop on URL updates");
  await app.controller.handle({ type: "ROLLING_VALIDATE_PAGE", sessionId: session.id }, { tab: { id: 17 } });
  assert.ok(app.store.rollingSession, "same playlist video survives page navigation checks");
  app.playerIds.set(17, "4cZy3I-0B-8");
  await app.controller.handle({ type: "ROLLING_VALIDATE_PAGE", sessionId: session.id }, { tab: { id: 17 } });
  assert.equal(app.store.rollingSession, undefined, "playlist item changes must not reuse old captions");
  assert.equal(app.capture.at(-1), "stop");
});

test("a playlist without a readable current video never guesses from its list", async () => {
  const app = coordinator();
  app.tabs.get(17).url = "https://www.youtube.com/watch_videos?video_ids=4cZy3I-0B-8";
  await assert.rejects(app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 }), /wait for its player/);
  assert.equal(app.tabs.has(18), false);
  assert.equal(app.capture.length, 0);
});

test("playlist validation rejects unknown tabs and unsupported pages before reading page scripts", async () => {
  const app = coordinator();
  for (const url of [
    "https://www.youtube.com/shorts/4cZy3I-0B-8",
    "https://www.youtube.com/playlist?list=example",
    "https://example.com/watch_videos?video_ids=4cZy3I-0B-8",
  ]) {
    app.tabs.get(17).url = url;
    await assert.rejects(app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 }), /YouTube watch/);
  }
  assert.equal(app.pageReads.length, 0);
  app.tabs.get(17).url = "https://www.youtube.com/watch?v=test";
  await app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 });
  await assert.rejects(app.controller.handle({
    type: "ROLLING_VALIDATE_PAGE", sessionId: app.store.rollingSession.id,
  }, { tab: { id: 99 } }), /Only an active translation tab/);
});

test("two-tab lifecycle pauses viewer, requires explicit helper capture, routes only source segments, and cleans up", async () => {
  const app = coordinator();
  await app.controller.handle({ type: "ROLLING_CREATE", tabId: 17, language: "ur", preparationMinutes: 3 }, {});
  const session = app.store.rollingSession;
  assert.equal(session.viewerTabId, 17);
  assert.equal(session.helperTabId, 18);
  assert.equal(app.capture.length, 0);
  assert.equal(app.sent.some(([, event]) => event.event === "rolling-preparation-start"), false);
  assert.equal(app.updates[0][1].muted, true);
  await app.controller.handle({ type: "ROLLING_START_CAPTURE", sessionId: session.id, streamId: "helper-stream" }, {});
  assert.equal(app.capture[0].tabId, 18);
  assert.equal(app.capture[0].streamId, "helper-stream");
  assert.equal(app.capture[0].silentCapture, true);
  assert.equal(app.capture[0].language, "ur");
  const startEvent = app.sent.find(([, event]) => event.event === "rolling-preparation-start");
  assert.equal(startEvent[0], 17);
  assert.equal(startEvent[1].startedAt, app.store.rollingSession.preparationStartedAt);
  assert.ok(Number.isFinite(startEvent[1].startedAt));
  assert.deepEqual(app.updates.at(-1), [17, { active: true }]);
  const event = { type: "ROLLING_SEGMENT", sessionId: session.id, generation: 1, segment: { start: 10, end: 22, cues: [] } };
  await assert.rejects(app.controller.handle(event, { tab: { id: 17 } }), /no longer active/);
  await app.controller.handle(event, { tab: { id: 18 } });
  assert.equal(app.sent.at(-1)[0], 17);
  assert.equal(app.sent.at(-1)[1].event, "rolling-segment");
  await app.controller.stop();
  assert.equal(app.store.rollingSession, undefined);
  assert.deepEqual(app.removed, [18]);
  assert.equal(app.capture.at(-1), "stop");
  assert.equal(JSON.stringify(app.store).includes("cues"), false);
});

test("buffer-pause commands target only the viewer and never interrupt source capture", async () => {
  const app = coordinator();
  await app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 });
  const sessionId = app.store.rollingSession.id;
  const request = { type: "ROLLING_SET_BUFFER_PAUSE", sessionId, tabId: 17, paused: true };
  await assert.rejects(app.controller.handle(request, {}), /Start capture first/);
  await app.controller.start({ sessionId });
  const captureCount = app.capture.length;
  await app.controller.handle(request, {});
  assert.equal(app.sent.at(-1)[0], 17);
  assert.equal(app.sent.at(-1)[1].event, "rolling-buffer-pause");
  assert.equal(app.store.rollingProgress.pausedForBuffer, true);
  assert.equal(app.store.rollingSession.phase, "preparing");
  await app.controller.handle({ ...request, paused: false }, {});
  assert.equal(app.store.rollingProgress.pausedForBuffer, false);
  assert.equal(app.capture.length, captureCount);
  await assert.rejects(app.controller.handle({ ...request, tabId: 18 }, {}), /viewing tab/);
  await assert.rejects(app.controller.handle({ ...request, paused: "yes" }, {}), /pause or resume/);
  app.controller.chrome.tabs.sendMessage = async () => ({ ok: false, error: "Viewing tab disconnected" });
  await assert.rejects(app.controller.handle(request, {}), /disconnected/);
  assert.equal(app.store.rollingProgress.pausedForBuffer, false);
});

test("popup progress reports elapsed waiting time separately from translated media", async () => {
  const app = coordinator();
  await app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 3 });
  const sessionId = app.store.rollingSession.id;
  const report = (extra) => app.controller.handle({
    type: "ROLLING_VIEW_PROGRESS", sessionId, generation: 1,
    progress: { phase: "buffering", aheadSeconds: 12, currentTime: 10, requiredSeconds: 12, ...extra },
  }, { tab: { id: 17 } });
  await report({ initialWaiting: true, waitRemainingSeconds: null });
  assert.match(app.store.lastStatus, /capture permission/);
  await report({ initialWaiting: true, waitRemainingSeconds: 37 });
  assert.match(app.store.lastStatus, /37 seconds of initial wait remaining/);
  await report({ initialWaiting: false, waitRemainingSeconds: 0 });
  assert.ok(app.store.lastStatus.includes("Buffering subtitles: 12 / 12 seconds ready"));
});

test("viewer seek persists a new generation, repositions source, and rejects stale segments", async () => {
  const app = coordinator();
  await app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 });
  const id = app.store.rollingSession.id;
  await app.controller.start({ sessionId: id, streamId: "helper-stream" });
  await app.controller.handle({ type: "ROLLING_SEEK", sessionId: id, generation: 1, time: 120 }, { tab: { id: 17 } });
  assert.equal(app.store.rollingSession.generation, 2);
  assert.equal(app.sent.at(-1)[1].session.start, 120);
  await assert.rejects(app.controller.handle({
    type: "ROLLING_SEGMENT", sessionId: id, generation: 1, segment: {},
  }, { tab: { id: 18 } }), /no longer active/);
  await app.controller.tabChanged(18, "https://www.youtube.com/watch?v=different");
  assert.equal(app.store.rollingSession, undefined);
  // A helper that navigated elsewhere is not forcibly closed by this scenario's mock URL.
});

test("newest skip wins even when an older helper seek is still pending and fails", async () => {
  const app = coordinator();
  await app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 });
  const id = app.store.rollingSession.id;
  await app.controller.start({ sessionId: id });
  const originalSend = app.controller.chrome.tabs.sendMessage;
  let release;
  app.controller.chrome.tabs.sendMessage = async (tabId, message) => {
    const response = await originalSend(tabId, message);
    if (message.event === "rolling-source-start" && message.restart && message.session.seekId === 1) {
      return new Promise((resolve) => { release = resolve; });
    }
    return response;
  };
  const first = app.controller.handle({
    type: "ROLLING_SEEK", sessionId: id, generation: 1, seekId: 1, time: 120,
  }, { tab: { id: 17 } });
  await flush();
  assert.equal(typeof release, "function");
  const last = app.controller.handle({
    type: "ROLLING_SEEK", sessionId: id, generation: 1, seekId: 2, time: 180,
  }, { tab: { id: 17 } });
  await flush();
  release({ ok: false, error: "The old seek was interrupted." });
  await Promise.all([first, last]);
  assert.equal(app.store.rollingSession.start, 180);
  assert.equal(app.store.rollingSession.generation, 3);
  assert.equal(app.store.rollingSession.seekId, 2);
  assert.equal(app.removed.length, 0);
  await app.controller.handle({
    type: "ROLLING_SEEK", sessionId: id, generation: 1, seekId: 1, time: 50,
  }, { tab: { id: 17 } });
  assert.equal(app.store.rollingSession.start, 180);
  await app.controller.handle({
    type: "ROLLING_FINISHED", sessionId: id, generation: 1,
  }, { tab: { id: 17 } });
  assert.equal(app.store.rollingSession, undefined);
});

test("seeking before capture preserves the explicit start step rather than starting an unready engine", async () => {
  const app = coordinator();
  await app.controller.create({ tabId: 17, language: "tr", preparationMinutes: 1 });
  const id = app.store.rollingSession.id;
  await app.controller.handle({ type: "ROLLING_SEEK", sessionId: id, generation: 1, time: 120 }, { tab: { id: 17 } });
  assert.equal(app.store.rollingSession.phase, "awaiting-capture");
  assert.equal(app.store.rollingSession.start, 120);
  assert.equal(app.sent.some(([, message]) => message.event === "rolling-source-start"), false);
  await app.controller.start({ sessionId: id, streamId: "helper-stream" });
  assert.equal(app.sent.find(([, message]) => message.event === "rolling-source-start")[1].session.start, 120);
});

test("failure cleanup pauses a playing viewer while manual stop releases an initial hold", () => {
  const app = viewer();
  app.add(0, 60);
  assert.equal(app.video.paused, false);
  app.controller.stop(false);
  assert.equal(app.video.paused, true);
  const pending = viewer();
  pending.controller.stop(true);
  assert.equal(pending.video.paused, false);
});
