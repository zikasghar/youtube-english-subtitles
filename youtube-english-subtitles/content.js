(() => {
  const CONTENT_VERSION = chrome.runtime.getManifest().version;
  if (globalThis.__ytesContentVersion === CONTENT_VERSION) return;
  const HOST_ID = "ytes-subtitle-host";
  const MAX_CUES = 1800;
  const POLL_INTERVAL_MS = 1600;

  let enabled = true;
  let currentVideoId = "";
  let cues = [];
  let cueIndex = -1;
  let generation = 0;
  let renderTimer = 0;
  let scanTimer = 0;
  let shadowRoot;
  let subtitleLine;
  let statusLine;
  let overlayHost;
  let liveAudioMode = false;
  let audioCueQueue = [];
  let audioCueTimer = 0;
  let latestAudioStatus = "Local audio translation is running.";
  let syncPlayback = null;
  let syncPageUrl = "";
  let rollingViewer = null;
  let rollingSource = null;
  let rollingSession = null;
  let rollingModelReady = false;
  const hasAd = () => !!document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting");

  function playTranslationVideo(video, shouldContinue) {
    return globalThis.YtesPlayVideo({
      video, shouldContinue,
      requestRecovery: (requestId) => chrome.runtime.sendMessage({ type: "RECOVER_TRANSLATION_PLAYBACK", requestId }),
    });
  }

  async function rollingMessage(type, values = {}, session = rollingSession || rollingSource) {
    const response = await chrome.runtime.sendMessage({
      type, sessionId: session?.id, generation: session?.generation, ...values,
    });
    if (!response?.ok) throw new Error(response?.error || "The rolling preparation session disconnected.");
    return response;
  }

  function stopRolling(resume = true) {
    rollingViewer?.stop(resume);
    rollingViewer = null;
    rollingSession = null;
    stopSynchronizedPlayback();
    rollingSource = null;
    rollingModelReady = false;
  }

  async function startRollingSource(session, restart) {
    stopSynchronizedPlayback();
    rollingSource = session;
    if (!restart) rollingModelReady = false;
    const video = document.querySelector("video");
    if (!video || hasAd()) throw new Error("Wait for the preparation video to load and finish any ad, then retry.");
    video.pause();
    video.muted = false;
    video.volume = 1;
    video.playbackRate = 1;
    if (Math.abs(video.currentTime - session.start) > 0.02) {
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          video.removeEventListener("seeked", complete);
          reject(new Error("The preparation video could not seek. Wait for it to load and retry."));
        }, 8000);
        function complete() {
          window.clearTimeout(timer);
          video.removeEventListener("seeked", complete);
          resolve();
        }
        video.addEventListener("seeked", complete);
        video.currentTime = session.start;
      });
    }
    liveAudioMode = true;
    syncPageUrl = location.href;
    showStatus("Preparation tab: open the extension and click Start preparation capture. Keep this tab open.");
    if (restart) {
      const controller = ensureSynchronizedPlayback();
      if (rollingModelReady) controller.modelReady();
    }
  }

  function stopSynchronizedPlayback() {
    syncPlayback?.stop();
    syncPlayback = null;
  }

  function ensureSynchronizedPlayback(preparationSeconds = 0) {
    if (syncPlayback) return syncPlayback;
    const video = document.querySelector("video");
    if (!video || !globalThis.YtesSyncPlayback) {
      throw new Error("The synchronized playback controller is missing. Reload the extension and refresh YouTube.");
    }
    syncPageUrl = location.href;
    liveAudioMode = true;
    window.clearTimeout(audioCueTimer);
    audioCueTimer = 0;
    audioCueQueue = [];
    const sourceSession = rollingSource ? { ...rollingSource } : null;
    syncPlayback = new globalThis.YtesSyncPlayback({
      video,
      preparationSeconds,
      sourceOnly: !!rollingSource,
      playVideo: (shouldContinue) => playTranslationVideo(video, shouldContinue),
      initialEpoch: rollingSource ? rollingSource.generation * 1000000 : 0,
      hasAd,
      onPreparedSegment: (segment) => rollingMessage("ROLLING_SEGMENT", { segment }, sourceSession),
      onSourceComplete: () => rollingMessage("ROLLING_SOURCE_DONE", {}, sourceSession),
      onProgress: (progress) => {
        void chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", progress }).catch(() => {});
      },
      onComplete: (text) => {
        liveAudioMode = false;
        void chrome.runtime.sendMessage({ type: "SYNC_COMPLETE", text }).catch(() => {});
      },
      send: (command) => chrome.runtime.sendMessage({ type: "SYNC_COMMAND", ...command }),
      showStatus,
      onFailure: (text) => {
        void chrome.runtime.sendMessage({ type: "SYNC_FAILURE", text }).catch(() => {});
      },
      hide: hideOverlayText,
      showCue: showSubtitle,
    });
    return syncPlayback;
  }

  function ensureOverlay() {
    const player = document.querySelector("#movie_player");
    if (!player) return false;

    if (!overlayHost || !overlayHost.isConnected) {
      overlayHost = document.createElement("div");
      overlayHost.id = HOST_ID;
      overlayHost.setAttribute("aria-live", "polite");
      overlayHost.setAttribute("aria-atomic", "true");
      shadowRoot = overlayHost.attachShadow({ mode: "open" });
      shadowRoot.innerHTML = `
        <style>
          :host {
            position: absolute;
            z-index: 2147483646;
            right: 5%;
            bottom: 8%;
            left: 5%;
            display: block;
            pointer-events: none;
            text-align: center;
            font-family: Arial, Helvetica, sans-serif;
          }
          .subtitle {
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
            line-clamp: 2;
            max-height: 2.9em;
            max-width: 100%;
            width: fit-content;
            margin: 0 auto;
            overflow: hidden;
            padding: 0.12em 0.38em 0.18em;
            border-radius: 0.18em;
            background: rgba(0, 0, 0, 0.82);
            color: #fff;
            font-size: clamp(17px, 2.6vw, 29px);
            font-weight: 650;
            line-height: 1.45;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            box-decoration-break: clone;
            -webkit-box-decoration-break: clone;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
          }
          .status {
            display: none;
            width: fit-content;
            max-width: min(560px, 90%);
            margin: 0 auto;
            padding: 8px 12px;
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 8px;
            background: rgba(12, 13, 16, 0.9);
            color: #f2f3f5;
            font-size: 13px;
            line-height: 1.4;
          }
          .status.visible { display: block; }
          .subtitle.hidden { display: none; }
          @media (max-width: 600px) {
            :host { bottom: 11%; }
          }
        </style>
        <div class="subtitle hidden"></div>
        <div class="status" role="status"></div>
      `;
      subtitleLine = shadowRoot.querySelector(".subtitle");
      statusLine = shadowRoot.querySelector(".status");
      player.appendChild(overlayHost);
    }
    return true;
  }

  function showSubtitle(text) {
    if (!enabled || !ensureOverlay()) return;
    statusLine.classList.remove("visible");
    subtitleLine.textContent = text;
    subtitleLine.classList.remove("hidden");
  }

  function showStatus(message, { buffering = false } = {}) {
    if (!ensureOverlay()) return;
    if (!buffering) {
      statusLine.classList.remove("visible");
      statusLine.textContent = "";
      return;
    }
    subtitleLine.classList.add("hidden");
    statusLine.textContent = message;
    statusLine.classList.add("visible");
  }

  function hideOverlayText() {
    if (!subtitleLine || !statusLine) return;
    subtitleLine.classList.add("hidden");
    statusLine.classList.remove("visible");
    subtitleLine.textContent = "";
    statusLine.textContent = "";
  }

  function getPlayerResponse() {
    const player = document.querySelector("#movie_player");
    try {
      return player?.getPlayerResponse?.() ?? null;
    } catch {
      return null;
    }
  }

  function getVideoId(response) {
    const shortsId = location.pathname.match(/^\/shorts\/([^/?]+)/)?.[1];
    return (
      response?.videoDetails?.videoId ||
      document.querySelector("#movie_player")?.getVideoData?.()?.video_id ||
      new URL(location.href).searchParams.get("v") ||
      shortsId ||
      ""
    );
  }

  function getCaptionTracks(response) {
    return response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  }

  function isEnglish(track) {
    return /^en(?:[-_]|$)/i.test(track?.languageCode ?? "");
  }

  function makeTrackUrl(baseUrl, { translate = false } = {}) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    if (translate) url.searchParams.set("tlang", "en");
    return url.toString();
  }

  function parseCaptionEvents(data) {
    const events = data?.events ?? [];
    const parsed = [];
    for (const event of events) {
      if (!Array.isArray(event.segs) || typeof event.tStartMs !== "number") continue;
      const text = event.segs
        .map((segment) => segment.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text === "♪") continue;
      parsed.push({
        start: event.tStartMs / 1000,
        end: (event.tStartMs + (event.dDurationMs ?? 2200)) / 1000,
        text,
      });
    }
    return parsed.sort((a, b) => a.start - b.start);
  }

  function parseCaptionXml(xmlText) {
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    if (xml.querySelector("parsererror")) return [];
    const parsed = [];

    for (const node of xml.querySelectorAll("text, p")) {
      const startSeconds = node.hasAttribute("start")
        ? Number(node.getAttribute("start"))
        : Number(node.getAttribute("t")) / 1000;
      const durationSeconds = node.hasAttribute("dur")
        ? Number(node.getAttribute("dur"))
        : Number(node.getAttribute("d")) / 1000;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!Number.isFinite(startSeconds) || !text || text === "♪") continue;
      parsed.push({
        start: startSeconds,
        end: startSeconds + (Number.isFinite(durationSeconds) && durationSeconds > 0
          ? durationSeconds
          : 2.2),
        text,
      });
    }
    return parsed.sort((a, b) => a.start - b.start);
  }

  async function fetchCaptionTrack(track, translate) {
    const response = await fetch(makeTrackUrl(track.baseUrl, { translate }), {
      credentials: "include",
    });
    if (!response.ok) throw new Error("YouTube captions could not be loaded.");
    const body = await response.text();
    let parsed = [];
    try {
      parsed = parseCaptionEvents(JSON.parse(body));
    } catch {
      parsed = parseCaptionXml(body);
    }
    if (!parsed.length) throw new Error("This caption track is empty.");
    return parsed;
  }

  async function translateCuesOnDevice(sourceCues, sourceLanguage, runId) {
    const translatorApi = globalThis.Translator;
    if (!translatorApi?.create) {
      throw new Error(
        "Chrome’s on-device translation is unavailable, and YouTube did not provide English captions.",
      );
    }

    const language = (sourceLanguage || "").split(/[-_]/)[0].toLowerCase();
    if (!language || language === "en") return sourceCues;

    showStatus("Preparing English subtitles…", { buffering: true });
    const translator = await translatorApi.create({
      sourceLanguage: language,
      targetLanguage: "en",
    });

    const translated = new Array(sourceCues.length);
    let nextIndex = 0;
    let completed = 0;
    const workerCount = Math.min(4, sourceCues.length);

    async function worker() {
      while (nextIndex < sourceCues.length) {
        if (runId !== generation) return;
        const index = nextIndex++;
        const cue = sourceCues[index];
        translated[index] = {
          ...cue,
          text: await translator.translate(cue.text),
        };
        completed++;
        if (completed % 40 === 0) {
          showStatus(`Translating captions… ${completed} of ${sourceCues.length}`, { buffering: true });
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: workerCount }, worker));
      return translated.filter(Boolean);
    } finally {
      translator.destroy?.();
    }
  }

  async function loadCaptions(response, videoId, runId) {
    const tracks = getCaptionTracks(response);
    if (!tracks.length) {
      showStatus(
        "No captions are available. Turn on Two-tab mode in the extension to translate audio.",
      );
      return;
    }

    const englishTrack = tracks.find(isEnglish);
    const sourceTrack = englishTrack ?? tracks[0];
    let loadedCues;

    if (englishTrack) {
      loadedCues = await fetchCaptionTrack(englishTrack, false);
    } else {
      try {
        if (sourceTrack.isTranslatable !== false) {
          loadedCues = await fetchCaptionTrack(sourceTrack, true);
        }
      } catch {
        // Continue with the source captions and Chrome's on-device translator.
      }

      if (!loadedCues) {
        const sourceCues = await fetchCaptionTrack(sourceTrack, false);
        loadedCues = await translateCuesOnDevice(
          sourceCues.slice(0, MAX_CUES),
          sourceTrack.languageCode,
          runId,
        );
        if (sourceCues.length > MAX_CUES) {
          showStatus(`Showing the first ${MAX_CUES} translated captions.`);
        }
      }
    }

    if (runId !== generation || videoId !== currentVideoId) return;
    if (!loadedCues.length) {
      showStatus(
        "No captions are available. Use the extension button to start local audio translation.",
      );
      return;
    }
    cues = loadedCues.slice(0, MAX_CUES);
    cueIndex = -1;
    hideOverlayText();
    startRendering();
  }

  function startRendering() {
    window.clearInterval(renderTimer);
    renderTimer = window.setInterval(renderCurrentCue, 100);
    renderCurrentCue();
  }

  function renderCurrentCue() {
    const video = document.querySelector("video");
    if (liveAudioMode || !video || !cues.length || !enabled || !ensureOverlay()) {
      if (!enabled) hideOverlayText();
      return;
    }

    const time = video.currentTime;
    if (cueIndex >= 0 && time >= cues[cueIndex].start && time <= cues[cueIndex].end) {
      return;
    }

    let low = 0;
    let high = cues.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= time) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (found === cueIndex && found >= 0 && time <= cues[found].end) return;
    cueIndex = found >= 0 && time <= cues[found].end ? found : -1;

    if (cueIndex === -1) {
      subtitleLine.classList.add("hidden");
      statusLine.classList.remove("visible");
      return;
    }

    statusLine.classList.remove("visible");
    showSubtitle(cues[cueIndex].text);
  }

  async function scanForVideo() {
    if (liveAudioMode) return;
    const isWatchPage = location.pathname.startsWith("/watch");
    const isShortsPage = location.pathname.startsWith("/shorts/");
    if (!enabled || (!isWatchPage && !isShortsPage)) return;

    const response = getPlayerResponse();
    const videoId = getVideoId(response);
    if (!response || !videoId || videoId === currentVideoId) return;

    currentVideoId = videoId;
    const runId = ++generation;
    cues = [];
    cueIndex = -1;
    window.clearInterval(renderTimer);
    showStatus("Loading English subtitles…", { buffering: true });

    try {
      await loadCaptions(response, videoId, runId);
    } catch (error) {
      if (runId !== generation) return;
      showStatus(
        error instanceof Error
          ? error.message
          : "Subtitles could not be loaded for this video.",
      );
    }
  }

  chrome.storage.local.get({ enabled: true }).then(({ enabled: storedEnabled }) => {
    enabled = storedEnabled;
    if (enabled) {
      scanForVideo();
      scanTimer = window.setInterval(scanForVideo, POLL_INTERVAL_MS);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    if (!enabled) {
      stopSynchronizedPlayback();
      generation++;
      cues = [];
      currentVideoId = "";
      window.clearInterval(renderTimer);
      window.clearTimeout(audioCueTimer);
      audioCueTimer = 0;
      audioCueQueue = [];
      hideOverlayText();
    } else {
      scanForVideo();
      if (liveAudioMode) showStatus("Local audio translation is running.");
      if (!scanTimer) scanTimer = window.setInterval(scanForVideo, POLL_INTERVAL_MS);
    }
  });

  document.addEventListener("yt-navigate-finish", () => {
    const activeSession = rollingSession || rollingSource;
    if (activeSession) {
      // Playlist routes have no ?v=. Ask the worker to read the actual player
      // identity instead of stopping a valid session on every navigation event.
      void rollingMessage("ROLLING_VALIDATE_PAGE", {}, activeSession).catch(() => {
        if ((rollingSession || rollingSource)?.id !== activeSession.id) return;
        stopRolling(false);
        void chrome.runtime.sendMessage({ type: "STOP_LOCAL_TRANSLATION" }).catch(() => {});
      });
    }
    if (!activeSession && syncPlayback && location.href !== syncPageUrl) {
      stopSynchronizedPlayback();
      void chrome.runtime.sendMessage({ type: "STOP_LOCAL_TRANSLATION" }).catch(() => {});
    }
    currentVideoId = "";
    window.setTimeout(scanForVideo, 300);
  });

  function showNextAudioCue() {
    if (
      !enabled ||
      !liveAudioMode ||
      audioCueTimer ||
      audioCueQueue.length === 0 ||
      !ensureOverlay()
    ) {
      return;
    }
    const cue = audioCueQueue.shift();
    showSubtitle(cue.text);
    audioCueTimer = window.setTimeout(
      () => {
        audioCueTimer = 0;
        if (audioCueQueue.length) showNextAudioCue();
        else hideOverlayText();
      },
      Math.max(1100, Math.min(5200, cue.durationMs || 2600)),
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse = () => {}) => {
    if (message?.type === "ROLLING_VIDEO_INFO") {
      const video = document.querySelector("video");
      if (message.pause) video?.pause();
      sendResponse({ currentTime: video?.currentTime, duration: video?.duration, ad: hasAd(),
        live: !!document.querySelector("#movie_player.ytp-live") });
      return;
    }
    if (message?.type === "YT_SUBTITLES_PING") {
      sendResponse({
        ready: true,
        version: CONTENT_VERSION,
        playerFound: !!document.querySelector("#movie_player"),
      });
      return;
    }
    if (message?.type !== "LOCAL_AUDIO_EVENT") return;
    const acknowledge = () => sendResponse({
      ok: !!overlayHost?.isConnected,
      overlayConnected: !!overlayHost?.isConnected,
    });

    if (message.event?.startsWith("rolling-")) {
      try {
        if (message.event === "rolling-viewer-start") {
          stopRolling(false);
          rollingSession = message.session;
          liveAudioMode = true;
          enabled = true;
          generation++;
          window.clearInterval(renderTimer);
          const session = rollingSession;
          const video = document.querySelector("video");
          if (!video || !globalThis.YtesRollingPlayback) throw new Error("Refresh YouTube after reloading the extension.");
          rollingViewer = new globalThis.YtesRollingPlayback({
            video, preparationWaitSeconds: session.preparationMinutes * 60, generation: session.generation,
            playVideo: (shouldContinue) => playTranslationVideo(video, shouldContinue),
            showStatus, hide: hideOverlayText, hasAd,
            showCue: showSubtitle,
            onSeek: (time, seekId) => rollingMessage("ROLLING_SEEK", { time, seekId }),
            onProgress: (progress) => { void rollingMessage("ROLLING_VIEW_PROGRESS", { progress }).catch(() => {}); },
            onComplete: () => { void rollingMessage("ROLLING_FINISHED").catch(() => {}); },
            onFailure: (text) => { void rollingMessage("ROLLING_FAILURE", { text }).catch(() => {}); },
          });
        } else if (message.event === "rolling-source-start") {
          startRollingSource(message.session, message.restart).then(acknowledge)
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        } else if (message.event === "rolling-stop") {
          if ((rollingSession || rollingSource)?.id === message.sessionId) {
            stopRolling(message.resume);
            liveAudioMode = false;
            showStatus(message.text || "Rolling translation stopped.");
          }
        } else if (rollingSession?.id === message.sessionId || message.session?.id === rollingSession?.id) {
          if (message.event === "rolling-buffer-pause") {
            if (!rollingViewer) throw new Error("The viewing controller is unavailable. Restart translation.");
            rollingViewer.setBufferPause(message.paused);
            sendResponse({ ok: true, overlayConnected: !!overlayHost?.isConnected,
              pausedForBuffer: rollingViewer.pausedForBuffer });
            return;
          } else if (message.event === "rolling-preparation-start") {
            rollingViewer?.startPreparation(message.startedAt);
          } else if (message.event === "rolling-reset") {
            if (message.session.generation > rollingSession.generation) {
              rollingSession = message.session;
              rollingViewer?.reset(rollingSession.start, rollingSession.generation, message.seekId);
            }
          } else if (message.event === "rolling-segment") {
            rollingViewer?.addSegment(message.segment, message.generation);
          } else if (message.event === "rolling-source-done") {
            rollingViewer?.sourceDone(message.generation);
          }
        }
        acknowledge();
      } catch (error) {
        sendResponse({ ok: false, error: error.message, overlayConnected: !!overlayHost?.isConnected });
      }
      return;
    }

    if (message.event === "connect") {
      stopSynchronizedPlayback();
      generation++;
      window.clearInterval(renderTimer);
      enabled = true;
      liveAudioMode = true;
      showStatus("Buffering subtitles…", { buffering: true });
      acknowledge();
      return;
    }

    if (["sync-prepare", "sync-ready", "sync-segment"].includes(message.event)) {
      try {
        const controller = ensureSynchronizedPlayback(message.preparationSeconds || 0);
        if (message.event === "sync-ready") {
          if (rollingSource) rollingModelReady = true;
          controller.modelReady();
        }
        if (message.event === "sync-segment") void controller.segment(message);
        acknowledge();
      } catch (error) {
        showStatus(error.message);
        void chrome.runtime.sendMessage({ type: "STOP_LOCAL_TRANSLATION" }).catch(() => {});
        sendResponse({ ok: false, error: error.message, overlayConnected: !!overlayHost?.isConnected });
      }
      return;
    }

    if (message.event === "status") {
      liveAudioMode = true;
      latestAudioStatus = message.text || "Local audio translation is running.";
      if (!syncPlayback && !rollingViewer && enabled && !audioCueTimer && audioCueQueue.length === 0) {
        showStatus(latestAudioStatus, { buffering: message.buffering === true });
      }
      acknowledge();
      return;
    }

    if (message.event === "cue") {
      liveAudioMode = true;
      if (!enabled) {
        acknowledge();
        return;
      }
      audioCueQueue.push({
        text: message.text || "",
        durationMs: message.durationMs,
      });
      if (audioCueQueue.length > 24) audioCueQueue.splice(0, audioCueQueue.length - 24);
      showNextAudioCue();
      acknowledge();
      return;
    }

    if (message.event === "error") {
      stopSynchronizedPlayback();
      liveAudioMode = true;
      audioCueQueue = [];
      window.clearTimeout(audioCueTimer);
      audioCueTimer = 0;
      if (enabled) showStatus(message.text || "Local audio translation could not continue.");
      else hideOverlayText();
      acknowledge();
      return;
    }

    if (message.event === "stopped") {
      stopSynchronizedPlayback();
      liveAudioMode = false;
      audioCueQueue = [];
      window.clearTimeout(audioCueTimer);
      audioCueTimer = 0;
      hideOverlayText();
      if (enabled && cues.length) startRendering();
      else if (enabled) showStatus(message.text || "Local audio translation stopped.");
      acknowledge();
    }
  });
  globalThis.__ytesContentVersion = CONTENT_VERSION;
  if (globalThis.location?.href && new URL(location.href).searchParams.has("ytes_prepare")) {
    const video = document.querySelector("video");
    const holdUntilCapture = () => { if (!rollingSource) video?.pause(); };
    video?.addEventListener("play", holdUntilCapture);
    holdUntilCapture();
    liveAudioMode = true;
    showStatus("Preparation tab: open the extension and click Start preparation capture. Keep this tab open.");
  }
  void Promise.resolve(chrome.runtime.sendMessage?.({ type: "ROLLING_PAGE_LOADED" })).catch(() => {});
})();
