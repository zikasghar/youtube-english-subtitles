import { SOURCE_LANGUAGE_CODES, SUGGESTED_SOURCE_LANGUAGE_CODES, requireSourceLanguage } from "./speech-language.js";

const enabledControl = document.querySelector("#enabled");
const twoTabControl = document.querySelector("#two-tab-mode");
const sourceLanguageControl = document.querySelector("#source-language");
const preparationLengthControl = document.querySelector("#preparation-length");
const captureButton = document.querySelector("#capture-audio");
const bufferPauseButton = document.querySelector("#buffer-pause");
const status = document.querySelector("#status");
let requestPending = false;
let rollingSession = null;
let translationActive = false;
let helperCanCapture = false;
let viewerCanBuffer = false;
let pausedForBuffer = false;
let refreshVersion = 0;
let actionError = "";

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const languageAliases = { jw: "Javanese", my: "Burmese", nn: "Norwegian Nynorsk", tl: "Tagalog" };
const languageOptions = SOURCE_LANGUAGE_CODES.map((code) => ({
  code, label: languageAliases[code] || languageNames.of(code),
})).sort((a, b) => a.label.localeCompare(b.label));
function appendLanguageGroup(label, options) {
  const group = document.createElement("optgroup");
  group.label = label;
  for (const { code, label: name } of options) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    group.append(option);
  }
  sourceLanguageControl.append(group);
}
appendLanguageGroup("Turkish and Urdu", languageOptions.filter(({ code }) => SUGGESTED_SOURCE_LANGUAGE_CODES.includes(code)));
appendLanguageGroup("Other languages", languageOptions.filter(({ code }) => !SUGGESTED_SOURCE_LANGUAGE_CODES.includes(code)));

function readableMessage(error) {
  const message = error instanceof Error ? error.message : "The extension could not complete the request.";
  if (/receiving end does not exist|could not establish connection/i.test(message)) {
    return "Reload the extension at chrome://extensions, then refresh YouTube.";
  }
  return message;
}

function renderControls() {
  if (!requestPending) twoTabControl.checked = translationActive;
  twoTabControl.disabled = requestPending;
  enabledControl.disabled = requestPending;
  sourceLanguageControl.disabled = requestPending || translationActive;
  preparationLengthControl.disabled = requestPending || translationActive;
  captureButton.hidden = !helperCanCapture;
  captureButton.disabled = requestPending;
  bufferPauseButton.hidden = !viewerCanBuffer;
  bufferPauseButton.disabled = requestPending;
  bufferPauseButton.textContent = pausedForBuffer ? "Resume playback" : "Pause to buffer";
}

async function refreshStatus() {
  if (requestPending) return;
  const version = ++refreshVersion;
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_LOCAL_STATUS" });
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (requestPending || version !== refreshVersion) return;
    rollingSession = result?.rollingSession || null;
    translationActive = !!result?.active || !!rollingSession;
    if (rollingSession) {
      if ([1, 3, 5].includes(rollingSession.preparationMinutes)) preparationLengthControl.value = String(rollingSession.preparationMinutes);
      if (SOURCE_LANGUAGE_CODES.includes(rollingSession.language)) sourceLanguageControl.value = rollingSession.language;
    }
    helperCanCapture = rollingSession?.phase === "awaiting-capture" && tab?.id === rollingSession.helperTabId;
    viewerCanBuffer = !!rollingSession && rollingSession.phase !== "awaiting-capture" &&
      tab?.id === rollingSession.viewerTabId;
    pausedForBuffer = result?.rollingProgress?.pausedForBuffer === true;
    renderControls();
    status.textContent = actionError || (helperCanCapture
      ? "Click Start preparation capture to allow audio in this tab."
      : rollingSession?.phase === "awaiting-capture"
        ? "Open the extension in the preparation tab to allow capture."
        : translationActive && !rollingSession
          ? "A previous translation is active. Turn Two-tab mode off to stop it."
          : translationActive ? result?.lastStatus || "Preparing English subtitles…"
            : enabledControl.checked ? "Ready. Use captions, or turn on Two-tab mode."
              : "Subtitles are off.");
  } catch (error) {
    if (!requestPending && version === refreshVersion) {
      renderControls();
      status.textContent = readableMessage(error);
    }
  }
}

async function runAction(action) {
  if (requestPending) return;
  requestPending = true;
  refreshVersion++;
  actionError = "";
  renderControls();
  try {
    await action();
  } catch (error) {
    actionError = readableMessage(error);
    status.textContent = actionError;
  } finally {
    requestPending = false;
    renderControls();
    await refreshStatus();
  }
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "The extension could not complete the request.");
}

twoTabControl.addEventListener("change", () => {
  const turnOn = twoTabControl.checked;
  return runAction(async () => {
    if (!turnOn) {
      await send({ type: "STOP_LOCAL_TRANSLATION" });
      translationActive = false;
      rollingSession = null;
      helperCanCapture = false;
      return;
    }
    const language = requireSourceLanguage(sourceLanguageControl.value);
    const preparationMinutes = Number(preparationLengthControl.value);
    if (![1, 3, 5].includes(preparationMinutes)) throw new Error("Choose 1, 3, or 5 minutes.");
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || new URL(tab.url).hostname !== "www.youtube.com" ||
        !["/watch", "/watch_videos"].includes(new URL(tab.url).pathname)) {
      throw new Error("Open a YouTube watch video or video playlist before turning on Two-tab mode.");
    }
    await chrome.storage.local.set({ enabled: true, sourceLanguage: language, preparationMinutes });
    enabledControl.checked = true;
    status.textContent = "Opening the preparation tab…";
    await send({ type: "ROLLING_CREATE", tabId: tab.id, language, preparationMinutes });
    translationActive = true;
  });
});

captureButton.addEventListener("click", () => runAction(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!helperCanCapture || tab?.id !== rollingSession?.helperTabId) {
    throw new Error("Open this extension in the preparation tab to allow capture.");
  }
  status.textContent = "Starting silent preparation…";
  await send({ type: "ROLLING_START_CAPTURE", sessionId: rollingSession.id });
}));

bufferPauseButton.addEventListener("click", () => runAction(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!viewerCanBuffer || tab?.id !== rollingSession?.viewerTabId) {
    throw new Error("Open this extension in the viewing tab to pause or resume playback.");
  }
  await send({ type: "ROLLING_SET_BUFFER_PAUSE", sessionId: rollingSession.id,
    tabId: tab.id, paused: !pausedForBuffer });
}));

enabledControl.addEventListener("change", () => {
  const enabled = enabledControl.checked;
  return runAction(async () => {
    await chrome.storage.local.set({ enabled });
    if (!enabled) {
      await send({ type: "STOP_LOCAL_TRANSLATION" });
      translationActive = false;
      rollingSession = null;
      helperCanCapture = false;
    }
  });
});

sourceLanguageControl.addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ sourceLanguage: requireSourceLanguage(sourceLanguageControl.value) });
    actionError = "";
  } catch (error) {
    actionError = readableMessage(error);
    status.textContent = actionError;
  }
});

preparationLengthControl.addEventListener("change", async () => {
  try {
    const preparationMinutes = Number(preparationLengthControl.value);
    if (![1, 3, 5].includes(preparationMinutes)) throw new Error("Choose 1, 3, or 5 minutes.");
    await chrome.storage.local.set({ preparationMinutes });
    actionError = "";
  } catch (error) {
    actionError = readableMessage(error);
    status.textContent = actionError;
  }
});

async function initialize() {
  twoTabControl.disabled = true;
  try {
    const settings = await chrome.storage.local.get({ enabled: true, sourceLanguage: "", preparationMinutes: 1 });
    enabledControl.checked = settings.enabled;
    if (SOURCE_LANGUAGE_CODES.includes(settings.sourceLanguage)) sourceLanguageControl.value = settings.sourceLanguage;
    preparationLengthControl.value = String([1, 3, 5].includes(settings.preparationMinutes) ? settings.preparationMinutes : 1);
  } catch (error) {
    actionError = readableMessage(error);
  }
  await refreshStatus();
  window.setInterval(refreshStatus, 1000);
}
void initialize();
