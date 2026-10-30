// Classic content script: no remote code or module imports in the page.
globalThis.YtesSyncPlayback = class {
  constructor({ video, send, showStatus, showCue, hide, preparationSeconds = 0, sourceOnly = false, initialEpoch = 0, onPreparedSegment = async () => {}, onSourceComplete = () => {}, hasAd = () => false, onProgress = () => {}, onComplete = () => {}, onFailure = () => {}, playVideo = () => video.play(), setInterval: interval = setInterval, clearInterval: clear = clearInterval }) {
    if (![0, 60, 180, 300].includes(preparationSeconds)) throw new Error("Choose a preparation length of 1, 3, or 5 minutes.");
    Object.assign(this, {
      video, send, showStatus, showCue, hide, onFailure, preparationSeconds, onProgress, onComplete,
      sourceOnly, onPreparedSegment, onSourceComplete, hasAd, playVideo,
      clear: (id) => clear.call(globalThis, id),
    });
    this.epoch = initialEpoch;
    this.state = "waiting";
    this.ready = false;
    this.wantsPlay = true;
    this.held = !video.paused;
    this.expectedSeek = null;
    this.listeners = {};
    this.on("error", () => {
      if (this.sourceOnly) this.fail("The preparation video failed to load. Refresh it and start preparation again.");
    });
    this.on("seeking", () => {
      if (this.expectedSeek !== null && Math.abs(video.currentTime - this.expectedSeek) < 0.4) return;
      if (this.sourceOnly) {
        this.fail("The preparation tab was moved. Seek using the viewing tab instead.");
        return;
      }
      if (this.inPreparedRange()) {
        this.state = "cached-seek";
        this.hide();
        return;
      }
      this.reset("Seeking: discarding previous subtitles…");
    });
    this.on("seeked", () => {
      if (this.expectedSeek !== null && Math.abs(video.currentTime - this.expectedSeek) < 0.4) {
        clearTimeout(this.seekTimer);
        this.expectedSeek = null;
        this.state = "replaying";
        this.reportPreparation("replaying");
        if (this.wantsPlay) {
          this.held = false;
          this.play();
        }
      } else if (this.state === "cached-seek" && this.inPreparedRange()) {
        this.state = "replaying";
      } else if (this.ready && this.wantsPlay) {
        void this.begin();
      }
    });
    this.on("ratechange", () => {
      if (this.sourceOnly) {
        this.fail("Keep the preparation tab at its original speed. Change speed in the viewing tab.");
        return;
      }
      if (this.inPreparedRange()) return; // Absolute media timestamps remain valid.
      this.reset("Playback speed changed. Preparing a new section…");
      if (this.ready && !video.seeking && this.wantsPlay) void this.begin();
    });
    this.on("loadedmetadata", () => {
      if (this.state === "waiting" && this.ready && this.wantsPlay) void this.begin();
    });
    this.on("pause", () => {
      if (video.paused && !video.ended && (this.state === "collecting" || this.state === "replaying")) this.wantsPlay = false;
      this.clock();
    });
    this.on("play", () => {
      if (this.sourceOnly && this.state === "complete") {
        this.pause();
        return;
      }
      this.wantsPlay = true;
      if (["processing", "replay-seek", "starting"].includes(this.state) || (this.state === "waiting" && !this.ready)) {
        this.held = true;
        this.pause();
        return;
      }
      if (this.state === "waiting" && this.ready && !video.seeking) void this.begin(!!this.plan);
    });
    this.on("playing", () => this.clock());
    this.on("waiting", () => {
      this.buffering = true;
      this.clock();
    });
    this.on("playing", () => { this.buffering = false; this.clock(); });
    this.on("ended", () => {
      if (this.state === "collecting") {
        this.wantsPlay = true;
        void this.finish();
      }
      else if (this.state === "replaying") {
        if (this.plan?.ready) {
          this.completePreparation();
          return;
        }
        this.state = "complete";
        this.wantsPlay = false;
        this.hide();
        this.showStatus("Synchronized playback complete. Seek to translate another section.");
      }
    });
    this.timer = interval.call(globalThis, () => this.tick(), 80);
    this.pause();
    this.showStatus("Synchronized mode: waiting for the speech model…", { buffering: true });
  }

  on(name, callback) {
    // Preserve multiple callbacks for the same native event.
    this.listeners[name] ??= [];
    this.listeners[name].push(callback);
    this.video.addEventListener(name, callback);
  }

  pause() {
    this.video.removeAttribute?.("data-ytes-playback-request");
    this.video.pause();
  }

  command(action, values = {}) {
    return Promise.resolve(this.send({ action, epoch: this.epoch, ...values }));
  }

  async safely(action, values = {}) {
    const epoch = this.epoch;
    try {
      const result = await this.command(action, values);
      if (!result?.ok) throw new Error(result?.error || "The synchronized audio processor did not respond.");
      return true;
    } catch (error) {
      if (epoch !== this.epoch || this.state === "stopped") return false;
      this.fail(error.message);
      return false;
    }
  }

  modelReady() {
    this.ready = true;
    if (this.state === "waiting" && !this.video.seeking && this.wantsPlay) void this.begin();
  }

  inPreparedRange() {
    return this.state !== "stopped" && this.plan?.ready &&
      this.video.currentTime >= this.plan.start && this.video.currentTime < this.plan.end;
  }

  reportPreparation(phase) {
    if (!this.plan) return;
    const preparedSeconds = Math.min(this.plan.end, this.plan.preparedEnd) - this.plan.start;
    const totalSeconds = this.plan.end - this.plan.start;
    this.onProgress({
      epoch: this.epoch, phase, preparedSeconds, totalSeconds,
      text: `${phase === "replaying" ? "Playing prepared subtitles." : phase === "complete" ? "Prepared interval finished." : "Preparing subtitles."} ${Math.round(preparedSeconds)} / ${Math.round(totalSeconds)} seconds translated.`,
    });
  }

  preparationNote() {
    return this.plan ? ` ${Math.round(this.plan.preparedEnd - this.plan.start)} / ${Math.round(this.plan.end - this.plan.start)} seconds translated.` : "";
  }

  async begin(continuePreparation = false) {
    if (this.state === "stopped" || !this.ready || this.video.seeking) return;
    this.epoch++;
    const epoch = this.epoch;
    const start = this.video.currentTime;
    if (Number.isNaN(this.video.duration)) {
      this.showStatus("Waiting for the video's duration…", { buffering: true });
      return;
    }
    if (!Number.isFinite(this.video.duration)) {
      this.fail("Synchronized mode requires a seekable video, not a live stream. Use continuous mode instead.");
      return;
    }
    if (start >= this.video.duration - 0.05) {
      this.fail("The video is at the end. Seek to an earlier position before preparing subtitles.");
      return;
    }
    if (this.preparationSeconds && (!continuePreparation || !this.plan)) {
      this.plan = {
        start, end: Math.min(start + this.preparationSeconds, this.video.duration),
        preparedEnd: start, cues: [], ready: false, estimated: false,
      };
    }
    this.section = { start, end: Math.min(start + 12, this.plan?.end ?? this.video.duration), rate: this.video.playbackRate };
    this.state = "starting";
    this.held = !this.video.paused || this.held;
    this.pause();
    this.cues = [];
    this.hide();
    this.showStatus((this.plan ? "Preparing the selected interval silently…" : "Preparing the next section silently; it will replay with English subtitles…") + this.preparationNote(), { buffering: true });
    this.reportPreparation("preparing");
    if (!await this.safely("begin", { start, rate: this.section.rate }) || this.epoch !== epoch) return;
    this.state = "collecting";
    this.held = false;
    this.play();
    this.clock();
  }

  play() {
    Promise.resolve(this.playVideo(() => ["collecting", "replaying"].includes(this.state) && this.wantsPlay)).catch((error) => {
      if (this.state !== "stopped") this.fail(error.message || "Open the preparation video and press Play before restarting translation.");
    });
  }

  clock() {
    if (this.state !== "collecting") return;
    void this.safely("clock", {
      playing: !this.video.paused && !this.video.seeking && !this.buffering && !this.video.ended,
    });
  }

  async finish() {
    if (this.state !== "collecting") return;
    const epoch = this.epoch;
    this.state = "processing";
    this.held = !this.video.paused || this.video.ended;
    this.pause();
    this.hide();
    this.showStatus((this.plan ? "Translating this section before continuing silent preparation…" : "Paused while this section is translated. Playback will resume with timed subtitles…") + this.preparationNote(), { buffering: true });
    this.reportPreparation("translating");
    // Let the worklet deliver its last 4096-sample batch before freezing audio.
    await new Promise((resolve) => setTimeout(resolve, 140));
    if (this.epoch !== epoch || this.state !== "processing") return;
    await this.safely("finish", { end: Math.min(this.video.currentTime, this.plan?.end ?? this.video.currentTime) });
  }

  async segment(message) {
    if (message.epoch !== this.epoch || this.state !== "processing") return;
    const epoch = this.epoch;
    this.section.end = message.end;
    if (this.sourceOnly) {
      try {
        await this.onPreparedSegment(message);
        if (this.state === "stopped" || this.epoch !== epoch) return;
        if (message.end >= this.video.duration - 0.05) {
          this.state = "complete";
          this.wantsPlay = false;
          this.held = false;
          this.pause();
          this.showStatus("All remaining subtitles are prepared. Keep this tab open until viewing finishes.");
          await this.onSourceComplete();
        } else {
          this.state = "waiting";
          this.wantsPlay = true;
          await this.begin();
        }
      } catch (error) {
        this.fail(error.message);
      }
      return;
    }
    if (this.plan && !this.plan.ready) {
      this.plan.cues.push(...(message.cues || []));
      this.plan.preparedEnd = Math.min(message.end, this.plan.end);
      this.plan.estimated ||= message.timing === "estimated whole-section timing";
      if (message.end < this.plan.end - 0.05) {
        this.state = "waiting";
        this.reportPreparation("preparing");
        if (this.wantsPlay) await this.begin(true);
        return;
      }
      this.plan.ready = true;
      this.section = { start: this.plan.start, end: this.plan.end, rate: this.section.rate };
      this.cues = this.plan.cues;
      this.timing = this.plan.estimated ? "some estimated section timing" : "model timestamps";
      this.reportPreparation("ready");
    } else {
      this.cues = message.cues || [];
      this.timing = message.timing;
    }
    this.state = "replay-seek";
    if (!await this.safely("replay") || this.epoch !== epoch) return;
    this.expectedSeek = this.section.start;
    this.seekTimer = setTimeout(() => {
      if (this.epoch === epoch && this.state === "replay-seek") {
        this.fail("YouTube did not finish seeking back to the translated section.");
      }
    }, 5000);
    try {
      this.video.currentTime = this.section.start;
    } catch (error) {
      this.fail(`The video could not be replayed: ${error.message}`);
      return;
    }
    this.showStatus(this.cues.length
      ? `Replaying with English subtitles (${this.timing}).`
      : "No speech recognized in this section. Replaying the original audio.");
  }

  reset(text) {
    if (this.state === "stopped") return;
    clearTimeout(this.seekTimer);
    this.epoch++;
    this.expectedSeek = null;
    this.cues = [];
    this.plan = null;
    this.state = "waiting";
    this.hide();
    this.showStatus(text, { buffering: true });
    void this.safely("cancel");
  }

  tick() {
    if (this.sourceOnly && this.state === "collecting" &&
        (this.video.error || this.video.readyState === 0 || !Number.isFinite(this.video.duration))) {
      this.fail("The preparation video lost its media stream. Refresh it and start preparation again.");
      return;
    }
    if (this.sourceOnly && this.state !== "stopped" && this.hasAd()) {
      this.fail("An ad interrupted preparation. Finish the ad, then restart translation.");
      return;
    }
    if (this.state !== "stopped" && this.video.isConnected === false) {
      this.fail("The video player changed. Start translation again on the new video.");
      return;
    }
    if (this.state === "collecting") {
      this.clock();
      if (this.video.currentTime >= this.section.end) void this.finish();
    } else if (this.state === "replaying") {
      const time = this.video.currentTime;
      if (this.plan?.ready && !this.video.paused && time >= this.plan.end - 0.03) {
        this.completePreparation();
        return;
      }
      if (!this.video.paused && time >= this.section.end - 0.03 && time < this.video.duration - 0.05) {
        void this.begin();
        return;
      }
      const cue = this.cues.find((entry) => entry.start <= time && time < entry.end);
      if (cue) this.showCue(cue.text);
      else this.hide();
    }
  }

  fail(text) {
    if (this.state === "stopped") return;
    this.stop();
    this.showStatus(`Synchronized translation stopped: ${text}`);
    this.onFailure(text);
  }

  completePreparation() {
    this.reportPreparation("complete");
    this.state = "complete";
    this.wantsPlay = false;
    this.held = false;
    this.pause();
    this.stop();
    const text = "Prepared interval finished. Choose Prepare, then play again to prepare the next interval.";
    this.showStatus(text);
    this.onComplete(text);
  }

  stop() {
    if (this.state === "stopped") return;
    const resume = !this.sourceOnly && this.held && this.wantsPlay;
    this.epoch++;
    this.state = "stopped";
    this.video.removeAttribute?.("data-ytes-playback-request");
    if (this.sourceOnly) this.pause();
    clearTimeout(this.seekTimer);
    void this.command("cancel").catch(() => {});
    this.clear(this.timer);
    for (const [name, callbacks] of Object.entries(this.listeners)) {
      for (const callback of callbacks) this.video.removeEventListener(name, callback);
    }
    this.cues = [];
    this.plan = null;
    this.hide();
    if (resume) Promise.resolve(this.video.play()).catch(() => {});
  }
};
