# Chrome Web Store listing draft

Status: draft for version 1.6.3. Not submitted or approved.

## Name
YouTube English Subtitles

## Short description
Show English subtitles on YouTube using available captions or on-device audio translation.

## Detailed description
Read English subtitles while watching YouTube videos in desktop Chrome.

Use available English caption tracks, YouTube-translated tracks, or supported browser translation when available. For videos without usable captions, choose the spoken language and enable Two-tab mode to prepare English subtitles using a local Whisper Small speech model.

Two-tab mode opens a separate preparation tab. Open the extension in that tab and click Start preparation capture to authorize audio capture. Keep both tabs open. After capture begins, the preparation tab supplies audio for local translation without playing it aloud, while the viewing tab displays timed English subtitles.

Choose an initial waiting time of 1, 3, or 5 minutes. This is time spent waiting, not a promise of that many minutes of translated video. The viewing video and sound remain paused during preparation. If translation falls behind later, viewing pauses until more subtitles are ready.

Want a larger reserve? Click Pause to buffer in the viewing tab. Preparation continues in the helper tab; click Resume playback when you are ready.

Features:
- English subtitle overlay on supported YouTube watch pages.
- Spoken-language selection, including Turkish and Urdu.
- On-device audio translation: captured audio is not uploaded to a translation service.
- Separate preparation and viewing tabs.
- Timed subtitles and reuse of prepared sections when seeking.
- Pause-to-buffer control and automatic catch-up pauses.

Important:
- Desktop Chrome only. This package does not run inside the mobile YouTube app, Chrome on iOS, or standard Chrome on Android.
- A large speech-model download is required on first use. Model files are cached locally when storage permits. Internet access is needed for YouTube and uncached model downloads.
- Preparation speed depends on your computer, GPU, memory, and available storage. Continuous playback cannot be guaranteed on slower devices.
- Machine-generated subtitles can be inaccurate or omit speech. Do not rely on them for safety-critical or professional translation.
- Intended for finite YouTube watch videos, including supported playlist-player pages. Live streams, Shorts, ads, and playlist episode changes are not supported continuous translation timelines.
- Not affiliated with or endorsed by YouTube or Google.

## Single-purpose statement
Display English subtitles for the YouTube video the user is watching, using available caption tracks or user-authorized local audio translation.

## Permission explanations

activeTab: Identify and interact with the YouTube tab in which the user invokes the extension and obtain a capture stream for the authorized preparation tab.

tabCapture: Capture audio from the user-authorized preparation tab for on-device speech translation. This is tab audio, not microphone recording.

offscreen: Run the local audio processing and speech inference in an extension offscreen document when the popup is closed.

scripting: Install or reconnect packaged subtitle/playback scripts when necessary and read or control the YouTube player in the page's main world for the active translation session.

storage: Save the user's subtitle, language, and initial-wait preferences, and maintain temporary session state and processing status.

unlimitedStorage: Allow caching the large speech-model files beyond the normal extension storage quota. Available device disk space still limits caching.

https://www.youtube.com/*: Read the current video's identity, timing and caption metadata; request caption tracks; display subtitles; and coordinate preparation/viewing playback. The packaged content script runs on matching YouTube pages; audio capture still requires a user action.

https://huggingface.co/* and https://*.hf.co/*: Download the speech-model weights, tokenizer and configuration assets, including download redirects. Captured audio and generated subtitles are not sent to these model-download services by the extension.

## Remote-code declaration notes
The JavaScript entrypoints, AudioWorklet script, ONNX JavaScript runtime and WebAssembly runtime are bundled inside the extension. The extension does not intentionally fetch executable JavaScript or WebAssembly at runtime. Hugging Face downloads supply model weights and model/tokenizer configuration data. Browser-managed translation may separately download language resources.

Before certifying any dashboard answer, inspect the final package and actual network behavior. Do not describe the extension as having no network access or guarantee Google will accept the model-loading design.

## Privacy disclosure notes
Captured audio, captions, video identifiers/positions and generated subtitles are processed locally to provide the feature. Preferences and cached model resources persist locally; temporary session metadata, status and some recent text can exist in browser session storage. The extension has no developer-operated analytics, advertising or audio-upload endpoint.

Model hosts receive ordinary download request metadata; YouTube receives normal page and caption requests, including normal YouTube credentials for caption requests. Review the current dashboard's definitions before selecting data-category checkboxes. Do not blindly certify that no data is accessed simply because inference is local.

## Reviewer instructions
1. Use current desktop Chrome on a computer with sufficient free storage and memory. Navigate to a finite YouTube watch video; finish any advertisement first.
2. Open the extension, choose the video's actual spoken language and select a 1-minute initial wait for the shortest test.
3. Enable Two-tab mode. In the new preparation tab, open the extension and click Start preparation capture. No extension account or API key is required.
4. Allow the large first-use model download. Keep both tabs open. Model loading is included in the selected wait, but playback will continue buffering if no section is ready when that wait expires.
5. Return to the viewing tab. Confirm English captions follow video time. Test Pause to buffer, Resume playback, seeking, and turning Two-tab mode off.
6. If autoplay is blocked, interact with the player as directed by the popup. Translation can be slower on CPU-only hardware.

## Publisher fields still required
- Publisher's public name and support contact.
- Public HTTPS privacy-policy URL.
- Support URL and optional homepage/source repository URL.
- Accurate category, language, distribution regions and any pricing declarations.
- Actual screenshots showing the popup and subtitle playback. Do not use fabricated screenshots.
- Store promotional images in the dimensions requested by the current dashboard.
- Final desktop Chrome verification, particularly Windows if advertising Windows support.
- Source licence choice and copyright-holder details before calling the repository open source. No project licence is assigned by this draft.
