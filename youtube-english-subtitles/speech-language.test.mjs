import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { RollingSessions } from "./rolling-session.js";
import {
  SOURCE_LANGUAGE_CODES,
  SUGGESTED_SOURCE_LANGUAGE_CODES,
  requireSourceLanguage,
  getSpeechTranslationOptions,
} from "./speech-language.js";

test("language choices match the installed Whisper implementation", () => {
  const require = createRequire(import.meta.url);
  const implementation = readFileSync(
    new URL("../src/models/whisper/common_whisper.js", `file://${require.resolve("@huggingface/transformers")}`),
    "utf8",
  );
  const supported = [...implementation.matchAll(/\['([a-z]{2,3})', '[a-z ]+'\]/g)]
    .map((match) => match[1]);
  // Only the first array contains language codes; aliases are longer names.
  assert.equal(new Set(SOURCE_LANGUAGE_CODES).size, SOURCE_LANGUAGE_CODES.length);
  assert.deepEqual([...SOURCE_LANGUAGE_CODES].sort(), supported.sort());
});

test("missing or invalid source languages never silently become English", () => {
  for (const invalid of ["", null, undefined, "auto", "xx"]) {
    assert.throws(() => requireSourceLanguage(invalid), /spoken language/);
  }
});

test("source language is explicit while translation output stays English", () => {
  for (const language of ["tr", "ur", "es", "ar", "hi", "ja", "en"]) {
    assert.deepEqual(getSpeechTranslationOptions(language), {
      language,
      task: "translate",
      return_timestamps: true,
    });
  }
});

test("Turkish and Urdu are suggested and valid explicit source languages", () => {
  assert.deepEqual(SUGGESTED_SOURCE_LANGUAGE_CODES, ["tr", "ur"]);
  for (const code of SUGGESTED_SOURCE_LANGUAGE_CODES) {
    assert.equal(requireSourceLanguage(code), code);
    assert.equal(getSpeechTranslationOptions(code).task, "translate");
  }
});

function createBackground({ hasPlayer = true, overlayConnected = true } = {}) {
  let listener;
  const captures = [];
  const session = {};
  vm.runInNewContext(readFileSync(new URL("./background.js", import.meta.url), "utf8").replace(/^import .+;$/gm, ""), {
    RollingSessions,
    console,
    setTimeout,
    URL,
    chrome: {
      runtime: {
        getManifest: () => ({ version: "1.1.0" }),
        getURL: (path) => `chrome-extension://test/${path}`,
        getContexts: async () => [{}],
        onMessage: { addListener: (callback) => { listener = callback; } },
        sendMessage: async (message) => {
          if (message.type === "PING") return { ready: true };
          captures.push(message);
          return { ok: true };
        },
      },
      storage: { session: {
        set: async (values) => Object.assign(session, values),
        get: async () => session,
        remove: async (key) => { delete session[key]; },
      } },
      offscreen: { closeDocument: async () => {} },
      tabs: {
        get: async () => ({ url: "https://www.youtube.com/watch?v=test" }),
        sendMessage: async (_tabId, message) => message.type === "YT_SUBTITLES_PING"
          ? { ready: true, version: "1.1.0", playerFound: hasPlayer }
          : { ok: overlayConnected, overlayConnected },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
    },
  });
  return {
    captures,
    session,
    request: (message, sender = {}) => new Promise((resolve) => listener(message, sender, resolve)),
    start: (language, synchronized = false, preparationMinutes = 0) => new Promise((resolve) => listener({
      type: "START_LOCAL_TRANSLATION", tabId: 1, streamId: "stream", language, synchronized, preparationMinutes,
    }, {}, resolve)),
  };
}

test("background forwards the selected source language to the offscreen capture", async () => {
  const background = createBackground();
  const response = await background.start("es");
  assert.equal(response.ok, true);
  assert.equal(background.captures.length, 1);
  assert.equal(background.captures[0].language, "es");
});

test("only the exact 1, 3, and 5-minute preparation options reach capture", async () => {
  for (const minutes of [1, 3, 5]) {
    const background = createBackground();
    const response = await background.start("ur", true, minutes);
    assert.equal(response.ok, true);
    assert.equal(background.captures[0].preparationMinutes, minutes);
  }
  for (const invalid of [2, -1, 6, "3", null]) {
    const background = createBackground();
    assert.equal((await background.start("tr", true, invalid)).ok, false);
    assert.equal(background.captures.length, 0);
  }
  assert.equal((await createBackground().start("tr", false, 3)).ok, false);
});

test("preparation progress survives popup reopening and completion releases capture", async () => {
  const background = createBackground();
  await background.start("tr", true, 1);
  const progress = { phase: "preparing", preparedSeconds: 24, totalSeconds: 60, text: "24 / 60 seconds translated." };
  const result = await background.request({ type: "SYNC_PROGRESS", progress }, { tab: { id: 1 } });
  assert.equal(result.ok, true);
  const status = await background.request({ type: "GET_LOCAL_STATUS" });
  assert.equal(status.preparationProgress.preparedSeconds, 24);
  assert.equal(status.active, true);
  assert.equal((await background.request({ type: "SYNC_PROGRESS", progress }, { tab: { id: 8 } })).ok, false);
  const complete = await background.request({
    type: "SYNC_COMPLETE", text: "Prepared interval finished.",
  }, { tab: { id: 1 } });
  assert.equal(complete.ok, true);
  assert.equal(background.captures.at(-1).type, "STOP_CAPTURE");
  assert.equal(background.captures.at(-1).notify, false);
  assert.equal(background.session.activeTabId, undefined);
});

test("synchronized mode reaches the offscreen engine and only its active tab can control it", async () => {
  const background = createBackground();
  await background.start("tr", true);
  assert.equal(background.captures[0].synchronized, true);
  const command = { type: "SYNC_COMMAND", action: "begin", epoch: 1, start: 20, rate: 1 };
  const rejected = await background.request(command, { tab: { id: 2 } });
  assert.equal(rejected.ok, false);
  assert.equal(background.captures.length, 1);
  const accepted = await background.request(command, { tab: { id: 1 } });
  assert.equal(accepted.ok, true);
  assert.equal(background.captures[1].target, "offscreen");
  assert.equal(background.captures[1].epoch, 1);
  assert.equal(background.captures[1].start, 20);
});

test("synchronized controller failure stops capture and retains an actionable error", async () => {
  const background = createBackground();
  await background.start("ur", true);
  const result = await background.request({
    type: "SYNC_FAILURE", text: "The video cannot be replayed.",
  }, { tab: { id: 1 } });
  assert.equal(result.ok, true);
  assert.equal(background.captures.at(-1).type, "STOP_CAPTURE");
  assert.equal(background.captures.at(-1).notify, false);
  assert.match(background.session.lastStatus, /cannot be replayed/);
  assert.equal(background.session.activeTabId, undefined);
});

test("background rejects missing source language before starting capture", async () => {
  const background = createBackground();
  const response = await background.start("");
  assert.equal(response.ok, false);
  assert.match(response.error, /spoken language/);
  assert.equal(background.captures.length, 0);
});

test("capture cannot report success without a player and connected overlay", async () => {
  for (const options of [{ hasPlayer: false }, { overlayConnected: false }]) {
    const background = createBackground(options);
    const response = await background.start("es");
    assert.equal(response.ok, false);
    assert.match(response.error, /player|overlay/);
    assert.equal(background.captures.length, 0);
  }
});
