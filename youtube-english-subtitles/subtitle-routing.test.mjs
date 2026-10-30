import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { RollingSessions } from "./rolling-session.js";

// Run the real background and content scripts, with small DOM/Chrome adapters.
// This verifies the message boundary and visible-element state, not CSS layout.
function createExtension({ missingReceiver = false, hasPlayer = true } = {}) {
  let backgroundListener;
  let contentListener;
  let settingsListener;
  let host;
  let nextTimer = 1;
  const timers = new Map();
  const deliveries = [];
  const session = {};
  const injections = [];
  let receiverAvailable = !missingReceiver;
  const element = (...classes) => {
    const names = new Set(classes);
    return {
      textContent: "",
      classList: {
        add: (name) => names.add(name),
        remove: (name) => names.delete(name),
        contains: (name) => names.has(name),
      },
    };
  };
  const subtitle = element("hidden");
  const status = element();
  const player = { appendChild: (node) => { node.isConnected = true; } };
  const window = {
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 1,
    clearInterval() {},
  };
  vm.runInNewContext(readFileSync(new URL("./content.js", import.meta.url), "utf8"), {
    window,
    document: {
      querySelector: (selector) => selector === "#movie_player" && hasPlayer ? player : null,
      addEventListener() {},
      createElement() {
        host = {
          isConnected: false,
          setAttribute() {},
          attachShadow: () => ({
            set innerHTML(_html) {},
            querySelector: (selector) => selector === ".subtitle" ? subtitle : status,
          }),
        };
        return host;
      },
    },
    chrome: {
      // Skip caption-track scanning; test incoming live audio events directly.
      storage: {
        local: { get: () => ({ then() {} }) },
        onChanged: { addListener: (callback) => { settingsListener = callback; } },
      },
      runtime: {
        getManifest: () => ({ version: "1.1.0" }),
        onMessage: { addListener: (callback) => { contentListener = callback; } },
      },
    },
  });
  // Exercise the real startup handshake directly, without a test-only runtime API.
  const connectOverlay = vm.runInNewContext(
    readFileSync(new URL("./background.js", import.meta.url), "utf8").replace(/^import .+;$/gm, "") +
      "\nensureOverlayConnection;", {
    RollingSessions,
    console,
    URL,
    setTimeout: window.setTimeout,
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.1.0" }),
        getURL: (path) => `chrome-extension://test/${path}`,
        onMessage: { addListener: (callback) => { backgroundListener = callback; } },
      },
      storage: {
        session: {
          set: async (values) => Object.assign(session, values),
          get: async () => session,
          remove: async (key) => { delete session[key]; },
        },
      },
      scripting: {
        executeScript: async (options) => { injections.push(options); receiverAvailable = true; },
      },
      offscreen: { closeDocument: async () => {} },
      tabs: {
        get: async () => ({ url: "https://www.youtube.com/watch?v=test" }),
        sendMessage: async (tabId, message) => {
          if (!receiverAvailable) throw new Error("Receiving end does not exist.");
          deliveries.push({ tabId, message });
          return new Promise((resolve) => contentListener(message, {}, resolve));
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
    },
  });
  return {
    connectOverlay: () => connectOverlay(42),
    subtitle,
    status,
    deliveries,
    session,
    injections,
    emit(event, values = {}) {
      return new Promise((resolve) => backgroundListener({
        type: "OFFSCREEN_EVENT", tabId: 42, event, ...values,
      }, {}, resolve));
    },
    request: (message) => new Promise((resolve) => backgroundListener(message, {}, resolve)),
    disable: () => settingsListener({ enabled: { newValue: false } }, "local"),
    expireCue() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test("offscreen progress is retagged and displayed on the YouTube overlay", async () => {
  const extension = createExtension();
  await extension.emit("status", { text: "Preparing the speech model…", buffering: true });
  assert.equal(extension.deliveries[0].tabId, 42);
  assert.equal(extension.deliveries[0].message.type, "LOCAL_AUDIO_EVENT");
  assert.equal(extension.status.textContent, "Preparing the speech model…");
  assert.equal(extension.status.classList.contains("visible"), true);
});

test("translated offscreen cue becomes a visible English subtitle", async () => {
  const extension = createExtension();
  await extension.emit("cue", { text: "Hello, how are you?", durationMs: 2400 });
  assert.equal(extension.subtitle.textContent, "Hello, how are you?");
  assert.equal(extension.subtitle.classList.contains("hidden"), false);
  assert.equal(extension.status.classList.contains("visible"), false);
});

test("the shared subtitle overlay is limited to two lines with overflow hidden", () => {
  const source = readFileSync(new URL("./content.js", import.meta.url), "utf8");
  const styles = source.match(/\.subtitle \{([^}]+)\}/)[1];
  assert.match(styles, /display: -webkit-box/);
  assert.match(styles, /-webkit-line-clamp: 2/);
  assert.match(styles, /max-height: 2\.9em/);
  assert.match(styles, /overflow: hidden/);
});

test("progress does not overwrite active captions and the next queued cue appears", async () => {
  const extension = createExtension();
  await extension.emit("cue", { text: "First line" });
  await extension.emit("status", { text: "Translating speech…", buffering: true });
  await extension.emit("cue", { text: "Second line" });
  assert.equal(extension.subtitle.textContent, "First line");
  extension.expireCue();
  assert.equal(extension.subtitle.textContent, "Second line");
  assert.equal(extension.subtitle.classList.contains("hidden"), false);
  extension.expireCue();
  assert.equal(extension.subtitle.classList.contains("hidden"), true);
});

test("turning subtitles off keeps incoming live cues hidden", async () => {
  const extension = createExtension();
  await extension.emit("cue", { text: "Visible before disable" });
  extension.disable();
  await extension.emit("cue", { text: "Must stay hidden" });
  await extension.emit("status", { text: "Must also stay hidden" });
  assert.equal(extension.subtitle.classList.contains("hidden"), true);
  assert.equal(extension.status.classList.contains("visible"), false);
});

test("processor errors and stopped messages stay in popup status, not video tags", async () => {
  const extension = createExtension();
  await extension.emit("error", { text: "The speech model could not be loaded." });
  assert.equal(extension.status.classList.contains("visible"), false);
  assert.equal((await extension.request({ type: "GET_LOCAL_STATUS" })).lastStatus, "The speech model could not be loaded.");
  await extension.emit("stopped", { text: "Local audio translation stopped." });
  assert.equal(extension.status.classList.contains("visible"), false);
  assert.equal((await extension.request({ type: "GET_LOCAL_STATUS" })).lastStatus, "Local audio translation stopped.");
});

test("finished and running status tags disappear while buffering tags remain visible", async () => {
  const extension = createExtension();
  for (const text of ["Prepared interval finished.", "Local audio translation is running.", "Video translation complete."]) {
    await extension.emit("status", { text: "Buffering subtitles…", buffering: true });
    assert.equal(extension.status.classList.contains("visible"), true);
    await extension.emit("status", { text });
    assert.equal(extension.status.classList.contains("visible"), false);
    assert.equal(extension.status.textContent, "");
  }
});

test("startup injects a missing page script and waits for its connected acknowledgement", async () => {
  const extension = createExtension({ missingReceiver: true });
  await extension.connectOverlay();
  assert.equal(extension.injections.length, 1);
  assert.equal(extension.injections[0].target.tabId, 42);
  assert.equal(extension.injections[0].files.join(","), "playback-recovery.js,sync-playback.js,rolling-playback.js,content.js");
  assert.equal(extension.status.textContent, "Buffering subtitles…");
  assert.equal(extension.status.classList.contains("visible"), true);
  assert.equal(extension.session.overlayDelivery.connected, true);
});

test("startup fails explicitly when the YouTube player is missing", async () => {
  const extension = createExtension({ hasPlayer: false });
  await assert.rejects(extension.connectOverlay(), /No YouTube video player/);
});

test("audio telemetry and last result remain available internally", async () => {
  const extension = createExtension();
  await extension.emit("telemetry", {
    telemetry: { recordedSeconds: 24, modelReady: true, windows: 1, cues: 1 },
  });
  await extension.emit("cue", { text: "A real translated line" });
  const result = await extension.request({ type: "GET_LOCAL_STATUS" });
  assert.equal(result.audioTelemetry.recordedSeconds, 24);
  assert.equal(result.audioTelemetry.modelReady, true);
  assert.equal(result.lastCueText, "A real translated line");
  assert.equal(result.overlayDelivery.connected, true);
});
