# Release and installation guide

## Files
- youtube-english-subtitles-1.6.3-store.zip: compiled extension only, manifest.json at the archive root. This is the candidate Chrome Web Store upload and the ZIP for manual testers.
- youtube-english-subtitles-1.6.3-publishing-kit.zip: listing/privacy drafts, this checklist, dependency notices, generated icon PNGs and a checksum file. Do not upload this kit as the extension.
- privacy-policy-draft.html: standalone readable draft that can be hosted after replacing the publisher/contact/effective-date fields.
- store-listing-draft.html: readable listing and reviewer-notes draft.
- mac-app-store-listing-draft.html: separate planning draft for a future macOS/Safari app. It does not make the Chrome ZIP suitable for the Mac App Store.

The release script generates these files under generated-artifacts/chrome-extension/. Names follow the current manifest version on future builds.

## Rebuild
From the workspace root:

    pnpm --filter @workspace/youtube-english-subtitles run release

Requires the existing workspace dependencies, Node, pnpm and Python 3. The script builds the extension, generates original caption-symbol PNG icons, checks packaged entrypoints and dependency notices, and creates ZIPs with Python's standard library. It does not install dependencies, upload files, create a store listing, or publish anything.

The store ZIP includes local dependency licence notices. These are drawn conservatively from Transformers' installed dependency graph; that list can include dependencies not used by the browser bundle. Downloaded model assets are not included in the ZIP. Review their licence and upstream notices before distribution; do not assume a generated dependency list is a complete legal audit.

## Manual installation for testers
1. Download the store ZIP and extract it into a permanent folder.
2. Open chrome://extensions in desktop Chrome.
3. Turn Developer mode on and click Load unpacked.
4. Select the extracted folder containing manifest.json.
5. Open a YouTube watch video, select the source language, turn on Two-tab mode and authorize capture from the preparation tab.

Keep the extracted folder; Chrome loads unpacked files from it. To update a manually installed copy, replace those files, reload the extension and refresh both YouTube tabs. A ZIP download is not a one-click Chrome installation and does not configure automatic updates.

## Before store submission
1. Review the name and generated original caption-symbol icon. It does not use YouTube's logo.
2. Test the exact extracted ZIP in real desktop Chrome on macOS and Windows. Automated bundle checks do not verify tab capture, inference quality or autoplay on those platforms.
3. Test first-use model downloads, cached restart, Turkish and Urdu, seeks, pause/resume, catch-up buffering, instructions disappearing during playback and stopping capture.
4. Replace all privacy-draft placeholders. Confirm the publisher identity/contact and support-data practices are accurate, then host the final policy on a public HTTPS page.
5. Complete the store listing, permission explanations, current data-use declarations and reviewer notes.
6. Supply genuine screenshots and the promotional images required by the current dashboard. Generated icon sizes are 16, 32, 48 and 128 pixels.
7. Review remote asset behavior, dependency licences and model licence. Confirm all code is packaged and no executable code is fetched at runtime.
8. Choose and add a licence for your own source before describing the repository as open source. Decide the copyright holder; no licence has been selected or granted by this kit.
9. Upload only the store ZIP through Google's developer dashboard and submit for review. Approval is not guaranteed. Never promise an approved store listing before review.
10. Once approved, share the store URL for Add to Chrome installation and store-managed updates.

For later store updates, increment the manifest version, keep package.json in sync, rebuild and submit the new ZIP.

## Official references
- Prepare and ZIP: https://developer.chrome.com/docs/webstore/prepare
- Privacy fields: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Listing assets: https://developer.chrome.com/docs/webstore/best_listing
- Publisher dashboard: https://chrome.google.com/webstore/devconsole
- Model card: https://huggingface.co/onnx-community/whisper-small
- Transformers.js: https://github.com/huggingface/transformers.js

These drafts do not create a GitHub repository, assign an open-source licence, host a policy, or submit an extension to Google.
