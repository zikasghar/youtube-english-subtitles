// Classic script shared by both isolated-world playback controllers.
globalThis.YtesPlayVideo = async function ({
  video, requestRecovery, shouldContinue = () => true, timeoutMs = 12000,
  setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout,
}) {
  const requestId = `${Date.now()}-${Math.random()}`;
  const attribute = "data-ytes-playback-request";
  const hasAttributes = typeof video.setAttribute === "function";
  if (hasAttributes) video.setAttribute(attribute, requestId);
  const current = () => shouldContinue() && (!hasAttributes || video.getAttribute(attribute) === requestId);
  const paused = () => { if (video.paused) video.removeAttribute?.(attribute); };
  video.addEventListener?.("pause", paused);
  const attempt = async (play) => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(play),
        new Promise((_, reject) => {
          timer = later.call(globalThis, () => reject(new Error("YouTube did not start playback.")), timeoutMs);
        }),
      ]);
    } finally {
      cancel.call(globalThis, timer);
    }
  };
  try {
    if (!current()) return;
    try {
      await attempt(() => video.play());
    } catch (firstError) {
      // The main-world bridge also checks this ticket before calling YouTube.
      if (!current()) return;
      try {
        await attempt(async () => {
          const result = await requestRecovery(requestId);
          if (!current()) return;
          if (!result?.ok) throw new Error(result?.error || "YouTube's player could not resume.");
          await video.play();
        });
      } catch (error) {
        if (!current()) return;
        throw new Error(`YouTube playback could not start: ${error.message || firstError.message}. Open that video tab and press Play. Check that YouTube itself can play the video.`);
      }
    }
  } finally {
    video.removeEventListener?.("pause", paused);
    if (hasAttributes && video.getAttribute(attribute) === requestId) video.removeAttribute(attribute);
  }
};
