# Mac App Store listing draft

Status: planning draft only. No macOS app or Safari port has been built, signed, submitted or approved. The existing deliverable is a Chrome extension, which can run in desktop Chrome on a Mac but cannot be uploaded to the Mac App Store as a ZIP.

Intended product: a future macOS app containing a Safari web extension. This is not an iPhone/iPad listing. The proposed copy below assumes the listed features have been implemented and verified in Safari; remove or revise every unsupported claim before submission.

## Proposed app name
English Video Subtitles

This is a working store name, not a rename of the existing Chrome extension. Check name availability and rights before use. Avoid implying endorsement by YouTube, Google or Apple.

## Subtitle
Translate speech into English

## Promotional text
Read English subtitles while watching videos in Safari, with on-device speech translation and playback controls that let subtitles catch up.

## Keywords
translation,captions,speech,Turkish,Urdu,language,accessibility,learning

## Description — conditional launch copy
Read English subtitles while watching supported YouTube videos in Safari on your Mac.

English Video Subtitles helps you follow videos in another language. Use available caption tracks where possible, or prepare English subtitles with on-device speech translation when usable captions are unavailable.

WATCH WITH ENGLISH SUBTITLES
Display readable, timed subtitles over supported video pages. Choose the video's spoken language, including Turkish or Urdu.

PREPARE BEFORE PLAYBACK
Choose an initial waiting time of 1, 3 or 5 minutes while subtitles are prepared. Your viewing video and sound stay paused during preparation. If translation falls behind, playback pauses until more subtitles are ready.

BUILD A LARGER RESERVE
Pause viewing to prepare more subtitles, then resume when you are ready. Previously prepared sections remain available during the current session.

PROCESS SPEECH ON YOUR MAC
Speech translation runs on your device. Captured audio is not uploaded to a speech-translation service. A large model download is required before first use, and model files are cached locally when storage permits.

IMPORTANT
This app is for Safari on macOS, not the native YouTube app, Chrome, iPhone or iPad. Enable its Safari extension and grant the permissions requested by the final app's setup flow.

Internet access is needed for YouTube and model downloads. Translation speed depends on your Mac, available memory and storage. Initial waiting time does not guarantee an equivalent duration of translated video or uninterrupted playback.

Machine-generated subtitles can contain errors or omit speech. This is not a professional or safety-critical translation service. Support is limited to the video types and macOS/Safari versions stated in the final compatibility information.

Not affiliated with or endorsed by YouTube, Google or Apple.

## Compatibility and category fields
- Platform: macOS.
- Proposed primary category: Utilities; confirm it matches the final app and current available categories.
- Primary listing language: English.
- Minimum macOS and Safari versions: [SET AFTER PORTING AND REAL-MAC TESTING].
- Supported Mac hardware: [SET AFTER APPLE SILICON / INTEL VALIDATION].
- Version/build: [FINAL MACOS APP VERSION AND BUILD NUMBER]. Do not assume the Chrome version or minimum Chrome version defines Safari compatibility.
- Price and availability: [PUBLISHER DECISION].
- Age rating and content declarations: complete Apple's current questionnaire based on the actual app, accessible web content and safeguards.

## URLs and publisher fields
- Support URL: [PUBLIC HTTPS SUPPORT PAGE WITH REAL CONTACT INFORMATION].
- Privacy-policy URL: [PUBLIC HTTPS POLICY FOR THE FINAL MACOS APP].
- Marketing URL: [OPTIONAL PUBLIC PRODUCT PAGE].
- Copyright: [YEAR] [RIGHTS HOLDER].
- App Review contact: supply the required details privately in App Store Connect, not in the public listing or this source document.
- Bundle identifier, signing team and app record: configure in the Apple developer tools for the actual macOS app.

## Privacy and permission disclosure worksheet
Do not simply copy Chrome permission names into App Store Connect. Safari site permissions, native entitlements and any system capture prompts must match the final implementation.

Document the final app's access to video page information, captions, playback position, generated subtitle text and captured audio. State whether it captures one tab, application audio or system audio; the current Chrome tab-capture behavior does not establish what a Safari port will capture.

The existing Chrome version processes audio locally, downloads model files from Hugging Face infrastructure, requests YouTube caption tracks, stores preferences and model caches locally, and retains temporary session state and recent text. A macOS app must be re-audited before making equivalent claims.

Check native libraries, SDKs, crash reporting, support flows and any embedded browser resources before completing Apple's App Privacy answers. Do not automatically select "Data Not Collected" just because speech inference is local.

If the final app introduces server translation, analytics, account features or broader audio capture, revise the listing, consent flow and policy before release.

## App Review notes template — complete after implementation
This macOS app contains a Safari web extension that provides English subtitles on supported video pages.

Installation and activation:
[EXACT STEPS FROM THE FINAL APP'S ONBOARDING, INCLUDING SAFARI EXTENSION ACTIVATION AND SITE ACCESS].

Audio authorization:
[EXACT CAPTURE SCOPE, USER ACTION AND MACOS/SAFARI PERMISSION STEPS. DO NOT INSERT CHROME'S PREPARATION-CAPTURE STEPS UNLESS THE SAFARI IMPLEMENTATION ACTUALLY MATCHES THEM].

Test content:
[A STABLE PUBLIC VIDEO THE REVIEWER IS AUTHORIZED TO ACCESS, ITS SPOKEN LANGUAGE AND EXPECTED SUBTITLE BEHAVIOR].

First-use preparation:
[FINAL MODEL DOWNLOAD SIZE, EXPECTED TIME RANGE ON TESTED HARDWARE AND PROGRESS INDICATORS].

Playback checks:
[HOW TO START, PAUSE TO BUFFER, RESUME, SEEK AND STOP CAPTURE IN THE FINAL APP].

Account requirement:
[CONFIRM WHETHER SIGN-IN IS REQUIRED. PROVIDE REVIEW ACCESS THROUGH APP STORE CONNECT IF NEEDED].

Remote resources:
[LIST MODEL/DATA DOWNLOAD HOSTS AND THEIR PURPOSE. IDENTIFY ALL PACKAGED EXECUTABLE COMPONENTS AND REVIEW APPLICABLE APPLE RULES FOR THE FINAL DESIGN].

Known limitations:
[ONLY VERIFIED MACOS/SAFARI/HARDWARE SUPPORT; UNSUPPORTED VIDEO TYPES; BEHAVIOR ON ADS, EPISODE CHANGES AND CLOSED PREPARATION TABS].

## Screenshot plan
Capture genuine screenshots of the completed macOS/Safari app, not the Chrome extension or a fabricated Safari rendering.

1. English subtitles visible over a video you have permission to show.
2. The real Safari extension's language and preparation controls.
3. The actual initial preparation state with the viewing player paused.
4. Pause-to-buffer and resume controls.
5. macOS onboarding showing how to enable the Safari extension and authorize the implemented audio source.

Use the sizes requested by the current App Store Connect screenshot specifications. Provide native macOS app/store icons; the small Chrome toolbar icons alone are not a complete macOS icon set. Supply any demonstration audio or video with appropriate rights.

## Submission blockers
1. Build the containing macOS app and Safari extension; conversion of the Chrome manifest alone is not enough.
2. Solve and verify audio access. The current chrome.tabCapture and offscreen processing flow must not be assumed to work in Safari. Establish a permitted capture architecture on real Macs before advertising no-caption audio translation.
3. Verify silent preparation, playback synchronization, pause-to-buffer, seeking, model caching and subtitle quality. If the Safari port only supports existing captions, rewrite the launch copy to omit audio translation and buffering features.
4. Set and test hardware, macOS and Safari compatibility; preserve the local-only promise only if the final design actually does so.
5. Review the app sandbox, permissions, signing, entitlements, downloaded-model behavior and current App Review rules.
6. Supply publisher details, public support/privacy URLs, actual screenshots and complete App Privacy declarations.
7. Review source/dependency/model licences and rights to test/store media.
8. Join the Apple Developer Program as needed, sign the app and extension, archive/upload the actual build using Apple's supported tooling, and submit through App Store Connect.

No listing text, Chrome ZIP or web-extension conversion command guarantees App Store approval.

## Official Apple references
- Metadata and name/subtitle fields: https://developer.apple.com/help/app-store-connect/reference/app-information/app-information
- Description, keywords, review notes and version fields: https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information
- Safari extension distribution and signed containing app: https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension
- App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- App Privacy: https://developer.apple.com/app-store/app-privacy-details/
- Screenshot specifications: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications
