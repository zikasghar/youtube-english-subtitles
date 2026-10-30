# YouTube English Subtitles

Desktop Chrome extension for English YouTube subtitles using caption tracks or user-authorized on-device speech translation.

## Development
Requires Node.js (a current supported LTS release), pnpm 10 and Python 3 for release ZIP generation.

```sh
pnpm install
pnpm --filter @workspace/youtube-english-subtitles test
pnpm --filter @workspace/youtube-english-subtitles build
pnpm --filter @workspace/youtube-english-subtitles test:bundle
```

Load `youtube-english-subtitles/dist/` using Chrome's Load unpacked control, never the source folder. See the extension README for setup and limitations.

Create download packages with `pnpm --filter @workspace/youtube-english-subtitles release`. Build outputs go into `generated-artifacts/chrome-extension/`.

## Store documents
`youtube-english-subtitles/release/` contains Chrome listing, privacy and macOS App Store drafts. The macOS listing is planning text only: no native macOS app or Safari port is included. Replace publisher/contact placeholders before publishing.

## Licence status
No licence has been assigned to this extension source by this export. Choose and add an appropriate licence and copyright details before presenting the repository as open source. Third-party code and downloaded model assets have their own terms.

This source export excludes credentials, workspace history, personal memory, unrelated apps, node_modules, compiled runtime files and downloaded model caches. A clean dependency install of this isolated export has not yet been verified.
