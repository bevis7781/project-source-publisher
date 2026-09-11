# Project Source Publisher

Publish 1–10 Markdown files from the currently loaded assistant response in a ChatGPT Project conversation to Google Drive-backed Project Sources.

> **Status: GITHUB PUBLIC BETA / EDGE PRE-RELEASE.** The public source repository is live at [github.com/bevis7781/project-source-publisher](https://github.com/bevis7781/project-source-publisher). Microsoft Edge Add-ons remains the first intended store channel, but its listing is not public yet and there is no supported public install link. This is still a beta, pre-store distribution; loading an arbitrary Git clone is not a supported OAuth installation path. Chrome Web Store support is planned later.

## Why

Moving generated Markdown into Project Sources can require downloading files, writing them to Drive, and manually setting up each source. Project Source Publisher keeps that workflow focused and predictable.

## How it works

1. It selects the latest loaded, visible assistant batch that contains file artifacts. It does not merge files across separate batches.
2. It supports 1–10 Markdown files. On first use, authorize Google Drive and add each source from the Project Sources page with **Copy Drive link → Add**.
3. Once a source is established, refresh updates only an existing source with the exact matching filename, keeps its Drive file ID, and verifies the write by reading it back.
4. Project context follows the active ChatGPT Project automatically. Reinstall recovery checks the exact source identity before restoring it.
5. Completion is shown only when every target has confirmation evidence.

## What it does

- Captures the selected Markdown files through their ChatGPT-generated download links.
- Keeps progress visible per file when multiple sources are involved.
- Preserves established source identity instead of guessing from filenames alone.
- Provides English and Chinese interfaces.

## Known limitations

- Discovery is limited to content that is already loaded and visible in the current ChatGPT Project conversation; it is not a full-history search.
- A first Add may save the file to Drive while PSP cannot confirm completion from observable ChatGPT state. **Saved to Drive · confirmation unavailable** is a known limitation, not proof of failure; Published remains withheld until confirmation is available.
- PSP is not a general Source Manager. It does not automatically add new filenames or perform rename, delete, merge, split, or arbitrary-upload operations.
- ChatGPT interface changes may affect the workflow. Google Drive, a supported Microsoft Edge browser, and an authenticated ChatGPT session are required.
- This source tree is not a supported public installation package. Loading an arbitrary Git clone unpacked is not a supported OAuth installation path and should not be expected to make Google OAuth work.

## Privacy and permissions

- Google Drive access uses only the `https://www.googleapis.com/auth/drive.file` scope.
- The extension uses `activeTab`, `scripting`, `downloads`, `identity`, and `storage` permissions, with access limited to ChatGPT and Google API pages needed by the workflow.
- There is no developer backend, telemetry, advertising, or data-broker activity. OAuth access tokens are handled transiently in the extension and are not sent to a developer-operated server.
- Project Source Publisher is an independent project. It is unofficial and is not affiliated with, endorsed by, or sponsored by OpenAI or Google.

See [Privacy Policy](PRIVACY.md), [Security Policy](SECURITY.md), and [MIT License](LICENSE).

## Release status

**GITHUB PUBLIC BETA / EDGE PRE-RELEASE**

GitHub Public Beta is live at [github.com/bevis7781/project-source-publisher](https://github.com/bevis7781/project-source-publisher). Microsoft Edge Add-ons is the first intended store channel, but the store listing is not yet public and no supported public install link is available. This local Edge ZIP is not publicly downloadable, and no GitHub Release exists. Chrome Web Store distribution is planned later; this status does not claim acceptance by either store.

## License

MIT
