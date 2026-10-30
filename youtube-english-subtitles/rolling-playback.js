// Viewer-only controller. Audio capture belongs exclusively to the preparation tab.
globalThis.YtesRollingPlayback = class {
  constructor({ video, preparationWaitSeconds, generation, showStatus, showCue, hide,
    onSeek, onProgress = () => {}, onComplete, onFailure, playVideo = () => video.play(),
    hasAd = () => false, seekDelay = 180, setTimeout: timeout = setTimeout, clearTimeout: cancelTimeout = clearTimeout,
    setInterval: interval = setInterval, clearInterval: clear = clearInterval, now = () => Date.now() }) {
    if (![60, 180, 300].includes(preparationWaitSeconds)) throw new Error("Choose 1, 3, or 5 minutes.");
    Object.assign(this, { video, preparationWaitSeconds, generation, showStatus, showCue, hide, now,
      onSeek, onProgress, onComplete, onFailure, hasAd, playVideo,
      seekDelay, later: (callback) => timeout.call(globalThis, callback, seekDelay),
      cancelLater: (id) => cancelTimeout.call(globalThis, id),
      clear: (id) => clear.call(globalThis, id) });
    this.listeners = [];
    this.wantsPlay = true;
    this.stopped = false;
    this.lastReport = 0;
    this.seekId = 0;
    this.seekInFlight = null;
    this.reset(video.currentTime, generation);
    this.on("pause", () => {
      if (!this.held && !video.ended) {
        this.wantsPlay = false;
        this.tick();
      }
    });
    this.on("play", () => {
      this.playbackError = "";
      this.wantsPlay = true;
      this.tick();
    });
    this.on("seeking", () => {
      this.seekId++;
      this.cancelLater(this.seekTimer);
      this.hold();
      this.hide();
      this.seeking = true;
    });
    this.on("seeked", () => {
      this.seeking = false;
      if (video.currentTime >= video.duration - 0.05) {
        this.stop(false);
        this.onComplete();
      } else if (!this.seekInFlight && !this.sourceMismatch &&
          video.currentTime >= this.start && video.currentTime < this.preparedEnd) {
        this.awaitingSeek = false;
        this.justSeeked = true;
        this.tick();
      } else {
        this.awaitingSeek = true;
        this.showStatus("Seeking: preparing subtitles for the new position…", { buffering: true });
        const id = this.seekId, time = video.currentTime;
        const dispatch = () => {
          if (this.stopped || this.seekId !== id || this.seeking) return;
          this.seekInFlight = id;
          Promise.resolve().then(() => {
            if (!this.stopped && this.seekId === id) return this.onSeek(time, id);
          }).catch((error) => {
            if (!this.stopped && this.seekId === id) this.fail(error.message);
          }).finally(() => {
            if (this.seekInFlight === id) this.seekInFlight = null;
          });
        };
        if (this.seekDelay === 0) dispatch();
        else this.seekTimer = this.later(dispatch);
      }
    });
    this.on("ended", () => {
      if (this.preparedEnd >= video.duration - 0.05 && !this.stopped) {
        this.stop(false);
        this.onComplete();
      }
    });
    this.timer = interval.call(globalThis, () => this.tick(), 80);
  }

  on(name, callback) {
    this.listeners.push([name, callback]);
    this.video.addEventListener(name, callback);
  }

  startPreparation(startedAt) {
    if (this.stopped || this.preparationStartedAt !== undefined || !Number.isFinite(startedAt)) return;
    this.preparationStartedAt = startedAt;
    this.tick();
  }

  get pausedForBuffer() {
    return !this.wantsPlay && !this.playbackError;
  }

  setBufferPause(paused) {
    if (this.stopped) throw new Error("This viewing session has stopped.");
    if (typeof paused !== "boolean") throw new Error("Choose pause or resume.");
    this.wantsPlay = !paused;
    this.playbackError = "";
    this.hold(); // Invalidates pending playback retries, without stopping capture.
    this.lastReport = 0;
    this.tick();
  }

  reset(start, generation, seekId) {
    if (this.stopped || (this.start !== undefined && generation <= this.generation)) return false;
    if (seekId !== undefined && seekId < this.seekId) {
      this.sourceMismatch = true;
      return false; // A newer native skip must not be undone by an older worker reply.
    }
    this.refillSeconds = 12;
    this.start = start;
    this.generation = generation;
    this.preparedEnd = start;
    this.cues = [];
    this.ready = false;
    this.done = false;
    this.awaitingSeek = false;
    this.sourceMismatch = false;
    this.justSeeked = false;
    this.playbackError = "";
    this.seeking = false;
    this.hold();
    this.showStatus(seekId === undefined
      ? "Waiting for the preparation tab. Open the extension there and start capture."
      : "Preparing subtitles at the new position. Video and audio are paused…", { buffering: true });
    return true;
  }

  hold() {
    this.video.removeAttribute?.("data-ytes-playback-request");
    this.held = true;
    this.video.pause();
  }

  addSegment(segment, generation) {
    if (this.stopped || generation !== this.generation) return;
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.end <= segment.start || Math.abs(segment.start - this.preparedEnd) > 0.6 ||
        segment.end > this.video.duration + 0.6 || !Array.isArray(segment.cues)) {
      this.fail("The preparation timeline changed. Restart preparation from the viewing tab.");
      return;
    }
    this.preparedEnd = Math.min(segment.end, this.video.duration);
    this.cues.push(...segment.cues.filter((cue) => Number.isFinite(cue.start) &&
      Number.isFinite(cue.end) && cue.end > cue.start && typeof cue.text === "string"));
    this.tick();
  }

  sourceDone(generation) {
    if (generation !== this.generation) return;
    if (this.preparedEnd < this.video.duration - 0.6) {
      this.fail("Preparation ended before the remaining video was translated.");
      return;
    }
    this.done = true;
    this.tick();
  }

  tick() {
    if (this.stopped) return;
    if (this.video.ended && this.preparedEnd >= this.video.duration - 0.05) {
      this.stop(false);
      this.onComplete();
      return;
    }
    if (this.video.isConnected === false || this.video.error || !Number.isFinite(this.video.duration) || this.hasAd()) {
      this.fail("The player changed, its media failed, or an ad interrupted playback. Check the video, then restart translation.");
      return;
    }
    const time = this.video.currentTime;
    const ahead = time >= this.start ? Math.max(0, this.preparedEnd - time) : 0;
    const target = Math.min(this.refillSeconds, this.video.duration - this.start);
    const waitRemainingSeconds = this.preparationStartedAt === undefined ? null
      : Math.max(0, Math.ceil((this.preparationStartedAt + this.preparationWaitSeconds * 1000 - this.now()) / 1000));
    // Only the initial wait uses elapsed time. Seeks and later catch-up pauses
    // require ready media, never another 1/3/5-minute countdown.
    if (waitRemainingSeconds === 0) this.initialWaitComplete = true;
    const waiting = !this.initialWaitComplete;
    if (!this.ready && this.preparedEnd - this.start >= target - 0.05) this.ready = true;
    const blocked = waiting || this.seeking || this.awaitingSeek || !this.ready ||
      (!this.done && (ahead < 0.3 || (this.held && !this.justSeeked && ahead < Math.min(12, this.video.duration - time) - 0.1)));
    if (this.pausedForBuffer) {
      this.hold();
      this.hide();
      this.showStatus("");
    } else if (blocked) {
      this.hold();
      this.hide();
      this.showStatus(waiting
        ? waitRemainingSeconds === null
          ? "Waiting for capture permission in the preparation tab…"
          : `Preparing subtitles: ${waitRemainingSeconds} seconds of initial wait remaining. Video and audio are paused.`
        : this.awaitingSeek ? "Preparing the new position…" : !this.ready
        ? `Preparing subtitles: ${Math.round(this.preparedEnd - this.start)} / ${Math.round(target)} seconds. Video and audio are paused.`
        : "Translation is catching up. Video and audio are paused…", { buffering: true });
    } else {
      // Clear preparation instructions even before the first timed cue appears.
      this.showStatus("");
      if (this.held && this.wantsPlay) {
        this.justSeeked = false;
        this.held = false;
        Promise.resolve(this.playVideo(() => !this.stopped && !this.held && this.wantsPlay)).catch((error) => {
          if (this.stopped) return;
          this.wantsPlay = false;
          this.playbackError = error.message || "Open the viewing tab and press Play.";
          this.showStatus("Subtitles are ready. Press Play on the viewing video.");
        });
      }
      const cue = this.cues.find((entry) => entry.start <= time && time < entry.end);
      if (cue) this.showCue(cue.text);
      else this.hide();
    }
    if (this.now() - this.lastReport >= 1000) {
      this.lastReport = this.now();
      this.onProgress({ aheadSeconds: ahead, preparedEnd: this.preparedEnd, currentTime: time,
        requiredSeconds: target,
        initialWaiting: waiting, waitRemainingSeconds,
        pausedForBuffer: this.pausedForBuffer,
        phase: this.pausedForBuffer ? "paused-buffering" : blocked ? "buffering" : this.playbackError ? "playback-blocked"
          : this.video.paused ? "paused" : this.video.readyState < 3 ? "media-buffering" : "playing",
        playbackError: this.playbackError || "" });
    }
  }

  fail(text) {
    if (this.stopped) return;
    this.hold();
    this.stop(false);
    this.showStatus(text);
    this.onFailure(text);
  }

  stop(resume = true) {
    if (this.stopped) return;
    this.stopped = true;
    this.video.removeAttribute?.("data-ytes-playback-request");
    this.cancelLater(this.seekTimer);
    this.clear(this.timer);
    for (const [name, callback] of this.listeners) this.video.removeEventListener(name, callback);
    if (!resume) this.video.pause();
    this.cues = [];
    this.hide();
    if (resume && this.held && this.wantsPlay) Promise.resolve(this.video.play()).catch(() => {});
  }
};
