# Privacy Policy — Project Source Publisher

Effective date: September 12, 2026

## Scope and purpose

Project Source Publisher is a local browser extension with one purpose: to
publish Markdown files discovered in a user's ChatGPT Project conversation to
stable Google Drive-backed Project Sources and synchronize those Sources.

The extension runs in the user's browser. Discovery is limited to relevant,
loaded ChatGPT page content used for the feature, including loaded assistant
message nodes. It does not read the user's entire ChatGPT account or assume
that a conversation's full history has loaded.

## Data processed from ChatGPT

For a user-requested Publish workflow, the extension may process:

- ChatGPT Project identifiers and URLs;
- Markdown filenames discovered in loaded assistant messages;
- Markdown content selected for publishing;
- Project Source identity information;
- Google Drive file identifiers associated with bound Sources;
- synchronization status and timestamps; and
- limited structured Source and synchronization metadata needed to confirm the
  requested operation.

The extension may also handle the exact ChatGPT-generated download URL and
download lifecycle information needed to capture the selected Markdown file.
It does not treat a filename alone as proof of artifact identity.

## Authenticated ChatGPT session behavior

The extension does not extract, copy, persist, or send ChatGPT passwords,
Cookie values, bearer tokens, or `Authorization` headers to the Project Source
Publisher developer or to a developer-operated server.

Some user-requested operations run inside the user's already authenticated
ChatGPT browser session. Limited same-origin, read-only requests may use that
existing browser session so that the browser can authenticate requests in its
normal way. The browser may therefore attach ChatGPT session credentials
automatically, without the extension reading the values of those credentials.

For the Publish workflow, the extension may retrieve the exact ChatGPT
download URL using that browser session in order to read the selected Markdown
bytes. The extension does not read the session credentials that the browser
may attach.

The extension may observe a bounded set of synchronization and identity
metadata from ChatGPT page or network activity. A bounded, read-only,
same-origin receipt check may also run in the page context. These paths are
limited to the Source/synchronization evidence needed to determine whether the
requested Project Source synchronization completed; they are not general
conversation or account collection paths.

This behavior is not described as official API access and is not an OpenAI
endorsement or authorization.

## Google Drive data

The extension uses Google OAuth for Drive and requests only the
`https://www.googleapis.com/auth/drive.file` scope. The browser/channel
determines the identity flow:

- The Edge release candidate uses `chrome.identity.launchWebAuthFlow()` with a
  Google Web Application OAuth client.
- The separate formal Chrome variant uses `chrome.identity.getAuthToken()`
  with a Chrome Extension OAuth client and its manifest `oauth2` block.

It uses that permission to create and/or update the Google Drive files used by
Project Source Publisher and to verify those writes. Relevant data can include
Markdown file content, filename, Drive file ID, and metadata needed for exact
write and readback verification. The extension does not request full access
to the user's entire Google Drive.

## OAuth authentication data

For the Edge release candidate, Google OAuth authorization is performed with
`chrome.identity.launchWebAuthFlow()` and the access token is handled
transiently inside the extension as needed to call Google Drive APIs. For the
formal Chrome variant, authorization uses `chrome.identity.getAuthToken()`.
Neither path sends OAuth access tokens to a developer-operated server.
Project Source Publisher does not operate an account backend that stores those
tokens.

## Local storage and retention

The extension may persist operational metadata in `chrome.storage.local`,
including data needed for:

- Project context and bindings;
- Google Drive file identity;
- publish and recovery state;
- synchronization evidence;
- user preferences such as UI language; and
- hashes, timestamps, and similar integrity or state fields.

The developer does not operate a remote retention database for this data.
Local operational state may survive browser or extension restarts when needed
for recovery. The Publish download flow may leave temporary or downloaded
Markdown files in the browser's local download storage. Files written to
Google Drive remain in the user's Google Drive until the user removes them.

## Where data goes

Data necessary to use ChatGPT remains processed in interaction with
OpenAI/ChatGPT. Markdown content selected for Publish is transmitted to Google
Drive at the user's request. No user data is transmitted to a Project Source
Publisher developer backend because no such backend exists.

Project Source Publisher does not sell user data, use it for advertising,
retargeting, profiling, or data-broker activity, or operate analytics or
telemetry. It does not use Google Workspace API data to train, develop, or
improve generalized or non-personalized AI or machine-learning models.

## Human access

Because there is no developer backend, maintainers do not receive normal
users' ChatGPT or Google Drive content through normal operation of the
extension. This does not make a promise about what OpenAI, Google, or another
provider may do under its own policies.

## Security

Network communication with ChatGPT/OpenAI and Google APIs uses HTTPS. The
extension requests the permissions used by its current user-facing feature.
Users should not send credentials, cookies, private tokens, authorization
headers, private Drive links, private ChatGPT Project URLs, or conversation
contents in public GitHub issues.

No software can be guaranteed secure or safe in every environment. Users
should keep their browser, operating system, and the relevant provider
accounts up to date and review the permissions they grant.

## User control and deletion

Users control when Publish runs. They can remove or uninstall the extension,
manage or remove files written to their Google Drive, and manage locally
downloaded files through their browser and operating system. Google
authorization can be revoked through the user's Google account. Locally stored
extension state can be removed through extension removal or relevant product
reset behavior where supported.

Project Source Publisher does not provide an in-product Delete Account
function.

## Third-party services

Use of ChatGPT and Google Drive is also governed by the respective providers'
terms and privacy policies. Their interfaces, terms, and policies can change,
and the extension may become unavailable or require changes as a result.

Project Source Publisher's use of information received from Google Workspace
APIs will adhere to the Google User Data Policy, including the Limited Use
requirements.

For the formal Chrome variant, the use of information received from Google
APIs will also adhere to the Chrome Web Store User Data Policy, including the
Limited Use requirements.

For a future store distribution, the applicable browser-store user-data
requirements also apply. This policy does not claim Google verification or
Microsoft certification.

## Changes to this policy

This policy may be updated when product behavior or applicable platform
requirements change. The effective date will be updated when the policy
changes.

## Contact

For privacy questions, use the support contact published with the project's
official GitHub repository or applicable public store listing when one exists.
