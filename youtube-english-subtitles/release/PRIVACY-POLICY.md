# Privacy policy draft — YouTube English Subtitles

DRAFT: Replace the publisher/contact fields and effective date before publishing. This document describes extension version 1.6.3 and is not a legal-compliance certification.

Publisher: [PUBLISHER NAME]

Privacy contact: [PUBLIC CONTACT EMAIL OR SUPPORT URL]

Effective date: [DATE OF PUBLICATION]

## What the extension does
YouTube English Subtitles displays English subtitles on supported YouTube watch pages. It uses available caption tracks where possible. When you explicitly start preparation capture, it can capture the preparation tab's audio and translate it on your device using a local speech model.

## Information processed on your device
The extension accesses the current YouTube video's identity, caption metadata, caption text and playback position to obtain and synchronize subtitles. It processes captured tab audio and generated English subtitle text for the local translation feature. It does not request microphone access.

The extension's scripts run on matching www.youtube.com pages. Audio capture is not started automatically merely by visiting YouTube; it requires you to invoke the preparation capture action.

## Storage and retention
Subtitle visibility, selected source language and initial waiting time are saved in local extension storage.

Downloaded speech-model files are stored in the browser's local cache when possible. The cache can be large and may remain across browser restarts.

Audio sections, bounded recent audio context and prepared subtitle sections are held in memory for the active translation session. Session storage also contains temporary tab/video identifiers, playback and preparation metadata, processing status and, in some paths, recent subtitle text. The extension does not deliberately save a complete audio recording or transcript as a persistent file.

Stopping translation releases capture and active audio/cue buffers. Some recent status or text may remain in session storage until the browser session ends or that state is replaced. Closing a popup alone does not stop translation.

## Network requests and third parties
The extension does not upload captured audio or generated subtitles to the publisher or to a speech-translation service.

YouTube supplies videos and caption tracks. Caption requests may include your ordinary YouTube session credentials so that YouTube can serve the requested track. The extension does not export those credentials to the publisher or to model hosts.

Hugging Face and its download infrastructure supply model weights, tokenizer files and configuration resources. Like other network services, these providers receive ordinary request metadata such as your IP address and requested file paths. Cached resources can reduce repeat downloads.

Where supported, caption translation may use Chrome's browser-provided Translator API. The browser manages its language resources under its own settings and policies.

YouTube/Google and model-download providers operate under their own terms and privacy policies. Local audio translation does not make YouTube browsing or model downloads anonymous, and it does not mean the extension works entirely offline.

## Analytics, advertising and sharing
This version contains no developer-operated analytics, advertising, user-account system or intentional sale of processed user data. The publisher does not operate an endpoint that receives your captured audio or generated subtitles through this extension.

If you voluntarily send logs, screenshots or other information to the support contact, that separate communication is not covered by the no-audio-upload behavior of the extension. Avoid sending sensitive content.

## Your controls
Turn Two-tab mode off to stop preparation capture. Pause to buffer pauses the viewing video and sound, not preparation capture. Close the preparation session or disable/remove the extension to prevent further extension activity.

Preferences can be changed through the popup. To remove retained extension data and model caches, use Chrome's extension/site storage controls as available, or uninstall the extension and verify removal in your browser profile. Uninstalling does not delete information independently held by YouTube or model-download services.

## Security and accuracy
Audio inference runs locally. Executable extension scripts and the WebAssembly runtime are included in the package rather than loaded from a remote script CDN. No software can guarantee absolute security. Machine-generated subtitles may contain mistakes.

## Changes and contact
The publisher should update this policy when data handling changes and publish the revised effective date. Contact the publisher using the public contact above for privacy questions.
