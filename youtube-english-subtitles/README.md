# YouTube English Subtitles

A Manifest V3 Chrome extension that displays English subtitles over YouTube videos. It uses YouTube caption tracks first and offers local audio translation when a video has no captions.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose the built `youtube-english-subtitles/dist` folder. The source folder does not contain an extension manifest.
5. Open a YouTube video and use **Show subtitles** to toggle captions. For audio translation, choose the spoken language and preparation length, then turn on **Two-tab mode**. Turn it off to stop.

To build the unpacked extension, run `pnpm --filter @workspace/youtube-english-subtitles run build` from the workspace root.

## Prepare a downloadable release

Run `pnpm --filter @workspace/youtube-english-subtitles run release` to build a store-upload candidate ZIP and a separate publishing kit under `generated-artifacts/chrome-extension/`. The candidate ZIP contains the compiled extension with its manifest at the archive root, caption-symbol icons and installed dependency notices.

Listing, privacy-policy and submission-checklist drafts are maintained in `release/`. Complete the publisher/contact fields, host the final privacy policy, provide genuine store screenshots, review upstream licences and test the extracted candidate in desktop Chrome before submitting. The release command does not publish anything. A GitHub ZIP still requires manual unpacked installation; Add to Chrome installation and automatic updates require an approved Chrome Web Store listing.

**Important:** Load `youtube-english-subtitles/dist`, not the `youtube-english-subtitles` source folder. The source `offscreen.js` imports a package name that Chrome cannot resolve directly; the build bundles that dependency for Chrome. If you loaded the source folder already, remove that extension, build, and load `dist` instead.

## How it works

- Reads caption tracks supplied by YouTube when available.
- Uses an English caption track when one is available.
- Otherwise asks YouTube for an English-translated caption track, then falls back to Chrome's on-device Translator API if the browser provides it.
- If no caption track exists, **Two-tab mode** opens a silent preparation tab and runs multilingual Whisper locally after explicit capture permission there. The first use downloads the model from Hugging Face; captured audio is not uploaded.
- Displays subtitles in a separate overlay, leaving YouTube's own captions unchanged.
- The on/off setting and chosen spoken language are saved locally in Chrome.

The current speech engine does not automatically detect the source language. Choose the language spoken in the video, not the desired output language: Whisper's translation output remains English. Stop audio translation before changing the spoken language.

Version 1.2.0 uses **multilingual Whisper Small** (`onnx-community/whisper-small`) instead of Tiny. Turkish (`tr`) and Urdu (`ur`) are listed first in the source-language selector. Choose the language matching each video; this does not automatically detect language changes within a video.

Small is a larger accuracy-oriented model, not a guarantee of correct translations. Its first download is several hundred MB, even if Tiny was previously cached. It uses WebGPU where supported and otherwise the same Small model on CPU, which may be too slow for real-time subtitles on some computers. Loading failures are reported rather than silently reverting to Tiny. Captured audio remains on the device.

Synchronized and two-tab translation retain up to **18 seconds of preceding audio** in memory. A normal 12-second section can therefore be translated with up to **30 seconds of audio context**, helping the model interpret sentences that cross section boundaries. Only the current section's captions are emitted, with timestamps adjusted for the retained context. If the model returns a sentence spanning the old/new boundary, or no usable timestamps, that section is retried without context rather than repeating earlier captions or dropping current speech. Silent new sections still remain subtitle-free. Context clears on seeks, restarts, discontinuous sections or playback-speed changes; nothing is uploaded or saved to disk. Longer model inputs and occasional retries can increase processing time. Translation-quality improvements are not guaranteed.

Local model output filters standalone “Subscribe” / “Please subscribe” cues (including punctuation and capitalization variants), which can be invented by Whisper during non-speech audio. Both timed chunks and full-text fallbacks are filtered in continuous and synchronized/two-tab modes; removing a cue does not remove the prepared audio interval or change other cue timestamps. Full sentences containing “subscribe” and YouTube-provided captions are not filtered. This narrow filter can also hide a genuinely spoken standalone “Subscribe”; it is not a general speech detector or a guarantee against other model hallucinations.

## Synchronized audio subtitles (version 1.3.0)

The original single-tab synchronized and continuous engines remain internal legacy paths, covered by tests, but are no longer offered in the simplified popup. Use **Two-tab mode** for audio translation.

Synchronized mode first waits for the model, then prepares up to 12 seconds of the video with speaker output silenced by the extension's local audio graph. The video visibly advances during this preparation. It pauses for translation, rewinds that section, and replays the original audio with English subtitles rendered against `video.currentTime`, rather than fixed display timers. It repeats this process for subsequent sections.

This is not seamless simultaneous translation: each section is visually played twice, and inference can cause long pauses on a slow computer. It requires a finite, seekable video and does not support live streams.

- User pauses during preparation are excluded from the speech buffer; pauses during replay keep captions aligned.
- Seeking or changing playback speed during preparation invalidates queued/in-flight results and starts fresh from the new position. Short-section synchronized mode does not retain earlier sections; the two-tab mode below retains prepared subtitles while the session is open.
- Stopping releases extension-owned pauses, restores audible playback, and leaves a user-paused video paused.
- Model segment timestamps are mapped to the video's timeline and speed. When no timestamps are returned, the whole section's text is displayed with **estimated whole-section timing**, not claimed as word-exact synchronization.
- The final shorter section and silent sections still replay; a section with no captured samples fails explicitly.

The automated checks exercise the buffer, timestamp conversion, stale-result handling, transport authorization, and playback state machine. They do not establish an end-to-end Chrome tab-capture or Whisper accuracy result.

## Rolling two-tab preparation (version 1.5.6)

1. Choose the video's spoken language.
2. Select **1 minute**, **3 minutes**, or **5 minutes** under **Initial waiting time**.
3. Turn on **Two-tab mode**. Your viewing video genuinely pauses, including its sound, and a preparation tab opens.
4. In that preparation tab, open the extension again and click **Start preparation capture**. This second user action is required by Chrome's per-tab capture authorization. Opening the tab alone does not start capture.
5. The extension returns you to your viewing tab. Keep both tabs open; do not operate the preparation tab's playback controls.

The preparation tab starts at your viewing position and plays ahead with captured audio output suppressed. It translates short sections locally, accumulating English cues with absolute media timestamps in the viewing tab's memory. It never rewinds for section replay. The selected 1/3/5 minutes now means elapsed waiting time, starting when capture is authorized and begins—not minutes of video translated, and not time spent opening the permission popup. Model loading counts toward that wait. Video and sound remain paused for the full selected wait, even for a shorter video or if subtitles are ready earlier. Afterward playback starts once the first translated section is ready; if none is ready, buffering continues until it is.

The viewing tab then plays its original video and audio while the preparation tab keeps working on later sections. It does not stop at the end of the initial buffer. If the viewer approaches the end of prepared material, native playback pauses (both picture and sound), and resumes after another section is ready. If your browser blocks automatic playback, press Play as prompted. Manually pausing the viewing video stays paused even as more subtitles arrive.

To build a larger subtitle reserve at any time, open the extension in the **viewing tab** and press **Pause to buffer**. Only the viewing video and sound pause; the silent preparation tab continues translating. The brief popup status shows how many seconds are ready ahead. Press **Resume playback**, or use YouTube's Play control, when ready. Resuming still respects any unfinished initial countdown or missing subtitles. Pausing with YouTube's normal controls also lets preparation continue. There is no automatic time limit or restart of the initial wait when manually buffering; it remains paused until you choose to resume. This can reduce later catch-up pauses but does not make the model itself run faster.

Seeking within the current prepared range reuses the existing cues immediately, including near that range's end. Seeking outside that range pauses picture and sound, repositions the preparation source, and buffers the next short section (up to 12 seconds of video), not the entire selected startup length. Near the end of the video, only the remaining duration is needed. Skipping to the end finishes the session.

Rapid backward/forward skips are combined and the latest position wins. Older seek replies, failures and translation results cannot reset or stop a newer skip. Valid incoming sections remain cached while a skip is pending, so changing your mind before preparation moves does not create a missing subtitle section. A manual user pause remains paused after seeking. You can change speed in the viewing tab; the preparation tab must retain its controlled playback speed. Seeking before capture or while the model loads does not bypass those readiness steps.

Finishing the viewing video or turning **Two-tab mode** off releases capture, clears in-memory subtitles and closes the extension-created preparation tab. Turning **Show subtitles** off also stops capture. Navigating or closing either participating tab stops the session. A reloaded page requires restarting preparation. Turning the mode off releases an extension-owned buffering pause; errors leave the viewing video paused rather than playing untranslated material.

The selector specifies an elapsed-time initial wait, not a target subtitle-buffer length. The countdown appears while buffering. Once it expires, only a ready section is required, rather than 1/3/5 minutes of translated video. Skipping during the initial countdown does not restart or bypass it; skips after it expires and later catch-up pauses wait only for subtitles, never another full countdown. Two simultaneous YouTube players also use more bandwidth and processing resources. Each source section currently pauses for inference; slow processing can eventually consume the initial head start and cause catch-up pauses. Uninterrupted whole-video playback cannot be guaranteed.

Finite YouTube videos on `/watch` and `/watch_videos` playlist-player pages are supported. For `/watch_videos`, the extension reads the video actually playing, rather than guessing the first entry in the URL's list. It keeps the viewing playlist page intact and opens a normal watch page for the same video in the silent preparation tab. Advancing to a different playlist item stops translation; start a new session for that item. Finish any initial ad before starting capture. Ads encountered later stop preparation explicitly to avoid applying ad-time captions to the video's timeline; skip the ad and restart. Live streams, Shorts and playlist-index pages without a playing video are not supported in two-tab mode.

The popup exposes only subtitle visibility, spoken language, preparation length, the **Two-tab mode** switch, and a brief status. Its capture-permission button appears only in the pending preparation tab. There is no local Start button, timing-mode selector, test-subtitle option or live-diagnostics panel. Opening the popup never starts capture automatically.

Playback requests have a 12-second startup watchdog. If a native Play request fails or never settles, the extension retries once through YouTube's own player, with a second bounded wait. Stop, pause, seek and translation holds invalidate pending recovery requests so a delayed retry cannot restart a held player. If recovery fails, preparation reports an error instead of silently collecting forever; a blocked viewer retains its prepared captions and can be resumed with the video's Play control. Brief popup status distinguishes the elapsed initial countdown, subtitle catch-up, media buffering and playback errors.

Automatic status tags over the video appear only during subtitle buffering, preparation or catch-up pauses. Completion and running notices—including “Prepared interval finished”—do not remain over the picture. Brief progress and errors remain available in the popup status; detailed telemetry remains internal for developer troubleshooting.

Local translation can be slower than playback, especially on a CPU. It is intended as a best-effort live fallback; caption-track translation is more tightly synchronized.

## Privacy

Turning **Two-tab mode** on opens a preparation tab but does not start capturing audio. The extension requests tab audio only after the user explicitly presses **Start preparation capture** in that tab. It captures only the preparation tab, never a mix of viewing and preparation sound. Audio is processed locally and is not uploaded. Only coordination metadata is stored in session storage; translated cues stay in page memory. The speech model is downloaded from Hugging Face and may be cached by Chrome.

The `unlimitedStorage` permission exempts the extension's large speech-model cache from Chrome's normal storage quota and eviction rules. It does not provide extra disk space or access to your files. Keep sufficient free disk space for the model. If an older version reports `Unable to add response to browser cache: QuotaExceededError`, translation can still run from the downloaded model, but caching may fail and require another download later. Update the entire compiled `dist` folder, reload the extension, approve any new permission prompt, and refresh both YouTube tabs before restarting translation. Existing cached models are not cleared.

ONNX executable code and its WASM binary are packaged inside `dist/onnx/`, not loaded from a CDN. Copy the entire `dist` folder when updating the extension, including `onnx/` and `assets/`. The extension keeps its self-only script security policy.

## Troubleshooting missing output

- Version 1.1.0 verifies that the YouTube page script and subtitle overlay respond before starting capture. It uses Chrome's `scripting` permission to reconnect the page script in an already-open video tab.
- Check the short popup status for preparation progress or playback errors. In a newly opened preparation tab, open the extension and allow capture once.
- Detailed capture/model telemetry remains internal for developer troubleshooting; obsolete test-subtitle messaging has been removed. Automated transport tests are not proof of live Chrome capture.
- Check the extension version at `chrome://extensions` when updating a local copy. Copy all of `dist`, reload the extension, accept any new permission prompt, and refresh YouTube.
