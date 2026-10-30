import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { SOURCE_LANGUAGE_CODES, SUGGESTED_SOURCE_LANGUAGE_CODES, requireSourceLanguage } from "./speech-language.js";

const html = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
const source = readFileSync(new URL("./popup.js", import.meta.url), "utf8").replace(/^import .+;$/gm, "");
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

async function popup(settings = {}) {
  const elements = new Map();
  function element() {
    return {
      value: "", hidden: false, disabled: false, checked: false, textContent: "", children: [], events: {},
      append(child) { this.children.push(child); },
      addEventListener(type, handler) { this.events[type] = handler; },
    };
  }
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(`#${id}`, element());
  elements.get("#capture-audio").hidden = true;
  const calls = [], stored = { enabled: true, sourceLanguage: "tr", preparationMinutes: 1, ...settings };
  let active = !!settings.active;
  let rollingSession = settings.rollingSession || null;
  let rollingProgress = settings.rollingProgress || null;
  let poll;
  vm.runInNewContext(source, {
    console, Intl, URL, Error, SOURCE_LANGUAGE_CODES, SUGGESTED_SOURCE_LANGUAGE_CODES, requireSourceLanguage,
    document: { querySelector: (selector) => elements.get(selector), createElement: element },
    window: { setInterval: (handler) => { poll = handler; return 1; } },
    chrome: {
      storage: { local: {
        get: async (defaults) => ({ ...defaults, ...stored }),
        set: async (values) => Object.assign(stored, values),
      } },
      tabs: { query: async () => [{
        id: settings.tabId || 17, url: settings.url || "https://www.youtube.com/watch?v=test",
      }] },
      runtime: {
        sendMessage: async (message) => {
          calls.push(message);
          if (message.type === settings.failType) return { ok: false, error: "Could not start preparation." };
          if (message.type === "GET_LOCAL_STATUS") return {
            active: active || !!rollingSession, rollingSession, rollingProgress, lastStatus: settings.lastStatus,
          };
          if (message.type === "ROLLING_CREATE") rollingSession = {
            id: "session", helperTabId: 18, viewerTabId: 17, phase: "awaiting-capture",
            language: message.language, preparationMinutes: message.preparationMinutes,
          };
          if (message.type === "ROLLING_START_CAPTURE") { rollingSession.phase = "preparing"; active = true; }
          if (message.type === "STOP_LOCAL_TRANSLATION") { active = false; rollingSession = null; }
          if (message.type === "ROLLING_SET_BUFFER_PAUSE") {
            rollingProgress = { pausedForBuffer: message.paused };
          }
          return { ok: true };
        },
      },
    },
  });
  await flush();
  return {
    calls, stored, elements,
    poll: async () => { await poll(); await flush(); },
    control: (id) => elements.get(`#${id}`),
    change: async (id, checked) => {
      const control = elements.get(`#${id}`);
      assert.equal(control.disabled, false);
      if (checked !== undefined) control.checked = checked;
      await control.events.change();
      await flush();
    },
    click: async (id) => {
      const control = elements.get(`#${id}`);
      assert.equal(control.disabled, false);
      assert.equal(control.hidden, false);
      await control.events.click();
      await flush();
    },
  };
}

test("simple popup removes diagnostics, tests, local Start and obsolete timing options", () => {
  for (const id of ["diagnostics-report", "test-overlay", "start-audio", "stop-audio", "playback-mode", "prepare-audio"]) {
    assert.ok(!html.includes(`id="${id}"`), id);
  }
  assert.ok(!html.includes("Live diagnostics"));
  assert.ok(!html.includes("Show test subtitle"));
  assert.ok(!html.includes("Start local audio translation"));
  assert.match(html, /id="two-tab-mode" type="checkbox" role="switch"/);
});

test("preparation selector keeps exactly 1, 3 and 5 minutes", () => {
  const selector = html.match(/<select id="preparation-length"[\s\S]*?<\/select>/)[0];
  assert.deepEqual([...selector.matchAll(/value="([^"]+)"/g)].map((match) => match[1]), ["1", "3", "5"]);
});

test("opening the popup never starts audio capture or a two-tab session", async () => {
  const app = await popup();
  assert.equal(app.control("two-tab-mode").checked, false);
  assert.equal(app.control("capture-audio").hidden, true);
  assert.equal(app.calls.filter(({ type }) => type !== "GET_LOCAL_STATUS").length, 0);
});

for (const minutes of [1, 3, 5]) {
  test(`two-tab toggle starts ${minutes}-minute preparation and turning off stops it`, async () => {
    const app = await popup({ preparationMinutes: minutes, sourceLanguage: "ur" });
    assert.equal(app.control("preparation-length").value, String(minutes));
    await app.change("two-tab-mode", true);
    const request = app.calls.find((message) => message.type === "ROLLING_CREATE");
    assert.equal(request.preparationMinutes, minutes);
    assert.equal(request.language, "ur");
    assert.equal(app.control("two-tab-mode").checked, true);
    assert.equal(app.control("two-tab-mode").disabled, false, "active mode must remain stoppable");
    assert.equal(app.control("preparation-length").disabled, true);
    assert.equal(app.control("source-language").disabled, true);
    assert.equal(app.calls.some(({ type }) => type === "START_LOCAL_TRANSLATION"), false);
    await app.change("two-tab-mode", false);
    assert.equal(app.calls.filter(({ type }) => type === "STOP_LOCAL_TRANSLATION").length, 1);
    assert.equal(app.control("two-tab-mode").checked, false);
    assert.equal(app.control("preparation-length").disabled, false);
    assert.equal(app.control("source-language").disabled, false);
    assert.equal(app.stored.preparationMinutes, minutes);
  });
}

test("watch_videos playlist links can start two-tab preparation", async () => {
  const app = await popup({
    url: "https://www.youtube.com/watch_videos?video_ids=4cZy3I-0B-8%2Cn6DTiZXXJes&type=0",
  });
  await app.change("two-tab-mode", true);
  assert.equal(app.calls.some(({ type }) => type === "ROLLING_CREATE"), true);
  assert.equal(app.control("two-tab-mode").checked, true);
});

test("viewing popup pauses and resumes buffering without restarting capture", async () => {
  const app = await popup({ rollingSession: {
    id: "session", phase: "preparing", viewerTabId: 17, helperTabId: 18, preparationMinutes: 1,
  } });
  assert.equal(app.control("buffer-pause").hidden, false);
  assert.equal(app.control("buffer-pause").textContent, "Pause to buffer");
  await app.click("buffer-pause");
  const pause = app.calls.find(({ type }) => type === "ROLLING_SET_BUFFER_PAUSE");
  assert.equal(pause.tabId, 17);
  assert.equal(pause.sessionId, "session");
  assert.equal(pause.paused, true);
  assert.equal(app.control("buffer-pause").textContent, "Resume playback");
  await app.click("buffer-pause");
  assert.equal(app.calls.filter(({ type }) => type === "ROLLING_SET_BUFFER_PAUSE").at(-1).paused, false);
  assert.equal(app.control("buffer-pause").textContent, "Pause to buffer");
  assert.equal(app.calls.some(({ type }) => ["ROLLING_CREATE", "ROLLING_START_CAPTURE", "STOP_LOCAL_TRANSLATION"].includes(type)), false);
});

test("buffer control is hidden without capture and outside the viewing tab", async () => {
  for (const settings of [
    {},
    { rollingSession: { id: "session", phase: "awaiting-capture", viewerTabId: 17, helperTabId: 18 } },
    { tabId: 18, rollingSession: { id: "session", phase: "preparing", viewerTabId: 17, helperTabId: 18 } },
    { tabId: 99, rollingSession: { id: "session", phase: "preparing", viewerTabId: 17, helperTabId: 18 } },
  ]) {
    const app = await popup(settings);
    assert.equal(app.control("buffer-pause").hidden, true);
  }
});

test("failed buffer pause leaves the action retryable without reporting success", async () => {
  const app = await popup({ failType: "ROLLING_SET_BUFFER_PAUSE", rollingSession: {
    id: "session", phase: "preparing", viewerTabId: 17, helperTabId: 18,
  } });
  await app.click("buffer-pause");
  assert.equal(app.control("buffer-pause").textContent, "Pause to buffer");
  assert.equal(app.control("buffer-pause").disabled, false);
  assert.match(app.control("status").textContent, /Could not start preparation/);
});

test("a missing language rolls the toggle back and keeps settings usable", async () => {
  const app = await popup({ sourceLanguage: "" });
  await app.change("two-tab-mode", true);
  assert.equal(app.calls.some(({ type }) => type === "ROLLING_CREATE"), false);
  assert.equal(app.control("two-tab-mode").checked, false);
  assert.equal(app.control("source-language").disabled, false);
  assert.match(app.control("status").textContent, /language/i);
});

test("non-YouTube tabs cannot start preparation", async () => {
  const app = await popup({ url: "https://example.com" });
  await app.change("two-tab-mode", true);
  assert.equal(app.calls.some(({ type }) => type === "ROLLING_CREATE"), false);
  assert.match(app.control("status").textContent, /YouTube watch video/);
  assert.equal(app.control("two-tab-mode").checked, false);
});

test("failed creation rolls back and preserves its actionable error across polls", async () => {
  const app = await popup({ failType: "ROLLING_CREATE" });
  await app.change("two-tab-mode", true);
  await app.poll();
  assert.equal(app.control("two-tab-mode").checked, false);
  assert.equal(app.control("preparation-length").disabled, false);
  assert.match(app.control("status").textContent, /Could not start preparation/);
});

const waitingSession = {
  id: "session", phase: "awaiting-capture", viewerTabId: 17, helperTabId: 18, preparationMinutes: 3,
};

test("only the pending preparation tab exposes the explicit capture handoff", async () => {
  const app = await popup({ tabId: 18, rollingSession: { ...waitingSession } });
  assert.equal(app.control("two-tab-mode").checked, true);
  assert.equal(app.control("capture-audio").hidden, false);
  await app.click("capture-audio");
  const request = app.calls.find(({ type }) => type === "ROLLING_START_CAPTURE");
  assert.equal(request.sessionId, "session");
  assert.equal(request.streamId, undefined);
  assert.equal(app.control("capture-audio").hidden, true);
  assert.equal(app.control("two-tab-mode").checked, true);
});

test("the viewing tab keeps capture permission instructions without a capture button", async () => {
  const app = await popup({ rollingSession: { ...waitingSession } });
  assert.equal(app.control("capture-audio").hidden, true);
  assert.match(app.control("status").textContent, /preparation tab/);
});

test("a failed helper handoff remains retryable", async () => {
  const app = await popup({ tabId: 18, rollingSession: { ...waitingSession }, failType: "ROLLING_START_CAPTURE" });
  await app.click("capture-audio");
  assert.equal(app.control("capture-audio").hidden, false);
  assert.equal(app.control("capture-audio").disabled, false);
  assert.equal(app.control("two-tab-mode").disabled, false);
});

test("turning subtitles off stops capture and resets two-tab mode", async () => {
  const app = await popup({ rollingSession: { ...waitingSession } });
  await app.change("enabled", false);
  assert.equal(app.stored.enabled, false);
  assert.equal(app.control("two-tab-mode").checked, false);
  assert.equal(app.control("preparation-length").disabled, false);
  assert.equal(app.calls.some(({ type }) => type === "STOP_LOCAL_TRANSLATION"), true);
});

test("an existing legacy translation can still be stopped after upgrading", async () => {
  const app = await popup({ active: true });
  assert.equal(app.control("two-tab-mode").checked, true);
  await app.change("two-tab-mode", false);
  assert.equal(app.control("two-tab-mode").checked, false);
});

test("brief progress and errors remain visible without the diagnostic panel", async () => {
  const app = await popup({
    rollingSession: { ...waitingSession, phase: "preparing" },
    lastStatus: "Preparing subtitles: 24 / 60 seconds ready.",
  });
  assert.equal(app.control("status").textContent, "Preparing subtitles: 24 / 60 seconds ready.");
});

test("failed Stop keeps the mode on and available for another attempt", async () => {
  const app = await popup({ rollingSession: { ...waitingSession }, failType: "STOP_LOCAL_TRANSLATION" });
  await app.change("two-tab-mode", false);
  assert.equal(app.control("two-tab-mode").checked, true);
  assert.equal(app.control("two-tab-mode").disabled, false);
});

test("reopening an active session shows its actual buffer and language", async () => {
  const app = await popup({ rollingSession: { ...waitingSession, language: "ur" } });
  assert.equal(app.control("preparation-length").value, "3");
  assert.equal(app.control("source-language").value, "ur");
  assert.equal(app.control("two-tab-mode").checked, true);
});
