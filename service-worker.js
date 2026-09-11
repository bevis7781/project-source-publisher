"use strict";

const ALLOWED_PAGE_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com"
]);
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
// Live Chrome uniquified without the space: "<base>(1)<ext>". The rule stays
// narrow (optional single space before the parenthesized index), is built
// from the armed filename with regex metacharacters escaped and the
// extension preserved, and is bounded capture correlation only — never
// artifact identity.
// LIVE REGRESSION 2026-09-06: ChatGPT's estuary download endpoint now
// uniquifies the SERVED filename server-side — observed download
// "project-source(20260906-052400).md" (fn= parameter carries the suffix),
// which Chrome saves verbatim. The parenthetical suffix list therefore
// allows one or more groups whose contents start with a digit and hold only
// digits/dashes (digits-only Chrome forms, nested "base(9) (1).md", and the
// new timestamp form). Letter/space suffixes like "base(copy).md" still fail
// closed; this stays bounded capture correlation, never artifact identity.
function downloadCaptureFilenamePattern(expected) {
  const filename = String(expected || "");
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escape(base)}(?: ?\\([0-9][0-9-]*\\))*${escape(extension)}$`, "i");
}

function isValidDownloadCaptureFilename(filename) {
  const value = String(filename || "");
  if (!value || value.length > 120 || value.includes("/") || value.includes("\\")) {
    return false;
  }
  return /\.md$/i.test(value);
}
// Must stay strictly below the content-side waiter (content.js
// DOWNLOAD_CAPTURE_TIMEOUT = 15000) so the armed job's timeout diagnostic
// reaches the T1 result before the page gives up waiting.
const DOWNLOAD_CAPTURE_TIMEOUT_MS = 12000;
const DOWNLOAD_CAPTURE_POLL_MS = 180;
const DOWNLOAD_CAPTURE_SETTLE_MS = 250;
let downloadCaptureJob = null;

function createDownloadDiagnostic() {
  return {
    download_event_seen: false,
    created_basename_initial: "",
    filename_became_available: false,
    resolved_basename: "",
    resolved_filename_qualified: false,
    captured_download_id_present: false,
    download_monitor_started: false,
    download_item_found: false,
    download_state: ""
  };
}

// Live Chrome fires onCreated before the target filename is populated.
// Candidates are therefore retained by id and qualified only once
// chrome.downloads.search exposes a non-empty filename.
const MAX_PROVISIONAL_DOWNLOADS = 8;

function basename(value) {
  return String(value || "").replace(/\\/g, "/").split("/").pop() || "";
}

function isQualifyingDownloadFilename(value, expected) {
  if (!isValidDownloadCaptureFilename(expected)) {
    return false;
  }
  return downloadCaptureFilenamePattern(expected).test(basename(value));
}

function downloadStartedAfterArm(item, job) {
  const startTime = Date.parse(String(item.startTime || ""));
  return !Number.isFinite(startTime) || startTime >= job.armedAt;
}

function clearDownloadCaptureJob(job) {
  job.finished = true;
  if (job.timeoutId) {
    clearTimeout(job.timeoutId);
  }
  if (downloadCaptureJob === job) {
    downloadCaptureJob = null;
  }
}

function sendDownloadCaptureResult(job, payload) {
  if (job.finished) {
    return;
  }
  clearDownloadCaptureJob(job);
  const message = { type: "PROJECT100_DOWNLOAD_CAPTURE_RESULT", ...payload, ...job.diagnostic };
  void chrome.tabs.sendMessage(job.sourceTabId, message).catch(() => {});
}

function discardDownloadCaptureJob(job) {
  if (job) {
    clearDownloadCaptureJob(job);
  }
}

async function evaluateCaptureJob(job) {
  const diagnostic = job.diagnostic;

  const remaining = [];
  for (const candidate of job.provisional) {
    let item = null;
    try {
      const items = await chrome.downloads.search({ id: candidate.id });
      item = items[0] || null;
    } catch (_error) {
      item = null;
    }
    if (!item || !item.filename) {
      // Filename not yet populated by Chrome; keep the candidate and wait.
      remaining.push(candidate);
      continue;
    }
    diagnostic.filename_became_available = true;
    // DownloadItem.filename is a lifecycle field: Chrome may report an
    // intermediate name (e.g. "Unconfirmed <n>.crdownload") before the final
    // one. Record the observed basename, re-qualify every poll, and never
    // drop a candidate on a non-matching intermediate value.
    diagnostic.resolved_basename = basename(item.filename);
    const qualified = isQualifyingDownloadFilename(item.filename, job.expectedFilename);
    diagnostic.resolved_filename_qualified = qualified;
    if (!qualified) {
      remaining.push(candidate);
      continue;
    }
    if (job.boundDownloadId !== null) {
      sendDownloadCaptureResult(job, {
        ok: false,
        error: "DOWNLOAD_CAPTURE_AMBIGUOUS"
      });
      return;
    }
    job.boundDownloadId = candidate.id;
    diagnostic.captured_download_id_present = true;
    diagnostic.download_monitor_started = true;
  }
  job.provisional = remaining;

  if (job.finished || job.boundDownloadId === null) {
    return;
  }

  try {
    const items = await chrome.downloads.search({ id: job.boundDownloadId });
    const item = items[0];
    if (item) {
      diagnostic.download_item_found = true;
      diagnostic.download_state = String(item.state || "");
    }
    if (item && item.state === "complete") {
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_CAPTURE_SETTLE_MS));
      if (job.finished) {
        return;
      }
      const url = item.url || item.finalUrl || "";
      sendDownloadCaptureResult(job, url
        ? {
          ok: true,
          downloadId: item.id,
          filename: item.filename || "",
          url
        }
        : {
          ok: false,
          error: "DOWNLOAD_URL_UNAVAILABLE"
        });
      return;
    }
    if (item && item.state === "interrupted") {
      sendDownloadCaptureResult(job, {
        ok: false,
        error: "DOWNLOAD_INTERRUPTED"
      });
      return;
    }
  } catch (_error) {
    sendDownloadCaptureResult(job, {
      ok: false,
      error: "DOWNLOAD_STATUS_UNAVAILABLE"
    });
  }
}

async function runCaptureMonitor(job) {
  const deadline = Date.now() + DOWNLOAD_CAPTURE_TIMEOUT_MS;
  while (!job.finished && Date.now() < deadline) {
    await evaluateCaptureJob(job);
    if (job.finished) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_CAPTURE_POLL_MS));
  }
  if (!job.finished) {
    sendDownloadCaptureResult(job, {
      ok: false,
      error: "DOWNLOAD_CAPTURE_TIMEOUT"
    });
  }
}

chrome.downloads.onCreated.addListener((item) => {
  const job = downloadCaptureJob;
  if (!job) {
    return;
  }
  const diagnostic = job.diagnostic;
  diagnostic.download_event_seen = true;
  if (!item || typeof item.id !== "number") {
    return;
  }
  diagnostic.created_basename_initial = basename(item.filename);
  if (!downloadStartedAfterArm(item, job)) {
    return;
  }
  if (job.provisional.length >= MAX_PROVISIONAL_DOWNLOADS) {
    sendDownloadCaptureResult(job, {
      ok: false,
      error: "DOWNLOAD_CAPTURE_AMBIGUOUS"
    });
    return;
  }
  job.provisional.push({ id: item.id, initialBasename: diagnostic.created_basename_initial });
  if (!job.monitorStarted) {
    job.monitorStarted = true;
    void runCaptureMonitor(job);
  }
});

function isAllowedExactUrl(url, sender) {
  if (!sender || !sender.tab || typeof sender.tab.url !== "string") {
    return false;
  }

  let requested;
  let page;
  try {
    requested = new URL(url);
    page = new URL(sender.tab.url);
  } catch (_error) {
    return false;
  }

  if (requested.protocol !== "https:") {
    return false;
  }

  return requested.origin === page.origin && ALLOWED_PAGE_ORIGINS.has(page.origin);
}

async function fetchExactDomUrl(url, sender) {
  if (!isAllowedExactUrl(url, sender)) {
    return {
      ok: false,
      error: "EXACT_URL_ORIGIN_NOT_ALLOWED"
    };
  }

  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow"
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP_${response.status}`
      };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_ARTIFACT_BYTES) {
      return {
        ok: false,
        error: "ARTIFACT_TOO_LARGE"
      };
    }

    return {
      ok: true,
      bytes: Array.from(new Uint8Array(buffer)),
      finalUrl: response.url
    };
  } catch (_error) {
    return {
      ok: false,
      error: "EXACT_URL_FETCH_FAILED"
    };
  }
}

const PROJECT100_MVP_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const PROJECT100_MVP_DRIVE_API = "https://www.googleapis.com/drive/v3";
const PROJECT100_MVP_DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const PROJECT100_MVP_BINDING_KEY = "project100MvpBinding";
const PROJECT100_MVP_MAX_SOURCE_BYTES = 10 * 1024 * 1024;

// RC-2: every durable value that can affect the popup or a later operation
// belongs to the exact ChatGPT Project that created it.  The unscoped keys
// remain readable only as a compatibility/migration boundary for older
// installs and for pre-RC-2 state that carries its own exact projectId.
const PROJECT100_MVP_PROJECT_NAMESPACE_MARKER = ":project:";

function project100MvpNormalizeProjectId(value) {
  const projectId = String(value || "").trim();
  if (!projectId || projectId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    return "";
  }
  return projectId;
}

function project100MvpEffectiveProjectId(value) {
  return project100MvpNormalizeProjectId(value) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
}

function project100MvpRecordProjectId(record) {
  if (!record || typeof record !== "object") {
    return "";
  }
  const direct = project100MvpNormalizeProjectId(record.projectId);
  if (direct) {
    return direct;
  }
  const establishment = record.establishment && typeof record.establishment === "object"
    ? record.establishment
    : null;
  const nested = project100MvpNormalizeProjectId(establishment && establishment.projectId);
  if (nested) {
    return nested;
  }
  for (const field of ["sourcePageUrl", "projectUrl", "captureTabUrl"]) {
    const value = record[field];
    if (!value) {
      continue;
    }
    const derived = project100MvpProjectSegmentOf(value);
    if (derived) {
      return derived;
    }
  }
  return "";
}

function project100MvpProjectScopedKey(baseKey, projectId) {
  const normalized = project100MvpNormalizeProjectId(projectId);
  return normalized
    ? `${baseKey}${PROJECT100_MVP_PROJECT_NAMESPACE_MARKER}${encodeURIComponent(normalized)}`
    : baseKey;
}

function project100MvpAssertStateProject(projectId, value) {
  const requested = project100MvpNormalizeProjectId(projectId);
  const stored = project100MvpRecordProjectId(value);
  if (requested && stored && requested !== stored) {
    throw new Error("PROJECT_CONTEXT_MISMATCH");
  }
  return requested || stored;
}

async function project100MvpReadProjectState(baseKey, projectId) {
  const requested = project100MvpNormalizeProjectId(projectId);
  if (!requested) {
    const stored = await chrome.storage.local.get(baseKey);
    return stored[baseKey] || null;
  }
  const scopedKey = project100MvpProjectScopedKey(baseKey, requested);
  const scoped = await chrome.storage.local.get(scopedKey);
  if (Object.prototype.hasOwnProperty.call(scoped, scopedKey)) {
    return scoped[scopedKey] || null;
  }
  // Safe one-time adoption: the old value must carry the exact Project
  // identity itself. An unknown legacy value is never assigned to the
  // currently open Project merely because it happens to be open.
  const legacy = await chrome.storage.local.get(baseKey);
  if (Object.prototype.hasOwnProperty.call(legacy, baseKey) &&
      project100MvpRecordProjectId(legacy[baseKey]) === requested) {
    const value = legacy[baseKey] || null;
    if (value) {
      await chrome.storage.local.set({ [scopedKey]: value });
    }
    return value;
  }
  return null;
}

async function project100MvpWriteProjectState(baseKey, value, projectId) {
  // An omitted context is the legacy compatibility path. Production callers
  // pass the current exact Project explicitly; do not silently change the
  // storage shape of older direct worker calls just because the value happens
  // to contain a projectId field.
  const requested = project100MvpNormalizeProjectId(projectId)
    ? project100MvpAssertStateProject(projectId, value)
    : "";
  const key = project100MvpProjectScopedKey(baseKey, requested);
  await chrome.storage.local.set({ [key]: value });
  return value;
}

async function project100MvpRemoveProjectState(baseKey, projectId) {
  const requested = project100MvpNormalizeProjectId(projectId);
  const key = project100MvpProjectScopedKey(baseKey, requested);
  if (chrome.storage && chrome.storage.local &&
      typeof chrome.storage.local.remove === "function") {
    await chrome.storage.local.remove(key);
    if (requested) {
      const legacy = await chrome.storage.local.get(baseKey);
      if (Object.prototype.hasOwnProperty.call(legacy, baseKey) &&
          project100MvpRecordProjectId(legacy[baseKey]) === requested) {
        // A migrated transient record (onboarding, recovery checkpoint or
        // create intent) must not be resurrected from its old global copy
        // after the scoped copy is cleared. Persistent binding migration is
        // read-only and does not call this helper.
        await chrome.storage.local.remove(baseKey);
      }
    }
  }
}

function project100MvpNormalizeFilename(value) {
  const filename = String(value || "").trim();
  if (!filename || filename.length > 120) {
    throw new Error("INVALID_FILENAME");
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    throw new Error("INVALID_FILENAME");
  }
  if (!/\.md$/i.test(filename)) {
    throw new Error("MVP_REQUIRES_MARKDOWN_FILENAME");
  }
  return filename;
}

function project100MvpNormalizeDriveFileId(value) {
  const fileId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
    throw new Error("INVALID_DRIVE_FILE_ID");
  }
  return fileId;
}

function project100MvpNormalizeSourcePageUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_error) {
    throw new Error("INVALID_SOURCE_PAGE_URL");
  }
  if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
    throw new Error("SOURCE_PAGE_ORIGIN_NOT_ALLOWED");
  }
  return url.toString();
}

// Edge release OAuth uses the proven Web client flow instead of the formal
// Chrome manifest oauth2 block.
const PROJECT100_MVP_EDGE_OAUTH_CLIENT_ID =
  "1052292872509-9rbuc98o6pk8jcnps1tq1dh8kftvsepb.apps.googleusercontent.com";
const PROJECT100_MVP_EDGE_OAUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
let project100MvpEdgeAccessToken = null;

function project100MvpEdgeGenerateState() {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function project100MvpEdgeNormalizeRedirect(value) {
  const parsed = new URL(String(value || ""));
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function project100MvpEdgeBuildAuthorizationUrl(state, redirectUri) {
  const parameters = new URLSearchParams({
    client_id: PROJECT100_MVP_EDGE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: PROJECT100_MVP_DRIVE_SCOPE,
    state
  });
  return `${PROJECT100_MVP_EDGE_OAUTH_ENDPOINT}?${parameters.toString()}`;
}

function project100MvpEdgeLaunchWebAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error("DRIVE_AUTH_FLOW_FAILED"));
          return;
        }
        resolve(responseUrl);
      }
    );
  });
}

function project100MvpEdgeTokenFromRedirect(responseUrl, expectedState, redirectUri) {
  let parsedResponse;
  try {
    parsedResponse = new URL(String(responseUrl || ""));
  } catch (_error) {
    throw new Error("DRIVE_AUTH_REDIRECT_INVALID");
  }

  if (project100MvpEdgeNormalizeRedirect(parsedResponse.href) !==
      project100MvpEdgeNormalizeRedirect(redirectUri)) {
    throw new Error("DRIVE_AUTH_REDIRECT_MISMATCH");
  }

  const fragment = parsedResponse.hash.startsWith("#")
    ? parsedResponse.hash.slice(1)
    : "";
  const parameters = new URLSearchParams(fragment);
  if (parameters.get("state") !== expectedState) {
    throw new Error("DRIVE_AUTH_STATE_MISMATCH");
  }
  if (parameters.has("error")) {
    throw new Error("DRIVE_AUTH_FAILED");
  }

  const token = parameters.get("access_token");
  if (!token) {
    throw new Error("DRIVE_AUTH_TOKEN_UNAVAILABLE");
  }
  return token;
}

async function project100MvpGetAuthToken(interactive) {
  if (project100MvpEdgeAccessToken) {
    return {
      token: project100MvpEdgeAccessToken,
      grantedScopes: [PROJECT100_MVP_DRIVE_SCOPE]
    };
  }

  if (!interactive) {
    throw new Error("DRIVE_AUTH_TOKEN_UNAVAILABLE");
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const state = project100MvpEdgeGenerateState();
  const responseUrl = await project100MvpEdgeLaunchWebAuthFlow(
    project100MvpEdgeBuildAuthorizationUrl(state, redirectUri)
  );
  project100MvpEdgeAccessToken = project100MvpEdgeTokenFromRedirect(
    responseUrl,
    state,
    redirectUri
  );

  return {
    token: project100MvpEdgeAccessToken,
    grantedScopes: [PROJECT100_MVP_DRIVE_SCOPE]
  };
}

async function project100MvpFetchWithToken(url, init, interactive) {
  let auth = await project100MvpGetAuthToken(interactive);
  let response = await fetch(url, {
    ...(init || {}),
    headers: {
      ...((init && init.headers) || {}),
      Authorization: `Bearer ${auth.token}`
    }
  });

  if (response.status === 401) {
    project100MvpEdgeAccessToken = null;
    throw new Error("DRIVE_AUTH_TOKEN_EXPIRED");
  }
  return response;
}

async function project100MvpParseJsonResponse(response, fallbackError) {
  let body = null;
  try {
    body = await response.json();
  } catch (_error) {
    body = null;
  }
  if (!response.ok) {
    const apiMessage = body && body.error && body.error.message
      ? String(body.error.message)
      : "";
    throw new Error(apiMessage ? `${fallbackError}:${apiMessage}` : `${fallbackError}:HTTP_${response.status}`);
  }
  return body || {};
}

async function project100MvpSha256Hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")).join("");
}

async function project100MvpReadBinding(projectId = "") {
  return project100MvpReadProjectState(
    PROJECT100_MVP_BINDING_KEY, project100MvpEffectiveProjectId(projectId));
}

async function project100MvpWriteBinding(binding, projectId = "") {
  return project100MvpWriteProjectState(
    PROJECT100_MVP_BINDING_KEY, binding, project100MvpEffectiveProjectId(projectId));
}

// ---- Multi-source v1: V2 Project binding -----------------------------------
// One bound ChatGPT Project, many logical Sources. Identity contract:
//   one exact logical filename <-> one stable Drive file ID <-> one stable
//   ChatGPT Project Source. The legacy v0.3.1 single-source binding is never
//   silently overwritten or deleted: when a V2 binding does not exist and a
//   valid V1 binding does, the legacy state is migrated once,
//   identity-preserving (same filename, same Drive file ID, same bound
//   status) — never guessed into any other logical filename.
const PROJECT100_MVP_BINDING_V2_KEY = "project100MvpBindingV2";
const PROJECT100_MVP_SOURCE_MARKER_KEY = "projectSourcePublisherCanonical";
const PROJECT100_MVP_SOURCE_MARKER_VALUE = "v2";
const PROJECT100_MVP_SOURCE_PROJECT_KEY = "projectSourcePublisherProjectId";
const PROJECT100_MVP_SOURCE_CONNECTOR_TYPE = "google_drive";
const PROJECT100_MVP_SOURCE_CREATE_INTENT_KEY = "project100MvpSourceCreateIntent";
const PROJECT100_MVP_SOURCE_CREATE_INTENT_VERSION = 2;
const PROJECT100_MVP_MAX_SOURCES = 10;

function project100MvpNormalizeLogicalFilename(value) {
  const filename = String(value || "").trim();
  if (!filename || filename.length > 120) {
    throw new Error("SOURCE_FILENAME_INVALID");
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    throw new Error("SOURCE_FILENAME_INVALID");
  }
  if (!/\.md$/i.test(filename)) {
    throw new Error("SOURCE_FILENAME_INVALID");
  }
  return filename;
}

// PC-1A: the worker may persist/pass only the frozen page-lifetime identity.
// DOM references and artifact bytes stay inside the content document.
function project100MvpNormalizeFrozenArtifactOperation(rawInput) {
  const raw = rawInput && typeof rawInput === "object" ? rawInput : {};
  if (raw.status && raw.status !== "PASS") {
    throw new Error(String(raw.error || "NO_MARKDOWN"));
  }
  const documentInstanceId = String(raw.documentInstanceId || "").trim();
  const frozenScopeToken = String(raw.frozenScopeToken || "").trim();
  const frozenOperationToken = String(raw.frozenOperationToken || "").trim();
  if (!documentInstanceId || !frozenScopeToken || !frozenOperationToken) {
    throw new Error("ARTIFACT_TARGET_LOST");
  }
  const rawTargets = Array.isArray(raw.targets) ? raw.targets : [];
  if (rawTargets.length === 0) {
    throw new Error("NO_MARKDOWN");
  }
  if (rawTargets.length > PROJECT100_MVP_MAX_SOURCES) {
    throw new Error("TOO_MANY_MARKDOWN");
  }
  const targetTokens = new Set();
  const filenames = new Set();
  const targets = rawTargets.map((targetInput) => {
    const target = targetInput && typeof targetInput === "object" ? targetInput : {};
    const frozenTargetToken = String(target.frozenTargetToken || "").trim();
    const targetScopeToken = String(target.frozenScopeToken || frozenScopeToken).trim();
    const targetOperationToken = String(
      target.frozenOperationToken || frozenOperationToken).trim();
    const exactFilename = project100MvpNormalizeLogicalFilename(target.exactFilename);
    if (!frozenTargetToken || targetScopeToken !== frozenScopeToken ||
        targetOperationToken !== frozenOperationToken ||
        targetTokens.has(frozenTargetToken) || filenames.has(exactFilename)) {
      throw new Error("ARTIFACT_AMBIGUOUS");
    }
    targetTokens.add(frozenTargetToken);
    filenames.add(exactFilename);
    return {
      documentInstanceId,
      frozenScopeToken,
      frozenOperationToken,
      frozenTargetToken,
      exactFilename
    };
  });
  return {
    documentInstanceId,
    frozenScopeToken,
    frozenOperationToken,
    scopeIndex: Number.isInteger(raw.scopeIndex) ? raw.scopeIndex : -1,
    targets
  };
}

function project100MvpFrozenTargetIdentity(operation, target) {
  return {
    documentInstanceId: operation.documentInstanceId,
    frozenOperationToken: operation.frozenOperationToken,
    frozenScopeToken: operation.frozenScopeToken,
    frozenTargetToken: target.frozenTargetToken,
    exactFilename: target.exactFilename
  };
}

function project100MvpNormalizeSourceBytes(bytesInput) {
  const rawBytes = bytesInput instanceof Uint8Array
    ? bytesInput
    : (Array.isArray(bytesInput) ? Uint8Array.from(bytesInput) : null);
  if (!rawBytes || rawBytes.byteLength === 0 ||
      rawBytes.byteLength > PROJECT100_MVP_MAX_SOURCE_BYTES) {
    throw new Error("INVALID_SOURCE_BYTES");
  }
  return rawBytes;
}

function project100MvpNormalizeContentPin(rawInput) {
  const raw = rawInput && typeof rawInput === "object" ? rawInput : null;
  if (!raw || String(raw.phase || "") !== "pinned" ||
      Number(raw.version) !== 1 ||
      !String(raw.operationToken || "") ||
      !String(raw.documentInstanceId || "") ||
      !String(raw.frozenScopeToken || "") ||
      !String(raw.frozenTargetToken || "") ||
      !String(raw.exactFilename || "") ||
      !Number.isInteger(Number(raw.byteLength)) || Number(raw.byteLength) <= 0 ||
      !/^[a-f0-9]{64}$/.test(String(raw.sha256 || "")) ||
      !String(raw.pinnedAt || "")) {
    throw new Error("CONTENT_PIN_INVALID");
  }
  return {
    version: 1,
    phase: "pinned",
    operationToken: String(raw.operationToken),
    documentInstanceId: String(raw.documentInstanceId),
    frozenScopeToken: String(raw.frozenScopeToken),
    frozenTargetToken: String(raw.frozenTargetToken),
    exactFilename: String(raw.exactFilename),
    byteLength: Number(raw.byteLength),
    sha256: String(raw.sha256),
    pinnedAt: String(raw.pinnedAt)
  };
}

async function project100MvpAssertContentPinMatchesCapture(pinInput, capture, identity) {
  const pin = project100MvpNormalizeContentPin(pinInput);
  const capturedBytes = project100MvpNormalizeSourceBytes(capture && capture.bytes);
  // The content script's hash is diagnostic input only. Recompute from the
  // bytes that are about to be written so a stale/malicious field cannot
  // preserve or replace a pinned content version.
  const capturedHash = await project100MvpSha256Hex(capturedBytes);
  if (pin.exactFilename !== String(identity && identity.exactFilename || "") ||
      pin.operationToken !== String(identity && identity.frozenOperationToken || "") ||
      pin.documentInstanceId !== String(identity && identity.documentInstanceId || "") ||
      pin.frozenScopeToken !== String(identity && identity.frozenScopeToken || "") ||
      pin.frozenTargetToken !== String(identity && identity.frozenTargetToken || "") ||
      pin.byteLength !== capturedBytes.byteLength ||
      pin.sha256 !== capturedHash) {
    throw new Error("ARTIFACT_CONTENT_CHANGED");
  }
  return pin;
}

async function project100MvpNormalizeCapturedArtifact(capture) {
  const bytes = project100MvpNormalizeSourceBytes(capture && capture.bytes);
  const sha256 = await project100MvpSha256Hex(bytes);
  return {
    bytes: Array.from(bytes),
    sha256,
    byteLength: bytes.byteLength
  };
}

function project100MvpBuildContentPin(identity, capture) {
  const normalizedIdentity = identity && typeof identity === "object" ? identity : {};
  const sha256 = String(capture && capture.sha256 || "");
  const byteLength = Number(capture && capture.byteLength);
  if (!/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error("ARTIFACT_CONTENT_HASH_INVALID");
  }
  return project100MvpNormalizeContentPin({
    version: 1,
    phase: "pinned",
    operationToken: normalizedIdentity.frozenOperationToken,
    documentInstanceId: normalizedIdentity.documentInstanceId,
    frozenScopeToken: normalizedIdentity.frozenScopeToken,
    frozenTargetToken: normalizedIdentity.frozenTargetToken,
    exactFilename: normalizedIdentity.exactFilename,
    byteLength,
    sha256,
    pinnedAt: new Date().toISOString()
  });
}

function project100MvpFrozenArtifactOperationsMatch(firstInput, secondInput) {
  try {
    const first = project100MvpNormalizeFrozenArtifactOperation(firstInput);
    const second = project100MvpNormalizeFrozenArtifactOperation(secondInput);
    if (first.documentInstanceId !== second.documentInstanceId ||
        first.frozenOperationToken !== second.frozenOperationToken ||
        first.frozenScopeToken !== second.frozenScopeToken ||
        first.targets.length !== second.targets.length) {
      return false;
    }
    return first.targets.every((target, index) => {
      const other = second.targets[index];
      return other && target.frozenTargetToken === other.frozenTargetToken &&
        target.exactFilename === other.exactFilename;
    });
  } catch (_error) {
    return false;
  }
}

function project100MvpRecoveryJobMatchesFrozenOperation(job, frozenInput) {
  return Boolean(job && job.frozenArtifactOperation && frozenInput &&
    project100MvpFrozenArtifactOperationsMatch(
      job.frozenArtifactOperation, frozenInput));
}

async function project100MvpWriteBindingV2(binding, projectId = "") {
  return project100MvpWriteProjectState(
    PROJECT100_MVP_BINDING_V2_KEY, binding,
    project100MvpEffectiveProjectId(projectId));
}

async function project100MvpReadBindingV2(projectId = "") {
  const requestedProjectId = project100MvpEffectiveProjectId(projectId);
  const v2 = await project100MvpReadProjectState(
    PROJECT100_MVP_BINDING_V2_KEY, requestedProjectId);
  if (v2 && v2.version === 2 && Array.isArray(v2.sources)) {
    return v2;
  }
  // One-time identity-preserving migration from v0.3.1 single-source state.
  // The legacy storage entry itself is left untouched.
  const legacy = await project100MvpReadBinding(requestedProjectId);
  if (legacy && legacy.driveFileId) {
    const legacyProjectId = project100MvpRecordProjectId(legacy);
    if (requestedProjectId && legacyProjectId !== requestedProjectId) {
      return null;
    }
    const migrated = {
      version: 2,
      projectId: legacyProjectId || requestedProjectId,
      sourcePageUrl: legacy.sourcePageUrl || "",
      sources: [{
        filename: legacy.filename || PROJECT100_CANONICAL_FILENAME,
        driveFileId: legacy.driveFileId,
        driveUrl: legacy.driveUrl || "",
        sourceBound: Boolean(legacy.sourcePageUrl),
        createdAt: legacy.createdAt || new Date().toISOString(),
        sourceBoundAt: legacy.sourceBoundAt || ""
      }],
      migratedFromV1: true,
      createdAt: legacy.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await project100MvpWriteBindingV2(
      migrated, requestedProjectId || migrated.projectId);
    return migrated;
  }
  return null;
}

function project100MvpBindingV2Complete(binding) {
  return Boolean(
    binding && binding.version === 2 && binding.sourcePageUrl &&
    Array.isArray(binding.sources) && binding.sources.length > 0 &&
    binding.sources.every((entry) => entry.driveFileId));
}

function project100MvpBindingV2AllBound(binding) {
  return Boolean(project100MvpBindingV2Complete(binding) &&
    binding.sources.every((entry) => entry.sourceBound));
}

// PC-1B lifecycle is deliberately kept inside the existing V2 binding and
// recovery/onboarding records. It is not a new cross-Chat registry. Structural
// binding completeness and connection-level sourceBound facts remain separate
// from the durable establishment decision below.
const PROJECT100_MVP_ESTABLISHMENT_SCHEMA_VERSION = 1;
const PROJECT100_MVP_ESTABLISHMENT_STATES = new Set([
  "INITIALIZING",
  "ESTABLISHED"
]);

function project100MvpEstablishmentRecord(binding) {
  const record = binding && binding.establishment;
  return record && typeof record === "object" ? record : null;
}

function project100MvpEstablishmentState(binding) {
  const record = project100MvpEstablishmentRecord(binding);
  const state = String(record && record.state || "");
  return PROJECT100_MVP_ESTABLISHMENT_STATES.has(state) ? state : "UNKNOWN";
}

function project100MvpUniqueExactFilenames(filenames) {
  const values = Array.isArray(filenames)
    ? filenames.map((filename) => String(filename || ""))
    : [];
  return values.length > 0 && values.every(Boolean) &&
    new Set(values).size === values.length;
}

function project100MvpSameFilenameSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right.map((value) => String(value || "")));
  return new Set(left.map((value) => String(value || ""))).size === rightSet.size &&
    left.every((value) => rightSet.has(String(value || "")));
}

// Existing V2 records may store either the canonical g-p id or the full URL
// path segment (which can include the human-readable Project slug). Both forms
// identify the same Project. Keep this compatibility at the lifecycle
// validation boundary; do not rewrite the stored identity or broaden matching.
function project100MvpProjectIdentityMatchesSourcePage(projectId, sourcePageUrl) {
  const expected = String(projectId || "");
  if (!expected || !sourcePageUrl) {
    return false;
  }
  const canonicalId = project100MvpResolveProjectId(sourcePageUrl);
  const pathSegment = project100MvpProjectSegmentOf(sourcePageUrl);
  return expected === canonicalId || expected === pathSegment;
}

function project100MvpBuildEstablishmentRecord(
  state,
  projectId,
  initialFilenames,
  frozenArtifactOperation,
  previous = null
) {
  const now = new Date().toISOString();
  const normalizedFrozen = frozenArtifactOperation
    ? project100MvpNormalizeFrozenArtifactOperation(frozenArtifactOperation)
    : null;
  return {
    version: PROJECT100_MVP_ESTABLISHMENT_SCHEMA_VERSION,
    state,
    projectId: String(projectId || ""),
    initialFilenames: (Array.isArray(initialFilenames) ? initialFilenames : []).slice(),
    // This is the existing PC-1A continuation identity, never document bytes.
    frozenArtifactOperation: normalizedFrozen ||
      (previous && previous.frozenArtifactOperation) || null,
    createdAt: previous && previous.createdAt
      ? String(previous.createdAt)
      : now,
    updatedAt: now,
    establishedAt: state === "ESTABLISHED"
      ? now
      : (previous && previous.establishedAt ? String(previous.establishedAt) : "")
  };
}

// An INITIALIZING record is the only durable authority for continuing an
// unfinished first Publish. It pins the original exact filename set and the
// PC-1A operation identity; the current page may not expand either one.
function project100MvpValidateInitializingBinding(binding) {
  const record = project100MvpEstablishmentRecord(binding);
  if (!record || record.version !== PROJECT100_MVP_ESTABLISHMENT_SCHEMA_VERSION ||
      record.state !== "INITIALIZING" ||
      !project100MvpUniqueExactFilenames(record.initialFilenames)) {
    throw new Error("SOURCE_NOT_ESTABLISHED");
  }
  if (!record.frozenArtifactOperation) {
    // The lifecycle is known, but the PC-1A continuation identity is not.
    // Preserve the existing target-loss STOP instead of rediscovering names.
    throw new Error("ARTIFACT_TARGET_LOST");
  }
  const frozen = project100MvpNormalizeFrozenArtifactOperation(record.frozenArtifactOperation);
  const frozenFilenames = frozen.targets.map((target) => target.exactFilename);
  if (!project100MvpSameFilenameSet(record.initialFilenames, frozenFilenames)) {
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  if (!binding || !Array.isArray(binding.sources) ||
      !project100MvpSameFilenameSet(
        record.initialFilenames,
        binding.sources.map((entry) => entry && entry.filename)
      )) {
    // An unfinished initialization may have unbound entries, but its durable
    // binding set must still be exactly the original frozen set. A stale extra
    // Source must never be carried into establishment or a retry.
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  const projectId = String(binding && binding.projectId || record.projectId || "");
  if (!projectId || (record.projectId && String(record.projectId) !== projectId)) {
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  if (binding && binding.sourcePageUrl) {
    if (!project100MvpProjectIdentityMatchesSourcePage(
      projectId, binding.sourcePageUrl)) {
      throw new Error("ESTABLISHMENT_CONFLICT");
    }
  }
  return {
    record,
    frozen,
    projectId,
    filenames: record.initialFilenames.slice()
  };
}

// Established is proven only by this explicit durable state plus a
// self-consistent exact binding set. No binding/allBound/sourceBound shortcut
// can reach Refresh.
function project100MvpValidateEstablishedBinding(binding) {
  const record = project100MvpEstablishmentRecord(binding);
  if (!record || record.version !== PROJECT100_MVP_ESTABLISHMENT_SCHEMA_VERSION ||
      record.state !== "ESTABLISHED") {
    throw new Error("SOURCE_NOT_ESTABLISHED");
  }
  if (!binding || binding.version !== 2 || !binding.sourcePageUrl ||
      !project100MvpUniqueExactFilenames(record.initialFilenames)) {
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  const projectId = String(binding.projectId || "");
  if (!projectId || !project100MvpProjectIdentityMatchesSourcePage(
      projectId, binding.sourcePageUrl) ||
      String(record.projectId || "") !== projectId) {
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  if (!Array.isArray(binding.sources) || binding.sources.length === 0 ||
      !project100MvpSameFilenameSet(
        record.initialFilenames,
        binding.sources.map((entry) => entry && entry.filename)
      )) {
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  const filenames = new Set();
  const driveIds = new Set();
  for (const entry of binding.sources) {
    if (!entry || typeof entry.filename !== "string" ||
        !project100MvpUniqueExactFilenames([entry.filename]) ||
        filenames.has(entry.filename) || entry.sourceBound !== true) {
      throw new Error("ESTABLISHMENT_CONFLICT");
    }
    const normalizedFilename = project100MvpNormalizeLogicalFilename(entry.filename);
    if (normalizedFilename !== entry.filename) {
      throw new Error("ESTABLISHMENT_CONFLICT");
    }
    const driveFileId = project100MvpNormalizeDriveFileId(entry.driveFileId);
    if (driveIds.has(driveFileId)) {
      throw new Error("ESTABLISHMENT_CONFLICT");
    }
    const completionIdentity = entry.completionIdentity;
    if (!completionIdentity ||
        String(completionIdentity.projectId || "") !== projectId ||
        String(completionIdentity.connectorType || "") !==
          PROJECT100_MVP_SOURCE_CONNECTOR_TYPE ||
        String(completionIdentity.canonicalHandle || "") !== driveFileId ||
        !String(completionIdentity.scopeId || "")) {
      throw new Error("ESTABLISHMENT_CONFLICT");
    }
    filenames.add(entry.filename);
    driveIds.add(driveFileId);
  }
  return {
    record,
    projectId,
    filenames: record.initialFilenames.slice()
  };
}

function project100MvpAssertInitialFrozenOperation(record, frozen) {
  if (!record || !frozen ||
      !project100MvpSameFilenameSet(
        record.initialFilenames,
        frozen.targets.map((target) => target.exactFilename)
      )) {
    throw new Error("ARTIFACT_SET_CHANGED");
  }
}

async function project100MvpConnectDrive() {
  const auth = await project100MvpGetAuthToken(true);
  return {
    status: "PASS",
    connected: true,
    scope: PROJECT100_MVP_DRIVE_SCOPE,
    grantedScopes: auth.grantedScopes
  };
}

// ---- Single-source v1: canonical Drive identity ----------------------------
// The canonical filename stays an implementation detail that must never
// reach the user-facing UI. Every file this extension creates carries an
// app-private marker so a reinstall (empty local storage) can recover the
// existing Drive object instead of creating a duplicate.
const PROJECT100_CANONICAL_FILENAME = "project-source.md";
const PROJECT100_CANONICAL_MARKER_KEY = "projectSourcePublisherCanonical";
const PROJECT100_CANONICAL_MARKER_VALUE = "v1";

function project100MvpCanonicalCreateMetadata(filename) {
  return {
    name: filename,
    mimeType: "text/markdown",
    appProperties: {
      [PROJECT100_CANONICAL_MARKER_KEY]: PROJECT100_CANONICAL_MARKER_VALUE
    }
  };
}

async function project100MvpCreateCanonicalFile(filename) {
  const boundary = `project100_${crypto.randomUUID().replace(/-/g, "")}`;
  const metadata = JSON.stringify(project100MvpCanonicalCreateMetadata(filename));
  const initialText = "# Canonical Project Source\n\n";
  const body = new Blob([
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    metadata,
    `\r\n--${boundary}\r\n`,
    "Content-Type: text/markdown; charset=UTF-8\r\n\r\n",
    initialText,
    `\r\n--${boundary}--\r\n`
  ], {
    type: `multipart/related; boundary=${boundary}`
  });

  const response = await project100MvpFetchWithToken(
    `${PROJECT100_MVP_DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body
    },
    // OAuth-once (§20): the batch already requested interactive consent
    // exactly once; every later Drive call reuses the cached token
    // non-interactively and must never re-prompt.
    false
  );
  const file = await project100MvpParseJsonResponse(response, "DRIVE_CREATE_FAILED");
  const fileId = project100MvpNormalizeDriveFileId(file.id);
  if (file.name !== filename) {
    throw new Error("DRIVE_CREATE_FILENAME_MISMATCH");
  }
  return {
    id: fileId,
    name: filename,
    mimeType: file.mimeType || "text/markdown",
    modifiedTime: file.modifiedTime || "",
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${fileId}/view`
  };
}

async function project100MvpWriteCanonicalBinding(driveFileId, driveUrl, previousBinding) {
  const binding = {
    version: 1,
    filename: PROJECT100_CANONICAL_FILENAME,
    driveFileId,
    driveUrl,
    sourcePageUrl: previousBinding && previousBinding.sourcePageUrl
      ? previousBinding.sourcePageUrl
      : "",
    createdAt: previousBinding && previousBinding.createdAt
      ? previousBinding.createdAt
      : new Date().toISOString(),
    sourceBoundAt: previousBinding && previousBinding.sourceBoundAt
      ? previousBinding.sourceBoundAt
      : ""
  };
  await project100MvpWriteBinding(binding);
  return binding;
}

// Search Drive within the drive.file app-visible scope. The query is built
// from fixed literals only (never user input).
async function project100MvpSearchCanonicalFiles(tagged) {
  const q = tagged
    ? `name = '${PROJECT100_CANONICAL_FILENAME}' and mimeType = 'text/markdown' and trashed = false and appProperties has { key='${PROJECT100_CANONICAL_MARKER_KEY}' and value='${PROJECT100_CANONICAL_MARKER_VALUE}' }`
    : `name = '${PROJECT100_CANONICAL_FILENAME}' and mimeType = 'text/markdown' and trashed = false`;
  const response = await project100MvpFetchWithToken(
    `${PROJECT100_MVP_DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink)&spaces=drive&pageSize=50`,
    {
      method: "GET",
      cache: "no-store"
    },
    false
  );
  const body = await project100MvpParseJsonResponse(
    response,
    tagged ? "DRIVE_TAGGED_SEARCH_FAILED" : "DRIVE_LEGACY_SEARCH_FAILED");
  const files = Array.isArray(body.files) ? body.files : [];
  return files.filter((file) => file &&
    typeof file.id === "string" &&
    /^[A-Za-z0-9_-]{10,200}$/.test(file.id) &&
    file.name === PROJECT100_CANONICAL_FILENAME &&
    file.mimeType === "text/markdown");
}

// Narrow best-effort upgrade for a legacy (v0.3.1) recovered file: add the
// app-private marker so future recoveries hit the tagged search. Failure is
// never fatal — the legacy search remains a permanent fallback.
async function project100MvpAddCanonicalMarker(fileId) {
  try {
    const response = await project100MvpFetchWithToken(
      `${PROJECT100_MVP_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=appProperties`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          appProperties: {
            [PROJECT100_CANONICAL_MARKER_KEY]: PROJECT100_CANONICAL_MARKER_VALUE
          }
        })
      },
      false
    );
    return response.ok;
  } catch (_error) {
    return false;
  }
}

// Reinstall-safe canonical identity, conceptually `ensureCanonicalSource()`:
//   1. valid local binding -> reuse, never create;
//   2. exactly one tagged app-private file -> recover it;
//   3. exactly one legacy v0.3.1 file (exact name + exact MIME, not trashed)
//      -> recover it and best-effort tag it;
//   4. more than one candidate at any step -> FAIL CLOSED, never auto-pick,
//      never create another;
//   5. zero candidates -> create exactly one new tagged canonical file.
async function project100MvpEnsureCanonicalSource() {
  const existing = await project100MvpReadBinding();
  if (existing && existing.driveFileId) {
    return {
      reused: true,
      created: false,
      driveFileId: existing.driveFileId,
      driveUrl: existing.driveUrl || "",
      binding: existing
    };
  }

  const tagged = await project100MvpSearchCanonicalFiles(true);
  if (tagged.length > 1) {
    throw new Error("CANONICAL_RECOVERY_AMBIGUOUS");
  }
  if (tagged.length === 1) {
    const file = tagged[0];
    const binding = await project100MvpWriteCanonicalBinding(
      file.id,
      file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      existing);
    return { reused: false, created: false, driveFileId: file.id, driveUrl: binding.driveUrl, binding };
  }

  const legacy = await project100MvpSearchCanonicalFiles(false);
  if (legacy.length > 1) {
    throw new Error("CANONICAL_RECOVERY_AMBIGUOUS");
  }
  if (legacy.length === 1) {
    const file = legacy[0];
    await project100MvpAddCanonicalMarker(file.id);
    const binding = await project100MvpWriteCanonicalBinding(
      file.id,
      file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      existing);
    return { reused: false, created: false, driveFileId: file.id, driveUrl: binding.driveUrl, binding };
  }

  const created = await project100MvpCreateCanonicalFile(PROJECT100_CANONICAL_FILENAME);
  const binding = await project100MvpWriteCanonicalBinding(
    created.id, created.webViewLink, existing);
  return { reused: false, created: true, driveFileId: created.id, driveUrl: binding.driveUrl, binding };
}

// ---- Multi-source v1: per-filename Drive identity --------------------------
// Each logical Source gets its own Drive file, named with the REAL logical
// filename (never a forced project-source.md), carrying an app-private V2
// marker plus the current Project identity. Same logical filename is forever
// PATCHed into the SAME Drive file ID (never delete + recreate).
function project100MvpEscapeDriveQueryLiteral(value) {
  return String(value).replace(/'/g, "\\'");
}

function project100MvpSourceCreateMetadataV2(filename, projectId, driveFileId) {
  const metadata = {
    name: filename,
    mimeType: "text/markdown",
    appProperties: {
      [PROJECT100_MVP_SOURCE_MARKER_KEY]: PROJECT100_MVP_SOURCE_MARKER_VALUE,
      [PROJECT100_MVP_SOURCE_PROJECT_KEY]: String(projectId || "")
    }
  };
  if (driveFileId) {
    metadata.id = project100MvpNormalizeDriveFileId(driveFileId);
  }
  return metadata;
}

async function project100MvpGenerateSourceDriveFileId() {
  const response = await project100MvpFetchWithToken(
    `${PROJECT100_MVP_DRIVE_API}/files/generateIds?count=1&space=drive&fields=ids`,
    { method: "GET", cache: "no-store" },
    false
  );
  const body = await project100MvpParseJsonResponse(response, "DRIVE_ID_GENERATE_FAILED");
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length !== 1) {
    throw new Error("DRIVE_ID_GENERATE_UNAVAILABLE");
  }
  return project100MvpNormalizeDriveFileId(ids[0]);
}

async function project100MvpCreateSourceFile(filename, projectId, bytesInput, reservedDriveFileId) {
  const reservedId = project100MvpNormalizeDriveFileId(reservedDriveFileId);
  const boundary = `project100_${crypto.randomUUID().replace(/-/g, "")}`;
  const metadata = JSON.stringify(
    project100MvpSourceCreateMetadataV2(filename, projectId, reservedId));
  const initialBytes = project100MvpNormalizeSourceBytes(bytesInput);
  const body = new Blob([
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    metadata,
    `\r\n--${boundary}\r\n`,
    "Content-Type: text/markdown; charset=UTF-8\r\n\r\n",
    initialBytes,
    `\r\n--${boundary}--\r\n`
  ], {
    type: `multipart/related; boundary=${boundary}`
  });

  const response = await project100MvpFetchWithToken(
    `${PROJECT100_MVP_DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body
    },
    // OAuth-once (§20): the batch already requested interactive consent
    // exactly once; every later Drive call reuses the cached token
    // non-interactively and must never re-prompt.
    false
  );
  const file = await project100MvpParseJsonResponse(response, "DRIVE_CREATE_FAILED");
  const fileId = project100MvpNormalizeDriveFileId(file.id);
  if (fileId !== reservedId) {
    throw new Error("DRIVE_ID_MISMATCH");
  }
  if (file.name !== filename) {
    throw new Error("DRIVE_CREATE_FILENAME_MISMATCH");
  }
  return {
    id: fileId,
    name: filename,
    mimeType: file.mimeType || "text/markdown",
    modifiedTime: file.modifiedTime || "",
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${fileId}/view`
  };
}

// Search V2-tagged app-visible files by the FROZEN V2 recovery identity:
// exact projectId + exact logical filename + v2 marker. Fixed-literal query
// parts only; filename and projectId are escaped for the query string. The
// returned files are ALSO validated client-side — the server-side clause is
// never trusted alone. Without a projectId nothing is recoverable (fail
// closed): a cross-Project same-name file must never be adopted.
async function project100MvpSearchSourceFiles(filename, projectId) {
  const wantedProjectId = String(projectId || "");
  if (!wantedProjectId) {
    throw new Error("SOURCE_PROJECT_ID_MISSING");
  }
  const safeName = project100MvpEscapeDriveQueryLiteral(filename);
  const safeProjectId = project100MvpEscapeDriveQueryLiteral(wantedProjectId);
  const q = `name = '${safeName}' and mimeType = 'text/markdown' and trashed = false and appProperties has { key='${PROJECT100_MVP_SOURCE_MARKER_KEY}' and value='${PROJECT100_MVP_SOURCE_MARKER_VALUE}' } and appProperties has { key='${PROJECT100_MVP_SOURCE_PROJECT_KEY}' and value='${safeProjectId}' }`;
  const response = await project100MvpFetchWithToken(
    `${PROJECT100_MVP_DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,appProperties)&spaces=drive&pageSize=50`,
    {
      method: "GET",
      cache: "no-store"
    },
    false
  );
  const body = await project100MvpParseJsonResponse(response, "DRIVE_SOURCE_SEARCH_FAILED");
  const files = Array.isArray(body.files) ? body.files : [];
  return files.filter((file) => file &&
    typeof file.id === "string" &&
    /^[A-Za-z0-9_-]{10,200}$/.test(file.id) &&
    file.name === filename &&
    file.mimeType === "text/markdown" &&
    String((file.appProperties || {})[PROJECT100_MVP_SOURCE_PROJECT_KEY] || "") ===
      wantedProjectId);
}

async function project100MvpReadSourceCreateIntent(projectId = "") {
  // `projectId` is part of the identity check, but storage routing follows
  // the explicit RC-2 operation context. Older direct worker fixtures pass a
  // projectId for Drive identity while still exercising the legacy key.
  const storageProjectId = project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  return project100MvpReadProjectState(
    PROJECT100_MVP_SOURCE_CREATE_INTENT_KEY,
    storageProjectId);
}

// There is one durable create-in-flight slot. Before a new Publish job is
// started, require any unresolved intent to belong to the exact current
// Project and to one of the currently discovered logical Sources. Otherwise
// BeginRecoveryJob would overwrite the old job before the per-file preflight
// had a chance to reject it, losing the identity needed to reconcile an
// accepted-but-unbound Drive create. This check is read-only and deliberately
// fail-closed; the user must return to the original Project/chat and retry
// that exact Source first.
async function project100MvpAssertSourceCreateIntentIdentity(filenames, projectId) {
  const intent = await project100MvpReadSourceCreateIntent(projectId);
  if (!intent) {
    return null;
  }
  const requestedProjectId = String(projectId || "");
  const requestedFilenames = Array.isArray(filenames)
    ? filenames.map((filename) => String(filename || ""))
    : [];
  const intentFilename = String(intent.filename || "");
  const intentProjectId = String(intent.projectId || "");
  if (!requestedProjectId || !intentFilename || !intentProjectId ||
      intentProjectId !== requestedProjectId ||
      !requestedFilenames.includes(intentFilename)) {
    throw new Error("RECOVERY_IDENTITY_MISMATCH");
  }
  return intent;
}

async function project100MvpWriteSourceCreateIntent(filename, projectId, identity = {}) {
  const requestedFilename = String(filename || "");
  const requestedProjectId = String(projectId || "");
  const existing = await project100MvpReadSourceCreateIntent(requestedProjectId);
  const requestedDriveFileId = identity.reservedDriveFileId
    ? project100MvpNormalizeDriveFileId(identity.reservedDriveFileId)
    : "";
  const identityFields = {
    reservedDriveFileId: requestedDriveFileId,
    operationToken: String(identity.operationToken || ""),
    documentInstanceId: String(identity.documentInstanceId || ""),
    frozenScopeToken: String(identity.frozenScopeToken || ""),
    frozenTargetToken: String(identity.frozenTargetToken || ""),
    exactFilename: String(identity.exactFilename || requestedFilename),
    contentPinSha256: String(identity.contentPinSha256 || "")
  };
  if (existing && (String(existing.filename || "") !== requestedFilename ||
      String(existing.projectId || "") !== requestedProjectId ||
      (requestedDriveFileId && String(existing.reservedDriveFileId || "") !== requestedDriveFileId) ||
      (identityFields.operationToken && String(existing.operationToken || "") !== identityFields.operationToken) ||
      (identityFields.documentInstanceId && String(existing.documentInstanceId || "") !== identityFields.documentInstanceId) ||
      (identityFields.frozenScopeToken && String(existing.frozenScopeToken || "") !== identityFields.frozenScopeToken) ||
      (identityFields.frozenTargetToken && String(existing.frozenTargetToken || "") !== identityFields.frozenTargetToken) ||
      (identityFields.contentPinSha256 && String(existing.contentPinSha256 || "") !== identityFields.contentPinSha256))) {
    // There is only one durable create-in-flight slot. Never replace an
    // unresolved request for another filename or Project; doing so would make
    // the original Drive response impossible to reconcile and could permit a
    // later retry to create a duplicate.
    throw new Error("RECOVERY_IDENTITY_MISMATCH");
  }
  if (existing) {
    // Preserve the intentId and original timestamps while the same identity
    // remains unresolved. A retry must keep referring to the same create.
    return existing;
  }
  const now = new Date().toISOString();
  const intent = {
    version: PROJECT100_MVP_SOURCE_CREATE_INTENT_VERSION,
    intentId: project100MvpRecoveryId("source-create"),
    workerInstanceId: PROJECT100_MVP_WORKER_INSTANCE_ID,
    filename: requestedFilename,
    projectId: requestedProjectId,
    ...identityFields,
    phase: "create-in-flight",
    createdAt: now,
    updatedAt: now
  };
  await project100MvpWriteProjectState(
    PROJECT100_MVP_SOURCE_CREATE_INTENT_KEY, intent,
    project100MvpNormalizeProjectId(project100MvpActiveProjectId));
  return intent;
}

async function project100MvpClearSourceCreateIntentIfMatches(filename, projectId) {
  const requestedProjectId = String(projectId || "");
  const intent = await project100MvpReadSourceCreateIntent(requestedProjectId);
  if (!intent) {
    return false;
  }
  if (String(intent.filename || "") !== String(filename || "") ||
      String(intent.projectId || "") !== String(projectId || "")) {
    throw new Error("RECOVERY_IDENTITY_MISMATCH");
  }
  await project100MvpRemoveProjectState(
    PROJECT100_MVP_SOURCE_CREATE_INTENT_KEY,
    project100MvpNormalizeProjectId(project100MvpActiveProjectId));
  return true;
}

async function project100MvpPendingSourceCreateCandidate(filename, projectId) {
  const intent = await project100MvpReadSourceCreateIntent(projectId);
  if (!intent) {
    return null;
  }
  if (String(intent.filename || "") !== String(filename || "") ||
      String(intent.projectId || "") !== String(projectId || "")) {
    throw new Error("RECOVERY_IDENTITY_MISMATCH");
  }
  const reservedId = String(intent.reservedDriveFileId || "");
  if (!reservedId) {
    throw new Error("SOURCE_CREATE_OUTCOME_UNKNOWN");
  }
  // A create response or the following binding write may have been lost when
  // the worker stopped. Search the exact project/name identity before any new
  // create. Zero candidates is deliberately fail-closed: the Drive request
  // may have succeeded but not been indexed yet.
  const candidates = await project100MvpSearchSourceFiles(filename, projectId);
  const matching = candidates.filter((candidate) => candidate && candidate.id === reservedId);
  const conflicting = candidates.filter((candidate) => candidate && candidate.id !== reservedId);
  if (conflicting.length > 0) {
    throw new Error("DRIVE_ID_MISMATCH");
  }
  if (matching.length > 1) {
    throw new Error("SOURCE_RECOVERY_AMBIGUOUS");
  }
  if (matching.length === 0) {
    throw new Error("SOURCE_CREATE_OUTCOME_UNKNOWN");
  }
  return matching[0];
}

// Legacy v0.3.1 guard: a logical source literally named project-source.md
// must never silently collide with (or impersonate) the old single-source
// canonical file. If such a legacy file exists, the identity is ambiguous ->
// FAIL CLOSED for that filename. No rename, no guess, no picker.
async function project100MvpLegacyCanonicalCollision(filename) {
  if (filename !== PROJECT100_CANONICAL_FILENAME) {
    return false;
  }
  const legacy = await project100MvpSearchCanonicalFiles(false);
  return legacy.length > 0;
}

// Reinstall-safe per-filename identity, conceptually ensureSourceFile():
//   1. a local V2 binding entry with a Drive file ID -> reuse, never create;
//   2. exactly one V2-tagged Drive file with this exact name -> recover it;
//   3. more than one candidate -> FAIL CLOSED (SOURCE_RECOVERY_AMBIGUOUS);
//   4. a legacy v0.3.1 canonical collision for project-source.md -> FAIL
//      CLOSED (LEGACY_SOURCE_AMBIGUOUS);
//   5. zero candidates -> create exactly one, named with the real filename.
// Every create/recover persists the V2 binding entry IMMEDIATELY, so an
// interrupted batch can never manufacture duplicates on retry.
async function project100MvpEnsureSourceFile(
  filename, projectId, contentBytes, reservedDriveFileId = "", createIdentity = {}) {
  const binding = await project100MvpReadBindingV2(project100MvpActiveProjectId);
  const sources = binding && Array.isArray(binding.sources) ? binding.sources : [];
  const existingEntry = sources.find((entry) => entry.filename === filename);
  if (existingEntry && existingEntry.driveFileId) {
    await project100MvpClearSourceCreateIntentIfMatches(filename, projectId);
    return {
      reused: true,
      created: false,
      driveFileId: existingEntry.driveFileId,
      driveUrl: existingEntry.driveUrl || ""
    };
  }
  if (await project100MvpLegacyCanonicalCollision(filename)) {
    throw new Error("LEGACY_SOURCE_AMBIGUOUS");
  }
  const pendingIntent = await project100MvpReadSourceCreateIntent();
  const pendingCandidate = await project100MvpPendingSourceCreateCandidate(filename, projectId);
  const tagged = pendingCandidate
    ? [pendingCandidate]
    : await project100MvpSearchSourceFiles(filename, projectId);
  if (tagged.length > 1) {
    throw new Error("SOURCE_RECOVERY_AMBIGUOUS");
  }
  const now = new Date().toISOString();
  let fileRecord = null;
  if (tagged.length === 1) {
    const file = tagged[0];
    fileRecord = {
      reused: false,
      created: false,
      driveFileId: file.id,
      driveUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
    };
  } else {
    const reservedId = project100MvpNormalizeDriveFileId(
      reservedDriveFileId || (pendingIntent && pendingIntent.reservedDriveFileId) ||
        await project100MvpGenerateSourceDriveFileId());
    // Persist the generated ID and the full create identity BEFORE the request.
    // A restart must either reuse this exact ID or stop; it may not recover by
    // searching for a different same-name object.
    const identity = {
      ...createIdentity,
      reservedDriveFileId: reservedId
    };
    await project100MvpUpdateRecoverySource(filename, {
      reservedDriveFileId: reservedId
    });
    await project100MvpWriteSourceCreateIntent(filename, projectId, identity);
    const created = await project100MvpCreateSourceFile(
      filename, projectId, contentBytes, reservedId);
    if (created.id !== reservedId) {
      throw new Error("DRIVE_ID_MISMATCH");
    }
    fileRecord = {
      reused: false,
      created: true,
      driveFileId: created.id,
      driveUrl: created.webViewLink
    };
  }
  // Immediate persistence: update (or append) the V2 binding entry NOW.
  const current = await project100MvpReadBindingV2(project100MvpActiveProjectId);
  const base = current || {
    version: 2,
    projectId: String(projectId || ""),
    sourcePageUrl: "",
    sources: [],
    createdAt: now,
    updatedAt: now
  };
  const entry = (base.sources || []).find((item) => item.filename === filename);
  if (entry) {
    entry.driveFileId = fileRecord.driveFileId;
    entry.driveUrl = fileRecord.driveUrl;
  } else {
    base.sources = [...(base.sources || []), {
      filename,
      driveFileId: fileRecord.driveFileId,
      driveUrl: fileRecord.driveUrl,
      sourceBound: false,
      createdAt: now,
      sourceBoundAt: ""
    }];
  }
  base.projectId = base.projectId || String(projectId || "");
  base.updatedAt = new Date().toISOString();
  await project100MvpWriteBindingV2(base, project100MvpActiveProjectId);
  await project100MvpClearSourceCreateIntentIfMatches(filename, projectId);
  return fileRecord;
}

// Batch-atomic fail-closed preflight: EVERY not-locally-bound filename must
// have an unambiguous recovery story BEFORE the first Drive create. One
// ambiguous filename blocks the whole batch — no partial publish, no partial
// onboarding queue, no duplicate-prone half-state (taskbook §9 / §21).
// Recovery identity is scoped to the CURRENT Project: candidates belonging to
// another Project (different projectSourcePublisherProjectId) are invisible
// here and can never cause or mask an ambiguity.
async function project100MvpPreflightSourceRecovery(filenames, projectId) {
  const binding = await project100MvpReadBindingV2(project100MvpActiveProjectId);
  const sources = binding && Array.isArray(binding.sources) ? binding.sources : [];
  for (const filename of filenames) {
    const existingEntry = sources.find((entry) => entry.filename === filename);
    if (existingEntry && existingEntry.driveFileId) {
      continue; // locally bound: identity already pinned, no Drive probe needed
    }
    if (await project100MvpLegacyCanonicalCollision(filename)) {
      throw new Error("LEGACY_SOURCE_AMBIGUOUS");
    }
    const pendingCandidate = await project100MvpPendingSourceCreateCandidate(filename, projectId);
    const tagged = pendingCandidate
      ? [pendingCandidate]
      : await project100MvpSearchSourceFiles(filename, projectId);
    if (tagged.length > 1) {
      throw new Error("SOURCE_RECOVERY_AMBIGUOUS");
    }
  }
}

// Legacy direct-create entry (guarded): kept for message compatibility.
// The guard is the duplicate-create fail-closed contract of slice 1: an
// existing binding must fail closed before any Drive create request.
async function project100MvpCreateCanonicalSource(filenameInput) {
  const filename = project100MvpNormalizeFilename(filenameInput);
  const existingBinding = await project100MvpReadBinding();
  if (existingBinding) {
    throw new Error("CANONICAL_SOURCE_ALREADY_EXISTS");
  }
  const created = await project100MvpCreateCanonicalFile(filename);
  const binding = await project100MvpWriteCanonicalBinding(created.id, created.webViewLink, null);
  return {
    status: "PASS",
    file: {
      id: created.id,
      name: created.name,
      mimeType: created.mimeType,
      modifiedTime: created.modifiedTime,
      webViewLink: created.webViewLink
    },
    binding
  };
}

// Multi-source v1: bind an exact logical Source (filename + Drive file ID)
// to the bound Project. The identity must already exist in the V2 binding
// with the same Drive file ID; only the ChatGPT Source binding state flips.
async function project100MvpSetSourceBinding(message) {
  const sourcePageUrl = project100MvpNormalizeSourcePageUrl(message.sourcePageUrl);
  const sourceProjectId = project100MvpProjectSegmentOf(sourcePageUrl);
  const requestedProjectId = project100MvpNormalizeProjectId(message.projectId) ||
    sourceProjectId;
  if (!requestedProjectId || (sourceProjectId && requestedProjectId !== sourceProjectId)) {
    throw new Error("PROJECT_CONTEXT_MISMATCH");
  }
  const binding = await project100MvpReadBindingV2(requestedProjectId);
  if (!binding || !Array.isArray(binding.sources)) {
    throw new Error("CANONICAL_FILE_NOT_CREATED");
  }
  const driveFileId = project100MvpNormalizeDriveFileId(message.driveFileId);
  const filename = project100MvpNormalizeLogicalFilename(message.filename);
  const entry = binding.sources.find((item) => item.filename === filename);
  if (!entry || entry.driveFileId !== driveFileId) {
    throw new Error("SOURCE_BINDING_DOES_NOT_MATCH_DRIVE_FILE");
  }
  entry.sourceBound = true;
  entry.sourceBoundAt = new Date().toISOString();
  binding.sourcePageUrl = sourcePageUrl;
  binding.updatedAt = new Date().toISOString();
  await project100MvpWriteBindingV2(binding, requestedProjectId);
  return {
    status: "PASS",
    binding
  };
}

function project100MvpAttachDriveMutationEvidence(error, acceptedAt) {
  const target = error instanceof Error
    ? error
    : new Error(String(error || "DRIVE_UPDATE_VERIFICATION_FAILED"));
  target.driveMutationAccepted = true;
  target.driveMutationAt = String(acceptedAt || new Date().toISOString());
  return target;
}

function project100MvpErrorHasDriveMutationEvidence(error) {
  return Boolean(error && error.driveMutationAccepted === true);
}

async function project100MvpAssertSourceDriveIdentity(filename, fileId, projectId) {
  const response = await project100MvpFetchWithToken(
    `${PROJECT100_MVP_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,trashed,appProperties`,
    {
      method: "GET",
      cache: "no-store"
    },
    false
  );
  const metadata = await project100MvpParseJsonResponse(
    response, "DRIVE_UPDATE_IDENTITY_READ_FAILED");
  if (metadata.id !== fileId) {
    throw new Error("DRIVE_UPDATE_FILE_ID_MISMATCH");
  }
  if (metadata.name !== filename) {
    throw new Error("DRIVE_UPDATE_FILENAME_MISMATCH");
  }
  if (metadata.trashed !== false) {
    throw new Error("DRIVE_UPDATE_FILE_TRASHED");
  }
  if (metadata.mimeType !== "text/markdown") {
    throw new Error("DRIVE_UPDATE_MIME_TYPE_MISMATCH");
  }
  const appProperties = metadata.appProperties && typeof metadata.appProperties === "object"
    ? metadata.appProperties
    : null;
  if (!appProperties || appProperties[PROJECT100_MVP_SOURCE_MARKER_KEY] !==
      PROJECT100_MVP_SOURCE_MARKER_VALUE) {
    throw new Error("DRIVE_UPDATE_SOURCE_MARKER_MISMATCH");
  }
  if (projectId && String(appProperties[PROJECT100_MVP_SOURCE_PROJECT_KEY] || "") !==
      String(projectId)) {
    throw new Error("DRIVE_UPDATE_PROJECT_MISMATCH");
  }
  return {
    sameFileId: true,
    sameFilename: true,
    notTrashed: true,
    markdown: true,
    sourceMarker: true,
    projectMarker: !projectId || String(appProperties[PROJECT100_MVP_SOURCE_PROJECT_KEY] || "") ===
      String(projectId)
  };
}

// Multi-source v1: per-Source same-file PATCH + exact readback. The frozen
// contract stays per Source: same Drive file ID, media PATCH, exact readback
// bytes, sha256 match — never delete + recreate, never a new object.
// `entry` = { filename, driveFileId, projectId } from the V2 binding. The
// legacy single-entry message form (bytes only) keeps working against the V2
// binding's matching entry.
async function project100MvpUpdateSourceEntry(entryInput, bytesInput) {
  const filename = project100MvpNormalizeFilename(entryInput.filename);
  const fileId = project100MvpNormalizeDriveFileId(entryInput.driveFileId);
  const projectId = String(entryInput.projectId || "");
  const rawBytes = bytesInput;
  if (!Array.isArray(rawBytes) || rawBytes.length === 0 || rawBytes.length > PROJECT100_MVP_MAX_SOURCE_BYTES) {
    throw new Error("INVALID_SOURCE_BYTES");
  }
  const bytes = Uint8Array.from(rawBytes);
  const preWriteIdentity = await project100MvpAssertSourceDriveIdentity(
    filename, fileId, projectId);
  const beforeHash = await project100MvpSha256Hex(bytes);

  const updateResponse = await project100MvpFetchWithToken(
    `${PROJECT100_MVP_DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType,modifiedTime,size`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "text/markdown; charset=UTF-8"
      },
      body: bytes
    },
    false
  );
  // Drive has accepted the media PATCH once the successful response arrives.
  // Any later validation/readback failure must carry this fact to recovery.
  if (!updateResponse.ok) {
    await project100MvpParseJsonResponse(updateResponse, "DRIVE_UPDATE_FAILED");
  }
  const driveMutationAt = new Date().toISOString();
  try {
    const updated = await project100MvpParseJsonResponse(updateResponse, "DRIVE_UPDATE_FAILED");
    if (updated.id !== fileId) {
      throw new Error("DRIVE_UPDATE_FILE_ID_MISMATCH");
    }
    if (updated.name !== filename) {
      throw new Error("DRIVE_UPDATE_FILENAME_MISMATCH");
    }
    if (updated.mimeType !== "text/markdown") {
      throw new Error("DRIVE_UPDATE_MIME_TYPE_MISMATCH");
    }

    const readbackResponse = await project100MvpFetchWithToken(
      `${PROJECT100_MVP_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        method: "GET",
        cache: "no-store"
      },
      false
    );
    if (!readbackResponse.ok) {
      throw new Error(`DRIVE_READBACK_FAILED:HTTP_${readbackResponse.status}`);
    }
    const readback = new Uint8Array(await readbackResponse.arrayBuffer());
    const afterHash = await project100MvpSha256Hex(readback);
    if (readback.byteLength !== bytes.byteLength || afterHash !== beforeHash) {
      throw new Error("DRIVE_READBACK_CONTENT_MISMATCH");
    }

    return {
      status: "PASS",
      driveFileId: fileId,
      filename,
      byteLength: bytes.byteLength,
      sha256: beforeHash,
      modifiedTime: updated.modifiedTime || "",
      sameFileId: true,
      sameFilename: true,
      exactReadback: true,
      preWriteIdentity,
      driveMutationAccepted: true,
      driveMutationAt,
      // Diagnostics only (taskbook §5F): canary fields parsed from the exact
      // Drive readback bytes. Never any other document content.
      readbackCanaryFields: project100MvpExtractCanaryFields(readback)
    };
  } catch (error) {
    throw project100MvpAttachDriveMutationEvidence(error, driveMutationAt);
  }
}

async function project100MvpUpdateCanonicalSource(message) {
  const requestedProjectId = project100MvpNormalizeProjectId(message && message.projectId);
  const bindingV2 = await project100MvpReadBindingV2(requestedProjectId);
  if (!bindingV2 || !bindingV2.sourcePageUrl ||
      !Array.isArray(bindingV2.sources) || bindingV2.sources.length === 0) {
    throw new Error("SOURCE_NOT_BOUND");
  }
  let entry = null;
  if (message && message.filename) {
    entry = bindingV2.sources.find((item) => item.filename === message.filename) || null;
  } else if (bindingV2.sources.length === 1) {
    entry = bindingV2.sources[0];
  }
  if (!entry) {
    throw new Error("SOURCE_NOT_BOUND");
  }
  return project100MvpUpdateSourceEntry(
    {
      filename: entry.filename,
      driveFileId: entry.driveFileId,
      projectId: bindingV2.projectId
    },
    message ? message.bytes : null);
}

function project100MvpSafeError(error) {
  const message = error && typeof error.message === "string"
    ? error.message
    : "UNEXPECTED_DRIVE_ERROR";
  return message.slice(0, 240);
}

const PROJECT100_MVP_PUBLISH_STATE_KEY = "project100MvpPublishState";
const PROJECT100_MVP_CONTENT_READY_TIMEOUT_MS = 15000;
const PROJECT100_MVP_CAPTURE_RESPONSE_TIMEOUT_MS = 45000;
const PROJECT100_MVP_RESYNC_RESPONSE_TIMEOUT_MS = 60000;
// Capture-tab self-heal: a ChatGPT page loaded before extension
// install/reload has no content script, and waiting alone never repairs it.
// Inject content.js exactly once via chrome.scripting, then keep bounded
// PING retries. Never reloads or navigates the user's tab.
const PROJECT100_MVP_CAPTURE_READY_TIMEOUT_MS = 5000;
const PROJECT100_MVP_CAPTURE_PING_INTERVAL_MS = 250;
// Bounded background verification window, counted from the moment the Drive
// exact readback passed (Milestone A). v1: 2 minutes total.
const PROJECT100_MVP_BACKGROUND_SYNC_WINDOW_MS = 120000;
const PROJECT100_MVP_BACKGROUND_SYNC_POLL_MS = 3000;
const PROJECT100_MVP_BACKGROUND_CONFIRMATIONS = 2;
// Backend completion receipt (GET connector_scopes) polling.
const PROJECT100_MVP_RECEIPT_POLL_MS = 2500;
const PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS = 10000;
// First Add is a read-only observation of the newly-created scope. It may
// legitimately report a running lifecycle before the backend exposes the
// completed timestamp, but it must never wait forever or issue a synthetic
// Resync to manufacture evidence.
const PROJECT100_MVP_INITIAL_COMPLETION_WINDOW_MS = 15000;
let project100MvpPublishRunning = false;
// Set only when the caller supplied an exact Project context (the RC-2 popup
// does). Legacy direct worker calls leave this empty and continue using the
// old unscoped fixture/storage compatibility path.
let project100MvpActiveProjectId = "";

// Durable publish recovery. MV3 service-worker globals disappear whenever
// Chrome suspends or restarts the worker, while chrome.storage.local survives.
// The job record therefore carries the task identity, the current phase and a
// bounded per-source checkpoint. It never carries document bytes.
const PROJECT100_MVP_RECOVERY_JOB_KEY = "project100MvpPublishRecoveryJob";
const PROJECT100_MVP_RECOVERY_SCHEMA_VERSION = 1;
const PROJECT100_MVP_WORKER_INSTANCE_ID = (() => {
  try {
    if (crypto && typeof crypto.randomUUID === "function") {
      return `worker-${crypto.randomUUID()}`;
    }
  } catch (_error) {
    // Use the bounded fallback below in older test/runtime implementations.
  }
  return `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
})();
const PROJECT100_MVP_ACTIVE_RECOVERY_STATUSES = new Set([
  "publishing",
  "syncing"
]);
// The durable job is written before the user-facing Publish snapshot. During
// that narrow write gap, a worker restart can therefore find an active job
// while the visible state is still terminal (or absent). Keep this phase set
// separate from the visible-state set so terminal job records are never
// mistaken for work that needs recovery.
const PROJECT100_MVP_ACTIVE_RECOVERY_PHASES = new Set([
  "publishing",
  "saving",
  "syncing",
  "resyncing",
  "creating",
  "onboarding"
]);
const PROJECT100_MVP_UNCERTAIN_RESYNC_STATUSES = new Set([
  "click-pending",
  "click-in-flight",
  "observing",
  "uncertain",
  "unknown-after-restart"
]);
// Recovery uses the same three-second cadence as the normal bounded
// background verifier. A shorter cadence would make restart reconciliation
// observe a different stability contract from the production path.
const PROJECT100_MVP_RECOVERY_CONFIRMATION_POLL_MS = PROJECT100_MVP_BACKGROUND_SYNC_POLL_MS;
let project100MvpRecoveryJob = null;
const project100MvpRecoveryReconcilePromises = new Map();

function project100MvpRecoveryNow() {
  return new Date().toISOString();
}

async function project100MvpReadRecoveryJob(projectId = "") {
  const requestedProjectId = project100MvpNormalizeProjectId(projectId) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  if (requestedProjectId && project100MvpRecoveryJob &&
      project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId) {
    return project100MvpRecoveryJob;
  }
  const job = await project100MvpReadProjectState(
    PROJECT100_MVP_RECOVERY_JOB_KEY, requestedProjectId);
  if (job && (!requestedProjectId ||
      project100MvpRecordProjectId(job) === requestedProjectId)) {
    // Do not replace an active operation owned by another Project merely
    // because a popup from a second Project asked for its own state.
    if (!requestedProjectId || !project100MvpRecoveryJob ||
        project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId) {
      project100MvpRecoveryJob = job;
    }
    return job;
  }
  return null;
}

async function project100MvpWriteRecoveryJob(job, projectId = "") {
  if (!job || typeof job !== "object") {
    return null;
  }
  const storageProjectId = project100MvpNormalizeProjectId(projectId) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  const requestedProjectId = storageProjectId
    ? project100MvpAssertStateProject(storageProjectId, job)
    : "";
  await project100MvpWriteProjectState(
    PROJECT100_MVP_RECOVERY_JOB_KEY, job, requestedProjectId);
  if (!requestedProjectId || !project100MvpRecoveryJob ||
      project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId) {
    project100MvpRecoveryJob = job;
  }
  return job;
}

async function project100MvpClearRecoveryJob(projectId = "") {
  const requestedProjectId = project100MvpNormalizeProjectId(projectId) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  await project100MvpRemoveProjectState(
    PROJECT100_MVP_RECOVERY_JOB_KEY, requestedProjectId);
  if (!requestedProjectId || !project100MvpRecoveryJob ||
      project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId) {
    project100MvpRecoveryJob = null;
  }
}

function project100MvpRecoveryId(prefix = "publish") {
  try {
    if (crypto && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch (_error) {
    // bounded fallback
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function project100MvpRecoverySourceSnapshot(entry, defaults = {}) {
  const source = entry && typeof entry === "object" ? entry : {};
  const filename = String(source.filename || source.logicalFilename || defaults.filename || "");
  const resyncStatus = String(source.resyncStatus || defaults.resyncStatus ||
    ((source.synced || source.resynced || defaults.synced || defaults.resynced)
      ? "confirmed" : "pending"));
  const phase = String(source.phase || defaults.phase || "pending");
  const rawContentPin = source.contentPin || defaults.contentPin || null;
  const rawCompletionIdentity = source.completionIdentity || defaults.completionIdentity || null;
  return {
    projectId: String(source.projectId || defaults.projectId || ""),
    filename,
    logicalFilename: filename,
    driveFileId: String(source.driveFileId || defaults.driveFileId || ""),
    reservedDriveFileId: String(
      source.reservedDriveFileId || defaults.reservedDriveFileId || ""),
    phase,
    status: String(source.status || phase),
    saved: Boolean(source.saved || defaults.saved),
    driveMutationAccepted: Boolean(
      source.driveMutationAccepted || defaults.driveMutationAccepted),
    driveMutationAt: String(
      source.driveMutationAt || defaults.driveMutationAt || ""),
    synced: Boolean(source.synced || defaults.synced || resyncStatus === "confirmed"),
    resynced: Boolean(source.resynced || defaults.resynced || resyncStatus === "confirmed"),
    resyncStatus,
    resyncClickCount: Number(source.resyncClickCount || defaults.resyncClickCount) || 0,
    byteLength: Number(source.byteLength || defaults.byteLength) || 0,
    sha256: String(source.sha256 || defaults.sha256 || ""),
    contentPin: rawContentPin ? project100MvpNormalizeContentPin(rawContentPin) : null,
    completionIdentity: rawCompletionIdentity && typeof rawCompletionIdentity === "object"
      ? {
        projectId: String(rawCompletionIdentity.projectId || ""),
        connectorType: String(rawCompletionIdentity.connectorType || ""),
        canonicalHandle: String(rawCompletionIdentity.canonicalHandle || ""),
        scopeId: String(rawCompletionIdentity.scopeId || "")
      }
      : null,
    preSyncValue: String(source.preSyncValue || defaults.preSyncValue || ""),
    preCompletedAt: String(source.preCompletedAt || defaults.preCompletedAt || ""),
    error: String(source.error || defaults.error || ""),
    updatedAt: String(source.updatedAt || defaults.updatedAt || project100MvpRecoveryNow())
  };
}

function project100MvpRecoverySourcesForPublishState(job) {
  if (!job || !Array.isArray(job.sources)) {
    return [];
  }
  return job.sources.map((source) => project100MvpRecoverySourceSnapshot(source));
}

function project100MvpRecoverySourceHasMutationEvidence(source) {
  const entry = source && typeof source === "object" ? source : null;
  if (!entry) {
    return false;
  }
  const phase = String(entry.phase || "");
  return Boolean(entry.saved || entry.synced || entry.resynced ||
    entry.driveMutationAccepted === true ||
    Number(entry.resyncClickCount) > 0 || Number(entry.byteLength) > 0 ||
    /^[a-f0-9]{64}$/.test(String(entry.sha256 || "")) ||
    new Set(["creating", "onboarding", "saving", "saved", "syncing",
      "resyncing", "resync-confirmed", "published"]).has(phase));
}

function project100MvpRecoveryStateFields(job) {
  if (!job) {
    return {};
  }
  const lifecycleState = String(job.establishment && job.establishment.state ||
    job.lifecycleState || "");
  const mutationSource = Array.isArray(job.sources)
    ? job.sources.find((entry) => entry && entry.driveMutationAccepted === true &&
      entry.driveMutationAt)
    : null;
  return {
    projectId: String(job.projectId || ""),
    recoveryJobId: String(job.jobId || ""),
    recoveryPhase: String(job.phase || ""),
    recoveryWorkerInstanceId: String(job.workerInstanceId || ""),
    recoveryUpdatedAt: String(job.updatedAt || ""),
    retryable: Boolean(job.retryable),
    driveMutationAccepted: Boolean(Array.isArray(job.sources) &&
      job.sources.some((entry) => entry && entry.driveMutationAccepted === true)),
    driveMutationAt: String(mutationSource && mutationSource.driveMutationAt || ""),
    recoveryQueueIndex: Number(job.currentIndex) || 0,
    lifecycleState,
    transaction: String(job.transaction || (lifecycleState === "ESTABLISHED"
      ? "REFRESH"
      : (lifecycleState === "INITIALIZING" ? "INITIALIZATION" : "")))
  };
}

async function project100MvpBeginRecoveryJob({
  phase,
  projectId,
  sourcePageUrl,
  captureTabId,
  filenames,
  previousJob = null,
  preserveConfirmed = false,
  frozenArtifactOperation = null,
  lifecycleState = "",
  initialFilenames = null
} = {}) {
  const now = project100MvpRecoveryNow();
  const normalizedFrozenArtifactOperation = frozenArtifactOperation
    ? project100MvpNormalizeFrozenArtifactOperation(frozenArtifactOperation)
    : null;
  const previousSources = previousJob && Array.isArray(previousJob.sources)
    ? previousJob.sources
    : [];
  const sources = (Array.isArray(filenames) ? filenames : []).map((filename) => {
    const previousRaw = previousSources.find((entry) =>
      entry && (entry.filename || entry.logicalFilename) === filename);
    const previous = previousRaw &&
      project100MvpRecoveryJobMatchesFrozenOperation(
        previousJob, normalizedFrozenArtifactOperation)
      ? previousRaw
      : null;
    const preserve = preserveConfirmed && previous &&
      previous.resyncStatus === "confirmed" && previous.sha256;
    return project100MvpRecoverySourceSnapshot({
      filename,
      driveFileId: previous && previous.driveFileId,
      driveMutationAccepted: Boolean(previous && previous.driveMutationAccepted),
      driveMutationAt: previous && previous.driveMutationAt
        ? previous.driveMutationAt : "",
      phase: "pending",
      status: "pending",
      saved: false,
      synced: Boolean(preserve),
      resynced: Boolean(preserve),
      resyncStatus: preserve ? "confirmed" : "pending",
      resyncClickCount: preserve ? Number(previous.resyncClickCount) || 1 : 0,
      sha256: preserve ? String(previous.sha256) : "",
      contentPin: previous && previous.contentPin ? previous.contentPin : null,
      preSyncValue: preserve ? String(previous.preSyncValue || "") : "",
      preCompletedAt: preserve ? String(previous.preCompletedAt || "") : ""
    });
  });
  const normalizedLifecycleState = PROJECT100_MVP_ESTABLISHMENT_STATES.has(
    String(lifecycleState || ""))
    ? String(lifecycleState)
    : "";
  const initialNames = Array.isArray(initialFilenames) && initialFilenames.length > 0
    ? initialFilenames
    : filenames;
  const establishment = normalizedLifecycleState
    ? project100MvpBuildEstablishmentRecord(
      normalizedLifecycleState,
      projectId,
      initialNames,
      normalizedFrozenArtifactOperation,
      previousJob && previousJob.establishment
        ? previousJob.establishment
        : null)
    : null;
  const job = {
    version: PROJECT100_MVP_RECOVERY_SCHEMA_VERSION,
    jobId: project100MvpRecoveryId(),
    workerInstanceId: PROJECT100_MVP_WORKER_INSTANCE_ID,
    phase: String(phase || "publishing"),
    projectId: String(projectId || ""),
    sourcePageUrl: String(sourcePageUrl || ""),
    captureTabId: typeof captureTabId === "number" ? captureTabId : null,
    filenames: (Array.isArray(filenames) ? filenames : []).slice(),
    // Serializable operation identity only. The page-local DOM references
    // remain in content.js and disappear with document replacement/reload.
    frozenArtifactOperation: normalizedFrozenArtifactOperation,
    lifecycleState: normalizedLifecycleState,
    transaction: normalizedLifecycleState === "ESTABLISHED"
      ? "REFRESH"
      : (normalizedLifecycleState === "INITIALIZING" ? "INITIALIZATION" : ""),
    establishment,
    sources,
    currentIndex: 0,
    retryable: false,
    retryOf: previousJob && previousJob.jobId ? String(previousJob.jobId) : "",
    createdAt: now,
    updatedAt: now,
    interruptedAt: ""
  };
  await project100MvpWriteRecoveryJob(job);
  return job;
}

async function project100MvpUpdateRecoveryJob(patch = {}, projectId = "") {
  const requestedProjectId = project100MvpNormalizeProjectId(projectId) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  const inMemoryMatches = project100MvpRecoveryJob &&
    (!requestedProjectId ||
      project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId);
  const current = inMemoryMatches
    ? project100MvpRecoveryJob
    : await project100MvpReadRecoveryJob(requestedProjectId);
  if (!current) {
    return null;
  }
  const job = {
    ...current,
    ...patch,
    updatedAt: project100MvpRecoveryNow()
  };
  return project100MvpWriteRecoveryJob(job, requestedProjectId);
}

async function project100MvpUpdateRecoverySource(filenameInput, patch = {}, projectId = "") {
  const filename = String(filenameInput || "");
  const requestedProjectId = project100MvpNormalizeProjectId(projectId) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  const inMemoryMatches = project100MvpRecoveryJob &&
    (!requestedProjectId ||
      project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId);
  const current = inMemoryMatches
    ? project100MvpRecoveryJob
    : await project100MvpReadRecoveryJob(requestedProjectId);
  if (!current || !Array.isArray(current.sources) || !filename) {
    return current || null;
  }
  const index = current.sources.findIndex((entry) =>
    entry && (entry.filename || entry.logicalFilename) === filename);
  if (index < 0) {
    return current;
  }
  const source = project100MvpRecoverySourceSnapshot(current.sources[index], patch);
  const sources = current.sources.slice();
  sources[index] = { ...sources[index], ...source, ...patch, filename, logicalFilename: filename,
    updatedAt: project100MvpRecoveryNow() };
  const job = {
    ...current,
    sources,
    currentIndex: Math.max(Number(current.currentIndex) || 0, index),
    updatedAt: project100MvpRecoveryNow()
  };
  await project100MvpWriteRecoveryJob(job, requestedProjectId);
  return job;
}

async function project100MvpMirrorRecoveryToPublishState(jobInput = null, projectId = "") {
  const job = jobInput || project100MvpRecoveryJob;
  if (!job) {
    return null;
  }
  const requestedProjectId = project100MvpNormalizeProjectId(projectId) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  const current = await project100MvpReadProjectState(
    PROJECT100_MVP_PUBLISH_STATE_KEY, requestedProjectId);
  if (!current || current.recoveryJobId && current.recoveryJobId !== job.jobId) {
    return current || null;
  }
  const perSource = project100MvpRecoverySourcesForPublishState(job);
  const filesSaved = perSource.filter((entry) => entry.saved).length;
  const state = {
    ...current,
    ...project100MvpRecoveryStateFields(job),
    filesSaved,
    perSource,
    retryable: Boolean(job.retryable)
  };
  await project100MvpWriteProjectState(
    PROJECT100_MVP_PUBLISH_STATE_KEY, state, requestedProjectId);
  return state;
}

async function project100MvpFinishRecoveryJob(phase, error = "", projectId = "") {
  const requestedProjectId = project100MvpNormalizeProjectId(projectId) ||
    project100MvpNormalizeProjectId(project100MvpActiveProjectId);
  const inMemoryMatches = project100MvpRecoveryJob &&
    (!requestedProjectId ||
      project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId);
  const current = inMemoryMatches
    ? project100MvpRecoveryJob
    : await project100MvpReadRecoveryJob(requestedProjectId);
  if (!current) {
    return null;
  }
  const terminal = String(phase || "failed");
  const job = await project100MvpUpdateRecoveryJob({
    phase: terminal,
    retryable: terminal === "failed" || terminal === "interrupted",
    error: String(error || "")
  }, requestedProjectId);
  await project100MvpMirrorRecoveryToPublishState(job, requestedProjectId);
  return job;
}

function project100MvpRecoveryHasUncertainResync(job) {
  return Boolean(job && (job.identityIncomplete ||
    Array.isArray(job.sources) && job.sources.some((entry) =>
      entry && PROJECT100_MVP_UNCERTAIN_RESYNC_STATUSES.has(String(entry.resyncStatus || "")))));
}

function project100MvpPublishStateHasUncertainResync(state) {
  if (!state || typeof state !== "object") {
    return false;
  }
  if (state.identityIncomplete) {
    return true;
  }
  const stateStatus = String(state.status || "");
  const entries = Array.isArray(state.perSource) ? state.perSource : [];
  const inProgressStatus = stateStatus === "interrupted" ||
    stateStatus === "syncing" || stateStatus === "failed";
  if (entries.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const resyncStatus = String(entry.resyncStatus || "");
    if (PROJECT100_MVP_UNCERTAIN_RESYNC_STATUSES.has(resyncStatus)) {
      return true;
    }
    const confirmed = Boolean(entry.synced || entry.resynced || resyncStatus === "confirmed");
    const hasCheckpoint = Boolean(entry.saved || entry.driveFileId ||
      entry.driveMutationAccepted || entry.sha256 ||
      entry.preSyncValue || entry.preCompletedAt || Number(entry.resyncClickCount) > 0);
    // Older visible states did not always carry resyncStatus. An interrupted
    // or failed saved Source with no positive completion evidence is still an
    // unknown operation and must not be discarded merely because a mismatched
    // recovery job happens to report a confirmed Source.
    return inProgressStatus && hasCheckpoint && !confirmed;
  })) {
    return true;
  }
  // Preserve the old single-source/top-level shape as unknown too. This is
  // deliberately limited to non-terminal states with an identity or save
  // checkpoint, so a foreign completed state remains eligible for a new task.
  return entries.length === 0 && inProgressStatus && Boolean(
    state.filename || state.driveFileId || Number(state.filesSaved) > 0);
}

function project100MvpIdentityMismatchBlockedState(state, job) {
  const visibleSources = state && Array.isArray(state.perSource) && state.perSource.length > 0
    ? state.perSource
    : project100MvpRecoverySourcesForPublishState(job);
  return {
    ...(state || {}),
    status: "interrupted",
    error: "RECOVERY_IDENTITY_MISMATCH",
    partialMessage: "已中断；当前项目与待恢复任务不一致，请先核对",
    publishedAt: "",
    retryable: true,
    perSource: visibleSources
  };
}

function project100MvpRecoveryJobMatchesBinding(job, binding) {
  if (!job || !binding) {
    return false;
  }
  const jobProjectId = String(job.projectId || "");
  const bindingProjectId = String(binding.projectId ||
    project100MvpProjectSegmentOf(binding.sourcePageUrl || "") || "");
  if (jobProjectId && bindingProjectId && jobProjectId !== bindingProjectId) {
    return false;
  }
  const jobSourcePage = String(job.sourcePageUrl || "");
  const bindingSourcePage = String(binding.sourcePageUrl || "");
  if (jobSourcePage && bindingSourcePage && jobSourcePage !== bindingSourcePage) {
    return false;
  }
  // Same filename is not enough identity. If both records know the bound
  // Drive object, a different file ID belongs to another task (or a stale
  // binding) and must never be used to preserve a Resync confirmation.
  if (Array.isArray(job.sources) && Array.isArray(binding.sources)) {
    for (const source of job.sources) {
      const filename = String(source && (source.filename || source.logicalFilename) || "");
      const bound = binding.sources.find((entry) => entry && entry.filename === filename);
      const jobDriveId = String(source && source.driveFileId || "");
      const boundDriveId = String(bound && bound.driveFileId || "");
      if (jobDriveId && boundDriveId && jobDriveId !== boundDriveId) {
        return false;
      }
    }
  }
  return true;
}

// A first Publish can fail before a binding exists. In that narrow case the
// durable recovery job is the only worker-side carrier of the already-frozen
// page-lifetime operation. Reuse it only for the same Project and tab; a
// different document will fail closed in content.js when its token is absent.
function project100MvpRecoveryJobMatchesCurrentUnboundPublish(job, captureTabUrl, captureTabId) {
  if (!job || !job.frozenArtifactOperation) {
    return false;
  }
  const projectId = project100MvpProjectSegmentOf(captureTabUrl);
  const sourcePageUrl = project100MvpDeriveSourcePageUrl(captureTabUrl);
  if (!projectId || !sourcePageUrl || String(job.projectId || "") !== projectId ||
      String(job.sourcePageUrl || "") !== sourcePageUrl) {
    return false;
  }
  return typeof job.captureTabId !== "number" || job.captureTabId === captureTabId;
}

// A Drive create can succeed after the recovery checkpoint is written but
// before the V2 binding's establishment record is written. In that narrow
// crash window, a matching INITIALIZING recovery job is durable lifecycle
// proof for the partial binding. Accept only its exact initial set and current
// Project identity; a legacy/malformed binding without this proof remains
// UNKNOWN and stops.
function project100MvpValidatePartialInitializingRecovery(binding, recoveryJob, captureTabUrl) {
  const record = recoveryJob && recoveryJob.establishment;
  if (!recoveryJob || recoveryJob.version !== PROJECT100_MVP_RECOVERY_SCHEMA_VERSION ||
      !record || record.version !== PROJECT100_MVP_ESTABLISHMENT_SCHEMA_VERSION ||
      record.state !== "INITIALIZING" ||
      !project100MvpUniqueExactFilenames(record.initialFilenames)) {
    return null;
  }
  let frozen = null;
  try {
    frozen = project100MvpNormalizeFrozenArtifactOperation(
      record.frozenArtifactOperation || recoveryJob.frozenArtifactOperation);
  } catch (_error) {
    return null;
  }
  const initialFilenames = record.initialFilenames.map((filename) => String(filename));
  if (!project100MvpSameFilenameSet(
      initialFilenames,
      frozen.targets.map((target) => target.exactFilename)) ||
      !Array.isArray(recoveryJob.filenames) ||
      !project100MvpSameFilenameSet(initialFilenames, recoveryJob.filenames)) {
    return null;
  }
  const projectId = String(binding && binding.projectId || "");
  const currentProjectId = project100MvpProjectSegmentOf(captureTabUrl);
  const currentSourcePageUrl = project100MvpDeriveSourcePageUrl(captureTabUrl);
  if (!projectId || String(record.projectId || "") !== projectId ||
      String(recoveryJob.projectId || "") !== projectId ||
      !currentProjectId || currentProjectId !== projectId ||
      !currentSourcePageUrl || String(recoveryJob.sourcePageUrl || "") !== currentSourcePageUrl) {
    return null;
  }
  if (binding.sourcePageUrl && !project100MvpProjectIdentityMatchesSourcePage(
      projectId, binding.sourcePageUrl)) {
    return null;
  }
  if (!Array.isArray(binding.sources) || binding.sources.length === 0 ||
      binding.sources.length > initialFilenames.length) {
    return null;
  }
  const expectedFilenames = new Set(initialFilenames);
  const seenFilenames = new Set();
  const seenDriveIds = new Set();
  for (const entry of binding.sources) {
    const filename = String(entry && entry.filename || "");
    if (!entry || !expectedFilenames.has(filename) || seenFilenames.has(filename) ||
        !entry.driveFileId) {
      return null;
    }
    try {
      if (project100MvpNormalizeLogicalFilename(filename) !== filename) {
        return null;
      }
      const driveFileId = project100MvpNormalizeDriveFileId(entry.driveFileId);
      if (seenDriveIds.has(driveFileId)) {
        return null;
      }
      seenDriveIds.add(driveFileId);
    } catch (_error) {
      return null;
    }
    seenFilenames.add(filename);
  }
  return {
    record,
    frozen,
    projectId,
    filenames: initialFilenames.slice()
  };
}

function project100MvpRecoveryIsActiveState(state) {
  return Boolean(state && PROJECT100_MVP_ACTIVE_RECOVERY_STATUSES.has(String(state.status || "")));
}

function project100MvpRecoveryIsActiveJob(job) {
  return Boolean(job && PROJECT100_MVP_ACTIVE_RECOVERY_PHASES.has(String(job.phase || "")));
}

// Never let a polling operation outlive the absolute completion window. The
// caller can pass the result directly to project100MvpWithTimeout; zero means
// the window has already expired and the caller should leave the loop.
function project100MvpRemainingTimeout(deadline, maximum) {
  const remaining = Number(deadline) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 0;
  }
  const cap = Number(maximum);
  return Math.max(1, Math.min(Number.isFinite(cap) && cap > 0 ? cap : remaining, remaining));
}

// Reconcile a Resync whose click may have reached ChatGPT before the worker
// stopped. This path is read-only: it opens a temporary Sources tab, reads the
// exact bound Source's receipt and DOM sync state, and never sends a Resync
// command. A missing/unchanged baseline is inconclusive and keeps the retry
// blocked rather than risking a second click.
async function project100MvpReconcileUncertainResyncEvidence(jobInput, binding) {
  const job = jobInput || project100MvpRecoveryJob;
  if (!job || !binding || !Array.isArray(job.sources)) {
    return { resolved: false, job };
  }
  if (job.identityIncomplete) {
    // There is no exact filename + Drive ID to probe. Treating an empty
    // legacy checkpoint as resolved would allow an unbounded blind click.
    return { resolved: false, job };
  }
  const uncertain = job.sources.filter((entry) =>
    entry && PROJECT100_MVP_UNCERTAIN_RESYNC_STATUSES.has(String(entry.resyncStatus || "")));
  if (uncertain.length === 0) {
    return { resolved: true, job };
  }
  let unresolved = false;
  for (const source of uncertain) {
    const bound = Array.isArray(binding.sources)
      ? binding.sources.find((entry) => entry.filename === source.filename)
      : null;
    if (!bound || !bound.driveFileId) {
      unresolved = true;
      continue;
    }
    const view = {
      filename: source.filename,
      driveFileId: bound.driveFileId,
      sourcePageUrl: binding.sourcePageUrl || job.sourcePageUrl
    };
    let sourceTabId = null;
    try {
      const sourceTab = await project100MvpWithTimeout(
        chrome.tabs.create({ url: view.sourcePageUrl, active: false }),
        PROJECT100_MVP_CONTENT_READY_TIMEOUT_MS,
        "RECOVERY_SOURCE_PAGE_NOT_READY");
      sourceTabId = sourceTab && typeof sourceTab.id === "number" ? sourceTab.id : null;
      if (sourceTabId === null) {
        throw new Error("RECOVERY_SOURCE_PAGE_NOT_READY");
      }
      await project100MvpWaitForContentScript(sourceTabId, "RECOVERY_SOURCE_PAGE_NOT_READY");
      await project100MvpWaitForBoundSourceReady(sourceTabId, view, "RECOVERY_SOURCE_PAGE_NOT_READY");

      let confirmed = false;
      let receiptFailedClosed = false;
      if (source.preCompletedAt) {
        try {
          const receipt = await project100MvpWithTimeout(
            chrome.tabs.sendMessage(sourceTabId, {
              type: "PROJECT100_MVP_CONNECTOR_SCOPE_RECEIPT",
              filename: view.filename,
              driveFileId: view.driveFileId,
              sourcePageUrl: view.sourcePageUrl
            }),
            PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS,
            "RECOVERY_RECEIPT_NOT_RESPONDING");
          if (receipt && receipt.status === "BLOCKED" &&
              (receipt.error === "RECEIPT_SOURCE_AMBIGUOUS" ||
               receipt.error === "RECEIPT_SOURCE_NOT_FOUND")) {
            // A reachable exact-source conflict is terminal for this recovery
            // attempt. DOM evidence cannot safely identify which Source the
            // click affected, so it must not mask the ambiguity.
            receiptFailedClosed = true;
          } else if (receipt && receipt.status === "PASS" && receipt.receipt) {
            const observed = receipt.receipt;
            if (observed.sync_error_code || observed.sync_error_message) {
              // Match the normal completion path: an explicit connector error
              // is a fail-closed result, even if the DOM happens to change.
              receiptFailedClosed = true;
            } else {
              confirmed = Boolean(observed.last_sync_status === "completed" &&
                observed.last_sync_completed_at &&
                observed.last_sync_completed_at !== source.preCompletedAt);
            }
          }
        } catch (_error) {
          // DOM evidence below remains an independent read-only fallback.
        }
      }
      if (!confirmed && !receiptFailedClosed && source.preSyncValue) {
        // DOM completion uses the same stability gate as the normal
        // background verifier: two consecutive readable, non-busy, changed
        // values. A single transient changed read is not recovery evidence.
        let lastStableValue = "";
        let stableCount = 0;
        for (let attempt = 0; attempt < PROJECT100_MVP_BACKGROUND_CONFIRMATIONS; attempt += 1) {
          try {
            const dom = await project100MvpWithTimeout(
              chrome.tabs.sendMessage(sourceTabId, {
                type: "PROJECT100_MVP_SYNC_STATE",
                filename: view.filename,
                driveFileId: view.driveFileId
              }),
              PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS,
              "RECOVERY_SYNC_STATE_NOT_RESPONDING");
            const state = dom && dom.status === "PASS" ? dom.syncState : null;
            const changed = Boolean(state && state.readable && !state.busy &&
              state.canonical !== "syncing" && state.value &&
              state.value !== source.preSyncValue &&
              state.canonical !== "sync_error" && state.canonical !== "not_synced");
            if (changed && state.value === lastStableValue) {
              stableCount += 1;
            } else if (changed) {
              lastStableValue = state.value;
              stableCount = 1;
            } else {
              lastStableValue = "";
              stableCount = 0;
            }
            if (stableCount >= PROJECT100_MVP_BACKGROUND_CONFIRMATIONS) {
              confirmed = true;
              break;
            }
          } catch (_error) {
            lastStableValue = "";
            stableCount = 0;
          }
          if (attempt + 1 < PROJECT100_MVP_BACKGROUND_CONFIRMATIONS) {
            await project100MvpDelay(PROJECT100_MVP_RECOVERY_CONFIRMATION_POLL_MS);
          }
        }
      }
      if (confirmed) {
        await project100MvpUpdateRecoverySource(source.filename, {
          phase: "resync-confirmed",
          status: "confirmed",
          saved: true,
          synced: true,
          resynced: true,
          resyncStatus: "confirmed",
          error: ""
        });
      } else {
        unresolved = true;
      }
    } catch (_error) {
      unresolved = true;
    } finally {
      if (sourceTabId !== null) {
        try {
          await chrome.tabs.remove(sourceTabId);
        } catch (_error) {
          // Cleanup is best effort and never becomes completion evidence.
        }
      }
    }
  }
  const refreshed = project100MvpRecoveryJob || await project100MvpReadRecoveryJob();
  // Keep the popup's interrupted checkpoint in lockstep with the read-only
  // evidence result. This changes only durable metadata; the helper never
  // clicks Resync and never writes Drive.
  if (refreshed) {
    await project100MvpMirrorRecoveryToPublishState(refreshed);
  }
  return { resolved: !unresolved && !project100MvpRecoveryHasUncertainResync(refreshed), job: refreshed };
}

function project100MvpInterruptedState(state, job) {
  const fields = project100MvpRecoveryStateFields(job);
  const perSource = project100MvpRecoverySourcesForPublishState(job);
  const firstSource = perSource[0] || {};
  const filenames = job && Array.isArray(job.filenames) ? job.filenames : [];
  const fileCount = filenames.length || perSource.length || Number(state && state.fileCount) || 0;
  const filesSaved = perSource.filter((entry) => entry.saved).length;
  const driveMutationAccepted = perSource.some((entry) =>
    entry && entry.driveMutationAccepted === true);
  const sameJob = Boolean(state && job && state.recoveryJobId &&
    state.recoveryJobId === job.jobId);
  return {
    ...(state || {}),
    status: "interrupted",
    filename: firstSource.filename || (state && state.filename) || "",
    driveFileId: firstSource.driveFileId || (state && state.driveFileId) || "",
    byteLength: Number(firstSource.byteLength) || (sameJob ? Number(state.byteLength) || 0 : 0),
    sha256: firstSource.sha256 || (sameJob ? String(state.sha256 || "") : ""),
    driveUpdated: filesSaved > 0 || driveMutationAccepted ||
      (sameJob && Boolean(state.driveUpdated)),
    resynced: false,
    error: "PUBLISH_INTERRUPTED",
    partialMessage: "已中断，可重试",
    publishedAt: "",
    fileCount,
    filesSaved,
    retryable: true,
    ...fields,
    recoveryPhase: "interrupted",
    perSource
  };
}

async function project100MvpReconcileRestart(projectId = "") {
  const requestedProjectId = project100MvpEffectiveProjectId(projectId);
  const reconcileKey = requestedProjectId || "__legacy__";
  if (project100MvpRecoveryReconcilePromises.has(reconcileKey)) {
    return project100MvpRecoveryReconcilePromises.get(reconcileKey);
  }
  const reconcilePromise = (async () => {
    const state = await project100MvpReadProjectState(
      PROJECT100_MVP_PUBLISH_STATE_KEY, requestedProjectId);
    const storedJob = await project100MvpReadRecoveryJob(requestedProjectId);
    const stateStatus = String(state && state.status || "");
    const stateFilename = String(state && state.filename || "");
    const stateDriveFileId = String(state && state.driveFileId || "");
    const stateFilesSaved = Number(state && state.filesSaved) || 0;
    const stateJobId = String(state && state.recoveryJobId || "");
    const storedJobId = String(storedJob && storedJob.jobId || "");
    const activeJobStateGap = project100MvpRecoveryIsActiveJob(storedJob) &&
      Boolean(storedJobId) && storedJobId !== stateJobId;
    if (!project100MvpRecoveryIsActiveState(state) && !activeJobStateGap) {
      if (storedJob && storedJob.workerInstanceId === PROJECT100_MVP_WORKER_INSTANCE_ID &&
          (!project100MvpRecoveryJob ||
            project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId)) {
        project100MvpRecoveryJob = storedJob;
      }
      return state;
    }
    const owner = storedJob && storedJob.workerInstanceId
      ? storedJob.workerInstanceId
      : (state && state.recoveryWorkerInstanceId);
    const stale = !owner || owner !== PROJECT100_MVP_WORKER_INSTANCE_ID;
    if (!activeJobStateGap && !stale) {
      project100MvpRecoveryJob = storedJob || null;
      return state;
    }

    // BeginRecoveryJob intentionally persists before the visible `publishing`
    // snapshot. If the worker stops in that gap, the previous visible state
    // may still say Published (or may be absent) even though the durable job
    // already names the new artifact set. Treat that active job as interrupted
    // and prefer its identity below, so retry cannot silently fall back to the
    // prior task's filenames or terminal result.
    const preferStoredJobIdentity = activeJobStateGap;

    // If the previous build has no job record, its syncing state is inherently
    // ambiguous. Reconstruct only bounded identity/progress fields and mark
    // every not-yet-confirmed Resync as uncertain. This prevents a blind click
    // after upgrading/restarting an old worker.
    const seedSources = storedJob && Array.isArray(storedJob.sources)
      ? storedJob.sources
      : (Array.isArray(state && state.perSource) ? state.perSource : []);
    // The first single-source builds persisted only the top-level identity.
    // Reconstruct that one source as an unknown checkpoint instead of treating
    // an empty perSource array as proof that there is nothing to protect.
    const stateSourceEntries = Array.isArray(state && state.perSource) ? state.perSource : [];
    const storedJobSourceNames = storedJob && Array.isArray(storedJob.filenames)
      ? storedJob.filenames.map((filename) => String(filename || "")).filter(Boolean)
      : (storedJob && Array.isArray(storedJob.sources)
        ? storedJob.sources.map((entry) => String(entry &&
          (entry.filename || entry.logicalFilename) || "")).filter(Boolean)
        : []);
    const sourceNames = preferStoredJobIdentity && storedJobSourceNames.length > 0
      ? storedJobSourceNames
      : stateSourceEntries.length > 0
      ? stateSourceEntries.map((entry) => String(entry.filename || entry.logicalFilename || ""))
        : (stateFilename
          ? [stateFilename]
          : (storedJob && Array.isArray(storedJob.filenames) ? storedJob.filenames.slice() : []));
    const sources = seedSources.map((entry) => {
      const seeded = project100MvpRecoverySourceSnapshot(entry);
      // Older builds persisted only `synced`/`resynced` in perSource. Treat
      // that positive evidence as confirmed when reconstructing a job without
      // a durable recovery record; otherwise a partial completion would be
      // needlessly re-clicked after restart.
      const knownConfirmed = Boolean(seeded.synced || seeded.resynced ||
        seeded.resyncStatus === "confirmed");
      const needsUncertainty = !storedJob && !knownConfirmed && stateStatus === "syncing";
      return {
        ...seeded,
        phase: "interrupted",
        status: "interrupted",
        resyncStatus: needsUncertainty ? "unknown-after-restart" : seeded.resyncStatus,
        synced: knownConfirmed,
        resynced: knownConfirmed,
        updatedAt: project100MvpRecoveryNow()
      };
    });
    for (const filename of sourceNames) {
      if (!sources.some((entry) => entry.filename === filename)) {
        const fromState = stateSourceEntries.find((entry) =>
          String(entry.filename || entry.logicalFilename || "") === filename);
        const fallbackEntry = fromState || (filename === stateFilename
          ? {
            filename,
            driveFileId: stateDriveFileId,
            saved: stateFilesSaved > 0 || stateStatus === "syncing",
            synced: false,
            resynced: false,
            error: ""
          }
          : null);
        const needsUncertainty = stateStatus === "syncing" &&
          !(fallbackEntry && (fallbackEntry.synced || fallbackEntry.resynced));
        sources.push(project100MvpRecoverySourceSnapshot(fallbackEntry, {
          filename,
          driveFileId: stateDriveFileId,
          phase: "interrupted",
          resyncStatus: needsUncertainty ? "unknown-after-restart" : "pending",
          saved: Boolean(fallbackEntry && fallbackEntry.saved),
          synced: Boolean(fallbackEntry && fallbackEntry.synced),
          resynced: Boolean(fallbackEntry && fallbackEntry.resynced)
        }));
      }
    }
    const now = project100MvpRecoveryNow();
    const job = {
      ...(storedJob || {}),
      version: PROJECT100_MVP_RECOVERY_SCHEMA_VERSION,
      jobId: storedJob && storedJob.jobId
        ? String(storedJob.jobId)
        : String(stateJobId || project100MvpRecoveryId()),
      workerInstanceId: PROJECT100_MVP_WORKER_INSTANCE_ID,
      phase: "interrupted",
      projectId: String((storedJob && storedJob.projectId) || ""),
      sourcePageUrl: String((storedJob && storedJob.sourcePageUrl) || ""),
      captureTabId: storedJob && typeof storedJob.captureTabId === "number"
        ? storedJob.captureTabId
        : null,
      filenames: Array.isArray(storedJob && storedJob.filenames)
        ? storedJob.filenames.slice()
        : sources.map((entry) => entry.filename),
      sources,
      identityIncomplete: stateStatus === "syncing" && sourceNames.length === 0,
      currentIndex: Number(storedJob && storedJob.currentIndex) || 0,
      retryable: true,
      interruptedAt: now,
      updatedAt: now
    };
    if (!project100MvpRecoveryJob ||
        project100MvpRecordProjectId(project100MvpRecoveryJob) === requestedProjectId) {
      project100MvpRecoveryJob = job;
    }
    const interrupted = project100MvpInterruptedState(state, job);
    // Persist the recovery record before the visible interrupted state. A
    // popup reopening between writes can therefore never see a false success.
    await project100MvpWriteRecoveryJob(job, requestedProjectId);
    await project100MvpWritePublishState(interrupted, requestedProjectId);
    return interrupted;
  })().finally(() => {
    project100MvpRecoveryReconcilePromises.delete(reconcileKey);
  });
  project100MvpRecoveryReconcilePromises.set(reconcileKey, reconcilePromise);
  return reconcilePromise;
}

async function project100MvpReadPublishState(projectId = "") {
  const requestedProjectId = project100MvpEffectiveProjectId(projectId);
  const reconciled = await project100MvpReconcileRestart(requestedProjectId);
  if (reconciled) {
    return reconciled;
  }
  return project100MvpReadProjectState(
    PROJECT100_MVP_PUBLISH_STATE_KEY, requestedProjectId);
}

// ---- Single-source v1: persisted onboarding (pending Publish intent) -------
// Narrow pending state only — never document contents. It survives popup
// closing, Sources-page loading and service-worker restarts.
const PROJECT100_MVP_ONBOARDING_KEY = "project100MvpOnboardingState";
const PROJECT100_MVP_ONBOARDING_WATCH_MS = 600000;

async function project100MvpReadOnboardingState(projectId = "") {
  return project100MvpReadProjectState(
    PROJECT100_MVP_ONBOARDING_KEY, project100MvpEffectiveProjectId(projectId));
}

async function project100MvpWriteOnboardingState(state, projectId = "") {
  await project100MvpWriteProjectState(
    PROJECT100_MVP_ONBOARDING_KEY, state,
    project100MvpEffectiveProjectId(projectId));
  return state;
}

async function project100MvpClearOnboardingState(projectId = "") {
  await project100MvpRemoveProjectState(
    PROJECT100_MVP_ONBOARDING_KEY, project100MvpEffectiveProjectId(projectId));
}

// Deterministic Project identity from a ChatGPT URL. The exact current
// Project path segment is preserved (same segment class as the production
// network-observer match pattern — g-p- ids may contain hyphens); no other
// Project is ever guessed.
function project100MvpProjectSegmentOf(urlString) {
  try {
    const url = new URL(String(urlString || ""));
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") {
      return "";
    }
    const match = url.pathname.match(/\/g\/(g-p-[A-Za-z0-9-]+)(?:\/|$|\?)/);
    return match ? match[1] : "";
  } catch (_error) {
    return "";
  }
}

// Derive the current Project's Sources URL from its chat URL:
// .../g/<current-project-segment>/project?tab=sources
function project100MvpDeriveSourcePageUrl(chatUrl) {
  try {
    const url = new URL(String(chatUrl || ""));
    if (url.protocol !== "https:" ||
        !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
      return "";
    }
    const segment = project100MvpProjectSegmentOf(url.toString());
    if (!segment) {
      return "";
    }
    return `https://${url.hostname}/g/${segment}/project?tab=sources`;
  } catch (_error) {
    return "";
  }
}

async function project100MvpGetTabUrl(tabId) {
  if (typeof tabId !== "number" ||
      !chrome.tabs || typeof chrome.tabs.get !== "function") {
    return "";
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && typeof tab.url === "string" ? tab.url : "";
  } catch (_error) {
    return "";
  }
}

// Batch coordinator sink: while a per-source frozen continuation runs, its
// publish-state writes go to a side key so the popup NEVER sees a premature
// per-source "Published ✓". The coordinator owns the user-facing state.
let project100MvpPublishStateSink = null;

async function project100MvpWritePublishState(state, projectId = "") {
  const storageProjectId = project100MvpEffectiveProjectId(projectId);
  const stateJob = storageProjectId
    ? await project100MvpReadRecoveryJob(storageProjectId)
    : project100MvpRecoveryJob;
  const key = project100MvpPublishStateSink ||
    project100MvpProjectScopedKey(PROJECT100_MVP_PUBLISH_STATE_KEY, storageProjectId);
  const recoveryFields = project100MvpRecoveryStateFields(stateJob);
  const persisted = stateJob &&
      (!state || !state.recoveryJobId || state.recoveryJobId === stateJob.jobId)
    ? { ...state, ...recoveryFields }
    : state;
  if (!project100MvpPublishStateSink) {
    await project100MvpWriteProjectState(
      PROJECT100_MVP_PUBLISH_STATE_KEY, persisted, storageProjectId);
  } else {
    await chrome.storage.local.set({ [key]: persisted });
  }
  return persisted;
}

async function project100MvpReadSidePublishState(key) {
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

async function project100MvpRemoveSidePublishState(key) {
  // Defensive: older test fixtures may not implement storage.remove; a
  // missing side-key cleanup must never fail a publish job.
  if (chrome.storage && chrome.storage.local &&
      typeof chrome.storage.local.remove === "function") {
    await chrome.storage.local.remove(key);
  }
}

function project100MvpPublishSnapshot(status, binding, fields) {
  const sourceList = Array.isArray(fields.perSource) ? fields.perSource : [];
  const perSource = sourceList.map((entry) => {
    const source = entry && typeof entry === "object" ? entry : {};
    const filename = String(source.filename || source.logicalFilename || "");
    const phase = String(source.phase || source.status || status || "pending");
    const resyncStatus = String(source.resyncStatus ||
      ((source.synced || source.resynced) ? "confirmed" : "pending"));
    return {
      ...source,
      filename,
      logicalFilename: filename,
      phase,
      status: String(source.status || phase),
      saved: Boolean(source.saved),
      synced: Boolean(source.synced || source.resynced || resyncStatus === "confirmed"),
      resynced: Boolean(source.resynced || source.synced || resyncStatus === "confirmed"),
      resyncStatus
    };
  });
  const recoveryFields = project100MvpRecoveryStateFields(project100MvpRecoveryJob);
  return {
    status,
    projectId: String(fields.projectId || recoveryFields.projectId ||
      (binding && binding.projectId) || project100MvpActiveProjectId || ""),
    filename: binding ? binding.filename : "",
    driveFileId: binding ? binding.driveFileId : "",
    byteLength: fields.byteLength || 0,
    sha256: fields.sha256 || "",
    publishedAt: fields.publishedAt || "",
    driveUpdated: Boolean(fields.driveUpdated),
    resynced: Boolean(fields.resynced),
    error: fields.error || "",
    partialMessage: fields.partialMessage || "",
    // Multi-source v1: how many logical Sources this job publishes and the
    // per-source results (small, fixed-shape identity records — no bytes).
    fileCount: Number(fields.fileCount) || 0,
    filesSaved: Number(fields.filesSaved) || 0,
    perSource,
    ...recoveryFields,
    driveMutationAccepted: Boolean(fields.driveMutationAccepted ||
      recoveryFields.driveMutationAccepted ||
      perSource.some((entry) => entry && entry.driveMutationAccepted === true)),
    driveMutationAt: String(fields.driveMutationAt ||
      recoveryFields.driveMutationAt ||
      ((perSource.find((entry) => entry && entry.driveMutationAccepted === true &&
        entry.driveMutationAt) || {}).driveMutationAt) || ""),
    lifecycleState: fields.lifecycleState || recoveryFields.lifecycleState || "",
    transaction: fields.transaction || recoveryFields.transaction || "",
    retryable: Boolean(fields.retryable || (project100MvpRecoveryJob && project100MvpRecoveryJob.retryable)),
    // Bounded local diagnostics (never rendered in the popup): capture
    // stage/errors, browser-download correlation evidence, Drive gate and
    // Resync completion evidence. Small fixed-shape objects only.
    captureDiagnostics: fields.captureDiagnostics || null,
    driveGate: fields.driveGate || null,
    resyncEvidence: fields.resyncEvidence || null,
    completion: fields.completion || "",
    // HY7: bounded Fresh Sources completion evidence (no raw attempt history
    // here — that stays in the separate diagnostics storage).
    freshSources: fields.freshSources || null
  };
}

function project100MvpClip(value, limit = 160) {
  const text = String(value == null ? "" : value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// Canary-field parse for diagnostics only (SOURCE_CANARY / REVISION /
// NONCE lines). Never dumps the document body.
function project100MvpExtractCanaryFields(bytes) {
  const fields = { canary: "", revision: "", nonce: "" };
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []));
    const extract = (name) => {
      const match = text.match(new RegExp(`(?:^|\\r?\\n)${name}=([^\\r\\n]*)`, "m"));
      return match ? project100MvpClip(match[1].trim(), 80) : "";
    };
    fields.canary = extract("SOURCE_CANARY");
    fields.revision = extract("REVISION");
    fields.nonce = extract("NONCE");
  } catch (_error) {
    // Non-UTF8 payloads leave the diagnostic fields empty; never throws.
  }
  return fields;
}

function project100MvpCaptureDiagnostics(captured) {
  if (!captured) {
    return null;
  }
  const errors = Array.isArray(captured.errors) ? captured.errors : [];
  return {
    stage: project100MvpClip(captured.stage, 60),
    errors: errors.slice(0, 3).map((entry) => project100MvpClip(entry, 160)),
    matching_openers: Number(captured.matching_openers) || 0,
    preview_download_actions: Number(captured.preview_download_actions) || 0,
    selected_download_action: captured.selected_download_action || null,
    canary: captured.canary || "",
    revision: captured.revision || "",
    nonce: captured.nonce || "",
    byte_length: Number(captured.byte_length) || 0,
    download_diagnostic: captured.download_diagnostic || null
  };
}

function project100MvpResyncEvidence(resync, extras = {}) {
  return {
    resync_actions_found: Number(resync && resync.resync_actions_found) || 0,
    resync_click_count: Number(resync && resync.resync_click_count) || 0,
    pre_sync: project100MvpClip(resync && resync.pre_sync, 80),
    post_sync: project100MvpClip(resync && resync.post_sync, 80),
    transient_activity_observed: Boolean(resync && resync.transient_activity_observed),
    sync_state_changed: Boolean(resync && resync.sync_state_changed),
    dom_fast_path_expired: Boolean(resync && resync.dom_fast_path_expired),
    ...extras
  };
}

function project100MvpDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Bounded readiness probing: ping the content script until it answers or the
// deadline passes. Never assume a fixed sleep makes a page usable.
async function project100MvpWaitForContentScript(tabId, timeoutError) {
  const deadline = Date.now() + PROJECT100_MVP_CONTENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PROJECT100_MVP_PING" });
      if (response && response.status === "PASS") {
        return;
      }
    } catch (_error) {
      // Content script not reachable yet; keep probing until the deadline.
    }
    await project100MvpDelay(250);
  }
  throw new Error(timeoutError);
}

function project100MvpWithTimeout(promise, timeoutMs, errorCode) {
  let timeoutId = 0;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
  });
  void promise.catch(() => {});
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// Active-capture-tab readiness with self-heal: PING the tab; if the content
// script is unreachable, inject content.js ONCE via chrome.scripting
// (manifest-declared permission model) and keep bounded PING retries until
// it answers. content.js's page-lifetime load guard makes repeated or
// redundant injection a no-op, so no duplicate listeners can appear. No
// reload, no navigation, no repeated injection.
async function project100MvpEnsureCaptureContentScript(tabId) {
  const deadline = Date.now() + PROJECT100_MVP_CAPTURE_READY_TIMEOUT_MS;
  let injected = false;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PROJECT100_MVP_PING" });
      if (response && response.status === "PASS") {
        return;
      }
    } catch (_error) {
      if (!injected) {
        injected = true;
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"]
          });
        } catch (_injectionError) {
          // Truthful CAPTURE_TAB_NOT_READY below; no repeated injection.
        }
      }
    }
    await project100MvpDelay(PROJECT100_MVP_CAPTURE_PING_INTERVAL_MS);
  }
  throw new Error("CAPTURE_TAB_NOT_READY");
}

// Freeze once at Publish operation start. Every later capture message carries
// one of these exact target identities; no later message performs chat
// discovery or filename-based re-selection.
async function project100MvpFreezeArtifactOperation(captureTabId) {
  await project100MvpEnsureCaptureContentScript(captureTabId);
  let response = null;
  try {
    response = await project100MvpWithTimeout(
      chrome.tabs.sendMessage(captureTabId, {
        type: "PROJECT100_MVP_FREEZE_ARTIFACT_SCOPE"
      }),
      PROJECT100_MVP_CAPTURE_RESPONSE_TIMEOUT_MS,
      "ARTIFACT_SCOPE_UNAVAILABLE"
    );
  } catch (error) {
    throw new Error(project100MvpSafeError(error) || "ARTIFACT_SCOPE_UNAVAILABLE");
  }
  return project100MvpNormalizeFrozenArtifactOperation(response);
}

// ---- MAIN-world network observer (PASS 1: OBSERVE ONLY) -------------------
// A read-only MAIN-world script (network-observer-main.js) is dynamically
// registered at document_start BEFORE the temporary Sources tab is created, so
// the page's own bootstrap traffic is observable. It is unregistered as soon as
// the flow ends; nothing survives the temporary tab lifecycle.
//
// The extension never sends, replays or reproduces a ChatGPT request and never
// touches Authorization / Cookie / tokens. Observed network data is stored as
// bounded diagnostics only and never influences the product verdict in PASS 1.
const PROJECT100_MVP_NETWORK_OBSERVER_SCRIPT_ID = "project100-network-observer";
const PROJECT100_MVP_NETWORK_EVIDENCE_KEY = "project100MvpNetworkEvidence";
// HY6 PoC: bounded fresh Sources reload/reopen diagnostics, fully separate
// from the verdict path. The page itself must remain the only
// connector_scopes initiator used as evidence; reload/reopen never click
// Resync; the ORIGINAL absolute window is never extended.
const PROJECT100_MVP_FRESH_SOURCES_EVIDENCE_KEY = "project100MvpFreshSourcesEvidence";
const PROJECT100_MVP_FRESH_SOURCES_MAX_RELOADS = 3;
const PROJECT100_MVP_FRESH_SOURCES_REOPEN_MAX = 1;
// Minimum interval between fresh navigations (never a tight loop):
// hard floor 5 s, production cadence ~8 s. The options parameter of the
// phase function exists ONLY for unit tests; the production call site passes
// no options, so production always uses the 8 s cadence.
const PROJECT100_MVP_FRESH_SOURCES_MIN_INTERVAL_MS = 5000;
const PROJECT100_MVP_FRESH_SOURCES_INTERVAL_MS = 8000;
// Per-load readiness cap; always clamped to the remaining ORIGINAL window.
const PROJECT100_MVP_FRESH_SOURCES_PER_LOAD_TIMEOUT_MS = 12000;
// The tail of the ORIGINAL window stays reserved for the product's own
// completion channels; the diagnostic never spends it.
const PROJECT100_MVP_FRESH_SOURCES_RESERVE_MS = 25000;
// HY8 §15: bounded budget for the pre-reload documentInstanceId PING retry.
// Short by design — an empty old id must never create a long new wait.
const PROJECT100_MVP_DOCUMENT_ID_PING_BUDGET_MS = 2000;

function project100MvpResolveProjectId(sourcePageUrl) {
  try {
    const url = new URL(String(sourcePageUrl || ""));
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") {
      return "";
    }
    const match = url.pathname.match(/\/g\/(g-p-[A-Za-z0-9]+)/);
    return match ? match[1] : "";
  } catch (_error) {
    return "";
  }
}

// Narrowest possible scope: only the bound Project's own Sources path.
// Never a broad host-wide pattern.
function project100MvpNetworkObserverMatchPattern(sourcePageUrl) {
  try {
    const url = new URL(String(sourcePageUrl || ""));
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") {
      return "";
    }
    if (!/^\/g\/g-p-[A-Za-z0-9-]+\/project(?:\/|$)/.test(url.pathname)) {
      return "";
    }
    return `${url.protocol}//${url.hostname}${url.pathname}*`;
  } catch (_error) {
    return "";
  }
}

async function project100MvpUnregisterNetworkObserver() {
  try {
    if (chrome.scripting && typeof chrome.scripting.unregisterContentScripts === "function") {
      await chrome.scripting.unregisterContentScripts({
        ids: [PROJECT100_MVP_NETWORK_OBSERVER_SCRIPT_ID]
      });
    }
  } catch (_error) {
    // Best-effort cleanup; never blocks or fails the publish flow.
  }
}

let project100MvpNetworkObserverInfo = null;

async function project100MvpRegisterNetworkObserver(sourcePageUrl) {
  if (!chrome.scripting || typeof chrome.scripting.registerContentScripts !== "function") {
    project100MvpNetworkObserverInfo = { installed: false, reason: "REGISTER_UNAVAILABLE", matchPattern: "" };
    return project100MvpNetworkObserverInfo;
  }
  const matchPattern = project100MvpNetworkObserverMatchPattern(sourcePageUrl);
  if (!matchPattern) {
    // Never broaden the scope just to make installation easier.
    project100MvpNetworkObserverInfo = { installed: false, reason: "OBSERVER_SCOPE_UNAVAILABLE", matchPattern: "" };
    return project100MvpNetworkObserverInfo;
  }
  await project100MvpUnregisterNetworkObserver();
  try {
    await chrome.scripting.registerContentScripts([{
      id: PROJECT100_MVP_NETWORK_OBSERVER_SCRIPT_ID,
      matches: [matchPattern],
      js: ["network-observer-main.js"],
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: false
    }]);
    project100MvpNetworkObserverInfo = { installed: true, reason: "REGISTERED", matchPattern };
    return project100MvpNetworkObserverInfo;
  } catch (_error) {
    project100MvpNetworkObserverInfo = { installed: false, reason: "OBSERVER_REGISTER_FAILED", matchPattern };
    return project100MvpNetworkObserverInfo;
  }
}

// Bounded diagnostic snapshot (PASS 1: classification only, never a verdict).
async function project100MvpCollectNetworkEvidence(tabId, timeoutMs = 0) {
  if (typeof tabId !== "number") {
    return null;
  }
  let evidence = null;
  try {
    const request = chrome.tabs.sendMessage(tabId, { type: "PROJECT100_MVP_NETWORK_EVIDENCE" });
    evidence = await (Number(timeoutMs) > 0
      ? project100MvpWithTimeout(request, Number(timeoutMs), "NETWORK_EVIDENCE_NOT_RESPONDING")
      : request);
  } catch (_error) {
    return null;
  }
  if (!evidence || typeof evidence !== "object") {
    return null;
  }
  const bounded = {
    observerRegistration: project100MvpNetworkObserverInfo,
    observerInstalled: Boolean(evidence.observerInstalled),
    observerFailed: Boolean(evidence.observerFailed),
    armed: Boolean(evidence.armed),
    windowId: project100MvpClip(evidence.windowId, 40),
    projectId: project100MvpClip(evidence.projectId, 60),
    driveFileId: project100MvpClip(evidence.driveFileId, 120),
    bootstrapRelevantEvents: Number(evidence.bootstrapRelevantEvents) || 0,
    armedRelevantEvents: Number(evidence.armedRelevantEvents) || 0,
    exactIdentityObserved: Boolean(evidence.exactIdentityObserved),
    exactIdentityMethod: project100MvpClip(evidence.exactIdentityMethod, 40),
    preCompletedAt: project100MvpClip(evidence.preCompletedAt, 60),
    postCompletedAt: project100MvpClip(evidence.postCompletedAt, 60),
    completionCandidateObserved: Boolean(evidence.completionCandidateObserved),
    explicitErrorObserved: Boolean(evidence.explicitErrorObserved),
    ambiguousObserved: Boolean(evidence.ambiguousObserved),
    projectMismatchEvents: Number(evidence.projectMismatchEvents) || 0,
    startedOnlyEvents: Number(evidence.startedOnlyEvents) || 0,
    sanitizedEvents: Array.isArray(evidence.sanitizedEvents)
      ? evidence.sanitizedEvents.slice(-64)
      : []
  };
  try {
    await chrome.storage.local.set({ [PROJECT100_MVP_NETWORK_EVIDENCE_KEY]: bounded });
  } catch (_error) {
    // Diagnostics must never break the job.
  }
  return bounded;
}

// ---- HY6 PoC: fresh Sources reload/reopen diagnostics ----------------------
// After the exact one-time Resync click, bounded fresh navigations of the
// temporary Sources tab let the ChatGPT page ITSELF re-issue its own
// authenticated GET /backend-api/projects/<id>/connector_scopes. That
// page-owned traffic is passively observed by the still-registered MAIN-world
// observer and classified against the ORIGINAL pre-Resync baseline (T1),
// which is held HERE, in the service worker, across reloads. A fresh
// document's own first state is never treated as a new baseline.
//
// Hard boundaries:
//   - no extension-initiated or MAIN-world-initiated connector_scopes fetch
//     (FR15/FR16): the page issues every request used as evidence;
//   - no second Resync click, ever — reload/reopen only re-read state;
//   - the ORIGINAL driveUpdatedAt + PROJECT100_MVP_BACKGROUND_SYNC_WINDOW_MS
//     window is never extended, and its tail stays reserved for the
//     product's own completion channels (diagnostic scheduling only — the
//     verdict semantics themselves are untouched);
//   - everything here is diagnostics only and can never write a verdict.
function project100MvpStoreFreshSourcesEvidence(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const boundedAttempt = (entry) => ({
    attempt: Number(entry && entry.attempt) || 0,
    mode: entry && entry.mode === "reopen" ? "reopen" : "reload",
    pageLoadId: project100MvpClip(entry && entry.pageLoadId, 40),
    ready: Boolean(entry && entry.ready),
    relevantGetObserved: Boolean(entry && entry.relevantGetObserved),
    httpStatus: Number(entry && entry.httpStatus) || 0,
    exactMatchObserved: Boolean(entry && entry.exactMatchObserved),
    exactMatchCount: Number(entry && entry.exactMatchCount) || 0,
    lastObservedStatus: project100MvpClip(entry && entry.lastObservedStatus, 60),
    lastObservedStartedAt: project100MvpClip(entry && entry.lastObservedStartedAt, 60),
    lastObservedCompletedAt: project100MvpClip(entry && entry.lastObservedCompletedAt, 60),
    explicitErrorObserved: Boolean(entry && entry.explicitErrorObserved),
    ambiguousObserved: Boolean(entry && entry.ambiguousObserved),
    completionCandidateObserved: Boolean(entry && entry.completionCandidateObserved),
    documentInstanceId: project100MvpClip(entry && entry.documentInstanceId, 60)
  });
  const bounded = {
    attempted: Boolean(source.attempted),
    originalPreCompletedAt: project100MvpClip(source.originalPreCompletedAt, 60),
    attempts: (Array.isArray(source.attempts) ? source.attempts : []).slice(-8).map(boundedAttempt),
    completionCandidateObserved: Boolean(source.completionCandidateObserved),
    winningAttempt: Number(source.winningAttempt) || 0,
    finalCompletedAt: project100MvpClip(source.finalCompletedAt, 60),
    terminalReason: project100MvpClip(source.terminalReason, 40)
  };
  return chrome.storage.local.set({ [PROJECT100_MVP_FRESH_SOURCES_EVIDENCE_KEY]: bounded })
    .catch(() => {
      // Diagnostics must never break the job.
    });
}

// Single fail-closed validator for the production completion rule (HY7 §5/§17):
// EVERY strong condition must hold, owned here — never scattered across
// branches. `resyncClickCount` rides on the evidence object the publish flow
// assembles; the helper fails closed when it is anything but exactly 1.
function project100MvpIsFreshSourcesCompletion(evidence) {
  const e = evidence && typeof evidence === "object" ? evidence : null;
  if (!e) {
    return false;
  }
  if (Number(e.resyncClickCount) !== 1) {
    return false;
  }
  const originalPreCompletedAt = String(e.originalPreCompletedAt || "");
  if (!originalPreCompletedAt) {
    return false;
  }
  if (e.terminalReason !== "FRESH_COMPLETED") {
    return false;
  }
  if (!e.completionCandidateObserved) {
    return false;
  }
  const winningAttempt = Number(e.winningAttempt) || 0;
  if (winningAttempt < 1) {
    return false;
  }
  const attempts = Array.isArray(e.attempts) ? e.attempts : [];
  const winner = attempts.find((entry) => entry && Number(entry.attempt) === winningAttempt);
  if (!winner) {
    return false;
  }
  if (!winner.relevantGetObserved) {
    return false;
  }
  if (Number(winner.httpStatus) !== 200) {
    return false;
  }
  if (!winner.exactMatchObserved || Number(winner.exactMatchCount) !== 1) {
    return false;
  }
  if (winner.lastObservedStatus !== "completed") {
    return false;
  }
  const finalCompletedAt = String(winner.lastObservedCompletedAt || "");
  if (!finalCompletedAt || finalCompletedAt === originalPreCompletedAt) {
    return false;
  }
  if (winner.explicitErrorObserved || winner.ambiguousObserved) {
    return false;
  }
  return true;
}

// One fresh-navigation diagnostic: PING the reloaded/reopened document until
// its content script is alive AND a NEW document identity is proven (HY7
// race hardening: the old document must never answer for a reload), then ask
// it to classify ITS OWN page-owned bootstrap traffic against the ORIGINAL
// baseline. Bounded by the per-load timeout, itself clamped to the remaining
// ORIGINAL window.
async function project100MvpFreshSourcesCollect(tabId, binding, originalPreCompletedAt, attemptTimeoutMs, attempt, mode, pageLoadId, previousDocumentInstanceId) {
  const base = {
    attempt: Number(attempt) || 0,
    mode: mode === "reopen" ? "reopen" : "reload",
    pageLoadId: project100MvpClip(pageLoadId, 40),
    ready: false,
    relevantGetObserved: false,
    httpStatus: 0,
    exactMatchObserved: false,
    exactMatchCount: 0,
    lastObservedStatus: "",
    lastObservedStartedAt: "",
    lastObservedCompletedAt: "",
    explicitErrorObserved: false,
    ambiguousObserved: false,
    completionCandidateObserved: false,
    noPreBaselineCandidate: false,
    documentInstanceId: ""
  };
  if (typeof tabId !== "number") {
    return base;
  }
  const attemptStartedAt = Date.now();
  const pingBudgetMs = Math.min(3000, Math.max(0, attemptTimeoutMs));
  const pingDeadline = attemptStartedAt + pingBudgetMs;
  let ready = false;
  let documentInstanceId = "";
  while (Date.now() < pingDeadline) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "PROJECT100_MVP_PING" });
      // Identity handshake: only a document whose instance id is non-empty
      // and DIFFERENT from the pre-navigation document may answer. An old
      // document's PING can never satisfy a reload attempt.
      const pingInstanceId = String(ping && ping.documentInstanceId) || "";
      if (ping && ping.status === "PASS" && pingInstanceId &&
          pingInstanceId !== String(previousDocumentInstanceId || "")) {
        ready = true;
        documentInstanceId = pingInstanceId;
        break;
      }
    } catch (_error) {
      // Content script not reachable yet; the document may still be loading.
    }
    await project100MvpDelay(200);
  }
  if (!ready) {
    return base;
  }
  base.ready = true;
  base.documentInstanceId = documentInstanceId;
  const collectBudgetMs = Math.max(0, attemptTimeoutMs - (Date.now() - attemptStartedAt));
  let response = null;
  try {
    response = await project100MvpWithTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "PROJECT100_MVP_FRESH_SOURCES_COLLECT",
        driveFileId: binding.driveFileId,
        projectId: project100MvpResolveProjectId(binding.sourcePageUrl),
        originalPreCompletedAt,
        perLoadTimeoutMs: collectBudgetMs
      }),
      collectBudgetMs + 2000,
      "FRESH_SOURCES_COLLECT_NOT_RESPONDING");
  } catch (_error) {
    response = null;
  }
  const raw = response && response.status === "PASS" && response.attempt &&
    typeof response.attempt === "object" ? response.attempt : null;
  if (!raw) {
    return base;
  }
  return {
    ...base,
    relevantGetObserved: Boolean(raw.relevantGetObserved),
    httpStatus: Number(raw.httpStatus) || 0,
    exactMatchObserved: Boolean(raw.exactMatchObserved),
    exactMatchCount: Number(raw.exactMatchCount) || 0,
    lastObservedStatus: project100MvpClip(raw.lastObservedStatus, 60),
    lastObservedStartedAt: project100MvpClip(raw.lastObservedStartedAt, 60),
    lastObservedCompletedAt: project100MvpClip(raw.lastObservedCompletedAt, 60),
    explicitErrorObserved: Boolean(raw.explicitErrorObserved),
    ambiguousObserved: Boolean(raw.ambiguousObserved),
    completionCandidateObserved: Boolean(raw.completionCandidateObserved),
    noPreBaselineCandidate: Boolean(raw.noPreBaselineCandidate)
  };
}

// The phase itself: up to MAX_RELOADS fresh reloads, then at most ONE reopen
// fallback when the reloads produced no usable page-owned traffic at all.
// Returns { evidence, currentTabId } — the caller must never derive any
// verdict from `evidence`.
async function project100MvpFreshSourcesReceiptPhase(sourceTabId, binding, driveUpdatedAt, originalPreCompletedAt, options = {}) {
  // options.* exist ONLY for unit tests; the production call site passes no
  // options, so production always uses the >=5s-floored ~8s cadence.
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : PROJECT100_MVP_FRESH_SOURCES_INTERVAL_MS;
  const perLoadTimeoutMs = Number(options.perLoadTimeoutMs) > 0
    ? Number(options.perLoadTimeoutMs)
    : PROJECT100_MVP_FRESH_SOURCES_PER_LOAD_TIMEOUT_MS;
  const reserveMs = Number(options.reserveMs) >= 0
    ? Number(options.reserveMs)
    : PROJECT100_MVP_FRESH_SOURCES_RESERVE_MS;
  const deadline = driveUpdatedAt + PROJECT100_MVP_BACKGROUND_SYNC_WINDOW_MS;
  const budgetEnd = deadline - reserveMs;
  const evidence = {
    attempted: true,
    originalPreCompletedAt: project100MvpClip(originalPreCompletedAt, 60),
    attempts: [],
    completionCandidateObserved: false,
    winningAttempt: 0,
    finalCompletedAt: "",
    terminalReason: ""
  };
  await project100MvpStoreFreshSourcesEvidence(evidence);
  let currentTabId = typeof sourceTabId === "number" ? sourceTabId : null;
  let lastAttemptAt = 0;
  let usableTrafficObserved = false;
  let lastRelevantStatus = "";

  const finish = (reason) => {
    if (!evidence.terminalReason) {
      evidence.terminalReason = reason;
    }
    return evidence;
  };
  const adoptResult = (result) => {
    if (result.relevantGetObserved) {
      usableTrafficObserved = true;
      lastRelevantStatus = result.lastObservedStatus;
    }
    if (result.completionCandidateObserved) {
      evidence.completionCandidateObserved = true;
      evidence.finalCompletedAt = result.lastObservedCompletedAt;
      evidence.winningAttempt = result.attempt;
    }
  };

  const runAttempt = async (attempt, mode, tabId, previousDocumentInstanceId) => {
    const pageLoadId = `pl${attempt}-${Date.now().toString(36)}`;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return null;
    }
    const result = await project100MvpFreshSourcesCollect(
      tabId, binding, originalPreCompletedAt,
      Math.min(perLoadTimeoutMs, remaining), attempt, mode, pageLoadId,
      previousDocumentInstanceId);
    evidence.attempts.push(result);
    adoptResult(result);
    return result;
  };
  const reopenedOk = (result) => result && result.ready;
  // Identity handshake helper: ask the CURRENT document for its instance id
  // before navigating, so the post-reload PING can prove a NEW document.
  // HY8 §15 hardening: a single PING can transiently fail (the tab may be
  // mid-operation), so retry within a short bounded budget — never a long
  // new wait. If the old id is still unavailable, the caller continues
  // cautiously; the collect-side guard (post-navigation instance id must be
  // non-empty, and completion still requires completed_at != original T1)
  // ensures old-document bootstrap evidence can never satisfy fresh
  // completion.
  const currentDocumentInstanceId = async (tabId) => {
    const deadline = Date.now() + PROJECT100_MVP_DOCUMENT_ID_PING_BUDGET_MS;
    while (Date.now() < deadline) {
      try {
        const ping = await chrome.tabs.sendMessage(tabId, { type: "PROJECT100_MVP_PING" });
        const instanceId = String(ping && ping.documentInstanceId) || "";
        if (instanceId) {
          return instanceId;
        }
      } catch (_error) {
        // Transient unreachability; retry inside the bounded budget.
      }
      await project100MvpDelay(200);
    }
    return "";
  };
  // HY7 §9 reopen trigger: "no usable exact receipt" means the fresh load
  // produced NO relevant GET, a non-200 status, or ZERO exact matches. A
  // load that DID produce an exact match (even running) is usable current
  // state — another reload is appropriate, never a reopen. Ambiguity and
  // explicit errors are terminal fail-closed conditions handled above.
  const usableExactReceipt = (result) => Boolean(result) &&
    result.ready && result.relevantGetObserved &&
    Number(result.httpStatus) === 200 && Number(result.exactMatchCount) === 1;

  try {
    let reloadSucceeded = false;
    let exactReceiptUsable = false;
    for (let attempt = 1; attempt <= PROJECT100_MVP_FRESH_SOURCES_MAX_RELOADS; attempt += 1) {
      if (Date.now() >= budgetEnd) {
        finish("DEADLINE");
        break;
      }
      // Minimum cadence between fresh navigations (never a tight loop).
      if (lastAttemptAt > 0) {
        const waitMs = lastAttemptAt + intervalMs - Date.now();
        if (waitMs > 0) {
          if (Date.now() + waitMs >= budgetEnd) {
            finish("DEADLINE");
            break;
          }
          await project100MvpDelay(waitMs);
        }
      }
      if (typeof chrome.tabs.reload !== "function" || currentTabId === null) {
        finish("RELOAD_FAILED");
        break;
      }
      const oldDocumentInstanceId = await currentDocumentInstanceId(currentTabId);
      try {
        await chrome.tabs.reload(currentTabId);
      } catch (_error) {
        finish("RELOAD_FAILED");
        break;
      }
      reloadSucceeded = true;
      lastAttemptAt = Date.now();
      const result = await runAttempt(attempt, "reload", currentTabId, oldDocumentInstanceId);
      if (!result) {
        finish("DEADLINE");
        break;
      }
      if (result.completionCandidateObserved) {
        finish("FRESH_COMPLETED");
        break;
      }
      if (result.ambiguousObserved) {
        finish("SOURCE_AMBIGUOUS");
        break;
      }
      if (result.noPreBaselineCandidate) {
        finish("NO_PRE_BASELINE");
        break;
      }
      if (result.explicitErrorObserved) {
        finish("EXPLICIT_SYNC_ERROR");
        break;
      }
      if (usableExactReceipt(result)) {
        exactReceiptUsable = true;
      }
      if (Date.now() >= budgetEnd) {
        finish("DEADLINE");
        break;
      }
    }

    // Reopen fallback (at most ONE): only when at least one reload navigation
    // itself succeeded but NO reload produced a usable exact receipt — no
    // relevant GET, non-200 status, or exactMatchCount === 0 (HY7 §9). A
    // running exact match is usable current state and never triggers reopen.
    // Reload API failures stay terminal RELOAD_FAILED.
    if (!evidence.terminalReason && reloadSucceeded && !exactReceiptUsable &&
        currentTabId !== null && Date.now() < budgetEnd) {
      let reopenUsed = 0;
      while (reopenUsed < PROJECT100_MVP_FRESH_SOURCES_REOPEN_MAX) {
        reopenUsed += 1;
        let reopenTabId = null;
        try {
          const reopenTab = await chrome.tabs.create({ url: binding.sourcePageUrl, active: false });
          reopenTabId = reopenTab && typeof reopenTab.id === "number" ? reopenTab.id : null;
        } catch (_error) {
          reopenTabId = null;
        }
        if (reopenTabId === null) {
          finish("REOPEN_FAILED");
          break;
        }
        const previousTabId = currentTabId;
        currentTabId = reopenTabId;
        lastAttemptAt = Date.now();
        // A reopened tab is a brand-new document on a brand-new tab; there is
        // no same-tab previous identity to exclude.
        const result = await runAttempt(evidence.attempts.length + 1, "reopen", reopenTabId, "");
        // The reopened page exists only to read state through the page's own
        // authenticated bootstrap; the previous temporary tab is now closed.
        if (typeof previousTabId === "number") {
          try {
            await chrome.tabs.remove(previousTabId);
          } catch (_error) {
            // Best-effort cleanup; never fails the diagnostic.
          }
        }
        if (!result) {
          finish("DEADLINE");
          break;
        }
        if (result.completionCandidateObserved) {
          finish("FRESH_COMPLETED");
          break;
        }
        if (result.ambiguousObserved) {
          finish("SOURCE_AMBIGUOUS");
          break;
        }
        if (result.noPreBaselineCandidate) {
          finish("NO_PRE_BASELINE");
          break;
        }
        if (result.explicitErrorObserved) {
          finish("EXPLICIT_SYNC_ERROR");
          break;
        }
        if (usableExactReceipt(result)) {
          // The reopen DID read usable current state, just not completion:
          // classify truthfully instead of claiming no receipt at all.
          finish(result.lastObservedStatus === "running"
            ? "MAX_RELOADS_RUNNING"
            : "MAX_RELOADS_STALE");
          break;
        }
        finish(reopenedOk(result) ? "NO_PAGE_OWNED_RECEIPT" : "REOPEN_FAILED");
        break;
      }
    }

    if (!evidence.terminalReason) {
      finish(!usableTrafficObserved
        ? "NO_PAGE_OWNED_RECEIPT"
        : (lastRelevantStatus === "running" ? "MAX_RELOADS_RUNNING" : "MAX_RELOADS_STALE"));
    }
  } finally {
    await project100MvpStoreFreshSourcesEvidence(evidence);
  }
  return { evidence, currentTabId };
}

// "Page still loading" answers may retry inside the readiness deadline.
// Structural conflicts mean ambiguity or a wrong page state, not loading —
// they fail closed immediately and are never resolved by auto-picking.
const PROJECT100_MVP_RETRYABLE_READY_ERRORS = new Set([
  "MATCHING_SOURCES_0",
  "ACTION_CONTROLS_0",
  "SYNC_STATE_UNREADABLE"
]);

// PING only proves the content script is alive; the bound Source row, its
// Drive link, its action menu and its sync state may still be rendering.
// Poll the read-only SOURCE_READY probe until it passes or the deadline is
// reached. Never waits forever, never sleeps a fixed single interval.
async function project100MvpWaitForBoundSourceReady(tabId, binding, timeoutError) {
  const deadline = Date.now() + PROJECT100_MVP_CONTENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let probe = null;
    try {
      probe = await chrome.tabs.sendMessage(tabId, {
        type: "PROJECT100_MVP_SOURCE_READY",
        filename: binding.filename,
        driveFileId: binding.driveFileId
      });
    } catch (_error) {
      // Content script not reachable yet; keep probing until the deadline.
    }
    if (probe && probe.status === "PASS") {
      return probe;
    }
    const probeError = probe && typeof probe.error === "string" ? probe.error : "";
    if (probeError && !PROJECT100_MVP_RETRYABLE_READY_ERRORS.has(probeError)) {
      throw new Error(probeError);
    }
    await project100MvpDelay(250);
  }
  throw new Error(timeoutError);
}

// ---- First Publish initiates onboarding (P1) -------------------------------
// Validate the current ChatGPT Project, use the latest artifact-bearing
// assistant scope frozen at operation start, run deterministic preflight before
// ANY Drive mutation, then request Google OAuth once for the whole batch.
// The frozen exact target identities are carried into every preflight/capture
// and persisted only as page-lifetime tokens in the pending intent; DOM nodes
// and artifact bytes never leave the content document. No Source binding is
// created on OAuth failure; no fake connected state is ever shown.
async function project100MvpRunFirstPublish(
  captureTab,
  captureTabUrl,
  frozenArtifactOperation,
  options = {}
) {
  const bindingBefore = await project100MvpReadBindingV2();
  if (project100MvpBindingV2Complete(bindingBefore) && bindingBefore.sourcePageUrl &&
      project100MvpEstablishmentState(bindingBefore) !== "INITIALIZING") {
    // Only reachable via internal misuse; the caller already routed this.
    throw new Error("NO_BINDING");
  }
  const sourcePageUrl = project100MvpDeriveSourcePageUrl(captureTabUrl);
  if (!sourcePageUrl) {
    // Step 1 of P1: validate the current ChatGPT Project.
    throw new Error("NOT_IN_PROJECT");
  }

  // Step 2: use the exact latest artifact-bearing scope frozen by the caller
  // at operation start. No current-chat re-discovery is allowed here.
  const frozen = frozenArtifactOperation
    ? project100MvpNormalizeFrozenArtifactOperation(frozenArtifactOperation)
    : await project100MvpFreezeArtifactOperation(captureTab.id);
  const filenames = frozen.targets.map((target) => target.exactFilename);
  const projectId = project100MvpProjectSegmentOf(sourcePageUrl);
  await project100MvpAssertSourceCreateIntentIdentity(filenames, projectId);
  const recoveryJob = await project100MvpBeginRecoveryJob({
    phase: "publishing",
    projectId,
    sourcePageUrl,
    captureTabId: captureTab.id,
    filenames,
    previousJob: options.previousRecoveryJob || null,
    frozenArtifactOperation: frozen,
    lifecycleState: "INITIALIZING",
    initialFilenames: filenames
  });
  await project100MvpWritePublishState(project100MvpPublishSnapshot("publishing",
    { filename: filenames[0] || "", driveFileId: "" }, {
      byteLength: 0,
      sha256: "",
      driveUpdated: false,
      resynced: false,
      error: "",
      partialMessage: "",
      publishedAt: "",
      fileCount: filenames.length,
      filesSaved: 0,
      lifecycleState: "INITIALIZING",
      transaction: "INITIALIZATION",
      perSource: project100MvpRecoverySourcesForPublishState(recoveryJob)
    }));

  // Step 2b: capture preflight — EVERY winning artifact must be capturable
  // before the first Drive mutation. Artifact bytes stay in this job's
  // memory only and are discarded; nothing is persisted.
  const preflightCaptures = await project100MvpRunCapturePreflight(captureTab.id, frozen);

  // Step 3: request Google OAuth ONCE for the whole batch. Failure leaves no
  // binding and no fake connected state; Retry stays available in the popup.
  try {
    await project100MvpGetAuthToken(true);
  } catch (_error) {
    throw new Error("ONBOARDING_OAUTH_FAILED");
  }

  // Step 4: ensure one Drive object per logical Source (recover or create),
  // persisted immediately per file. Recovery ambiguity is preflighted for the
  // WHOLE batch first: one ambiguous filename fails closed with zero creates.
  await project100MvpPreflightSourceRecovery(filenames, projectId);
  const now = new Date().toISOString();
  const sources = [];
  for (let sourceIndex = 0; sourceIndex < filenames.length; sourceIndex += 1) {
    const filename = filenames[sourceIndex];
    const captured = preflightCaptures.find((item) => item.target.exactFilename === filename);
    if (!captured) {
      throw new Error("ARTIFACT_TARGET_LOST");
    }
    const targetIdentity = project100MvpFrozenTargetIdentity(frozen, captured.target);
    const currentSource = recoveryJob.sources.find((entry) => entry.filename === filename);
    let contentPin = currentSource && currentSource.contentPin
      ? currentSource.contentPin
      : null;
    if (contentPin) {
      await project100MvpAssertContentPinMatchesCapture(
        contentPin, captured, targetIdentity);
    } else {
      const priorSource = options.previousRecoveryJob &&
        Array.isArray(options.previousRecoveryJob.sources)
        ? options.previousRecoveryJob.sources.find((entry) =>
          entry && entry.filename === filename)
        : null;
      if (project100MvpRecoverySourceHasMutationEvidence(currentSource) ||
          (project100MvpRecoveryJobMatchesFrozenOperation(
            options.previousRecoveryJob, frozen) &&
           project100MvpRecoverySourceHasMutationEvidence(priorSource))) {
        throw new Error("CONTENT_PIN_MISSING");
      }
      contentPin = project100MvpBuildContentPin(targetIdentity, captured);
    }
    await project100MvpUpdateRecoverySource(filename, { contentPin });
    await project100MvpUpdateRecoveryJob({
      phase: "creating",
      currentIndex: sourceIndex
    });
    await project100MvpUpdateRecoverySource(filename, {
      phase: "creating",
      status: "creating",
      saved: false,
      synced: false,
      resynced: false,
      resyncStatus: "pending",
      error: ""
    });
    const ensured = await project100MvpEnsureSourceFile(
      filename,
      projectId,
      captured.bytes,
      currentSource && currentSource.reservedDriveFileId,
      {
        reservedDriveFileId: currentSource && currentSource.reservedDriveFileId,
        operationToken: contentPin.operationToken,
        documentInstanceId: contentPin.documentInstanceId,
        frozenScopeToken: contentPin.frozenScopeToken,
        frozenTargetToken: contentPin.frozenTargetToken,
        exactFilename: contentPin.exactFilename,
        contentPinSha256: contentPin.sha256
      });
    sources.push({
      filename,
      driveFileId: ensured.driveFileId,
      driveUrl: ensured.driveUrl,
      sourceBound: false,
      createdAt: now,
      sourceBoundAt: ""
    });
    await project100MvpUpdateRecoverySource(filename, {
      driveFileId: ensured.driveFileId,
      phase: "onboarding",
      status: "onboarding",
      saved: false,
      synced: false,
      resynced: false,
      resyncStatus: "pending",
      error: ""
    });
  }

  // Step 5: persist the V2 binding and the pending Publish intent (survives
  // popup close and service-worker restarts). Document contents are never
  // persisted.
  const binding = {
    version: 2,
    projectId,
    sourcePageUrl: "",
    sources,
    establishment: project100MvpBuildEstablishmentRecord(
      "INITIALIZING", projectId, filenames, frozen),
    createdAt: now,
    updatedAt: now
  };
  await project100MvpWriteBindingV2(binding);
  for (const source of sources) {
    const recoverySource = project100MvpRecoveryJob &&
      Array.isArray(project100MvpRecoveryJob.sources)
      ? project100MvpRecoveryJob.sources.find((entry) =>
        entry && entry.filename === source.filename)
      : null;
    await project100MvpUpdateRecoverySource(source.filename, {
      driveFileId: source.driveFileId,
      byteLength: recoverySource && recoverySource.contentPin
        ? recoverySource.contentPin.byteLength : 0,
      sha256: recoverySource && recoverySource.contentPin
        ? recoverySource.contentPin.sha256 : "",
      phase: "onboarding",
      status: "onboarding",
      saved: false,
      synced: false,
      resynced: false,
      resyncStatus: "pending"
    });
  }
  await project100MvpUpdateRecoveryJob({
    phase: "onboarding",
    projectId,
    sourcePageUrl,
    retryable: false
  });
  const onboarding = {
    version: 2,
    phase: "canonical-ready",
    projectId,
    projectUrl: typeof captureTabUrl === "string" ? captureTabUrl : "",
    sourcePageUrl,
    captureTabId: typeof captureTab.id === "number" ? captureTab.id : null,
    onboardingTabId: null,
    filenames,
    frozenArtifactOperation: frozen,
    queue: sources.map((entry) => ({
      filename: entry.filename,
      driveFileId: entry.driveFileId,
      driveUrl: entry.driveUrl
    })),
    queueIndex: 0,
    // Popup clipboard compat: the current queue head's Drive link.
    driveUrl: sources.length > 0 ? sources[0].driveUrl : "",
    createdAt: now,
    updatedAt: now
  };
  await project100MvpWriteOnboardingState(onboarding);
  const publishState = project100MvpPublishSnapshot("onboarding",
    { filename: filenames[0] || "", driveFileId: sources[0] ? sources[0].driveFileId : "" }, {
    byteLength: 0,
    sha256: "",
    driveUpdated: false,
    resynced: false,
    error: "",
    partialMessage: "",
    publishedAt: "",
    fileCount: filenames.length,
    filesSaved: 0,
    lifecycleState: "INITIALIZING",
    transaction: "INITIALIZATION",
    perSource: []
  });
  await project100MvpWritePublishState(publishState);
  return { status: "PASS", publishState, onboarding };
}

// Capture preflight: every logical Source in the batch must be capturable
// through the frozen preview-download chain BEFORE the first Drive mutation.
// Bytes are validated then discarded (never persisted).
async function project100MvpRunCapturePreflight(captureTabId, frozenArtifactOperation) {
  const frozen = project100MvpNormalizeFrozenArtifactOperation(frozenArtifactOperation);
  const captures = [];
  for (const target of frozen.targets) {
    let captured = null;
    try {
      captured = await project100MvpWithTimeout(
        chrome.tabs.sendMessage(captureTabId, {
          type: "PROJECT100_MVP_CAPTURE_ARTIFACT",
          filename: target.exactFilename,
          driveFileId: "preflight-validation-only",
          frozenTargetIdentity: project100MvpFrozenTargetIdentity(frozen, target)
        }),
        PROJECT100_MVP_CAPTURE_RESPONSE_TIMEOUT_MS,
        "CAPTURE_NOT_RESPONDING"
      );
    } catch (error) {
      throw new Error(project100MvpSafeError(error) || "CAPTURE_NOT_RESPONDING");
    }
    if (!captured || captured.status !== "PASS") {
      const captureError = captured && Array.isArray(captured.errors) && captured.errors.length > 0
        ? captured.errors[0]
        : (captured && captured.error) || "ARTIFACT_NOT_FOUND";
      throw new Error(captureError);
    }
    const normalized = await project100MvpNormalizeCapturedArtifact(captured);
    captures.push({ target, ...normalized });
  }
  return captures;
}

function project100MvpReceiptTimestamp(value) {
  const text = String(value || "");
  const parsed = Date.parse(text);
  return text && Number.isFinite(parsed) ? parsed : 0;
}

function project100MvpInitialReceiptTimeline(receipt, operationStartedAt) {
  const boundary = project100MvpReceiptTimestamp(operationStartedAt);
  const createdAt = project100MvpReceiptTimestamp(receipt && receipt.createdAt);
  if (!boundary || !createdAt) {
    return { status: "BLOCKED", error: "RECEIPT_INITIAL_COMPLETION_UNPROVEN" };
  }
  if (createdAt < boundary) {
    // A pre-existing scope cannot establish this First Add operation, even if
    // its current status says completed.
    return { status: "BLOCKED", error: "RECEIPT_INITIAL_COMPLETION_STALE" };
  }
  const startedAtText = String(receipt.last_sync_started_at || "");
  const completedAtText = String(receipt.last_sync_completed_at || "");
  const startedAt = startedAtText ? project100MvpReceiptTimestamp(startedAtText) : 0;
  const completedAt = completedAtText ? project100MvpReceiptTimestamp(completedAtText) : 0;
  if (startedAtText && !startedAt || completedAtText && !completedAt) {
    return { status: "PROGRESS" };
  }
  if (startedAt && startedAt < createdAt) {
    return { status: "BLOCKED", error: "RECEIPT_LIFECYCLE_CONFLICT" };
  }
  if (completedAt && startedAt && completedAt < startedAt) {
    return { status: "BLOCKED", error: "RECEIPT_LIFECYCLE_CONFLICT" };
  }
  if (String(receipt.last_sync_status || "").toLowerCase() === "completed" &&
      completedAt && completedAt > boundary && startedAt) {
    return { status: "PASS" };
  }
  return { status: "PROGRESS" };
}

// First Add completion is read-only. A newly bound Source may already have
// completed naturally; that evidence can establish initialization without a
// synthetic PATCH or Resync. A current scope may first report PROGRESS and is
// polled inside a short bounded window. Any missing, weak, conflicting, stale,
// or incomplete receipt remains UNKNOWN and never establishes the Project.
async function project100MvpProbeInitialSourceCompletion(
  tabId, filename, driveFileId, sourcePageUrl, options = {}) {
  let response = null;
  try {
    response = await project100MvpWithTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "PROJECT100_MVP_CONNECTOR_SCOPE_RECEIPT",
        filename,
        driveFileId,
        sourcePageUrl,
        firstAdd: true
      }),
      Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs) : PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS,
      "INITIAL_COMPLETION_UNPROVEN"
    );
  } catch (_error) {
    return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
  }
  if (!response || !response.receipt ||
      (response.status !== "PASS" && response.status !== "PROGRESS")) {
    return {
      status: "BLOCKED",
      error: String(response && response.error || "INITIAL_COMPLETION_UNPROVEN")
    };
  }
  const receipt = response.receipt;
  const projectId = project100MvpProjectSegmentOf(sourcePageUrl);
  if (String(receipt.projectId || "") !== projectId ||
      String(receipt.connectorType || "") !== PROJECT100_MVP_SOURCE_CONNECTOR_TYPE ||
      String(receipt.canonicalHandle || "") !== String(driveFileId || "") ||
      !String(receipt.scopeId || "") ||
      String(receipt.sync_error_code || "") ||
      String(receipt.sync_error_message || "")) {
    return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
  }
  const timeline = project100MvpInitialReceiptTimeline(
    receipt, options.operationStartedAt);
  if (timeline.status === "BLOCKED") {
    return timeline;
  }
  if (timeline.status !== "PASS") {
    return { status: "PROGRESS", receipt };
  }
  return {
    status: "PASS",
    receipt,
    identity: {
      projectId,
      connectorType: PROJECT100_MVP_SOURCE_CONNECTOR_TYPE,
      canonicalHandle: String(driveFileId),
      scopeId: String(receipt.scopeId),
      createdAt: String(receipt.createdAt),
      startedAt: String(receipt.last_sync_started_at),
      completedAt: String(receipt.last_sync_completed_at)
    }
  };
}

async function project100MvpProbeInitialSourceCompletionIdentity(
  tabId, filename, driveFileId, sourcePageUrl, operationStartedAt, deadline) {
  while (Date.now() < deadline) {
    const timeoutMs = project100MvpRemainingTimeout(
      deadline, PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS);
    if (!timeoutMs) {
      break;
    }
    const observation = await project100MvpProbeInitialSourceCompletion(
      tabId, filename, driveFileId, sourcePageUrl, {
        operationStartedAt,
        timeoutMs
      });
    if (observation.status === "PASS" && observation.identity) {
      return observation.identity;
    }
    if (observation.status === "BLOCKED") {
      return null;
    }
    const delayMs = project100MvpRemainingTimeout(deadline, PROJECT100_MVP_RECEIPT_POLL_MS);
    if (!delayMs) {
      break;
    }
    await project100MvpDelay(delayMs);
  }
  return null;
}

async function project100MvpCompleteInitializationFromNativeAdd(
  state, binding, tabId, recoveryJobInput = null) {
  if (!binding || !Array.isArray(binding.sources) ||
      !project100MvpBindingV2AllBound(binding)) {
    return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
  }
  const operationProjectId = project100MvpNormalizeProjectId(
    project100MvpActiveProjectId);
  const job = recoveryJobInput || project100MvpRecoveryJob ||
    await project100MvpReadRecoveryJob(operationProjectId);
  if (!job || String(job.establishment && job.establishment.state ||
      job.lifecycleState || "") !== "INITIALIZING") {
    return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
  }
  let frozen = null;
  try {
    frozen = project100MvpNormalizeFrozenArtifactOperation(
      state && state.frozenArtifactOperation);
  } catch (_error) {
    return { status: "BLOCKED", error: "ARTIFACT_TARGET_LOST" };
  }
  if (!project100MvpRecoveryJobMatchesFrozenOperation(job, frozen) ||
      String(job.projectId || "") !== String(state && state.projectId || "")) {
    return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
  }
  const initialFilenames = Array.isArray(job.establishment &&
      job.establishment.initialFilenames) &&
      job.establishment.initialFilenames.length > 0
    ? job.establishment.initialFilenames.slice()
    : (Array.isArray(job.filenames) ? job.filenames.slice() : []);
  const filenames = Array.isArray(job.filenames) ? job.filenames.slice() : [];
  if (!project100MvpSameFilenameSet(
      initialFilenames, frozen.targets.map((target) => target.exactFilename)) ||
      !project100MvpSameFilenameSet(
        initialFilenames, Array.isArray(state && state.filenames)
          ? state.filenames : []) ||
      !project100MvpSameFilenameSet(initialFilenames, filenames)) {
    return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
  }
  const identities = [];
  const scopeIds = new Set();
  const completionDeadline = Date.now() + PROJECT100_MVP_INITIAL_COMPLETION_WINDOW_MS;
  for (const filename of initialFilenames) {
    const entry = binding.sources.find((item) => item.filename === filename);
    if (!entry) {
      return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
    }
    const identity = await project100MvpProbeInitialSourceCompletionIdentity(
      tabId,
      entry.filename,
      entry.driveFileId,
      state.sourcePageUrl,
      job.createdAt,
      completionDeadline);
    if (!identity) {
      return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
    }
    if (scopeIds.has(identity.scopeId)) {
      return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN" };
    }
    scopeIds.add(identity.scopeId);
    identities.push({ filename: entry.filename, identity });
  }
  const saved = filenames.map((filename) => {
    const source = job.sources.find((entry) => entry.filename === filename);
    return {
      filename,
      driveFileId: source && source.driveFileId,
      byteLength: Number(source && source.byteLength) || 0,
      sha256: String(source && source.sha256 || "")
    };
  });
  if (saved.some((item) => !item.driveFileId || !item.byteLength ||
      !/^[a-f0-9]{64}$/.test(item.sha256))) {
    throw new Error("INITIAL_COMPLETION_UNPROVEN");
  }
  for (const item of identities) {
    const entry = binding.sources.find((source) => source.filename === item.filename);
    if (!entry) {
      throw new Error("INITIAL_COMPLETION_UNPROVEN");
    }
    entry.completionIdentity = item.identity;
  }
  binding.updatedAt = new Date().toISOString();
  await project100MvpWriteBindingV2(binding, operationProjectId);
  const syncResults = saved.map((item) => ({
    filename: item.filename,
    driveFileId: item.driveFileId,
    synced: true,
    resynced: false,
    completionIdentity: identities.find((entry) => entry.filename === item.filename).identity
  }));
  const establishedBinding = await project100MvpCommitEstablishedInitialization(
    job, filenames, saved, syncResults);
  for (const item of saved) {
    const identity = syncResults.find((result) => result.filename === item.filename)
      .completionIdentity;
    await project100MvpUpdateRecoverySource(item.filename, {
      phase: "published",
      status: "published",
      saved: true,
      synced: true,
      resynced: false,
      resyncStatus: "not-required",
      completionIdentity: identity,
      error: ""
    }, operationProjectId);
  }
  await project100MvpFinishRecoveryJob("published", "", operationProjectId);
  const publishedState = project100MvpPublishSnapshot("published", {
    filename: filenames[0] || "",
    driveFileId: saved[0] ? saved[0].driveFileId : ""
  }, {
    byteLength: saved.reduce((sum, item) => sum + item.byteLength, 0),
    sha256: saved[0] ? saved[0].sha256 : "",
    driveUpdated: true,
    resynced: false,
    error: "",
    partialMessage: "",
    publishedAt: new Date().toISOString(),
    fileCount: filenames.length,
    filesSaved: saved.length,
    lifecycleState: "ESTABLISHED",
    transaction: "INITIALIZATION",
    perSource: project100MvpRecoverySourcesForPublishState(project100MvpRecoveryJob),
    completion: "native-add-completed"
  });
  await project100MvpWritePublishState(publishedState, operationProjectId);
  await project100MvpClearOnboardingState(operationProjectId);
  return { status: "PASS", establishedBinding, publishState: publishedState };
}

// Multi-source v1 continue-connection path: (re)open the ACTIVE onboarding
// Sources tab and arm the page-local auto-bind watcher on the CURRENT QUEUE
// HEAD. Idempotent while the watcher is already live; the automatic clipboard
// copy itself is performed by the popup inside the original Publish click
// gesture (first queue entry only; later entries use the banner's
// extension-owned "Copy next link" button).
async function project100MvpOnboardingProceed(message) {
  const projectId = project100MvpNormalizeProjectId(message && message.projectId);
  const state = await project100MvpReadOnboardingState(projectId);
  if (!state) {
    throw new Error("ONBOARDING_NOT_PENDING");
  }
  if (projectId && project100MvpRecordProjectId(state) &&
      project100MvpRecordProjectId(state) !== projectId) {
    throw new Error("PROJECT_CONTEXT_MISMATCH");
  }
  const binding = await project100MvpReadBindingV2(projectId);
  if (project100MvpBindingV2AllBound(binding) && binding.sourcePageUrl) {
    const lifecycleState = project100MvpEstablishmentState(binding);
    if (lifecycleState === "UNKNOWN") {
      // allBound is only a connection fact. Missing lifecycle proof must not
      // be treated as an established Project or clear the pending state.
      throw new Error("SOURCE_NOT_ESTABLISHED");
    }
    if (lifecycleState === "ESTABLISHED") {
      project100MvpValidateEstablishedBinding(binding);
      // Binding already complete: nothing pending.
      await project100MvpClearOnboardingState(projectId);
      return { status: "PASS", onboarding: null };
    }
    // INITIALIZING deliberately falls through: allBound still cannot prove
    // establishment, and the existing onboarding/resume path owns completion.
  }
  let tabId = typeof state.onboardingTabId === "number" ? state.onboardingTabId : null;
  let tabAlive = false;
  if (tabId !== null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabAlive = Boolean(tab && typeof tab.id === "number");
    } catch (_error) {
      tabAlive = false;
    }
  }
  if (!tabAlive) {
    const tab = await chrome.tabs.create({ url: state.sourcePageUrl, active: true });
    tabId = tab && typeof tab.id === "number" ? tab.id : null;
    if (tabId === null) {
      throw new Error("ONBOARDING_PAGE_NOT_READY");
    }
  }
  await project100MvpWaitForContentScript(tabId, "ONBOARDING_PAGE_NOT_READY");
  // linkCopied is the popup's truthful clipboard outcome for this proceed:
  // the page banner must never claim "Drive link copied" when the automatic
  // copy actually failed.
  const linkCopied = Boolean(message && message.linkCopied);
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const head = queue[state.queueIndex] || queue[0] || null;
  if (!head) {
    throw new Error("ONBOARDING_QUEUE_EMPTY");
  }
  const watchResponse = await chrome.tabs.sendMessage(tabId, {
    type: "PROJECT100_ONBOARDING_ARM_WATCH",
    ...(projectId ? { projectId } : {}),
    filename: head.filename,
    driveFileId: head.driveFileId,
    driveUrl: head.driveUrl || "",
    queueIndex: state.queueIndex,
    queueTotal: queue.length,
    windowMs: PROJECT100_MVP_ONBOARDING_WATCH_MS,
    linkCopied
  });
  if (!watchResponse || watchResponse.status !== "PASS") {
    throw new Error("ONBOARDING_WATCH_ARM_FAILED");
  }
  if (watchResponse.bound) {
    // Deterministic race guard (Issue C repair, multi-source edition): the
    // immediate existing-Source probe already fired
    // PROJECT100_MVP_ONBOARDING_SOURCE_DETECTED, whose handler is the SOLE
    // owner of every queue transition (write binding -> persist progress ->
    // advance). Writing any snapshot of `state` here could land AFTER that
    // handler advanced or cleared the onboarding state and resurrect stale
    // pending state. Re-read instead and never write on this branch.
    const current = await project100MvpReadOnboardingState(projectId);
    return { status: "PASS", onboarding: current, bound: true };
  }
  state.phase = "watching";
  state.onboardingTabId = tabId;
  state.updatedAt = new Date().toISOString();
  await project100MvpWriteOnboardingState(state, projectId);
  return { status: "PASS", onboarding: state };
}

// Auto-bind landing (sent by the onboarding tab's content script the moment
// exactly one Source matching the CURRENT QUEUE HEAD matched): persist the
// binding entry, advance the queue, re-arm the watcher for the next entry on
// the SAME Sources tab. Only the LAST entry performs the terminal transition:
// clear onboarding, close the ACTIVE onboarding tab, refocus the original
// chat tab and automatically resume the original Publish — exactly once.
async function project100MvpOnboardingSourceDetected(message, sender) {
  const projectId = project100MvpNormalizeProjectId(message && message.projectId);
  if (projectId) {
    project100MvpActiveProjectId = projectId;
  }
  const state = await project100MvpReadOnboardingState(projectId);
  if (!state) {
    return { status: "PASS", ignored: "NO_ONBOARDING" };
  }
  if (projectId && project100MvpRecordProjectId(state) &&
      project100MvpRecordProjectId(state) !== projectId) {
    throw new Error("PROJECT_CONTEXT_MISMATCH");
  }
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const head = queue[state.queueIndex] || null;
  if (!head) {
    return { status: "PASS", ignored: "ONBOARDING_QUEUE_EMPTY" };
  }
  let driveFileId = "";
  let filename = "";
  try {
    driveFileId = project100MvpNormalizeDriveFileId(message && message.driveFileId);
    filename = project100MvpNormalizeLogicalFilename(message && message.filename);
  } catch (_error) {
    return { status: "BLOCKED", error: "ONBOARDING_IDENTITY_MISMATCH" };
  }
  if (driveFileId !== head.driveFileId || filename !== head.filename) {
    // Only the current queue head may bind; a stale or future detection is
    // never applied.
    return { status: "BLOCKED", error: "ONBOARDING_IDENTITY_MISMATCH" };
  }
  const binding = await project100MvpReadBindingV2(projectId);
  if (!binding || !Array.isArray(binding.sources)) {
    throw new Error("SOURCE_NOT_BOUND");
  }
  const entry = binding.sources.find((item) => item.filename === head.filename);
  if (!entry || entry.driveFileId !== head.driveFileId) {
    throw new Error("SOURCE_BINDING_DOES_NOT_MATCH_DRIVE_FILE");
  }
  // Persist the bound entry, then advance the queue — durable BEFORE any tab
  // cleanup or resume, so an interruption can never re-queue a bound Source.
  entry.sourceBound = true;
  entry.sourceBoundAt = new Date().toISOString();
  binding.sourcePageUrl = project100MvpNormalizeSourcePageUrl(state.sourcePageUrl);
  binding.projectId = binding.projectId || state.projectId || "";
  binding.updatedAt = new Date().toISOString();
  await project100MvpWriteBindingV2(binding, projectId);

  state.queueIndex += 1;
  state.updatedAt = new Date().toISOString();
  const onboardingTabId = sender && sender.tab && typeof sender.tab.id === "number"
    ? sender.tab.id
    : (typeof state.onboardingTabId === "number" ? state.onboardingTabId : null);

  if (state.queueIndex < queue.length) {
    // Queue progress persists, then the SAME tab re-arms for the next head.
    // If the next Source already exists on the page, the re-arm's immediate
    // probe detects and binds it without any user action.
    state.driveUrl = queue[state.queueIndex].driveUrl || "";
    state.phase = "watching";
    // Persist the SAME tab for the next Continue connection: one ACTIVE
    // Sources tab for the whole queue (§13-14). Losing this would make the
    // next PROCEED open a second Sources tab while the first is still open.
    if (onboardingTabId !== null) {
      state.onboardingTabId = onboardingTabId;
    }
    await project100MvpWriteOnboardingState(state, projectId);
    const nextHead = queue[state.queueIndex];
    if (onboardingTabId !== null) {
      try {
        await chrome.tabs.sendMessage(onboardingTabId, {
          type: "PROJECT100_ONBOARDING_ARM_WATCH",
          ...(projectId ? { projectId } : {}),
          filename: nextHead.filename,
          driveFileId: nextHead.driveFileId,
          driveUrl: nextHead.driveUrl || "",
          queueIndex: state.queueIndex,
          queueTotal: queue.length,
          windowMs: PROJECT100_MVP_ONBOARDING_WATCH_MS,
          linkCopied: false
        });
      } catch (_error) {
        // A later Continue connection re-arms the watcher.
      }
    }
    return { status: "PASS", advanced: true, queueIndex: state.queueIndex };
  }

  // Queue complete: the terminal transition. The pending intent must remain
  // discoverable until the resume publishes the SAME artifact set
  // (resume safety), so it is kept with a terminal marker and cleared by the
  // resumed publish (or a later Continue connection / Publish).
  state.phase = "resume-pending";
  state.onboardingTabId = null;
  await project100MvpWriteOnboardingState(state, projectId);
  let nativeCompletion = null;
  const inMemoryRecoveryMatches = project100MvpRecoveryJob &&
    (!projectId || project100MvpRecordProjectId(project100MvpRecoveryJob) === projectId);
  const recoveryForNativeCompletion = inMemoryRecoveryMatches
    ? project100MvpRecoveryJob
    : await project100MvpReadRecoveryJob(projectId);
  if (projectId) {
    // An onboarding event carries the exact Project context. Make the
    // in-memory checkpoint follow that namespace even when another Project's
    // terminal job is still resident in this MV3 worker. This is only a
    // rehydration of the same durable job; it is not a new operation and
    // never performs artifact discovery or filename-based recovery.
    project100MvpRecoveryJob = recoveryForNativeCompletion || null;
  } else if (!project100MvpRecoveryJob && recoveryForNativeCompletion) {
    // Legacy direct-worker fixtures have no Project context; retain their
    // historical compatibility behavior.
    project100MvpRecoveryJob = recoveryForNativeCompletion;
  }
  const hasInitializingRecovery = Boolean(recoveryForNativeCompletion &&
    String(recoveryForNativeCompletion.establishment &&
      recoveryForNativeCompletion.establishment.state ||
      recoveryForNativeCompletion.lifecycleState || "") === "INITIALIZING");
  // The natural First Add proof may finish without another artifact capture,
  // but it must not turn a lost page-lifetime target into an implicit
  // recovery.  The original capture document is the authority for the frozen
  // target; if it is gone, let the normal resumed Publish report
  // CAPTURE_TAB_GONE and never establish from a replacement document.
  let captureTabAvailable = true;
  const originalCaptureTabId = typeof state.captureTabId === "number"
    ? state.captureTabId : null;
  if (originalCaptureTabId !== null) {
    try {
      const originalCaptureTab = await chrome.tabs.get(originalCaptureTabId);
      captureTabAvailable = Boolean(originalCaptureTab &&
        typeof originalCaptureTab.id === "number");
    } catch (_error) {
      captureTabAvailable = false;
    }
  }
  if (onboardingTabId !== null && hasInitializingRecovery && captureTabAvailable) {
    nativeCompletion = await project100MvpCompleteInitializationFromNativeAdd(
      state, binding, onboardingTabId, recoveryForNativeCompletion);
    if (!nativeCompletion || nativeCompletion.status !== "PASS") {
      await project100MvpFinishRecoveryJob(
        "failed", "INITIAL_COMPLETION_UNPROVEN", projectId);
      const failedState = project100MvpPublishSnapshot("failed", {
        filename: queue.map((item) => item.filename)[0] || "",
        driveFileId: queue[0] ? queue[0].driveFileId : ""
      }, {
        byteLength: 0,
        sha256: "",
        driveUpdated: true,
        resynced: false,
        error: "INITIAL_COMPLETION_UNPROVEN",
        partialMessage: "首次添加已完成，但当前 Source completion 无法证明",
        publishedAt: "",
        fileCount: queue.length,
        filesSaved: 0,
        lifecycleState: "INITIALIZING",
        transaction: "INITIALIZATION",
        perSource: project100MvpRecoverySourcesForPublishState(project100MvpRecoveryJob)
      });
      await project100MvpWritePublishState(failedState, projectId);
      await project100MvpClearOnboardingState(projectId);
    }
  }
  if (onboardingTabId !== null) {
    try {
      await chrome.tabs.sendMessage(onboardingTabId, { type: "PROJECT100_ONBOARDING_DISARM_WATCH" });
    } catch (_error) {
      // Tab may already be closing.
    }
    try {
      await chrome.tabs.remove(onboardingTabId);
    } catch (_error) {
      // Best-effort cleanup.
    }
  }
  const captureTabId = typeof state.captureTabId === "number" ? state.captureTabId : null;
  if (captureTabId !== null) {
    try {
      await chrome.tabs.update(captureTabId, { active: true });
    } catch (_error) {
      // The original tab may be gone; the resumed publish reports truthfully.
    }
    try {
      const tab = await chrome.tabs.get(captureTabId);
      if (tab && typeof tab.windowId === "number" && chrome.windows &&
          typeof chrome.windows.update === "function") {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (_error) {
      // Best-effort focus restoration.
    }
  }
  if (nativeCompletion && nativeCompletion.status === "PASS") {
    return { ...nativeCompletion, resumed: false, complete: true };
  }
  if (nativeCompletion && nativeCompletion.status !== "PASS") {
    return { status: "BLOCKED", error: "INITIAL_COMPLETION_UNPROVEN", complete: true };
  }
  // Exactly one Publish resume through the normal production path, reusing the
  // persisted frozen operation (capture -> Drive PATCH -> exact readback ->
  // one Resync per Source -> Fresh Sources). No filename re-selection occurs.
  if (captureTabId !== null) {
    void project100MvpRunPublish({
      captureTabId,
      resumedFromOnboarding: true,
      projectId
    }).catch(() => {
      // The continuation persists its own truthful terminal state.
    });
  }
  return { status: "PASS", resumed: captureTabId !== null, complete: true };
}

async function project100MvpRunPublish(options = {}) {
  if (project100MvpPublishRunning) {
    return { status: "BLOCKED", error: "PUBLISH_BUSY" };
  }
  project100MvpPublishRunning = true;
  // Popup calls carry the exact current Project. A missing value is retained
  // as the legacy compatibility path used by the older focused harnesses.
  project100MvpActiveProjectId = project100MvpNormalizeProjectId(options.projectId);
  let binding = null;
  let captured = null;
  let updated = null;
  let captureDiagnostics = null;
  let driveGate = null;
  let captureTab = null;
  let filenames = [];
  let frozenArtifactOperation = null;
  let pendingIntent = null;
  let previousRecoveryJob = null;
  let previousPublishState = null;
  let lifecycleState = "UNKNOWN";
  let lifecycleInfo = null;
  let establishedInfo = null;
  const perSource = [];
  try {
    // Capture tab: the explicitly resumed tab (auto-resumed onboarding
    // publish) or the active tab (normal popup Publish click).
    if (typeof options.captureTabId === "number") {
      try {
        captureTab = await chrome.tabs.get(options.captureTabId);
      } catch (_error) {
        captureTab = null;
      }
      if (!captureTab || typeof captureTab.id !== "number") {
        // Truthful failure: the original capture tab is gone; the user must
        // return to the Project chat and publish again. Never capture from
        // another tab silently.
        throw new Error("CAPTURE_TAB_GONE");
      }
    } else {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      captureTab = activeTabs[0];
    }
    if (!captureTab || typeof captureTab.id !== "number") {
      throw new Error("CAPTURE_TAB_NOT_READY");
    }
    const captureTabUrl = typeof captureTab.url === "string" ? captureTab.url
      : await project100MvpGetTabUrl(captureTab.id);
    const captureProjectId = project100MvpProjectSegmentOf(captureTabUrl);
    if (project100MvpActiveProjectId && captureProjectId &&
        project100MvpActiveProjectId !== captureProjectId) {
      throw new Error("PROJECT_CONTEXT_MISMATCH");
    }

    binding = await project100MvpReadBindingV2(project100MvpActiveProjectId);
    previousPublishState = await project100MvpReadPublishState(
      project100MvpActiveProjectId);
    previousRecoveryJob = await project100MvpReadRecoveryJob(
      project100MvpActiveProjectId);
    if (project100MvpActiveProjectId) {
      // Only one publish transaction runs at a time. Once its explicit
      // Project is known, make the in-memory checkpoint follow that same
      // namespace instead of retaining a terminal job from the last Project.
      project100MvpRecoveryJob = previousRecoveryJob || null;
    }
    lifecycleState = project100MvpEstablishmentState(binding);
    if (binding && lifecycleState === "INITIALIZING") {
      lifecycleInfo = project100MvpValidateInitializingBinding(binding);
    } else if (binding && lifecycleState === "ESTABLISHED") {
      establishedInfo = project100MvpValidateEstablishedBinding(binding);
    } else if (binding) {
      // A partial binding may temporarily lack its establishment field only
      // when the matching durable recovery job proves the same INITIALIZING
      // transaction. A legacy/malformed binding without that proof is UNKNOWN.
      lifecycleInfo = project100MvpValidatePartialInitializingRecovery(
        binding, previousRecoveryJob, captureTabUrl);
      if (lifecycleInfo) {
        lifecycleState = "INITIALIZING";
      } else {
        // Stop before capture, Drive, onboarding or Resync.
        throw new Error("SOURCE_NOT_ESTABLISHED");
      }
    }
    // A durable record belongs to one Project. Never let a stale job from a
    // different binding become evidence or a preserve-confirmed source for a
    // new task that happens to use the same filename.
    const recoveryJobMatchesBinding = project100MvpRecoveryJobMatchesBinding(
      previousRecoveryJob, binding);
    // A first Publish can fail at OAuth before a V2 binding exists. In that
    // narrow retry case, the same-tab frozen operation is the only durable
    // carrier of the original page-lifetime target identity. Treat the
    // matching failed/interrupted job as the current operation; do not clear
    // it merely because the binding is still absent.
    const recoveryJobMatchesCurrentUnboundPublish = Boolean(
      !binding && previousPublishState &&
      (previousPublishState.status === "failed" ||
        previousPublishState.status === "interrupted") &&
      project100MvpRecoveryJobMatchesCurrentUnboundPublish(
        previousRecoveryJob, captureTabUrl, captureTab.id));
    const recoveryJobMatchesCurrentPublish = recoveryJobMatchesBinding ||
      recoveryJobMatchesCurrentUnboundPublish;
    const visibleStateHasUncertainResync =
      project100MvpPublishStateHasUncertainResync(previousPublishState);
    const recoveryJobHasUncertainResync =
      project100MvpRecoveryHasUncertainResync(previousRecoveryJob);
    const recoveryJobIdentityMismatch = Boolean(previousRecoveryJob &&
      !recoveryJobMatchesCurrentPublish);
    if (recoveryJobIdentityMismatch &&
        (recoveryJobHasUncertainResync || visibleStateHasUncertainResync)) {
      // A mismatched job cannot be used as evidence for the current binding,
      // but an uncertain click (or an older visible state that still records
      // one) must not be erased and replaced by a new job. Stop before any
      // capture, Drive write/create or Resync, while retaining the durable
      // record for an operator to reconcile against its original identity.
      const blockedState = project100MvpIdentityMismatchBlockedState(
        previousPublishState, previousRecoveryJob);
      project100MvpPublishRunning = false;
      await project100MvpWritePublishState(
        blockedState, project100MvpActiveProjectId);
      return {
        status: "BLOCKED",
        error: "RECOVERY_IDENTITY_MISMATCH",
        publishState: blockedState
      };
    }
    if (!recoveryJobMatchesCurrentPublish) {
      previousRecoveryJob = null;
    }
    const retryingInterrupted = Boolean(previousPublishState &&
      previousPublishState.status === "interrupted");
    const retryingRecovery = retryingInterrupted || Boolean(previousPublishState &&
      previousPublishState.status === "failed");
    if (retryingRecovery && project100MvpRecoveryHasUncertainResync(previousRecoveryJob)) {
      // A click may have reached ChatGPT before the old worker disappeared.
      // First run the bounded read-only receipt/DOM probe. Only evidence that
      // proves the exact bound Source completed may clear the checkpoint;
      // the probe itself never clicks a second time or mutates Drive.
      const evidence = await project100MvpReconcileUncertainResyncEvidence(
        previousRecoveryJob, binding);
        previousRecoveryJob = evidence && evidence.job
        ? evidence.job
        : await project100MvpReadRecoveryJob(project100MvpActiveProjectId);
      if (!evidence || !evidence.resolved) {
        project100MvpPublishRunning = false;
        const blockedState = {
          ...previousPublishState,
          ...(previousRecoveryJob ? project100MvpRecoveryStateFields(previousRecoveryJob) : {}),
          error: "RESYNC_EVIDENCE_REQUIRED",
          partialMessage: "已中断，可重试；请先核对同步结果",
          retryable: true,
          perSource: previousRecoveryJob
            ? project100MvpRecoverySourcesForPublishState(previousRecoveryJob)
            : previousPublishState.perSource
        };
        await project100MvpWritePublishState(
          blockedState, project100MvpActiveProjectId);
        return {
          status: "BLOCKED",
          error: "RESYNC_EVIDENCE_REQUIRED",
          publishState: blockedState
        };
      }
    }

    pendingIntent = await project100MvpReadOnboardingState(project100MvpActiveProjectId);
    const pendingFrozen = pendingIntent && pendingIntent.frozenArtifactOperation
      ? pendingIntent.frozenArtifactOperation
      : null;
    const retryFrozen = previousRecoveryJob &&
      (previousRecoveryJob.retryable || project100MvpRecoveryIsActiveJob(previousRecoveryJob))
      ? previousRecoveryJob.frozenArtifactOperation
      : null;
    const lifecycleFrozen = lifecycleInfo && lifecycleInfo.frozen
      ? lifecycleInfo.frozen
      : null;
    const continuationRequiresFrozen = Boolean(
      options.resumedFromOnboarding || pendingIntent ||
      (retryingRecovery && previousRecoveryJob) ||
      (binding && lifecycleState === "INITIALIZING"));
    const reusableFrozen = pendingFrozen || retryFrozen || lifecycleFrozen || null;
    if (reusableFrozen) {
      frozenArtifactOperation = project100MvpNormalizeFrozenArtifactOperation(reusableFrozen);
    } else if (continuationRequiresFrozen) {
      // A pending operation from before PC-1A has no safe target identity.
      // Never replace it with a fresh filename lookup.
      throw new Error("ARTIFACT_TARGET_LOST");
    }

    // First publish / unfinished onboarding: OAuth + per-file Drive ensure
    // are part of the first Publish. No prior Connect Drive step exists.
    if (!binding ||
        (lifecycleState === "INITIALIZING" &&
          (!project100MvpBindingV2Complete(binding) || !binding.sourcePageUrl))) {
      const onboardingResult = await project100MvpRunFirstPublish(
        captureTab,
        captureTabUrl,
        frozenArtifactOperation,
        { previousRecoveryJob });
      project100MvpPublishRunning = false;
      return onboardingResult;
    }

    // One-project v1 rule: a different Project must never silently publish
    // into the bound Project. Fail with an actionable error instead.
    const captureSegment = project100MvpProjectSegmentOf(captureTabUrl);
    const boundSegment = project100MvpProjectSegmentOf(binding.sourcePageUrl);
    if (captureSegment && boundSegment && captureSegment !== boundSegment) {
      throw new Error("PROJECT_MISMATCH");
    }

    // Current operation identity was frozen once at Publish start. Capture
    // never re-runs page status or selects a same-name occurrence.
    if (!frozenArtifactOperation) {
      frozenArtifactOperation = await project100MvpFreezeArtifactOperation(captureTab.id);
    }
    filenames = frozenArtifactOperation.targets.map((target) => target.exactFilename);

    if (lifecycleState === "INITIALIZING") {
      project100MvpAssertInitialFrozenOperation(
        lifecycleInfo && lifecycleInfo.record,
        frozenArtifactOperation);
    }

    // Resume safety (§18): a resumed publish must publish exactly the
    // artifact set recorded in the pending intent — never a silently
    // different batch.
    if (pendingIntent && pendingIntent.phase === "resume-pending") {
      const expected = Array.isArray(pendingIntent.filenames)
        ? [...pendingIntent.filenames].sort()
        : [];
      const actual = [...filenames].sort();
      if (expected.length !== actual.length ||
          expected.some((value, index) => value !== actual[index])) {
        await project100MvpClearOnboardingState();
        throw new Error("ARTIFACT_SET_CHANGED");
      }
      await project100MvpClearOnboardingState();
    }

    const initialization = lifecycleState === "INITIALIZING";
    const previousOperationMatches = project100MvpRecoveryJobMatchesFrozenOperation(
      previousRecoveryJob, frozenArtifactOperation);
    // INITIALIZING may continue the original frozen set and may onboard only
    // its still-unbound entries. ESTABLISHED is a different transaction:
    // Refresh is the exact intersection of the frozen names and the complete
    // established binding set. No unmatched name enters onboarding.
    const unboundFilenames = initialization
      ? filenames.filter((filename) => {
        const entry = binding.sources.find((item) => item.filename === filename);
        return !entry || !entry.sourceBound || !entry.driveFileId;
      })
      : [];
    const refreshFilenames = initialization
      ? filenames.slice()
      : filenames.filter((filename) => establishedInfo.filenames.includes(filename));
    const unmatchedFilenames = initialization
      ? []
      : filenames.filter((filename) => !refreshFilenames.includes(filename));

    const recoveryProjectId = binding.projectId || captureSegment;
    await project100MvpAssertSourceCreateIntentIdentity(filenames, recoveryProjectId);
    // Explicit established refreshes and all-bound INITIALIZING continuations
    // are Drive work with no later onboarding auth step to own the token.
    // Reacquire a memory-only token after a worker restart, but never turn an
    // automatic onboarding resume into an unsolicited OAuth prompt, and never
    // duplicate the later onboarding OAuth for still-unbound Sources.
    const explicitDriveWorkNeedsAuth = refreshFilenames.length > 0 &&
      !options.resumedFromOnboarding &&
      (lifecycleState === "ESTABLISHED" ||
        (lifecycleState === "INITIALIZING" && unboundFilenames.length === 0));
    if (explicitDriveWorkNeedsAuth) {
      await project100MvpGetAuthToken(true);
    }
    const preservePreviousOperation = Boolean(previousRecoveryJob &&
      (retryingRecovery || options.resumedFromOnboarding || pendingIntent ||
        lifecycleState === "INITIALIZING"));
    const recoveryJob = await project100MvpBeginRecoveryJob({
      phase: "publishing",
      projectId: recoveryProjectId,
      sourcePageUrl: binding.sourcePageUrl,
      captureTabId: captureTab.id,
      filenames,
      previousJob: preservePreviousOperation ? previousRecoveryJob : null,
      preserveConfirmed: retryingRecovery,
      frozenArtifactOperation,
      lifecycleState,
      initialFilenames: initialization
        ? lifecycleInfo.record.initialFilenames
        : establishedInfo.filenames
    });

    for (const filename of unmatchedFilenames) {
      await project100MvpUpdateRecoverySource(filename, {
        phase: "rejected",
        status: "rejected",
        saved: false,
        synced: false,
        resynced: false,
        resyncStatus: "rejected",
        error: "SOURCE_NOT_ESTABLISHED"
      });
      perSource.push({
        filename,
        driveFileId: "",
        saved: false,
        phase: "rejected",
        status: "rejected",
        synced: false,
        resynced: false,
        resyncStatus: "rejected",
        byteLength: 0,
        sha256: "",
        error: "SOURCE_NOT_ESTABLISHED"
      });
    }

    await project100MvpWritePublishState(project100MvpPublishSnapshot("publishing",
      { filename: filenames[0] || "", driveFileId: "" }, {
      byteLength: 0,
      sha256: "",
      driveUpdated: false,
      resynced: false,
      error: "",
      partialMessage: "",
      publishedAt: "",
      fileCount: filenames.length,
      filesSaved: 0,
      lifecycleState,
      transaction: initialization ? "INITIALIZATION" : "REFRESH",
      perSource: perSource.length > 0
        ? perSource
        : project100MvpRecoverySourcesForPublishState(recoveryJob)
    }));

    if (!initialization && refreshFilenames.length === 0) {
      await project100MvpFinishRecoveryJob("failed", "SOURCE_NOT_ESTABLISHED");
      const failedState = project100MvpPublishSnapshot("failed", {
        filename: filenames[0] || "",
        driveFileId: ""
      }, {
        byteLength: 0,
        sha256: "",
        driveUpdated: false,
        resynced: false,
        error: "SOURCE_NOT_ESTABLISHED",
        partialMessage: "",
        publishedAt: "",
        fileCount: filenames.length,
        filesSaved: 0,
        lifecycleState: "ESTABLISHED",
        transaction: "REFRESH",
        perSource
      });
      await project100MvpWritePublishState(failedState);
      project100MvpPublishRunning = false;
      return { status: "BLOCKED", error: "SOURCE_NOT_ESTABLISHED", publishState: failedState };
    }

    if (unboundFilenames.length > 0) {
      // Phase 1 (batch with new Sources): deterministic preflight — EVERY
      // winning artifact must be capturable before ANY Drive mutation.
      const preflightCaptures = await project100MvpRunCapturePreflight(
        captureTab.id, frozenArtifactOperation);
      // Phase 2: OAuth once for the whole batch.
      try {
        await project100MvpGetAuthToken(true);
      } catch (_error) {
        throw new Error("ONBOARDING_OAUTH_FAILED");
      }
      // Phase 3: ensure one Drive object per new logical Source (recover or
      // create), persisted immediately per file. Recovery ambiguity is
      // preflighted for the WHOLE batch first: one ambiguous filename fails
      // closed with zero creates (batch-atomic, taskbook §9/§21).
      const projectId = recoveryProjectId;
      await project100MvpPreflightSourceRecovery(unboundFilenames, projectId);
      const now = new Date().toISOString();
      for (const filename of unboundFilenames) {
        const captured = preflightCaptures.find((item) =>
          item.target.exactFilename === filename);
        if (!captured) {
          throw new Error("ARTIFACT_TARGET_LOST");
        }
        const frozenTarget = frozenArtifactOperation.targets.find(
          (target) => target.exactFilename === filename);
        if (!frozenTarget) {
          throw new Error("ARTIFACT_TARGET_LOST");
        }
        const targetIdentity = project100MvpFrozenTargetIdentity(
          frozenArtifactOperation, frozenTarget);
        const recoverySource = project100MvpRecoveryJob &&
          Array.isArray(project100MvpRecoveryJob.sources)
          ? project100MvpRecoveryJob.sources.find((item) => item.filename === filename)
          : null;
        const previousSource = previousRecoveryJob &&
          Array.isArray(previousRecoveryJob.sources)
          ? previousRecoveryJob.sources.find((item) => item.filename === filename)
          : null;
        let contentPin = recoverySource && recoverySource.contentPin
          ? recoverySource.contentPin
          : null;
        if (contentPin) {
          await project100MvpAssertContentPinMatchesCapture(
            contentPin, captured, targetIdentity);
        } else {
          if (project100MvpRecoverySourceHasMutationEvidence(recoverySource) ||
              (previousOperationMatches &&
               project100MvpRecoverySourceHasMutationEvidence(previousSource))) {
            throw new Error("CONTENT_PIN_MISSING");
          }
          contentPin = project100MvpBuildContentPin(targetIdentity, captured);
        }
        await project100MvpUpdateRecoverySource(filename, {
          contentPin,
          byteLength: captured.byteLength,
          sha256: captured.sha256
        });
        const ensured = await project100MvpEnsureSourceFile(
          filename,
          projectId,
          captured.bytes,
          recoverySource && recoverySource.reservedDriveFileId,
          {
            operationToken: contentPin.operationToken,
            documentInstanceId: contentPin.documentInstanceId,
            frozenScopeToken: contentPin.frozenScopeToken,
            frozenTargetToken: contentPin.frozenTargetToken,
            exactFilename: contentPin.exactFilename,
            contentPinSha256: contentPin.sha256
          });
        const entry = binding.sources.find((item) => item.filename === filename);
        if (entry) {
          entry.driveFileId = ensured.driveFileId;
          entry.driveUrl = ensured.driveUrl;
        } else {
          binding.sources.push({
            filename,
            driveFileId: ensured.driveFileId,
            driveUrl: ensured.driveUrl,
            sourceBound: false,
            createdAt: now,
            sourceBoundAt: ""
          });
        }
      }
      binding.updatedAt = new Date().toISOString();
      await project100MvpWriteBindingV2(binding);
      // Persist the pending Publish intent with the onboarding queue.
      const queue = unboundFilenames.map((filename) => {
        const entry = binding.sources.find((item) => item.filename === filename);
        return {
          filename,
          driveFileId: entry.driveFileId,
          driveUrl: entry.driveUrl || ""
        };
      });
      const onboarding = {
        version: 2,
        phase: "canonical-ready",
        projectId,
        projectUrl: typeof captureTabUrl === "string" ? captureTabUrl : "",
        sourcePageUrl: binding.sourcePageUrl,
        captureTabId: typeof captureTab.id === "number" ? captureTab.id : null,
        onboardingTabId: null,
        filenames,
        frozenArtifactOperation,
        queue,
        queueIndex: 0,
        driveUrl: queue.length > 0 ? queue[0].driveUrl : "",
        createdAt: now,
        updatedAt: now
      };
      await project100MvpWriteOnboardingState(onboarding);
      const onboardingState = project100MvpPublishSnapshot("onboarding",
        { filename: filenames[0] || "", driveFileId: queue[0] ? queue[0].driveFileId : "" }, {
        byteLength: 0,
        sha256: "",
        driveUpdated: false,
        resynced: false,
        error: "",
         partialMessage: "",
         publishedAt: "",
         fileCount: filenames.length,
         filesSaved: 0,
         lifecycleState: "INITIALIZING",
         transaction: "INITIALIZATION",
         perSource: []
       });
      await project100MvpWritePublishState(onboardingState);
      project100MvpPublishRunning = false;
      return { status: "PASS", publishState: onboardingState, onboarding };
    }

    // All current logical Sources are bound: batch publish.
    // Per Source: capture (fresh bytes, in job memory only) -> same-file
    // PATCH + exact readback. Any capture/PATCH failure stops the batch
    // BEFORE its Resync phase and reports the truthful partial count —
    // never claim Published on a partial update.
    const saved = [];
    const saveFilenames = initialization ? filenames : refreshFilenames;
    for (let sourceIndex = 0; sourceIndex < saveFilenames.length; sourceIndex += 1) {
      const filename = saveFilenames[sourceIndex];
      const entry = binding.sources.find((item) => item.filename === filename);
      captured = null;
      updated = null;
      await project100MvpUpdateRecoveryJob({
        phase: "saving",
        currentIndex: sourceIndex
      });
      await project100MvpUpdateRecoverySource(filename, {
        phase: "capturing",
        status: "capturing",
        saved: false,
        error: ""
      });
      try {
        const frozenTarget = frozenArtifactOperation.targets.find(
          (target) => target.exactFilename === filename);
        if (!frozenTarget) {
          throw new Error("ARTIFACT_TARGET_LOST");
        }
        captured = await project100MvpWithTimeout(
          chrome.tabs.sendMessage(captureTab.id, {
            type: "PROJECT100_MVP_CAPTURE_ARTIFACT",
            filename,
            driveFileId: entry.driveFileId,
            frozenTargetIdentity: project100MvpFrozenTargetIdentity(
              frozenArtifactOperation,
              frozenTarget)
          }),
          PROJECT100_MVP_CAPTURE_RESPONSE_TIMEOUT_MS,
          "CAPTURE_NOT_RESPONDING"
        );
        if (!captured || captured.status !== "PASS") {
          const captureError = captured && Array.isArray(captured.errors) && captured.errors.length > 0
            ? captured.errors[0]
            : (captured && captured.error) || "ARTIFACT_NOT_FOUND";
          captureDiagnostics = project100MvpCaptureDiagnostics(captured);
          throw new Error(captureError);
        }
        captureDiagnostics = project100MvpCaptureDiagnostics(captured);
        const normalizedCapture = await project100MvpNormalizeCapturedArtifact(captured);
        const targetIdentity = project100MvpFrozenTargetIdentity(
          frozenArtifactOperation,
          frozenTarget);
        const recoverySource = project100MvpRecoveryJob &&
          Array.isArray(project100MvpRecoveryJob.sources)
          ? project100MvpRecoveryJob.sources.find((item) => item.filename === filename)
          : null;
        let contentPin = recoverySource && recoverySource.contentPin
          ? recoverySource.contentPin
          : null;
        if (contentPin) {
          await project100MvpAssertContentPinMatchesCapture(
            contentPin, normalizedCapture, targetIdentity);
        } else {
          const previousSource = previousRecoveryJob &&
            Array.isArray(previousRecoveryJob.sources)
            ? previousRecoveryJob.sources.find((item) => item.filename === filename)
            : null;
          if (project100MvpRecoverySourceHasMutationEvidence(previousSource) &&
              previousOperationMatches) {
            throw new Error("CONTENT_PIN_MISSING");
          }
          contentPin = project100MvpBuildContentPin(targetIdentity, normalizedCapture);
        }
        // This is the authoritative-capture boundary: the pin must be durable
        // before the first Drive PATCH for this Source. A storage failure
        // therefore exits through the existing safe failure path with no
        // external content mutation.
        await project100MvpUpdateRecoverySource(filename, {
          contentPin,
          byteLength: normalizedCapture.byteLength,
          sha256: normalizedCapture.sha256
        });
        updated = await project100MvpUpdateSourceEntry(
          {
            filename,
            driveFileId: entry.driveFileId,
            projectId: recoveryProjectId
          }, normalizedCapture.bytes);
        driveGate = {
          sameFileId: Boolean(updated.sameFileId),
          exactReadback: Boolean(updated.exactReadback),
          preWriteIdentity: updated.preWriteIdentity || null,
          byteLength: updated.byteLength,
          sha256: updated.sha256,
          ...(updated.readbackCanaryFields ||
            project100MvpExtractCanaryFields(normalizedCapture.bytes))
        };
        const preserveResync = Boolean(
          recoverySource && recoverySource.resyncStatus === "confirmed" &&
          recoverySource.sha256 && recoverySource.sha256 === updated.sha256
        );
        await project100MvpUpdateRecoverySource(filename, {
          phase: "saved",
          status: "saved",
          saved: true,
          synced: preserveResync,
          resynced: preserveResync,
          resyncStatus: preserveResync ? "confirmed" : "pending",
          resyncClickCount: preserveResync
            ? Number(recoverySource.resyncClickCount) || 1
            : 0,
          byteLength: updated.byteLength,
          sha256: updated.sha256,
          driveMutationAccepted: true,
          driveMutationAt: updated.driveMutationAt || "",
          error: ""
        });
        saved.push({
          filename,
          driveFileId: entry.driveFileId,
          byteLength: updated.byteLength,
           sha256: updated.sha256,
           canaryFields: updated.readbackCanaryFields ||
            project100MvpExtractCanaryFields(normalizedCapture.bytes)
         });
        perSource.push({
          filename,
          driveFileId: entry.driveFileId,
          saved: true,
          phase: "saved",
          status: "saved",
          synced: preserveResync,
          resynced: preserveResync,
          resyncStatus: preserveResync ? "confirmed" : "pending",
          resyncClickCount: preserveResync
            ? Number(recoverySource && recoverySource.resyncClickCount) || 1
            : 0,
          byteLength: updated.byteLength,
          sha256: updated.sha256,
          driveMutationAccepted: true,
          driveMutationAt: updated.driveMutationAt || "",
          error: ""
        });
      } catch (error) {
        const errorCode = project100MvpSafeError(error);
        const currentRecoverySource = project100MvpRecoveryJob &&
          Array.isArray(project100MvpRecoveryJob.sources)
          ? project100MvpRecoveryJob.sources.find((item) => item.filename === filename)
          : null;
        const driveMutationAccepted =
          project100MvpErrorHasDriveMutationEvidence(error) ||
          Boolean(updated && updated.driveMutationAccepted === true) ||
          Boolean(currentRecoverySource && currentRecoverySource.driveMutationAccepted === true);
        const driveMutationAt = String(
          (error && error.driveMutationAt) ||
          (currentRecoverySource && currentRecoverySource.driveMutationAt) || "");
        const mutationEvidencePatch = driveMutationAccepted
          ? { driveMutationAccepted: true, driveMutationAt }
          : {};
        const evidenceByteLength = driveMutationAccepted && currentRecoverySource
          ? Number(currentRecoverySource.byteLength) || 0
          : 0;
        const evidenceSha256 = driveMutationAccepted && currentRecoverySource
          ? String(currentRecoverySource.sha256 || "")
          : "";
        await project100MvpUpdateRecoverySource(filename, {
          phase: "failed",
          status: "failed",
          saved: false,
          synced: false,
          resynced: false,
          resyncStatus: "failed",
          ...mutationEvidencePatch,
          error: errorCode
        });
        perSource.push({
          filename,
          driveFileId: entry ? entry.driveFileId : "",
          saved: false,
          phase: "failed",
          status: "failed",
          synced: false,
          resynced: false,
          resyncStatus: "failed",
          byteLength: evidenceByteLength,
          sha256: evidenceSha256,
          driveMutationAccepted,
          driveMutationAt,
          error: errorCode
        });
        const partial = saved.length > 0;
        await project100MvpUpdateRecoveryJob({
          phase: partial ? "syncing" : "failed",
          retryable: true,
          currentIndex: sourceIndex
        });
        const failedState = project100MvpPublishSnapshot("failed",
          { filename: filenames[0] || "", driveFileId: "" }, {
          byteLength: updated ? updated.byteLength : (captured ? captured.byte_length || 0 : 0),
          sha256: updated ? updated.sha256 : (captured ? captured.sha256 || "" : ""),
          driveUpdated: saved.length > 0 || driveMutationAccepted,
          driveMutationAccepted,
          driveMutationAt,
          resynced: false,
          error: partial ? "PUBLISH_INCOMPLETE" : errorCode,
          partialMessage: partial
            ? `Publish incomplete. ${saved.length} of ${filenames.length} files were saved.`
            : "",
          publishedAt: "",
          fileCount: filenames.length,
          filesSaved: saved.length,
          lifecycleState,
          transaction: initialization ? "INITIALIZATION" : "REFRESH",
          perSource,
          captureDiagnostics,
          driveGate
        });
        await project100MvpWritePublishState(failedState);
        if (partial) {
          // Truthful partial recovery: the Sources of the files that WERE
          // saved still get their exactly-one Resync (bounded, sink-isolated
          // per-source runs, detached). The job stays failed with the partial
          // count; a retry re-PATCHes the same Drive file IDs — safe.
          void project100MvpRunBatchResyncPhase(binding, saved, perSource)
            .catch(() => {})
            .finally(async () => {
              await project100MvpFinishRecoveryJob("failed", "PUBLISH_INCOMPLETE");
              project100MvpPublishRunning = false;
            });
        } else {
          project100MvpPublishRunning = false;
        }
        return { status: "BLOCKED", error: failedState.error, publishState: failedState };
      }
    }

    // Milestone A (multi-source edition): every artifact is durably saved
    // (exact readback PASS per Source). The user-facing state drops out of
    // the blocking wait here; the per-Source Resync phase continues as a
    // detached bounded background job that keeps holding the single-job
    // lock. Exactly one Resync per published Source through the frozen
    // per-source completion machinery; per-source states are sink-isolated.
    const driveUpdatedAt = Date.now();
    await project100MvpUpdateRecoveryJob({
      phase: "syncing",
      currentIndex: 0,
      retryable: false,
      driveUpdatedAt
    });
    const syncingState = project100MvpPublishSnapshot("syncing",
      { filename: filenames[0] || "", driveFileId: saved[0] ? saved[0].driveFileId : "" }, {
      byteLength: saved.reduce((sum, item) => sum + item.byteLength, 0),
      sha256: saved[0] ? saved[0].sha256 : "",
      driveUpdated: true,
      resynced: false,
      error: "",
      partialMessage: "",
      publishedAt: "",
      fileCount: filenames.length,
      filesSaved: saved.length,
      lifecycleState,
      transaction: initialization ? "INITIALIZATION" : "REFRESH",
      perSource,
      captureDiagnostics,
      driveGate
    });
    await project100MvpWritePublishState(syncingState);
    void project100MvpRunBatchResyncAndFinalize(binding, saved, perSource,
      filenames, { captureDiagnostics, driveGate })
      .catch((_error) => {
        // The finalizer persists its own truthful terminal state; a totally
        // unexpected crash must never surface as unhandled.
      })
      .finally(() => {
        project100MvpPublishRunning = false;
      });
    return { status: "PASS", publishState: syncingState };
  } catch (error) {
    const errorCode = project100MvpSafeError(error);
    // A new job may fail before it reaches the batch finalizer (for example
    // during discovery or first-use preflight). Close only the job created by
    // this invocation; never rewrite an unrelated terminal/foreign record.
    const currentJobId = project100MvpRecoveryJob && project100MvpRecoveryJob.jobId
      ? project100MvpRecoveryJob.jobId
      : "";
    const previousJobId = previousRecoveryJob && previousRecoveryJob.jobId
      ? previousRecoveryJob.jobId
      : "";
    if (currentJobId && currentJobId !== previousJobId) {
      try {
        await project100MvpFinishRecoveryJob("failed", errorCode);
      } catch (_error) {
        // Terminal publish state below remains the user-facing truth even if
        // a best-effort recovery metadata write is unavailable.
      }
    }
    // A first Publish creates the INITIALIZING recovery checkpoint before it
    // can fail at OAuth, capture preflight, or onboarding. Preserve that
    // lifecycle in the terminal publish state; UNKNOWN here would make a
    // failed initialization look like an established Refresh.
    const recoveryLifecycleState = currentJobId && currentJobId !== previousJobId &&
      project100MvpRecoveryJob && project100MvpRecoveryJob.establishment
      ? String(project100MvpRecoveryJob.establishment.state || "")
      : (currentJobId && currentJobId !== previousJobId
        ? String(project100MvpRecoveryJob && project100MvpRecoveryJob.lifecycleState || "")
        : "");
    const effectiveLifecycleState = lifecycleState !== "UNKNOWN"
      ? lifecycleState
      : (PROJECT100_MVP_ESTABLISHMENT_STATES.has(recoveryLifecycleState)
        ? recoveryLifecycleState
        : lifecycleState);
    const preservingPriorRecovery = Boolean(previousRecoveryJob &&
      currentJobId && currentJobId === previousRecoveryJob.jobId &&
      previousPublishState &&
      (previousPublishState.status === "failed" ||
        previousPublishState.status === "interrupted"));
    const priorRecoverySources = preservingPriorRecovery
      ? project100MvpRecoverySourcesForPublishState(previousRecoveryJob)
      : [];
    const driveMutationAccepted = project100MvpErrorHasDriveMutationEvidence(error) ||
      Boolean(updated && updated.driveMutationAccepted === true) ||
      perSource.some((entry) => entry && entry.driveMutationAccepted === true) ||
      priorRecoverySources.some((entry) => entry && entry.driveMutationAccepted === true);
    const failurePerSource = perSource.length > 0 ? perSource : priorRecoverySources;
    const driveMutationAt = String((error && error.driveMutationAt) ||
      (updated && updated.driveMutationAt) ||
      ((failurePerSource.find((entry) => entry && entry.driveMutationAccepted === true &&
        entry.driveMutationAt) || {}).driveMutationAt) || "");
    const failedState = project100MvpPublishSnapshot("failed", binding
      ? { filename: filenames[0] || (Array.isArray(binding.sources) && binding.sources[0]
        ? binding.sources[0].filename : ""), driveFileId: "" }
      : null, {
      byteLength: updated ? updated.byteLength : (captured ? captured.byte_length || 0 : 0),
      sha256: updated ? updated.sha256 : (captured ? captured.sha256 || "" : ""),
      driveUpdated: driveMutationAccepted,
      driveMutationAccepted,
      driveMutationAt,
      resynced: false,
      error: errorCode,
      partialMessage: "",
      publishedAt: "",
      fileCount: filenames.length,
      filesSaved: 0,
      retryable: true,
      lifecycleState: effectiveLifecycleState,
      transaction: effectiveLifecycleState === "INITIALIZING" ? "INITIALIZATION" :
        (effectiveLifecycleState === "ESTABLISHED" ? "REFRESH" : ""),
      perSource: failurePerSource,
      captureDiagnostics,
      driveGate
    });
    await project100MvpWritePublishState(failedState);
    project100MvpPublishRunning = false;
    return { status: "BLOCKED", error: errorCode, publishState: failedState };
  }
}

// Batch Resync finalizer (detached): run the per-source Resync phase, then
// write the SINGLE user-facing terminal state — Published only when EVERY
// saved Source confirmed; otherwise a truthful failed state with the partial
// confirmation count. Per-source runs stay sink-isolated throughout.
async function project100MvpCommitEstablishedInitialization(
  jobInput,
  filenames,
  saved,
  syncResults
) {
  const job = jobInput || project100MvpRecoveryJob;
  const operationProjectId = project100MvpNormalizeProjectId(
    project100MvpActiveProjectId);
  if (!job || !Array.isArray(job.sources) ||
      String(job.establishment && job.establishment.state ||
        job.lifecycleState || "") !== "INITIALIZING" ||
      !Array.isArray(filenames) || !Array.isArray(saved) ||
      !Array.isArray(syncResults) || saved.length !== filenames.length ||
      syncResults.length !== filenames.length ||
      syncResults.some((result) => !result || result.synced !== true)) {
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  const binding = await project100MvpReadBindingV2(operationProjectId);
  const initializing = project100MvpValidateInitializingBinding(binding);
  if (!project100MvpSameFilenameSet(initializing.record.initialFilenames, filenames) ||
      !project100MvpBindingV2Complete(binding) || !binding.sourcePageUrl ||
      !Array.isArray(binding.sources) || binding.sources.some((entry) =>
        !entry || entry.sourceBound !== true || !entry.driveFileId)) {
    throw new Error("ESTABLISHMENT_CONFLICT");
  }
  const establishedRecord = project100MvpBuildEstablishmentRecord(
    "ESTABLISHED",
    initializing.projectId,
    initializing.record.initialFilenames,
    initializing.frozen,
    initializing.record);
  const establishedBinding = {
    ...binding,
    establishment: establishedRecord,
    updatedAt: new Date().toISOString()
  };
  // This durable write is the establishment boundary. The caller publishes
  // only after it succeeds; a crash or storage failure cannot be guessed into
  // ESTABLISHED later.
  await project100MvpWriteBindingV2(establishedBinding, operationProjectId);
  await project100MvpUpdateRecoveryJob({
    lifecycleState: "ESTABLISHED",
    establishment: establishedRecord
  }, operationProjectId);
  return establishedBinding;
}

async function project100MvpRunBatchResyncAndFinalize(binding, saved, perSource,
  filenames, diagnostics = {}) {
  const syncResults = await project100MvpRunBatchResyncPhase(binding, saved, perSource);
  const syncedCount = syncResults.filter((result) => result.synced).length;
  const allTargetsSucceeded = syncedCount === saved.length &&
    saved.length > 0 && saved.length === filenames.length;
  if (allTargetsSucceeded) {
    const initialization = project100MvpRecoveryJob &&
      String(project100MvpRecoveryJob.establishment &&
        project100MvpRecoveryJob.establishment.state ||
        project100MvpRecoveryJob.lifecycleState || "") === "INITIALIZING";
    if (initialization) {
      await project100MvpCommitEstablishedInitialization(
        project100MvpRecoveryJob, filenames, saved, syncResults);
    }
    await project100MvpFinishRecoveryJob("published");
    const last = syncResults[syncResults.length - 1];
    const publishedState = project100MvpPublishSnapshot("published",
      { filename: filenames[0] || "", driveFileId: saved[0] ? saved[0].driveFileId : "" }, {
      byteLength: saved.reduce((sum, item) => sum + item.byteLength, 0),
      sha256: saved[0] ? saved[0].sha256 : "",
      driveUpdated: true,
      resynced: true,
      error: "",
      partialMessage: "",
       publishedAt: new Date().toISOString(),
       fileCount: filenames.length,
       filesSaved: saved.length,
       perSource: project100MvpRecoveryJob
         ? project100MvpRecoverySourcesForPublishState(project100MvpRecoveryJob)
         : perSource,
      captureDiagnostics: diagnostics.captureDiagnostics || null,
      driveGate: diagnostics.driveGate || null,
      resyncEvidence: last ? last.resyncEvidence : null,
      freshSources: last ? last.freshSources : null
    });
    await project100MvpWritePublishState(publishedState);
    return;
  }
  const firstSyncFailure = syncResults.find((result) => !result.synced);
  const rejectedTarget = Array.isArray(perSource)
    ? perSource.find((entry) => entry && entry.error === "SOURCE_NOT_ESTABLISHED")
    : null;
  const finalError = firstSyncFailure && firstSyncFailure.error
    ? firstSyncFailure.error
    : (rejectedTarget ? rejectedTarget.error : "PROJECT_SOURCE_SYNC_UNCONFIRMED");
  await project100MvpFinishRecoveryJob("failed",
    finalError);
  const failedSyncState = project100MvpPublishSnapshot("failed",
    { filename: filenames[0] || "", driveFileId: "" }, {
    byteLength: saved.reduce((sum, item) => sum + item.byteLength, 0),
    sha256: saved[0] ? saved[0].sha256 : "",
    driveUpdated: true,
    resynced: false,
    error: finalError,
    partialMessage: syncedCount > 0 && syncedCount < filenames.length
      ? `Publish incomplete. ${syncedCount} of ${filenames.length} files were confirmed.`
      : (saved.length < filenames.length
        ? `Publish incomplete. ${syncedCount} of ${filenames.length} files were confirmed.`
        : project100MvpSyncFailureMessage(finalError)),
    publishedAt: "",
    fileCount: filenames.length,
    filesSaved: saved.length,
    perSource: project100MvpRecoveryJob
      ? project100MvpRecoverySourcesForPublishState(project100MvpRecoveryJob)
      : perSource,
    captureDiagnostics: diagnostics.captureDiagnostics || null,
    driveGate: diagnostics.driveGate || null,
    resyncEvidence: firstSyncFailure ? firstSyncFailure.resyncEvidence : null
  });
  await project100MvpWritePublishState(failedSyncState);
}

// Batch Resync phase: for EVERY saved Source, run the FROZEN per-source
// completion machinery (ContinuePublishAfterSave) exactly once. Its
// publish-state writes are routed to per-source side keys so the popup never
// sees a premature per-source "Published ✓"; the coordinator owns the
// user-facing state. Each per-source run opens its own temporary INACTIVE
// Sources tab (allowed by §22.2) and clicks its Resync exactly once.
async function project100MvpRunBatchResyncPhase(binding, saved, perSource) {
  const results = [];
  for (let index = 0; index < saved.length; index += 1) {
    const item = saved[index];
    const recoverySource = project100MvpRecoveryJob &&
      Array.isArray(project100MvpRecoveryJob.sources)
      ? project100MvpRecoveryJob.sources.find((entry) => entry.filename === item.filename)
      : null;
    // A source already confirmed for the exact same bytes before a worker
    // restart is complete. Reusing that evidence avoids a second Resync click
    // during an explicit retry. If the bytes changed, the source is treated as
    // a new update and follows the normal one-click path below.
    if (recoverySource && recoverySource.resyncStatus === "confirmed" &&
        recoverySource.sha256 && recoverySource.sha256 === item.sha256) {
      const record = perSource.find((entry) => entry.filename === item.filename);
      if (record) {
        record.phase = "resync-confirmed";
        record.status = "confirmed";
        record.synced = true;
        record.resynced = true;
        record.resyncStatus = "confirmed";
        record.resyncClickCount = Number(recoverySource.resyncClickCount) || 1;
      }
      results.push({
        filename: item.filename,
        driveFileId: item.driveFileId,
        synced: true,
        skipped: true,
        error: "",
        resyncEvidence: null,
        freshSources: null,
        byteLength: item.byteLength,
        sha256: item.sha256
      });
      await project100MvpUpdateRecoveryJob({
        phase: "resyncing",
        currentIndex: index + 1
      });
      continue;
    }
    await project100MvpUpdateRecoveryJob({
      phase: "resyncing",
      currentIndex: index
    });
    await project100MvpUpdateRecoverySource(item.filename, {
      phase: "resync-preparing",
      status: "resync-preparing",
      saved: true,
      synced: false,
      resynced: false,
      resyncStatus: "pending",
      error: ""
    });
    const view = {
      filename: item.filename,
      driveFileId: item.driveFileId,
      sourcePageUrl: binding.sourcePageUrl
    };
    const sideKey = `project100MvpPublishState:source:${index}`;
    project100MvpPublishStateSink = sideKey;
    try {
      await project100MvpContinuePublishAfterSave(view, {
        byteLength: item.byteLength,
        sha256: item.sha256
      }, Date.now(), {});
    } catch (_error) {
      // The per-source run persists its own truthful terminal state; the
      // classification below reads it from the side key.
    } finally {
      project100MvpPublishStateSink = null;
    }
    const sideState = await project100MvpReadSidePublishState(sideKey);
    await project100MvpRemoveSidePublishState(sideKey);
    const synced = Boolean(sideState && sideState.status === "published" && sideState.resynced);
    const reportedClickCount = sideState && sideState.resyncEvidence
      ? Number(sideState.resyncEvidence.resync_click_count) || 0
      : 0;
    const existingRecoverySource = project100MvpRecoveryJob &&
      Array.isArray(project100MvpRecoveryJob.sources)
      ? project100MvpRecoveryJob.sources.find((entry) => entry.filename === item.filename)
      : null;
    const checkpointClickCount = existingRecoverySource &&
      PROJECT100_MVP_UNCERTAIN_RESYNC_STATUSES.has(
        String(existingRecoverySource.resyncStatus || ""))
      ? Math.max(Number(existingRecoverySource.resyncClickCount) || 0, 1)
      : 0;
    const resyncClickCount = Math.max(reportedClickCount, checkpointClickCount);
    const sourceResyncStatus = synced
      ? "confirmed"
      : (resyncClickCount > 0 ? "uncertain" : "failed");
    await project100MvpUpdateRecoverySource(item.filename, {
      phase: synced ? "resync-confirmed" : "resync-failed",
      status: synced ? "confirmed" : "failed",
      saved: true,
      synced,
      resynced: synced,
      resyncStatus: sourceResyncStatus,
      resyncClickCount,
      byteLength: item.byteLength,
      sha256: item.sha256,
      error: sideState && sideState.status === "failed" ? sideState.error : ""
    });
    await project100MvpUpdateRecoveryJob({
      phase: "resyncing",
      currentIndex: index + 1
    });
    results.push({
      filename: item.filename,
      driveFileId: item.driveFileId,
      synced,
      error: sideState && sideState.status === "failed" ? sideState.error : "",
      // Terminal per-source evidence is preserved verbatim so the single
      // user-facing final state keeps the frozen evidence shape.
      resyncEvidence: (sideState && sideState.resyncEvidence) || null,
      freshSources: (sideState && sideState.freshSources) || null,
      byteLength: item.byteLength,
      sha256: item.sha256
    });
    const record = perSource.find((entry) => entry.filename === item.filename);
    if (record) {
      record.phase = synced ? "resync-confirmed" : "resync-failed";
      record.status = synced ? "confirmed" : "failed";
      record.synced = synced;
      record.resynced = synced;
      record.resyncStatus = sourceResyncStatus;
      record.resyncClickCount = resyncClickCount;
      record.completion = sideState && sideState.resyncEvidence
        ? sideState.resyncEvidence.completion || sideState.status
        : (sideState ? sideState.status : "no-state");
      if (!synced) {
        record.error = results[results.length - 1].error;
      }
    }
  }
  return results;
}

// ---- Phase 2: temporary Sources tab Resync (canonical production path) ----
// The last human-proven flow: open the bound Project's Sources page in a
// temporary INACTIVE tab, wait for the exact bound Source, click its Resync
// exactly once, then confirm completion.
//
// Completion evidence priority (frozen — describes the code as it is):
//   1. A structured connector_scopes receipt with a NEW
//      last_sync_completed_at — used ONLY when the receipt endpoint is
//      actually reachable from the extension context. Live human recon has
//      shown that same-origin native fetches (isolated or MAIN world) can be
//      rejected with HTTP 401, so receipt reachability is probed, never
//      assumed, and a rejected receipt is treated as unavailable.
//   2. Otherwise the deterministic DOM completion path: the exact bound
//      Source's sync state must settle persistently CHANGED after the single
//      Resync click (two stable changed reads inside the Resync observation,
//      or the bounded two-confirmation background poll).
//
// The Resync trigger alone is never sufficient for Published. A transient
// busy/spinner state alone is never sufficient. An explicit error state
// always fails the job. Never publishes on the click alone.

// User-facing failure copy for post-Save failures. Internal error codes stay
// in the persisted state's `error` field for development; the popup shows
// only these concise human messages.
function project100MvpSyncFailureMessage(errorCode) {
  switch (errorCode) {
    case "RECEIPT_SOURCE_NOT_FOUND":
      return "Saved to Drive\nProject Source could not be located for sync.";
    case "RECEIPT_SOURCE_AMBIGUOUS":
    case "PROJECT_SOURCE_SYNC_UNCONFIRMED":
      return "Saved to Drive\nProject Source update could not be confirmed.";
    case "RECEIPT_SCOPE_ID_UNAVAILABLE":
    case "BACKEND_RECEIPT_UNAVAILABLE":
      return "Saved to Drive\nProject Source sync could not be started.";
    case "POST_SYNC_ERROR_STATE":
      return "Saved to Drive\nProject Source sync reported an error.";
    default:
      return "Saved to Drive\nProject Source sync failed.";
  }
}

// Explicit terminal failure already returned by runSourceResync. These always
// fail closed — the job must not keep observing after the exact Source /
// Resync action / explicit error failed. The bounded-observation outcomes
// (SYNC_STATE_UNCHANGED, POST_SYNC_SETTLE_TIMEOUT, POST_SYNC_UNVERIFIABLE) are
// NOT explicit failures: the one-time Resync click still happened, so later
// receipt / DOM evidence inside the same window remains eligible.
function project100MvpIsExplicitResyncFailure(errorCode) {
  if (!errorCode) {
    return false;
  }
  if (errorCode === "POST_SYNC_ERROR_STATE") {
    return true;
  }
  if (errorCode === "DRIVE_ID_MISMATCH" ||
      errorCode === "PRE_SYNC_UNREADABLE" ||
      errorCode === "RESYNC_ACTION_EXECUTION_FAILED" ||
      errorCode === "RESYNC_FAILED") {
    return true;
  }
  if (/^MATCHING_SOURCES_/.test(errorCode) ||
      /^ACTION_CONTROLS_/.test(errorCode) ||
      /^RESYNC_ACTIONS_/.test(errorCode) ||
      /^POST_MATCHING_SOURCES_/.test(errorCode)) {
    return true;
  }
  return false;
}

async function project100MvpContinuePublishAfterSave(binding, saved, driveUpdatedAt, diagnostics = {}) {
  const captureDiagnostics = diagnostics.captureDiagnostics || null;
  const driveGate = diagnostics.driveGate || null;
  let sourceTabId = null;
  let networkObserverRegistered = false;
  try {
    // MAIN-world observer is registered BEFORE the tab is created so it is
    // installed at document_start and can also see the page's own bootstrap
    // traffic. Failure to install never fails the publish flow.
    const networkObserver = await project100MvpRegisterNetworkObserver(binding.sourcePageUrl);
    networkObserverRegistered = Boolean(networkObserver.installed);

    // Temporary background Sources page: never steals focus from
    // the user's working conversation tab.
    const sourceTab = await chrome.tabs.create({ url: binding.sourcePageUrl, active: false });
    sourceTabId = sourceTab && typeof sourceTab.id === "number" ? sourceTab.id : null;
    if (sourceTabId === null) {
      throw new Error("SOURCE_PAGE_NOT_READY");
    }
    await project100MvpWaitForContentScript(sourceTabId, "SOURCE_PAGE_NOT_READY");
    // PING is not enough: wait until the bound Source DOM (row, Drive link,
    // action menu, readable sync state) is actually present before Resync.
    // The returned read-only state is the baseline used by restart recovery
    // when the worker stops after the click but before its response is stored.
    const preSourceReady = await project100MvpWaitForBoundSourceReady(
      sourceTabId, binding, "SOURCE_PAGE_NOT_READY");

    // Pre-snapshot the structured backend receipt BEFORE the single Resync
    // click. Primary freshness proof = post.last_sync_completed_at !==
    // pre.last_sync_completed_at (no local-clock comparison).
    const preReceiptResponse = await project100MvpWithTimeout(
      chrome.tabs.sendMessage(sourceTabId, {
        type: "PROJECT100_MVP_CONNECTOR_SCOPE_RECEIPT",
        filename: binding.filename,
        driveFileId: binding.driveFileId,
        sourcePageUrl: binding.sourcePageUrl
      }),
      PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS,
      "RECEIPT_NOT_RESPONDING"
    ).catch(() => null);
    const backendReceiptAvailable = Boolean(
      preReceiptResponse && preReceiptResponse.status === "PASS" &&
      preReceiptResponse.receipt &&
      typeof preReceiptResponse.receipt.last_sync_completed_at === "string");
    if (preReceiptResponse && preReceiptResponse.status === "BLOCKED" &&
        (preReceiptResponse.error === "RECEIPT_SOURCE_AMBIGUOUS" ||
         preReceiptResponse.error === "RECEIPT_SOURCE_NOT_FOUND")) {
      // Duplicate or missing exact-source correlation on a REACHABLE backend:
      // fail closed BEFORE clicking Resync — never auto-pick, never run into
      // an ambiguous or wrong-source mapping.
      await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
        byteLength: saved.byteLength,
        sha256: saved.sha256,
        driveUpdated: true,
        resynced: false,
        error: preReceiptResponse.error,
        partialMessage: project100MvpSyncFailureMessage(preReceiptResponse.error),
        publishedAt: "",
        captureDiagnostics,
        driveGate,
        resyncEvidence: project100MvpResyncEvidence(null, {
          backend_receipt_available: backendReceiptAvailable,
          completion: "receipt-failed-closed:" + preReceiptResponse.error
        })
      }));
      return;
    }

    const preSyncValue = preSourceReady && preSourceReady.syncState &&
      typeof preSourceReady.syncState.value === "string"
      ? preSourceReady.syncState.value
      : "";
    const preCompletedAt = backendReceiptAvailable && preReceiptResponse.receipt
      ? String(preReceiptResponse.receipt.last_sync_completed_at || "")
      : "";
    // Establish a durable no-click checkpoint before arming/calling the page.
    // The next write immediately before sendMessage becomes click-in-flight;
    // a worker restart can therefore conservatively distinguish a safe
    // pending source from a click whose outcome needs read-only evidence.
    await project100MvpUpdateRecoverySource(binding.filename, {
      phase: "resync-click-pending",
      status: "resync-click-pending",
      saved: true,
      synced: false,
      resynced: false,
      resyncStatus: "pending",
      resyncClickCount: 0,
      byteLength: saved.byteLength,
      sha256: saved.sha256,
      preSyncValue,
      preCompletedAt,
      error: ""
    });

    // Arm the MAIN-world observation window for the coming Resync. The
    // deadline is the ORIGINAL absolute window (driveUpdatedAt + 120000);
    // no second window, no extension.
    const networkWindowId = `p100-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await chrome.tabs.sendMessage(sourceTabId, {
        type: "PROJECT100_MVP_NETWORK_OBSERVER_PREPARE",
        windowId: networkWindowId,
        projectId: project100MvpResolveProjectId(binding.sourcePageUrl),
        driveFileId: binding.driveFileId,
        deadline: driveUpdatedAt + PROJECT100_MVP_BACKGROUND_SYNC_WINDOW_MS
      });
    } catch (_error) {
      // Observer absence must never block the Resync.
    }

    // This is the last durable point before the one allowed Resync action.
    // If the worker disappears after this write, retry must first reconcile
    // evidence and must never blindly send the action again.
    await project100MvpUpdateRecoverySource(binding.filename, {
      phase: "resync-click-in-flight",
      status: "resync-click-in-flight",
      saved: true,
      synced: false,
      resynced: false,
      resyncStatus: "click-in-flight",
      resyncClickCount: 0,
      byteLength: saved.byteLength,
      sha256: saved.sha256,
      preSyncValue,
      preCompletedAt,
      error: ""
    });
    const resync = await project100MvpWithTimeout(
      chrome.tabs.sendMessage(sourceTabId, {
        type: "PROJECT100_MVP_RESYNC_BOUND_SOURCE",
        filename: binding.filename,
        driveFileId: binding.driveFileId
      }),
      PROJECT100_MVP_RESYNC_RESPONSE_TIMEOUT_MS,
      "RESYNC_NOT_RESPONDING"
    );
    const resyncError = resync && Array.isArray(resync.errors) && resync.errors.length > 0
      ? resync.errors[0]
      : (resync && resync.error) || "RESYNC_FAILED";
    const resyncStatus = resync ? resync.status : "";
    const syncStateChanged = Boolean(resync && resync.sync_state_changed);
    const resyncClickCount = Number(resync && resync.resync_click_count) || 0;
    // The page has acknowledged the action, but completion evidence is still
    // pending. Persist an uncertain/observing checkpoint before any further
    // await so a worker restart cannot turn the click into a duplicate.
    await project100MvpUpdateRecoverySource(binding.filename, {
      phase: "resync-observing",
      status: "resync-observing",
      saved: true,
      synced: false,
      resynced: false,
      resyncStatus: resyncClickCount === 1 ? "observing" : "uncertain",
      resyncClickCount,
      byteLength: saved.byteLength,
      sha256: saved.sha256,
      preSyncValue,
      preCompletedAt,
      error: ""
    });
    const resyncEvidence = project100MvpResyncEvidence(resync, {
      backend_receipt_available: backendReceiptAvailable,
      completion: "pending"
    });
    // PASS 1: record the observed network diagnostics (never a verdict input).
    // This snapshot (classified from the ORIGINAL document's pre-click
    // bootstrap records) also provides the page-owned completion baseline T1
    // when the extension receipt probe is unreachable; that ORIGINAL baseline
    // is held below and must survive later page reloads.
    const networkSnapshotAfterResync = await project100MvpCollectNetworkEvidence(sourceTabId);

    // HY5 active receipt polling is DISABLED for the HY6 build: the
    // orchestration never arms the MAIN-world active GET (§4 of the HY6
    // taskbook). The page itself must remain the only connector_scopes
    // initiator used as evidence; the observer's own active code path stays
    // dormant because nothing ever sends it the arm command.

    // Evidence precedence. An already-established strong runSourceResync DOM
    // PASS (persistent changed settled state after the exact one-time Resync)
    // is TERMINAL completion evidence. Receipt reachability must not matter
    // after this point, and a later receipt signal must never retroactively
    // overturn it (audit Finding A).
    if (resyncStatus === "PASS" && syncStateChanged) {
      await project100MvpWritePublishState(project100MvpPublishSnapshot("published", binding, {
        byteLength: saved.byteLength,
        sha256: saved.sha256,
        driveUpdated: true,
        resynced: true,
        error: "",
        partialMessage: "",
        publishedAt: new Date().toISOString(),
        captureDiagnostics,
        driveGate,
        resyncEvidence: { ...resyncEvidence, completion: "dom-state-changed" }
      }));
      return;
    }

    // An explicit terminal error already returned by runSourceResync is
    // fail-closed; the job must not keep observing.
    if (project100MvpIsExplicitResyncFailure(resyncError)) {
      await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
        byteLength: saved.byteLength,
        sha256: saved.sha256,
        driveUpdated: true,
        resynced: false,
        error: resyncError,
        partialMessage: project100MvpSyncFailureMessage(resyncError),
        publishedAt: "",
        captureDiagnostics,
        driveGate,
        resyncEvidence: { ...resyncEvidence, completion: "resync-failed-closed" }
      }));
      return;
    }

    // Audit Finding B: exactly one Resync click (exact source identity + one
    // Resync action + one executed click + no explicit error) establishes that
    // the already-authorized bounded completion observation may CONTINUE inside
    // the SAME original absolute window. The click alone is never completion
    // evidence — it only keeps receipt + later DOM evidence eligible. Transient
    // activity is diagnostic evidence only and is NOT required to enter here.
    if (resyncClickCount === 1) {
      // HY7 PRODUCTION: the live-proven Fresh Sources route is now the
      // first-class completion authority. Exactly one Resync click already
      // happened; bounded fresh reload/reopen navigations let the ChatGPT
      // page ITSELF re-issue its authenticated connector_scopes GET, passively
      // observed by the still-registered MAIN-world observer and classified
      // against the ORIGINAL pre-Resync baseline (T1) held here, in the
      // service worker, across reloads. A strong FRESH_COMPLETED verdict
      // (single fail-closed helper below) is TERMINAL: Published immediately,
      // no legacy wait, no remaining-window burn. An explicit terminal sync
      // error or ambiguity from the fresh route fails closed. Everything else
      // falls through to the legacy completion channels, which keep their
      // existing semantics.
      // HY8 latency cleanup: runSourceResync returns quickly now (short DOM
      // fast path; POST_SYNC_FAST_PATH_EXPIRED is NOT an explicit failure),
      // so this Fresh Sources phase starts right after the click instead of
      // behind the old 45s full DOM wait. The old DOM detector is now a
      // fast-path/diagnostic/fallback only — never a long blocking
      // prerequisite for the Fresh Sources route.
      const originalPreCompletedAt =
        (backendReceiptAvailable && preReceiptResponse.receipt)
          ? String(preReceiptResponse.receipt.last_sync_completed_at || "")
          : String((networkSnapshotAfterResync && networkSnapshotAfterResync.preCompletedAt) || "");
      let freshEvidence = null;
      try {
        const freshOutcome = await project100MvpFreshSourcesReceiptPhase(
          sourceTabId, binding, driveUpdatedAt, originalPreCompletedAt);
        if (freshOutcome && typeof freshOutcome.currentTabId === "number") {
          // A reopen fallback may have replaced the temporary tab; the
          // remaining product verification and the final cleanup target the
          // current one.
          sourceTabId = freshOutcome.currentTabId;
        }
        if (freshOutcome && freshOutcome.evidence) {
          freshEvidence = { ...freshOutcome.evidence, resyncClickCount };
        }
      } catch (_error) {
        // A fresh-route failure must never block the legacy verdict path.
      }
      if (project100MvpIsFreshSourcesCompletion(freshEvidence)) {
        const winner = freshEvidence.attempts.find(
          (entry) => entry && Number(entry.attempt) === Number(freshEvidence.winningAttempt)) || {};
        await project100MvpWritePublishState(project100MvpPublishSnapshot("published", binding, {
          byteLength: saved.byteLength,
          sha256: saved.sha256,
          driveUpdated: true,
          resynced: true,
          error: "",
          partialMessage: "",
          publishedAt: new Date().toISOString(),
          captureDiagnostics,
          driveGate,
          resyncEvidence: { ...resyncEvidence, completion: "fresh-sources-completed" },
          freshSources: {
            originalPreCompletedAt: freshEvidence.originalPreCompletedAt,
            winningAttempt: freshEvidence.winningAttempt,
            finalCompletedAt: freshEvidence.finalCompletedAt,
            mode: winner.mode || ""
          }
        }));
        return;
      }
      if (freshEvidence &&
          (freshEvidence.terminalReason === "EXPLICIT_SYNC_ERROR" ||
           freshEvidence.terminalReason === "SOURCE_AMBIGUOUS")) {
        // Precedence 3: an explicit terminal sync error (or an ambiguous
        // exact-source observation) observed through the page-owned route
        // fails closed; the job must not keep observing.
        await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
          byteLength: saved.byteLength,
          sha256: saved.sha256,
          driveUpdated: true,
          resynced: false,
          error: freshEvidence.terminalReason,
          partialMessage: "Saved to Drive\nProject Source sync reported an error.",
          publishedAt: "",
          captureDiagnostics,
          driveGate,
          resyncEvidence: {
            ...resyncEvidence,
            completion: `fresh-sources-failed-closed:${freshEvidence.terminalReason}`
          }
        }));
        return;
      }
      if (backendReceiptAvailable) {
        // Combined channel: bounded read-only polling of BOTH the structured
        // backend receipt AND the exact bound Source's DOM sync state inside
        // the SAME absolute window; either independently confirms.
        await project100MvpWaitForBackendReceipt(sourceTabId, binding, saved, driveUpdatedAt, {
          lastSyncCompletedAt: preReceiptResponse.receipt.last_sync_completed_at,
          lastSyncStartedAt: preReceiptResponse.receipt.last_sync_started_at
        }, {
          captureDiagnostics,
          driveGate,
          preSyncValue: typeof resync.pre_sync === "string" ? resync.pre_sync : "",
          resyncEvidence: { ...resyncEvidence, completion: "receipt" }
        });
      } else {
        await project100MvpVerifyBackgroundSync(sourceTabId, binding, saved, driveUpdatedAt,
          typeof resync.pre_sync === "string" ? resync.pre_sync : "", {
          captureDiagnostics,
          driveGate,
          resyncEvidence: { ...resyncEvidence, completion: "background-dom" }
        });
      }
      return;
    }

    // No exact one-time Resync click to justify continued observation ->
    // fail closed.
    await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
      byteLength: saved.byteLength,
      sha256: saved.sha256,
      driveUpdated: true,
      resynced: false,
      error: resyncError,
      partialMessage: project100MvpSyncFailureMessage(resyncError),
      publishedAt: "",
      captureDiagnostics,
      driveGate,
      resyncEvidence: { ...resyncEvidence, completion: "resync-not-triggered" }
    }));
  } catch (error) {
    const errorCode = project100MvpSafeError(error);
    await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
      byteLength: saved.byteLength,
      sha256: saved.sha256,
      driveUpdated: true,
      resynced: false,
      error: errorCode,
      partialMessage: project100MvpSyncFailureMessage(errorCode),
      publishedAt: "",
      captureDiagnostics,
      driveGate
    }));
  } finally {
    // Final PASS-1 diagnostic snapshot, then terminal disarm. The observer
    // must never outlive the temporary tab lifecycle. NOTE: no added delay
    // here — the terminal active-receipt diagnostic travels through the
    // content script's own runtime relay (independent of this tab), and any
    // wait between the verdict write and cleanup would race the RP12
    // contract that the temporary tab is closed immediately after.
    if (sourceTabId !== null) {
      await project100MvpCollectNetworkEvidence(sourceTabId);
      try {
        await chrome.tabs.sendMessage(sourceTabId, { type: "PROJECT100_MVP_NETWORK_OBSERVER_DISARM" });
      } catch (_error) {
        // Tab may already be gone; nothing to disarm.
      }
    }
    if (networkObserverRegistered) {
      await project100MvpUnregisterNetworkObserver();
    }
    // Always close ONLY the temporary Sources tab, after every terminal
    // outcome. The user's working tabs are never touched; a failed
    // cleanup never overwrites an otherwise valid terminal state.
    if (sourceTabId !== null) {
      try {
        await chrome.tabs.remove(sourceTabId);
      } catch (_error) {
        // Best-effort cleanup; a closed tab must never fail the job report.
      }
    }
  }
}

// Completion detector, combined channel: bounded read-only polling inside the
// SAME absolute window (driveUpdatedAt + PROJECT100_MVP_BACKGROUND_SYNC_WINDOW_MS)
// of BOTH the structured backend receipt (when the pre-flight probe proved it
// reachable) AND the exact bound Source's DOM sync state. Either channel
// independently confirms Published; an explicit error observed on either
// channel before terminal confirmation fails closed. Never clicks Resync;
// never mutates via the internal API.
async function project100MvpWaitForBackendReceipt(tabId, binding, saved, driveUpdatedAt, preReceipt, diagnostics = {}) {
  const extras = {
    captureDiagnostics: diagnostics.captureDiagnostics || null,
    driveGate: diagnostics.driveGate || null,
    resyncEvidence: diagnostics.resyncEvidence || null
  };
  const preSyncValue = typeof diagnostics.preSyncValue === "string" ? diagnostics.preSyncValue : "";
  const deadline = driveUpdatedAt + PROJECT100_MVP_BACKGROUND_SYNC_WINDOW_MS;
  let confirmedCount = 0;
  let lastConfirmedValue = "";
  while (Date.now() < deadline) {
    // --- Receipt channel ---
    let probe = null;
    try {
      const timeoutMs = project100MvpRemainingTimeout(
        deadline, PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS);
      if (!timeoutMs) {
        break;
      }
      probe = await project100MvpWithTimeout(
        chrome.tabs.sendMessage(tabId, {
          type: "PROJECT100_MVP_CONNECTOR_SCOPE_RECEIPT",
          filename: binding.filename,
          driveFileId: binding.driveFileId,
          sourcePageUrl: binding.sourcePageUrl
        }),
        timeoutMs,
        "RECEIPT_NOT_RESPONDING"
      );
    } catch (_error) {
      probe = null;
    }
    // PASS 1: keep the observed network diagnostics fresh (never a verdict).
    const evidenceTimeoutMs = project100MvpRemainingTimeout(
      deadline, PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS);
    if (!evidenceTimeoutMs) {
      break;
    }
    await project100MvpCollectNetworkEvidence(tabId, evidenceTimeoutMs);
    if (probe && probe.status === "PASS" && probe.receipt) {
      const receipt = probe.receipt;
      // Explicit failure evidence = non-empty sync_error_code OR
      // sync_error_message. last_sync_detail_message is diagnostic text
      // only and must never trigger a failure on its own.
      if (receipt.sync_error_code !== "" || receipt.sync_error_message !== "") {
        const detail = receipt.sync_error_message ||
          receipt.sync_error_code || receipt.last_sync_detail_message || "";
        await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
          byteLength: saved.byteLength,
          sha256: saved.sha256,
          driveUpdated: true,
          resynced: false,
          error: "POST_SYNC_ERROR_STATE",
          partialMessage: detail
            ? `Saved to Drive\nProject Source sync reported an error: ${detail.slice(0, 160)}`
            : "Saved to Drive\nProject Source sync reported an error.",
          publishedAt: "",
          ...extras
        }));
        return;
      }
      if (receipt.last_sync_status === "completed" &&
          receipt.last_sync_completed_at !== "" &&
          receipt.last_sync_completed_at !== preReceipt.lastSyncCompletedAt) {
        await project100MvpWritePublishState(project100MvpPublishSnapshot("published", binding, {
          byteLength: saved.byteLength,
          sha256: saved.sha256,
          driveUpdated: true,
          resynced: true,
          error: "",
          partialMessage: "",
          publishedAt: new Date().toISOString(),
          ...extras
        }));
        return;
      }
      // completed-but-unchanged timestamp (stale receipt), in-progress or
      // unknown status, or source momentarily missing: keep polling.
    } else if (probe && probe.status === "BLOCKED" &&
               probe.error === "RECEIPT_SOURCE_AMBIGUOUS") {
      // Duplicate exact-source correlation: fail closed, never auto-pick.
      await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
        byteLength: saved.byteLength,
        sha256: saved.sha256,
        driveUpdated: true,
        resynced: false,
        error: "RECEIPT_SOURCE_AMBIGUOUS",
        partialMessage: "Saved to Drive\nProject Source update could not be confirmed.",
        publishedAt: "",
        ...extras,
        resyncEvidence: extras.resyncEvidence
          ? { ...extras.resyncEvidence, completion: "receipt-failed-closed:RECEIPT_SOURCE_AMBIGUOUS" }
          : null
      }));
      return;
    }
    // Structural unavailability (endpoint down, 0 matches, malformed shape)
    // keeps polling inside the bounded window; expiry is truthful below.

    // --- DOM channel (independent confirmation, same window) ---
    let domProbe = null;
    try {
      const timeoutMs = project100MvpRemainingTimeout(
        deadline, PROJECT100_MVP_RECEIPT_RESPONSE_TIMEOUT_MS);
      if (!timeoutMs) {
        break;
      }
      domProbe = await project100MvpWithTimeout(
        chrome.tabs.sendMessage(tabId, {
          type: "PROJECT100_MVP_SYNC_STATE",
          filename: binding.filename,
          driveFileId: binding.driveFileId
        }),
        timeoutMs,
        "SYNC_STATE_NOT_RESPONDING"
      );
    } catch (_error) {
      domProbe = null;
    }
    if (domProbe && domProbe.status === "PASS" && domProbe.syncState &&
        domProbe.syncState.readable && !domProbe.syncState.busy) {
      const state = domProbe.syncState;
      if (state.canonical === "sync_error" || state.canonical === "not_synced") {
        await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
          byteLength: saved.byteLength,
          sha256: saved.sha256,
          driveUpdated: true,
          resynced: false,
          error: "POST_SYNC_ERROR_STATE",
          partialMessage: "Saved to Drive\nProject Source sync reported an error state.",
          publishedAt: "",
          ...extras
        }));
        return;
      }
      if (state.canonical !== "syncing" && state.value && state.value !== preSyncValue) {
        if (state.value === lastConfirmedValue) {
          confirmedCount += 1;
        } else {
          confirmedCount = 1;
          lastConfirmedValue = state.value;
        }
        if (confirmedCount >= PROJECT100_MVP_BACKGROUND_CONFIRMATIONS) {
          await project100MvpWritePublishState(project100MvpPublishSnapshot("published", binding, {
            byteLength: saved.byteLength,
            sha256: saved.sha256,
            driveUpdated: true,
            resynced: true,
            error: "",
            partialMessage: "",
            publishedAt: new Date().toISOString(),
            ...extras,
            resyncEvidence: extras.resyncEvidence
              ? { ...extras.resyncEvidence, completion: "background-dom" }
              : null
          }));
          return;
        }
      } else {
        confirmedCount = 0;
        lastConfirmedValue = "";
      }
    }

    const delayMs = project100MvpRemainingTimeout(deadline, PROJECT100_MVP_RECEIPT_POLL_MS);
    if (!delayMs) {
      break;
    }
    await project100MvpDelay(delayMs);
  }
  await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
    byteLength: saved.byteLength,
    sha256: saved.sha256,
    driveUpdated: true,
    resynced: false,
    error: "PROJECT_SOURCE_SYNC_UNCONFIRMED",
    partialMessage: "Saved to Drive\nProject Source update could not be confirmed.",
    publishedAt: "",
    ...extras,
    resyncEvidence: extras.resyncEvidence
      ? { ...extras.resyncEvidence, completion: "receipt-unconfirmed" }
      : null
  }));
}

// Completion detector, evidence priority 2: bounded read-only background
// verification of the already triggered sync via the exact bound Source's
// DOM sync state. Used only when the backend receipt is structurally
// unavailable (e.g. HTTP 401 on the receipt endpoint). Polls the live
// sync-state snapshot until the terminal state persistently differs from the
// pre-sync value (two consecutive confirmations), an error state shows up,
// or the background window expires. Never clicks Resync.
async function project100MvpVerifyBackgroundSync(tabId, binding, saved, driveUpdatedAt, preSyncValue, diagnostics = {}) {
  const extras = {
    captureDiagnostics: diagnostics.captureDiagnostics || null,
    driveGate: diagnostics.driveGate || null,
    resyncEvidence: diagnostics.resyncEvidence || null
  };
  const deadline = driveUpdatedAt + PROJECT100_MVP_BACKGROUND_SYNC_WINDOW_MS;
  let confirmedCount = 0;
  let lastConfirmedValue = "";
  while (Date.now() < deadline) {
    let probe = null;
    try {
      const timeoutMs = project100MvpRemainingTimeout(
        deadline, PROJECT100_MVP_BACKGROUND_SYNC_POLL_MS);
      if (!timeoutMs) {
        break;
      }
      probe = await project100MvpWithTimeout(
        chrome.tabs.sendMessage(tabId, {
          type: "PROJECT100_MVP_SYNC_STATE",
          filename: binding.filename,
          driveFileId: binding.driveFileId
        }),
        timeoutMs,
        "SYNC_STATE_NOT_RESPONDING"
      );
    } catch (_error) {
      probe = null;
    }
    // PASS 1: keep the observed network diagnostics fresh (never a verdict).
    const evidenceTimeoutMs = project100MvpRemainingTimeout(
      deadline, PROJECT100_MVP_BACKGROUND_SYNC_POLL_MS);
    if (!evidenceTimeoutMs) {
      break;
    }
    await project100MvpCollectNetworkEvidence(tabId, evidenceTimeoutMs);
    if (probe && probe.status === "PASS" && probe.syncState &&
        probe.syncState.readable && !probe.syncState.busy) {
      const state = probe.syncState;
      if (state.canonical === "sync_error" || state.canonical === "not_synced") {
        await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
          byteLength: saved.byteLength,
          sha256: saved.sha256,
          driveUpdated: true,
          resynced: false,
          error: "POST_SYNC_ERROR_STATE",
          partialMessage: "Saved to Drive\nProject Source sync reported an error state.",
          publishedAt: "",
          ...extras
        }));
        return;
      }
      if (state.canonical !== "syncing" && state.value && state.value !== preSyncValue) {
        if (state.value === lastConfirmedValue) {
          confirmedCount += 1;
        } else {
          confirmedCount = 1;
          lastConfirmedValue = state.value;
        }
        if (confirmedCount >= PROJECT100_MVP_BACKGROUND_CONFIRMATIONS) {
          await project100MvpWritePublishState(project100MvpPublishSnapshot("published", binding, {
            byteLength: saved.byteLength,
            sha256: saved.sha256,
            driveUpdated: true,
            resynced: true,
            error: "",
            partialMessage: "",
            publishedAt: new Date().toISOString(),
            ...extras
          }));
          return;
        }
      } else {
        confirmedCount = 0;
        lastConfirmedValue = "";
      }
    }
    const delayMs = project100MvpRemainingTimeout(deadline, PROJECT100_MVP_BACKGROUND_SYNC_POLL_MS);
    if (!delayMs) {
      break;
    }
    await project100MvpDelay(delayMs);
  }
  await project100MvpWritePublishState(project100MvpPublishSnapshot("failed", binding, {
    byteLength: saved.byteLength,
    sha256: saved.sha256,
    driveUpdated: true,
    resynced: false,
    error: "PROJECT_SOURCE_SYNC_UNCONFIRMED",
    partialMessage: "Saved to Drive\nProject Source sync could not be confirmed.",
    publishedAt: "",
    ...extras
  }));
}

function project100MvpMessageProjectId(message, sender) {
  const requested = project100MvpNormalizeProjectId(message && message.projectId);
  const senderUrl = sender && sender.tab && typeof sender.tab.url === "string"
    ? sender.tab.url
    : "";
  const senderProjectId = project100MvpProjectSegmentOf(senderUrl);
  if (requested && senderProjectId && requested !== senderProjectId) {
    throw new Error("PROJECT_CONTEXT_MISMATCH");
  }
  return requested || senderProjectId;
}

function project100MvpOperation(message, sender) {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("PROJECT100_MVP_")) {
    return null;
  }
  const messageProjectId = project100MvpMessageProjectId(message, sender);
  if (message.type === "PROJECT100_MVP_DRIVE_CONNECT") {
    return project100MvpConnectDrive();
  }
  if (message.type === "PROJECT100_MVP_CREATE_CANONICAL") {
    return project100MvpCreateCanonicalSource(message.filename);
  }
  if (message.type === "PROJECT100_MVP_GET_BINDING") {
    return project100MvpReadBindingV2(messageProjectId)
      .then((binding) => ({ status: "PASS", binding }));
  }
  if (message.type === "PROJECT100_MVP_SET_SOURCE_BINDING") {
    return project100MvpSetSourceBinding({ ...message, projectId: messageProjectId });
  }
  if (message.type === "PROJECT100_MVP_UPDATE_CANONICAL") {
    return project100MvpUpdateCanonicalSource({ ...message, projectId: messageProjectId });
  }
  if (message.type === "PROJECT100_MVP_GET_PUBLISH_STATE") {
    return project100MvpReadPublishState(messageProjectId)
      .then((publishState) => ({ status: "PASS", publishState }));
  }
  if (message.type === "PROJECT100_MVP_GET_ONBOARDING") {
    return project100MvpReadOnboardingState(messageProjectId)
      .then((onboarding) => ({ status: "PASS", onboarding }));
  }
  if (message.type === "PROJECT100_MVP_ONBOARDING_PROCEED") {
    return project100MvpOnboardingProceed({ ...message, projectId: messageProjectId });
  }
  if (message.type === "PROJECT100_MVP_ONBOARDING_SOURCE_DETECTED") {
    return project100MvpOnboardingSourceDetected(
      { ...message, projectId: messageProjectId }, sender);
  }
  if (message.type === "PROJECT100_MVP_ONBOARDING_WATCH_EXPIRED") {
    // The bounded auto-bind window expired: reset the pending phase so a
    // later Continue connection re-opens and re-arms the onboarding tab.
    return project100MvpReadOnboardingState(messageProjectId).then(async (state) => {
      if (state && state.phase === "watching") {
        state.phase = "canonical-ready";
        state.updatedAt = new Date().toISOString();
        await project100MvpWriteOnboardingState(state, messageProjectId);
      }
      return { status: "PASS" };
    });
  }
  if (message.type === "PROJECT100_MVP_PUBLISH") {
    return project100MvpRunPublish({ projectId: messageProjectId });
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const mvpOperation = project100MvpOperation(message, sender);
  if (mvpOperation) {
    mvpOperation
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        status: "BLOCKED",
        error: project100MvpSafeError(error)
      }));
    return true;
  }

  if (message && message.type === "PROJECT100_ARM_DOWNLOAD_CAPTURE") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId !== "number") {
      sendResponse({
        ok: false,
        error: "DOWNLOAD_CAPTURE_TAB_UNAVAILABLE"
      });
      return false;
    }
    if (!isValidDownloadCaptureFilename(message.filename)) {
      sendResponse({
        ok: false,
        error: "DOWNLOAD_CAPTURE_FILENAME_UNEXPECTED"
      });
      return false;
    }
    if (downloadCaptureJob) {
      sendResponse({
        ok: false,
        error: "DOWNLOAD_CAPTURE_BUSY"
      });
      return false;
    }

    const job = {
      sourceTabId: tabId,
      expectedFilename: String(message.filename),
      armedAt: Date.now(),
      provisional: [],
      boundDownloadId: null,
      monitorStarted: false,
      diagnostic: createDownloadDiagnostic(),
      timeoutId: 0,
      finished: false
    };
    job.timeoutId = setTimeout(() => {
      if (!job.finished) {
        sendDownloadCaptureResult(job, {
          ok: false,
          error: "DOWNLOAD_CAPTURE_TIMEOUT"
        });
      }
    }, DOWNLOAD_CAPTURE_TIMEOUT_MS);
    downloadCaptureJob = job;
    sendResponse({
      ok: true,
      capture: "chrome_downloads"
    });
    return false;
  }

  if (message && message.type === "PROJECT100_DISARM_DOWNLOAD_CAPTURE") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId === "number" && downloadCaptureJob && downloadCaptureJob.sourceTabId === tabId) {
      discardDownloadCaptureJob(downloadCaptureJob);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (!message || message.type !== "PROJECT100_FETCH_EXACT_DOM_URL") {
    return false;
  }

  fetchExactDomUrl(message.url, sender).then(sendResponse);
  return true;
});
