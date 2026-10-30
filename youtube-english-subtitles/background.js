import { RollingSessions } from "./rolling-session.js";

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
let activeTabId = null;
let closeOffscreenTimer = null;
const rolling = new RollingSessions({
  chrome, ensureOverlay: ensureOverlayConnection, startCapture: startLocalTranslation,
  stopCapture: stopLocalTranslation, hasCapture: async () => (await getActiveSessionTabId()) !== null,
  prepareCapture: async () => { await ensureOffscreenDocument(); await waitForOffscreenReady(); },
});

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function ensureOffscreenDocument() {
  if (closeOffscreenTimer !== null) globalThis.clearTimeout?.(closeOffscreenTimer);
  closeOffscreenTimer = null;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });

  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification:
        "Process audio captured from the active YouTube tab locally for English subtitles.",
    });
  }
}

async function waitForOffscreenReady() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "PING",
      });
      if (response?.ready) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  console.error("The offscreen processor readiness check failed.", lastError);
  throw new Error(
    "The offscreen audio processor did not load. Load the compiled dist folder in chrome://extensions, then refresh YouTube. Check the offscreen page console for the startup error.",
  );
}

async function sendToOffscreen(message) {
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    ...message,
  });
  if (!response || typeof response.ok !== "boolean") {
    throw new Error("The offscreen audio processor did not respond.");
  }
  return response;
}

async function ensureOverlayConnection(tabId) {
  let page = await chrome.tabs.sendMessage(tabId, { type: "YT_SUBTITLES_PING" }).catch(() => null);
  if (!page?.ready || page.version !== EXTENSION_VERSION) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["playback-recovery.js", "sync-playback.js", "rolling-playback.js", "content.js"] });
    page = await chrome.tabs.sendMessage(tabId, { type: "YT_SUBTITLES_PING" });
  }
  if (!page?.ready || page.version !== EXTENSION_VERSION || !page.playerFound) {
    throw new Error("No YouTube video player was found. Open a video watch page and try again.");
  }
  const response = await sendToTab(tabId, { event: "connect" });
  if (!response?.ok || !response.overlayConnected) {
    throw new Error("The YouTube subtitle overlay could not attach. Refresh the video page and try again.");
  }
  await chrome.storage.session.set({ overlayDelivery: { connected: true, error: "" } });
}

async function startLocalTranslation({ tabId, streamId, language, synchronized = false, preparationMinutes = 0, silentCapture = false }) {
  if (![0, 1, 3, 5].includes(preparationMinutes) || (preparationMinutes && synchronized !== true)) {
    throw new Error("Choose a preparation length of 1, 3, or 5 minutes in synchronized mode.");
  }
  if (typeof language !== "string" || !language.trim()) {
    throw new Error("Choose the video's spoken language before starting audio translation.");
  }
  if (!Number.isInteger(tabId) || !streamId) {
    throw new Error("The active YouTube tab could not be captured.");
  }
  const tab = await chrome.tabs.get(tabId);
  const hostname = tab.url ? new URL(tab.url).hostname : "";
  if (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) {
    throw new Error("Open a YouTube video before starting audio translation.");
  }
  await ensureOverlayConnection(tabId);

  activeTabId = tabId;
  await chrome.storage.session.set({
    activeTabId,
    lastStatus: "Overlay connected. Starting the audio processor…",
    audioTelemetry: null,
    lastCueText: "",
    lastCueAt: null,
    preparationProgress: null,
  });
  try {
    await ensureOffscreenDocument();
    await waitForOffscreenReady();
    const response = await sendToOffscreen({
      type: "START_CAPTURE",
      tabId,
      streamId,
      language,
      synchronized: synchronized === true,
      preparationMinutes,
      silentCapture,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not start local audio translation.");
    }
  } catch (error) {
    activeTabId = null;
    await chrome.storage.session.remove("activeTabId");
    const text = `Audio translation could not start: ${error.message || "Unknown startup error."}`;
    await chrome.storage.session.set({ lastStatus: text });
    await sendToTab(tabId, { event: "error", text }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    throw error;
  }
}

async function getActiveSessionTabId() {
  if (activeTabId !== null) return activeTabId;
  const session = await chrome.storage.session.get("activeTabId");
  activeTabId = Number.isInteger(session.activeTabId) ? session.activeTabId : null;
  return activeTabId;
}

async function stopLocalTranslation(notify = true) {
  const tabId = await getActiveSessionTabId();
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length) {
    try {
      await sendToOffscreen({ type: "STOP_CAPTURE", notify });
    } catch {
      // The offscreen document may already have stopped or been closed.
    }
  }
  activeTabId = null;
  await chrome.storage.session.remove("activeTabId");
  if (notify) await chrome.storage.session.set({ preparationProgress: null });
  if (contexts.length) {
    closeOffscreenTimer = setTimeout(() => {
      if (activeTabId === null) void chrome.offscreen.closeDocument().catch(() => {});
    }, 500);
  }
  return tabId;
}

function sendToTab(tabId, event) {
  return chrome.tabs.sendMessage(tabId, {
    ...event,
    // Set this last: incoming events still carry type "OFFSCREEN_EVENT".
    type: "LOCAL_AUDIO_EVENT",
  });
}

async function handleOffscreenEvent(message) {
  const rollingSession = await rolling.get();
  if (rollingSession && message.tabId !== rollingSession.helperTabId) return;
  if (["error", "stopped"].includes(message.event) && rollingSession) {
    await rolling.stop(message.text || "Preparation capture stopped. Start preparation again.", false);
    return;
  }
  if (message.event === "telemetry") {
    await chrome.storage.session.set({ audioTelemetry: message.telemetry });
    return;
  }
  const patch = {};
  if (message.event === "cue") {
    patch.lastCueText = message.text;
    patch.lastCueAt = Date.now();
  } else if (message.text) {
    patch.lastStatus = message.text || message.event;
  }
  await chrome.storage.session.set(patch);
  const tabId = Number.isInteger(message.tabId) ? message.tabId : activeTabId;
  if (Number.isInteger(tabId)) {
    try {
      const response = await sendToTab(tabId, message);
      await chrome.storage.session.set({
        overlayDelivery: {
          connected: !!response?.overlayConnected,
          error: response?.overlayConnected ? "" : "The video page did not acknowledge a connected overlay.",
        },
      });
    } catch (error) {
      await chrome.storage.session.set({
        overlayDelivery: { connected: false, error: error.message || "Refresh the YouTube tab." },
      });
      console.warn("Subtitle delivery failed. Refresh YouTube and restart translation.", error);
    }
  }
  if (message.event === "stopped" || message.event === "error") {
    activeTabId = null;
    await chrome.storage.session.remove("activeTabId");
    setTimeout(() => chrome.offscreen.closeDocument().catch(() => {}), 500);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "RECOVER_TRANSLATION_PLAYBACK") {
    (async () => {
      const tabId = sender.tab?.id;
      if (typeof message.requestId !== "string" || message.requestId.length > 100) {
        throw new Error("Invalid playback request.");
      }
      const session = await rolling.get();
      const activeTab = await getActiveSessionTabId();
      if (!Number.isInteger(tabId) || (session
        ? ![session.viewerTabId, session.helperTabId].includes(tabId) : tabId !== activeTab)) {
        throw new Error("Only an active translation player can request playback.");
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        args: [message.requestId],
        func: (requestId) => {
          const video = document.querySelector("video");
          const player = document.querySelector("#movie_player");
          if (video?.getAttribute("data-ytes-playback-request") !== requestId) {
            return { ok: false, error: "Playback was paused, stopped or moved." };
          }
          if (!video || !player || player.classList.contains("ad-showing") ||
              player.classList.contains("ad-interrupting")) return { ok: false, error: "Wait for the video and any ad to finish." };
          // Use YouTube's own playback state machine, not just its media element.
          if (typeof player.playVideo !== "function") return { ok: false, error: "YouTube's player is not ready." };
          player.playVideo();
          return { ok: true };
        },
      });
      return results?.[0]?.result || { ok: false, error: "YouTube's player did not respond." };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type?.startsWith("ROLLING_")) {
    if (message.type === "ROLLING_PAGE_LOADED") {
      rolling.get().then(async (session) => {
        if (session && (sender.tab?.id === session.viewerTabId ||
            (session.phase !== "awaiting-capture" && sender.tab?.id === session.helperTabId))) {
          await rolling.stop("A translation page reloaded. Start preparation again.", false);
        }
      }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    } else {
      rolling.handle(message, sender).then(() => sendResponse({ ok: true }))
        .catch(async (error) => {
          // Errors in an established viewer timeline must release both players.
          if (["ROLLING_SEEK", "ROLLING_SEGMENT", "ROLLING_SOURCE_DONE"].includes(message.type)) {
            const session = await rolling.get();
            const currentSeek = message.type === "ROLLING_SEEK" && Number.isSafeInteger(message.seekId)
              ? rolling.isLatestSeek(message) : session?.generation === message.generation;
            if (session?.id === message.sessionId && currentSeek &&
                [session.viewerTabId, session.helperTabId].includes(sender.tab?.id)) {
              await rolling.stop(error.message, false);
            }
          }
          sendResponse({ ok: false, error: error.message });
        });
    }
    return true;
  }
  if (message?.type === "SYNC_PROGRESS" || message?.type === "SYNC_COMPLETE") {
    getActiveSessionTabId().then(async (tabId) => {
      if (!Number.isInteger(tabId) || sender.tab?.id !== tabId) {
        throw new Error("Only the active translation tab can report preparation progress.");
      }
      if (message.type === "SYNC_COMPLETE") {
        await stopLocalTranslation(false);
        await chrome.storage.session.set({ lastStatus: String(message.text || "Prepared interval finished.") });
      } else {
        const progress = message.progress;
        if (!progress || !Number.isFinite(progress.preparedSeconds) || !Number.isFinite(progress.totalSeconds) ||
            progress.preparedSeconds < 0 || progress.preparedSeconds > progress.totalSeconds || progress.totalSeconds > 300) {
          throw new Error("Invalid preparation progress.");
        }
        await chrome.storage.session.set({ preparationProgress: progress, lastStatus: progress.text });
      }
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "SYNC_FAILURE") {
    getActiveSessionTabId().then(async (tabId) => {
      if (!Number.isInteger(tabId) || sender.tab?.id !== tabId) {
        throw new Error("Only the active translation tab can stop synchronized playback.");
      }
      if (await rolling.get()) {
        await rolling.stop(String(message.text || "Preparation failed."), false);
        sendResponse({ ok: true });
        return;
      }
      await stopLocalTranslation(false);
      const text = `Synchronized translation stopped: ${String(message.text || "Playback failed.")}`;
      await chrome.storage.session.set({ lastStatus: text });
      await sendToTab(tabId, { event: "error", text });
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "SYNC_COMMAND" && message.target !== "offscreen") {
    getActiveSessionTabId().then(async (tabId) => {
      if (!Number.isInteger(tabId) || sender.tab?.id !== tabId) {
        throw new Error("Only the active translation tab can control synchronized playback.");
      }
      return sendToOffscreen({ ...message, type: "SYNC_COMMAND" });
    }).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "START_LOCAL_TRANSLATION") {
    rolling.get().then((session) => {
      if (session) throw new Error("Stop the two-tab session before starting another translation.");
      return startLocalTranslation(message);
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Could not start local translation.",
        }),
      );
    return true;
  }

  if (message?.type === "STOP_LOCAL_TRANSLATION") {
    rolling.get().then((session) => session ? rolling.stop() : stopLocalTranslation())
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Could not stop local translation.",
        }),
      );
    return true;
  }

  if (message?.type === "GET_LOCAL_STATUS") {
    Promise.all([
      getActiveSessionTabId(),
      chrome.storage.session.get(["lastStatus", "audioTelemetry", "overlayDelivery", "lastCueText", "lastCueAt", "preparationProgress"]),
      rolling.get(),
      chrome.storage.session.get("rollingProgress"),
    ])
      .then(([tabId, diagnostics, session, progress]) => sendResponse({
        active: tabId !== null || !!session, tabId, ...diagnostics,
        rollingSession: session, rollingProgress: progress.rollingProgress,
      }))
      .catch(() => sendResponse({ active: false, tabId: null }));
    return true;
  }

  if (message?.type === "OFFSCREEN_EVENT") {
    handleOffscreenEvent(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void rolling.tabChanged(tabId, changeInfo.url).catch(console.warn);
  const hostname = new URL(changeInfo.url).hostname;
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) return;
  void getActiveSessionTabId().then((activeId) => {
    if (activeId === tabId) void stopLocalTranslation();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void rolling.tabChanged(tabId, null, true).catch(console.warn);
  void getActiveSessionTabId().then((activeId) => {
    if (activeId === tabId) void stopLocalTranslation();
  });
});
