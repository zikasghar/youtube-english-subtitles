// The service worker persists coordination metadata only, never audio or transcripts.
export class RollingSessions {
  constructor({ chrome, ensureOverlay, startCapture, stopCapture, hasCapture, prepareCapture = async () => {} }) {
    Object.assign(this, { chrome, ensureOverlay, startCapture, stopCapture, hasCapture, prepareCapture });
    this.queue = Promise.resolve();
    this.latestSeeks = new Map();
  }

  async get() {
    return (await this.chrome.storage.session.get("rollingSession")).rollingSession || null;
  }

  async save(session) {
    await this.chrome.storage.session.set({ rollingSession: session });
  }

  send(tabId, event, values = {}) {
    return this.chrome.tabs.sendMessage(tabId, { type: "LOCAL_AUDIO_EVENT", event, ...values });
  }

  async videoId(tabId, url) {
    if (url.hostname !== "www.youtube.com" || !["/watch", "/watch_videos"].includes(url.pathname)) return "";
    if (url.pathname === "/watch") return url.searchParams.get("v") || "";
    // /watch_videos contains a LIST, not the currently playing video ID.
    // Player methods are page-owned and must be read in MAIN, not the isolated
    // content-script world. Never guess the first ID from the playlist URL.
    const results = await this.chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: () => {
        const player = document.querySelector("#movie_player");
        try {
          return player?.getVideoData?.()?.video_id ||
            player?.getPlayerResponse?.()?.videoDetails?.videoId || "";
        } catch {
          return "";
        }
      },
    });
    const id = results?.[0]?.result;
    return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
  }

  async info(tabId) {
    const tab = await this.chrome.tabs.get(tabId);
    const url = new URL(tab.url);
    const videoId = await this.videoId(tabId, url);
    if (!videoId) {
      throw new Error("Open a YouTube watch video or video playlist and wait for its player to load. Shorts and live streams are not supported.");
    }
    const info = await this.chrome.tabs.sendMessage(tabId, { type: "ROLLING_VIDEO_INFO", pause: true });
    if (!info || !Number.isFinite(info.duration) || info.duration <= 0 || info.live || info.ad) {
      throw new Error("Wait for the video to load and finish any ad. Live streams are not supported.");
    }
    return { ...info, videoId };
  }

  async create({ tabId, language, preparationMinutes }) {
    if (await this.get() || await this.hasCapture()) throw new Error("Stop the current translation first.");
    if (![1, 3, 5].includes(preparationMinutes) || !language) throw new Error("Choose a language and 1, 3, or 5 minutes.");
    await this.ensureOverlay(tabId);
    const info = await this.info(tabId);
    if (info.currentTime >= info.duration - 0.05) throw new Error("Seek before the end of the video first.");
    const session = { id: crypto.randomUUID(), viewerTabId: tabId, helperTabId: null,
      generation: 1, videoId: info.videoId, start: info.currentTime, language,
      preparationMinutes, phase: "awaiting-capture" };
    await this.save(session);
    await this.chrome.storage.session.set({
      rollingProgress: null, preparationProgress: null, audioTelemetry: null,
      lastCueText: "", lastCueAt: null,
    });
    try {
      const response = await this.send(tabId, "rolling-viewer-start", { session });
      if (!response?.ok) throw new Error(response?.error || "The viewing player did not respond.");
      const helper = await this.chrome.tabs.create({
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(session.videoId)}&t=${Math.floor(session.start)}s&ytes_prepare=${session.id}`,
        active: true, openerTabId: tabId,
      });
      session.helperTabId = helper.id;
      await this.save(session);
      await this.chrome.tabs.update(helper.id, { muted: true });
      await this.chrome.storage.session.set({ lastStatus: "In the preparation tab, open this extension and click Start preparation capture." });
      return session;
    } catch (error) {
      await this.shutdown(error.message, false);
      throw error;
    }
  }

  async start({ sessionId }) {
    const session = await this.requireSession(sessionId);
    if (session.phase !== "awaiting-capture") throw new Error("Preparation is already running.");
    const helper = await this.chrome.tabs.get(session.helperTabId);
    if (!helper.active) throw new Error("Open the extension from the preparation tab to start capture.");
    await this.ensureOverlay(session.helperTabId);
    const info = await this.info(session.helperTabId);
    if (info.videoId !== session.videoId) throw new Error("The preparation tab is on a different video. Stop and restart.");
    const response = await this.send(session.helperTabId, "rolling-source-start", { session });
    if (!response?.ok) throw new Error(response?.error || "The preparation player did not respond.");
    session.phase = "preparing";
    await this.save(session);
    try {
      await this.prepareCapture();
      // Allocate the short-lived ID only after seeking and offscreen loading.
      // Opening the action popup in this helper granted its activeTab permission.
      const streamId = await this.chrome.tabCapture.getMediaStreamId({ targetTabId: session.helperTabId });
      session.preparationStartedAt = Date.now();
      await this.save(session);
      const viewer = await this.send(session.viewerTabId, "rolling-preparation-start", {
        sessionId: session.id, startedAt: session.preparationStartedAt,
      });
      if (!viewer?.ok) throw new Error(viewer?.error || "The viewing player could not start its preparation timer.");
      await this.startCapture({ tabId: session.helperTabId, streamId, language: session.language,
        synchronized: true, preparationMinutes: 0, silentCapture: true });
      // Capture now owns audio output and its gain is permanently zero.
      await this.chrome.tabs.update(session.helperTabId, { muted: false });
      await this.chrome.tabs.update(session.viewerTabId, { active: true });
    } catch (error) {
      await this.shutdown(error.message, false);
      throw error;
    }
  }

  async requireSession(id, senderTabId, role, generation) {
    const session = await this.get();
    if (!session || id !== session.id || (role && senderTabId !== session[`${role}TabId`]) ||
        (generation !== undefined && generation !== session.generation)) {
      throw new Error("This preparation session is no longer active.");
    }
    return session;
  }

  async handle(message, sender) {
    // This check may enqueue a stop, so it must not wait on its own lifecycle
    // queue. Only the resulting shutdown needs serialization with seeks.
    if (message.type === "ROLLING_VALIDATE_PAGE") {
      const session = await this.requireSession(message.sessionId);
      const tabId = sender.tab?.id;
      if (![session.viewerTabId, session.helperTabId].includes(tabId)) {
        throw new Error("Only an active translation tab can check its player.");
      }
      const tab = await this.chrome.tabs.get(tabId);
      return this.tabChanged(tabId, tab.url);
    }
    if (message.type === "ROLLING_SEEK" && Number.isSafeInteger(message.seekId) && message.seekId > 0) {
      // Register intent before the serialized queue: rapid skips supersede an
      // older helper seek even while that older native seek is still awaiting.
      const session = await this.get();
      if (session?.id === message.sessionId && sender.tab?.id === session.viewerTabId) {
        this.latestSeeks.set(session.id, Math.max(this.latestSeeks.get(session.id) || session.seekId || 0, message.seekId));
      }
    }
    // Serialize lifecycle/seek changes, but not offscreen SYNC_COMMAND requests.
    const task = this.queue.catch(() => {}).then(async () => {
      if (message.type === "ROLLING_CREATE") return this.create(message);
      if (message.type === "ROLLING_START_CAPTURE") return this.start(message);
      if (message.type === "ROLLING_SET_BUFFER_PAUSE") {
        const session = await this.requireSession(message.sessionId);
        if (message.tabId !== session.viewerTabId || session.phase === "awaiting-capture") {
          throw new Error("Start capture first, then open the extension in the viewing tab.");
        }
        if (typeof message.paused !== "boolean") throw new Error("Choose pause or resume.");
        const response = await this.send(session.viewerTabId, "rolling-buffer-pause", {
          sessionId: session.id, paused: message.paused,
        });
        if (!response?.ok || typeof response.pausedForBuffer !== "boolean") {
          throw new Error(response?.error || "The viewing tab did not respond. Refresh it and restart translation.");
        }
        const { rollingProgress = {} } = await this.chrome.storage.session.get("rollingProgress");
        const progress = { ...rollingProgress, pausedForBuffer: response.pausedForBuffer };
        await this.chrome.storage.session.set({ rollingProgress: progress,
          lastStatus: response.pausedForBuffer
            ? "Viewing paused to buffer. The preparation tab keeps translating ahead."
            : "Playback requested. Waiting for subtitles if necessary." });
        return;
      }
      const role = ["ROLLING_SEGMENT", "ROLLING_SOURCE_DONE"].includes(message.type) ? "helper" : "viewer";
      const identifiedSeek = message.type === "ROLLING_SEEK" && Number.isSafeInteger(message.seekId) && message.seekId > 0;
      const session = await this.requireSession(message.sessionId, sender.tab?.id, role,
        identifiedSeek || message.type === "ROLLING_FINISHED" ? undefined : message.generation);
      if (identifiedSeek && (!this.isLatestSeek(message) || message.seekId <= (session.seekId || 0))) return;
      if (message.type === "ROLLING_SEGMENT") {
        const response = await this.send(session.viewerTabId, "rolling-segment", {
          sessionId: session.id, generation: session.generation, segment: message.segment,
        });
        if (!response?.ok) throw new Error("The viewing tab disconnected. Restart translation.");
      } else if (message.type === "ROLLING_SOURCE_DONE") {
        await this.send(session.viewerTabId, "rolling-source-done", { sessionId: session.id, generation: session.generation });
      } else if (message.type === "ROLLING_SEEK") {
        if (!Number.isFinite(message.time) || message.time < 0) throw new Error("Invalid seek position.");
        session.start = message.time;
        session.generation++;
        if (identifiedSeek) session.seekId = message.seekId;
        const awaitingCapture = session.phase === "awaiting-capture";
        if (!awaitingCapture) session.phase = "preparing";
        await this.save(session);
        await this.send(session.viewerTabId, "rolling-reset", { session, seekId: message.seekId });
        if (!awaitingCapture) {
          const response = await this.send(session.helperTabId, "rolling-source-start", { session, restart: true });
          if (identifiedSeek && !this.isLatestSeek(message)) return;
          if (!response?.ok) throw new Error(response?.error || "The preparation tab could not seek.");
        }
      } else if (message.type === "ROLLING_VIEW_PROGRESS") {
        const progress = message.progress;
        if (!progress || !Number.isFinite(progress.aheadSeconds) || !Number.isFinite(progress.currentTime)) {
          throw new Error("Invalid buffer progress.");
        }
        await this.chrome.storage.session.set({ rollingProgress: progress,
          lastStatus: progress.pausedForBuffer
            ? `Paused to buffer: ${Math.round(progress.aheadSeconds)} seconds ready ahead. Preparation continues.`
            : progress.phase === "buffering"
            ? progress.initialWaiting
              ? progress.waitRemainingSeconds === null
                ? "Waiting for capture permission in the preparation tab."
                : `Preparing subtitles: ${Math.ceil(progress.waitRemainingSeconds)} seconds of initial wait remaining. Video and audio are paused.`
              : `Buffering subtitles: ${Math.round(progress.aheadSeconds)} / ${Math.round(progress.requiredSeconds || 12)} seconds ready. Video and audio are paused.`
            : progress.phase === "playback-blocked" ? progress.playbackError || "Open the viewing tab and press Play."
            : progress.phase === "media-buffering" ? "Subtitles are ready; YouTube itself is buffering the video. Check the video's network playback."
            : `Rolling subtitles: ${Math.round(progress.aheadSeconds)} seconds prepared ahead (${progress.phase}).` });
      } else if (message.type === "ROLLING_FINISHED" || message.type === "ROLLING_FAILURE") {
        await this.shutdown(message.text || "Video translation complete.", false);
      }
    });
    this.queue = task;
    return task;
  }

  isLatestSeek(message) {
    return !Number.isSafeInteger(message.seekId) || this.latestSeeks.get(message.sessionId) === message.seekId;
  }

  async shutdown(text = "Rolling translation stopped.", resume = true) {
    const session = await this.get();
    if (!session) return;
    // Remove ownership first so tab-close events and delayed messages cannot restart it.
    await this.chrome.storage.session.remove("rollingSession");
    this.latestSeeks.delete(session.id);
    await Promise.allSettled([
      this.send(session.viewerTabId, "rolling-stop", { sessionId: session.id, resume, text }),
      session.helperTabId === null ? Promise.resolve() : this.send(session.helperTabId, "rolling-stop", { sessionId: session.id, resume: false, text }),
    ]);
    await this.stopCapture(false);
    if (session.helperTabId !== null) {
      const tab = await this.chrome.tabs.get(session.helperTabId).catch(() => null);
      if (tab?.url?.includes(`ytes_prepare=${session.id}`)) await this.chrome.tabs.remove(session.helperTabId).catch(() => {});
    }
    await this.chrome.storage.session.set({ rollingProgress: null, lastStatus: text });
  }

  stop(text, resume) {
    const task = this.queue.catch(() => {}).then(() => this.shutdown(text, resume));
    this.queue = task;
    return task;
  }

  async tabChanged(tabId, url, removed = false) {
    const session = await this.get();
    if (!session || ![session.viewerTabId, session.helperTabId].includes(tabId)) return;
    let videoId = "";
    if (!removed && url) {
      try {
        videoId = await this.videoId(tabId, new URL(url));
      } catch {
        // A missing/transitioning player is not safe to reuse for old captions.
      }
    }
    if (removed || videoId !== session.videoId) {
      const task = this.queue.catch(() => {}).then(async () => {
        if ((await this.get())?.id !== session.id) return;
        await this.shutdown("A translation tab closed or changed video. Start preparation again.", false);
      });
      this.queue = task;
      await task;
    }
  }
}
