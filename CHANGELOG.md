# Changelog

## 0.3.3 — Reliability release (2026-09-16)

Project identity and recovery-state reliability release. Published the runtime that
completed real Microsoft Edge human verification of the full publish path
(first publish, one-time Project Source connection, same-name newer revision,
`Published ✓`, fresh Chat reads the new revision).

### User-facing changes

- Treats a ChatGPT Project's canonical identity consistently whether the page URL
  carries a trailing name segment or not, so one Project always resolves to one
  stored connection instead of two.
- Safely adopts state left by earlier versions that stored a Project's connection
  under the older name-bearing identity, preserving the existing Drive file and
  Project Source.
- Fails closed, instead of guessing, when stored state for a Project is ambiguous,
  and keeps failing closed on every later attempt.
- Remains compatible with Drive files that were created under the older Project
  identity, so an existing connection stays updatable.
- Correctly refreshes an already-connected Source on a newer same-name revision
  after an unconfirmed first publish, without replaying one-time connection setup.

## 0.3.1 — GitHub Public Beta (2026-09-12)

Published the 0.3.1 source baseline on GitHub. See the [README](README.md#availability) for current store and installation availability.

### User-facing changes

- Added an Edge-compatible Google Drive OAuth flow.
- Supports publishing 1–10 Markdown files from one loaded assistant batch.
- Added first-use per-source connection and exact-filename refresh for established sources.
- Added automatic ChatGPT Project context and identity-checked reinstall recovery.
- Added per-file progress and a truthful confirmation-unavailable state when a Drive save cannot be confirmed from the ChatGPT page.
- Kept English and Chinese interfaces.
