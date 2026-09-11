(() => {
  "use strict";

  if (window.__project100SourcePublisherSpikeLoaded) {
    return;
  }
  window.__project100SourcePublisherSpikeLoaded = true;

  let TEST_FILENAME = "source-test.md";
  let EXPECTED_DRIVE_ID = "1V-zE0fJNbY_ndW41ovaM-pp9NhziBrJy";
  const EXPECTED_ARTIFACT = {
    canary: "project100-live-browser",
    revision: "v6",
    nonce: "606VMUOLU2L4",
    byteLength: 69,
    sha256: "7909ac67ac5fcafc9a63f0203802d7e8e100b8520419bb94935c18966be85d13"
  };
  const PREFERRED_DOWNLOAD_LABELS = new Set([
    "下载 source-test.md",
    "Download source-test.md"
  ]);
  const UNRELATED_INTERFACE_LABEL_RE = /^(?:正在编码引语|encoding\s+citation|quote(?:\s|$)|citation(?:\s|$))/i;
  // Must stay strictly above the service-worker capture timeout
  // (DOWNLOAD_CAPTURE_TIMEOUT_MS = 12000) so the armed job's timeout payload
  // with its bounded download diagnostic arrives before the page gives up.
  const DOWNLOAD_CAPTURE_TIMEOUT = 15000;
  // Bounded sync-completion settle window. Live evidence: ChatGPT Project
  // Source synchronization can legitimately finish later than 15s (a fresh
  // chat already read the new canary while this wait had returned
  // POST_SYNC_SETTLE_TIMEOUT). Must stay safely below the service-worker
  // Resync response timeout (PROJECT100_MVP_RESYNC_RESPONSE_TIMEOUT_MS =
  // 60000) so the content operation returns its own result first.
  const SYNC_COMPLETION_TIMEOUT = 45000;
  // HY8 latency cleanup fast path: runSourceResync no longer blocks the Fresh
  // Sources production route behind the full 45s DOM settle wait. After the
  // one-time Resync click it gives the DOM detector only this short window to
  // produce a strong PASS (persistent changed settled state). A strong PASS
  // inside the window is still terminal (the service worker publishes as
  // dom-state-changed immediately); expiry is NOT an error that blocks the
  // Fresh Sources phase — the service worker starts it as soon as the trigger
  // receipt returns (see POST_SYNC_FAST_PATH_EXPIRED). Kept well below the
  // service-worker Resync response timeout (60000).
  const SYNC_COMPLETION_FAST_PATH_TIMEOUT = 4000;
  // The live-proven opener is modeled as PREVIEW OPENER: it opens the document
  // preview panel; the real download happens from a download control inside
  // that panel. chrome.downloads capture must be armed only after the preview
  // download action is resolved and before that single click.
  const PREVIEW_WAIT_TIMEOUT = 8000;
  const PREVIEW_POLL_INTERVAL = 150;
  const PREVIEW_SETTLE_MS = 250;
  const PREVIEW_CONTROL_LIMIT = 12;
  const PREVIEW_CONTAINER_SELECTOR = [
    '[role="dialog"]',
    '[role="complementary"]',
    "aside",
    '[data-testid*="preview"]',
    '[data-testid*="canvas"]',
    '[data-testid*="artifact"]',
    '[data-testid*="panel"]'
  ].join(",");
  const PREVIEW_FILENAME_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    '[role="heading"]',
    "header",
    '[data-testid*="title"]',
    '[data-testid*="header"]',
    '[data-testid*="filename"]'
  ].join(",");
  const DOWNLOAD_NAME_RE = /(?:\bdownloads?\b|下载)/i;
  const EXCLUDED_PREVIEW_CONTROL_RE = /(?:close|dismiss|cancel|关闭|取消)/i;

  const ARTIFACT_TEXT_LIMIT = 220;
  const DIAGNOSTIC_LIMIT = 6;
  const ARTIFACT_SELECTOR = [
    "a[href]",
    "button",
    "[role]",
    "[download]",
    "[data-href]",
    "[data-url]",
    "[data-download-url]",
    "[data-file-url]",
    "[data-artifact-url]",
    "[data-file-id]",
    "[data-attachment-id]",
    "[data-artifact-id]",
    "span",
    "p",
    "div",
    "li",
    "article"
  ].join(",");
  const DRIVE_SELECTOR = [
    "a[href]",
    "[data-url]",
    "[data-href]",
    "[data-source-url]",
    "[data-drive-url]",
    "[data-file-url]",
    "[data-drive-id]",
    "[data-file-id]",
    "[data-source-id]",
    '[role="link"]',
    '[role="treeitem"]',
    '[role="listitem"]',
    '[role="option"]',
    "[aria-label]",
    "[title]",
    "span"
  ].join(",");
  const SOURCE_CONTAINER_SELECTOR = [
    "article",
    "li",
    "section",
    '[role="listitem"]',
    '[role="treeitem"]',
    '[role="option"]',
    '[data-source-id]',
    '[data-source-url]'
  ].join(",");
  const ARTIFACT_TURN_SELECTOR = [
    "article",
    '[data-message-author-role="assistant"]',
    '[data-testid*="conversation-turn"]'
  ].join(",");

  const ACTION_NAME_RE = /(?:more\s+actions?|source\s+actions?|file\s+actions?|actions?|more\s+options?|options?|menu|更多操作|更多选项|操作|菜单)/i;
  const RESYNC_NAME_RE = /^(?:re[- ]?sync|重新同步)$/i;
  const FORBIDDEN_ACTION_RE = /(?:delete|remove|upload|replace|取消关联|删除|上传|替换)/i;
  const STATUS_PATTERNS = [
    // Project Source-local state only; unrelated page timestamps must not match.
    { key: "synced", re: /^上次同步时间\s*[：:]\s*\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})$/i },
    { key: "not_synced", re: /(?:not\s+synced|out\s+of\s+date|needs?\s+sync|sync(?:hroni[sz]e)?\s+required|未同步|待同步|需要同步|过期)/i },
    { key: "sync_error", re: /(?:sync(?:hroni[sz]e)?(?:ation)?\s+(?:error|failed|failure)|failed\s+to\s+sync|同步失败|同步错误)/i },
    { key: "syncing", re: /(?:sync(?:hroni[sz]e)?(?:ation)?\s*(?:in\s+progress|now)|syncing|同步中|正在同步)/i },
    { key: "synced", re: /(?:last\s+synced|up\s+to\s+date|sync(?:hroni[sz]e)?d|sync(?:hroni[sz]e)?(?:ation)?\s+(?:complete|completed)|已同步|同步完成)/i }
  ];
  const LINKED_SOURCE_MARKER_RE = /(?:project\s+sources?|project\s+source|linked\s+sources?|linked\s+source|google\s+drive|drive\s+source|source\s+(?:action|resync|sync|file)|项目来源|项目源|已链接来源|来源操作)/i;
  const LINKED_SOURCE_ATTRIBUTE_RE = /^(?:data-(?:source|drive|project-source|linked-source)(?:-|$)|aria-(?:label|description)|title)$/i;
  // T3 identity rule: a bare Drive ID is accepted only from attributes whose
  // name itself declares an ID semantic, and only when the value equals
  // EXPECTED_DRIVE_ID. Visible text is never identity unless it carries a
  // parseable drive.google.com URL.
  const EXPLICIT_DRIVE_ID_ATTRIBUTE_RE = /^(?:data-drive-id|data-source-id|data-file-id)$/i;

  let nextElementId = 1;
  const elementIds = new WeakMap();
  let pendingDownloadCapture = null;

  function waitForDownloadCapture(timeoutMilliseconds = DOWNLOAD_CAPTURE_TIMEOUT) {
    if (pendingDownloadCapture) {
      return Promise.reject(new Error("DOWNLOAD_CAPTURE_BUSY"));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        timeoutId: 0,
        resolve: null,
        reject: null
      };
      waiter.resolve = (value) => {
        if (pendingDownloadCapture !== waiter) {
          return;
        }
        window.clearTimeout(waiter.timeoutId);
        pendingDownloadCapture = null;
        resolve(value);
      };
      waiter.reject = (error) => {
        if (pendingDownloadCapture !== waiter) {
          return;
        }
        window.clearTimeout(waiter.timeoutId);
        pendingDownloadCapture = null;
        reject(error);
      };
      waiter.timeoutId = window.setTimeout(() => {
        if (pendingDownloadCapture === waiter) {
          pendingDownloadCapture = null;
          reject(new Error("DOWNLOAD_CAPTURE_TIMEOUT"));
        }
      }, timeoutMilliseconds);
      pendingDownloadCapture = waiter;
    });
  }

  function cancelDownloadCaptureWaiter(error = new Error("DOWNLOAD_CAPTURE_CANCELLED")) {
    if (pendingDownloadCapture) {
      pendingDownloadCapture.reject(error);
    }
  }

  function settleDownloadCaptureMessage(message) {
    if (!message || message.type !== "PROJECT100_DOWNLOAD_CAPTURE_RESULT" || !pendingDownloadCapture) {
      return false;
    }
    if (message.ok && message.url) {
      pendingDownloadCapture.resolve(message);
    } else {
      const error = new Error(message.error || "DOWNLOAD_CAPTURE_FAILED");
      error.downloadDiagnostic = {
        download_event_seen: Boolean(message.download_event_seen),
        created_basename_initial: String(message.created_basename_initial || ""),
        filename_became_available: Boolean(message.filename_became_available),
        resolved_basename: String(message.resolved_basename || ""),
        resolved_filename_qualified: Boolean(message.resolved_filename_qualified),
        captured_download_id_present: Boolean(message.captured_download_id_present),
        download_monitor_started: Boolean(message.download_monitor_started),
        download_item_found: Boolean(message.download_item_found),
        download_state: String(message.download_state || "")
      };
      pendingDownloadCapture.reject(error);
    }
    return true;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function isElement(value) {
    return value instanceof Element;
  }

  function isVisible(element) {
    if (!isElement(element) || element.hidden) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function clippedText(value, limit = ARTIFACT_TEXT_LIMIT) {
    const normalized = normalizeText(value);
    return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
  }

  function elementText(element) {
    if (!isElement(element)) {
      return "";
    }
    return normalizeText(element.innerText || element.textContent || "");
  }

  function decodeMaybe(value) {
    try {
      return decodeURIComponent(String(value || ""));
    } catch (_error) {
      return String(value || "");
    }
  }

  function hasExactFilename(value) {
    const decoded = decodeMaybe(value).toLowerCase();
    const filename = TEST_FILENAME.toLowerCase();
    const index = decoded.indexOf(filename);
    if (index < 0) {
      return false;
    }
    const before = decoded[index - 1] || "";
    const after = decoded[index + filename.length] || "";
    return !/[a-z0-9_.-]/i.test(before) && !/[a-z0-9_.-]/i.test(after);
  }

  function isPreferredDownloadAction(element) {
    if (!isElement(element) || !isVisible(element) || element.tagName !== "BUTTON") {
      return false;
    }
    const label = String(element.getAttribute("aria-label") || "").trim();
    return PREFERRED_DOWNLOAD_LABELS.has(label);
  }

  function isUnrelatedInterfaceControl(element) {
    if (!isElement(element)) {
      return false;
    }
    const label = String(element.getAttribute("aria-label") || "").trim();
    return UNRELATED_INTERFACE_LABEL_RE.test(label);
  }

  function getElementId(element) {
    if (!elementIds.has(element)) {
      elementIds.set(element, `element-${nextElementId++}`);
    }
    return elementIds.get(element);
  }

  function relevantAttributes(element) {
    if (!isElement(element)) {
      return [];
    }

    const entries = [];
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const relevant = name === "href" ||
        name === "download" ||
        name === "title" ||
        name === "aria-label" ||
        name === "aria-haspopup" ||
        name === "aria-controls" ||
        name === "aria-expanded" ||
        name === "aria-busy" ||
        /^(?:data-)?(?:file|artifact|attachment|source|drive|download|sync|status|url|href)(?:-|$)/i.test(name);
      if (relevant && attribute.value) {
        entries.push({ name, value: attribute.value });
      }
    }
    return entries;
  }

  function attributeValue(element, names) {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function toAbsoluteUrl(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw || raw === "#" || /^javascript:/i.test(raw) || /^mailto:/i.test(raw)) {
      return "";
    }
    try {
      const url = new URL(raw, window.location.href);
      if (!["http:", "https:", "blob:", "data:"].includes(url.protocol)) {
        return "";
      }
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function sanitizeUrl(rawValue) {
    const raw = String(rawValue || "");
    if (!raw) {
      return "";
    }
    if (/^data:/i.test(raw)) {
      const comma = raw.indexOf(",");
      return comma >= 0 ? `${raw.slice(0, comma)};[payload omitted]` : "data:[payload omitted]";
    }
    if (/^blob:/i.test(raw)) {
      try {
        return `blob:${new URL(raw).origin}/[token omitted]`;
      } catch (_error) {
        return "blob:[unparseable]";
      }
    }
    try {
      const url = new URL(raw, window.location.href);
      return `${url.origin}${url.pathname}`;
    } catch (_error) {
      return clippedText(raw, 160);
    }
  }

  function isPrivateOpenAiEndpoint(rawValue) {
    try {
      const url = new URL(rawValue);
      const host = url.hostname.toLowerCase();
      const openAiHost = host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com" || host.endsWith(".openai.com");
      return openAiHost && /\/(?:backend-api|api|files)(?:\/|$)/i.test(url.pathname);
    } catch (_error) {
      return false;
    }
  }

  function isGoogleDriveUrl(rawValue) {
    try {
      const url = new URL(rawValue);
      const host = url.hostname.toLowerCase();
      return host === "drive.google.com" || host.endsWith(".drive.google.com");
    } catch (_error) {
      return false;
    }
  }

  function containsKnownDriveId(value) {
    return decodeMaybe(value).includes(EXPECTED_DRIVE_ID);
  }

  function isAllowedArtifactHost(rawValue) {
    if (/^(?:blob|data):/i.test(rawValue)) {
      return true;
    }
    try {
      const url = new URL(rawValue);
      const host = url.hostname.toLowerCase();
      const currentHost = window.location.hostname.toLowerCase();
      const chatHost = host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com" || host.endsWith(".openai.com");
      const artifactHost = host === "oaiusercontent.com" || host.endsWith(".oaiusercontent.com") || host === "openaiusercontent.com" || host.endsWith(".openaiusercontent.com");
      return host === currentHost || chatHost || artifactHost;
    } catch (_error) {
      return false;
    }
  }

  function linkedSourceContextReason(candidate) {
    const nodes = [];
    const addNodeAndAncestors = (node) => {
      let current = node;
      let depth = 0;
      while (current && depth < 4 && current !== document.body) {
        if (!nodes.includes(current)) {
          nodes.push(current);
        }
        current = current.parentElement;
        depth += 1;
      }
    };
    addNodeAndAncestors(candidate.identityNode || candidate.element);
    if (candidate.container !== candidate.identityNode) {
      addNodeAndAncestors(candidate.container);
    }

    for (const node of nodes) {
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value || "";
        if (containsKnownDriveId(value)) {
          return "KNOWN_DRIVE_ID";
        }
        if (LINKED_SOURCE_ATTRIBUTE_RE.test(name) && LINKED_SOURCE_MARKER_RE.test(value)) {
          return `LINKED_SOURCE_ATTRIBUTE:${name}`;
        }
        if (LINKED_SOURCE_ATTRIBUTE_RE.test(name) && /^(?:data-(?:source|drive|project-source|linked-source))/i.test(name)) {
          return `LINKED_SOURCE_ATTRIBUTE:${name}`;
        }
      }

      const semanticText = [
        node.getAttribute("aria-label") || "",
        node.getAttribute("aria-description") || "",
        node.getAttribute("title") || "",
        elementText(node).length <= 320 ? elementText(node) : ""
      ].join(" ");
      if (LINKED_SOURCE_MARKER_RE.test(semanticText)) {
        return "LINKED_SOURCE_SEMANTIC_CONTEXT";
      }
    }
    return "";
  }

  function artifactCandidateRejectionReason(candidate) {
    const identityUrl = candidate.identity && candidate.identity.fetchUrl ? candidate.identity.fetchUrl : "";
    if (identityUrl && isGoogleDriveUrl(identityUrl)) {
      return "REJECTED_GOOGLE_DRIVE_URL";
    }
    if (identityUrl && containsKnownDriveId(identityUrl)) {
      return "REJECTED_KNOWN_DRIVE_ID";
    }
    const linkedSourceReason = linkedSourceContextReason(candidate);
    if (linkedSourceReason) {
      return linkedSourceReason;
    }
    if (identityUrl && !isAllowedArtifactHost(identityUrl)) {
      return "REJECTED_NON_CHATGPT_ARTIFACT_HOST";
    }
    return "";
  }

  function extractFileIdentity(element) {
    if (!isElement(element)) {
      return null;
    }

    const directUrlNames = [
      "href",
      "data-href",
      "data-url",
      "data-download-url",
      "data-file-url",
      "data-artifact-url",
      "data-source-url",
      "data-drive-url"
    ];
    for (const name of directUrlNames) {
      const raw = element.getAttribute(name);
      const url = toAbsoluteUrl(raw);
      if (url) {
        const type = url.startsWith("blob:") ? "blob_url" : url.startsWith("data:") ? "data_url" : "http_url";
        return {
          fetchUrl: url,
          identityType: type,
          identitySource: `${element.tagName.toLowerCase()}[${name}]`,
          identityKey: `${type}:${url}`,
          diagnosticUrl: sanitizeUrl(url)
        };
      }
    }

    const idNames = [
      "data-file-id",
      "data-attachment-id",
      "data-artifact-id",
      "data-source-id",
      "data-drive-id"
    ];
    for (const name of idNames) {
      const value = element.getAttribute(name);
      if (value) {
        return {
          fetchUrl: "",
          identityType: "dom_token",
          identitySource: `${element.tagName.toLowerCase()}[${name}]`,
          identityKey: `${name}:${value}`,
          diagnosticUrl: "",
          candidateFileToken: `[redacted; length=${value.length}]`
        };
      }
    }

    return null;
  }

  function findArtifactIdentity(element) {
    let current = element;
    let depth = 0;
    while (current && depth < 8 && current !== document.body) {
      const identity = extractFileIdentity(current);
      if (identity) {
        return { identity, identityNode: current };
      }
      current = current.parentElement;
      depth += 1;
    }
    return { identity: null, identityNode: null };
  }

  function semanticPath(element) {
    const path = [];
    let current = element;
    let depth = 0;
    while (current && depth < 5 && current !== document.body) {
      const role = current.getAttribute("role");
      const aria = current.getAttribute("aria-label");
      const title = current.getAttribute("title");
      if (role || aria || title || current.matches(SOURCE_CONTAINER_SELECTOR)) {
        const label = aria || title || role || "";
        path.push(`${current.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${label ? `(${clippedText(label, 60)})` : ""}`);
      }
      current = current.parentElement;
      depth += 1;
    }
    return path;
  }

  function artifactFilenameEvidence(element) {
    const ownText = elementText(element);
    if (hasExactFilename(ownText)) {
      return TEST_FILENAME;
    }

    for (const { name, value } of relevantAttributes(element)) {
      if (hasExactFilename(value)) {
        return TEST_FILENAME;
      }
    }
    return "";
  }

  function isArtifactSemanticElement(element) {
    if (!isElement(element)) {
      return false;
    }
    return ["A", "BUTTON"].includes(element.tagName) ||
      ["link", "button"].includes((element.getAttribute("role") || "").toLowerCase()) ||
      element.hasAttribute("download") ||
      ["data-file-id", "data-attachment-id", "data-artifact-id", "data-download-url", "data-file-url", "data-artifact-url"]
        .some((name) => element.hasAttribute(name));
  }

  function findArtifactContainer(element, identityNode) {
    let current = identityNode || element;
    let depth = 0;
    let fallback = identityNode || element;
    while (current && depth < 8 && current !== document.body) {
      const text = elementText(current);
      if (hasExactFilename(text)) {
        fallback = current;
        const hasSemanticBoundary = current.matches(SOURCE_CONTAINER_SELECTOR) || current.querySelector("a[href], [role=button], button");
        if (hasSemanticBoundary) {
          return current;
        }
      }
      current = current.parentElement;
      depth += 1;
    }
    return fallback;
  }

  function findArtifactScope(element, identityNode) {
    const fallback = findArtifactContainer(element, identityNode);
    let current = identityNode || element;
    let depth = 0;
    while (current && depth < 12 && current !== document.body) {
      if (current.matches(ARTIFACT_TURN_SELECTOR) && hasExactFilename(elementText(current))) {
        return current;
      }
      current = current.parentElement;
      depth += 1;
    }
    return fallback;
  }

  function artifactAliasCount(scope, primaryElement) {
    if (!isElement(scope)) {
      return 0;
    }
    return Array.from(scope.querySelectorAll("button, a, [role=button], [role=link]"))
      .filter((element) => element !== primaryElement && isVisible(element) && artifactFilenameEvidence(element))
      .length;
  }

  function artifactCandidateDiagnostic(candidate) {
    const element = candidate.element;
    const attrs = {};
    for (const { name, value } of relevantAttributes(element)) {
      const sensitiveIdentity = /(?:token|secret|auth|cookie|password|(?:data-)?(?:file|attachment|artifact|source|drive)-id)/i.test(name);
      attrs[name] = name === "href" || /url/i.test(name)
        ? sanitizeUrl(value)
        : sensitiveIdentity
          ? `[redacted; length=${value.length}]`
          : clippedText(value, 100);
    }
    return {
      candidate_status: candidate.rejectionReason ? "rejected" : "eligible",
      rejection_reason: candidate.rejectionReason || "",
      tag: element.tagName.toLowerCase(),
      href: candidate.identity && candidate.identity.diagnosticUrl ? candidate.identity.diagnosticUrl : "",
      aria_label: clippedText(element.getAttribute("aria-label"), 100),
      title: clippedText(element.getAttribute("title"), 100),
      relevant_attributes: attrs,
      nearby_semantic_structure: semanticPath(candidate.container),
      candidate_file_token: candidate.candidateFileToken || TEST_FILENAME,
      preferred_action: candidate.preferredAction
        ? {
          tag: element.tagName.toLowerCase(),
          aria_label: clippedText(element.getAttribute("aria-label"), 100)
        }
        : null,
      artifact_alias_count: candidate.aliasCount || 0
    };
  }

  function makeArtifactCandidate(element, preferredAction = false) {
    const { identity, identityNode } = findArtifactIdentity(element);
    const container = findArtifactScope(element, identityNode);
    return {
      element,
      container,
      identity,
      identityNode,
      preferredAction,
      aliasCount: artifactAliasCount(container, element),
      candidateFileToken: TEST_FILENAME
    };
  }

  function collectRejectedArtifactHits(preferredElements, rejectedByElement) {
    const elements = Array.from(document.querySelectorAll(ARTIFACT_SELECTOR));
    const preferredSet = new Set(preferredElements);
    for (const element of elements) {
      if (!isVisible(element) || preferredSet.has(element)) {
        continue;
      }

      const filenameHit = Boolean(artifactFilenameEvidence(element));
      const unrelatedControl = isUnrelatedInterfaceControl(element);
      if (!filenameHit && !unrelatedControl) {
        continue;
      }
      if (!isArtifactSemanticElement(element) && elementText(element).length > 120) {
        continue;
      }

      const candidate = makeArtifactCandidate(element);
      const contextReason = artifactCandidateRejectionReason(candidate);
      candidate.rejectionReason = contextReason ||
        (unrelatedControl
          ? "REJECTED_UNRELATED_INTERFACE_CONTROL"
          : "REJECTED_NON_PREFERRED_FILENAME_HIT");
      rejectedByElement.set(element, candidate);
    }
  }

  function collectArtifactCandidates() {
    const candidates = [];
    const preferredElements = Array.from(document.querySelectorAll("button"))
      .filter((element) => isPreferredDownloadAction(element));
    const rejectedByElement = new Map();

    for (const element of preferredElements) {
      const candidate = makeArtifactCandidate(element, true);
      const rejectionReason = artifactCandidateRejectionReason(candidate);
      if (rejectionReason) {
        candidate.rejectionReason = rejectionReason;
        rejectedByElement.set(element, candidate);
        continue;
      }
      candidates.push(candidate);
    }

    collectRejectedArtifactHits(preferredElements, rejectedByElement);
    for (const candidate of candidates) {
      candidate.diagnostic = artifactCandidateDiagnostic(candidate);
    }
    const rejected = Array.from(rejectedByElement.values());
    for (const candidate of rejected) {
      candidate.diagnostic = artifactCandidateDiagnostic(candidate);
    }
    return { candidates, rejected, preferredActions: preferredElements };
  }


  function parseDataUrl(url) {
    const comma = url.indexOf(",");
    if (comma < 0) {
      throw new Error("DATA_URL_MALFORMED");
    }
    const metadata = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    if (/;base64/i.test(metadata)) {
      const binary = window.atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  }

  async function readBytesFromUrl(url) {
    if (url.startsWith("data:")) {
      return {
        bytes: parseDataUrl(url),
        method: "direct_fetch",
        privateEndpointUsed: false,
        endpoint: url
      };
    }

    let firstError = "";
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "include",
        redirect: "follow"
      });
      if (!response.ok) {
        throw new Error(`HTTP_${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return {
        bytes: new Uint8Array(buffer),
        method: "direct_fetch",
        privateEndpointUsed: isPrivateOpenAiEndpoint(url) || isPrivateOpenAiEndpoint(response.url),
        endpoint: response.url
      };
    } catch (error) {
      firstError = error instanceof Error ? error.message : "DIRECT_FETCH_FAILED";
    }

    if (/^https:/i.test(url)) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "PROJECT100_FETCH_EXACT_DOM_URL",
          url
        });
        if (response && response.ok && Array.isArray(response.bytes)) {
          return {
            bytes: Uint8Array.from(response.bytes),
            method: "direct_fetch",
            privateEndpointUsed: isPrivateOpenAiEndpoint(url) || isPrivateOpenAiEndpoint(response.finalUrl),
            endpoint: response.finalUrl || url
          };
        }
        throw new Error(response && response.error ? response.error : "SERVICE_WORKER_FETCH_FAILED");
      } catch (error) {
        const secondError = error instanceof Error ? error.message : "SERVICE_WORKER_FETCH_FAILED";
        throw new Error(`DIRECT_FETCH_FAILED:${firstError};EXACT_DOM_FETCH_FAILED:${secondError}`);
      }
    }

    throw new Error(`DIRECT_FETCH_FAILED:${firstError}`);
  }

  function artifactCaptureUrlRejectionReason(rawValue) {
    const url = String(rawValue || "");
    if (!url) {
      return "DOWNLOAD_URL_UNAVAILABLE";
    }
    if (isGoogleDriveUrl(url)) {
      return "REJECTED_GOOGLE_DRIVE_URL";
    }
    if (containsKnownDriveId(url)) {
      return "REJECTED_KNOWN_DRIVE_ID";
    }
    if (!isAllowedArtifactHost(url)) {
      return "REJECTED_NON_CHATGPT_ARTIFACT_HOST";
    }
    return "";
  }

  async function armDownloadCapture() {
    const response = await chrome.runtime.sendMessage({
      type: "PROJECT100_ARM_DOWNLOAD_CAPTURE",
      filename: TEST_FILENAME
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "DOWNLOAD_CAPTURE_ARM_FAILED");
    }
  }

  async function disarmDownloadCapture() {
    try {
      await chrome.runtime.sendMessage({ type: "PROJECT100_DISARM_DOWNLOAD_CAPTURE" });
    } catch (_error) {
      // The browser may already have discarded the short-lived capture job.
    }
  }

  function previewContainersInDom() {
    return Array.from(document.querySelectorAll(PREVIEW_CONTAINER_SELECTOR))
      .filter((element) => isVisible(element));
  }

  function isInsideConversationTurn(element) {
    let current = element;
    let depth = 0;
    while (current && depth < 14 && current !== document.body) {
      if (current.matches(ARTIFACT_TURN_SELECTOR)) {
        return true;
      }
      current = current.parentElement;
      depth += 1;
    }
    return false;
  }

  function previewControlQualifies(element) {
    const name = actionControlName(element);
    if (EXCLUDED_PREVIEW_CONTROL_RE.test(name) || FORBIDDEN_ACTION_RE.test(name)) {
      return false;
    }
    if (DOWNLOAD_NAME_RE.test(name)) {
      return true;
    }
    return element.tagName === "A" && element.hasAttribute("download");
  }

  function findPreviewDownloadActions(previewRoot) {
    return Array.from(previewRoot.querySelectorAll('button, a, [role="button"], [role="menuitem"]'))
      .filter((element) => isVisible(element) && previewControlQualifies(element));
  }

  function previewFilenameEvidence(container) {
    const evidence = [];
    for (const name of ["aria-label", "title"]) {
      const value = container.getAttribute(name);
      if (value && hasExactFilename(value)) {
        evidence.push({ source: `container[${name}]`, text: clippedText(value, 120) });
      }
    }

    for (const element of Array.from(container.querySelectorAll(PREVIEW_FILENAME_SELECTOR))) {
      if (!isVisible(element)) {
        continue;
      }
      const values = [
        [`${element.tagName.toLowerCase()}[text]`, elementText(element)],
        [`${element.tagName.toLowerCase()}[aria-label]`, element.getAttribute("aria-label") || ""],
        [`${element.tagName.toLowerCase()}[title]`, element.getAttribute("title") || ""]
      ];
      for (const [source, value] of values) {
        if (value && value.length <= 200 && hasExactFilename(value)) {
          evidence.push({ source, text: clippedText(value, 120) });
        }
      }
    }

    if (evidence.length === 0) {
      const descendants = Array.from(container.querySelectorAll("*")).slice(0, 400);
      for (const element of descendants) {
        if (!isVisible(element)) {
          continue;
        }
        const text = elementText(element);
        if (text && text.length <= 120 && hasExactFilename(text)) {
          evidence.push({ source: `${element.tagName.toLowerCase()}[text]`, text: clippedText(text, 120) });
          break;
        }
      }
    }
    return evidence;
  }

  function previewIdentitySummary(container, evidence, preexisting) {
    const text = elementText(container);
    return {
      proven_filename: TEST_FILENAME,
      tag: container.tagName.toLowerCase(),
      role: container.getAttribute("role") || "",
      aria_label: clippedText(container.getAttribute("aria-label"), 120),
      title: clippedText(container.getAttribute("title"), 120),
      filename_evidence: evidence,
      content_canary_visible: text.includes(`SOURCE_CANARY=${EXPECTED_ARTIFACT.canary}`),
      content_nonce_visible: text.includes(EXPECTED_ARTIFACT.nonce),
      preexisting_before_opener_click: preexisting
    };
  }

  function previewControlDiagnostic(previewRoot) {
    return Array.from(previewRoot.querySelectorAll('button, a, [role="button"], [role="menuitem"]'))
      .filter((element) => isVisible(element))
      .slice(0, PREVIEW_CONTROL_LIMIT)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        aria_label: clippedText(element.getAttribute("aria-label"), 100),
        title: clippedText(element.getAttribute("title"), 100),
        name: clippedText(actionControlName(element), 120),
        qualifies_as_download: previewControlQualifies(element)
      }));
  }

  function previewContainerScanDiagnostic(container, preClickSet) {
    return {
      tag: container.tagName.toLowerCase(),
      role: container.getAttribute("role") || "",
      aria_label: clippedText(container.getAttribute("aria-label"), 120),
      title: clippedText(container.getAttribute("title"), 120),
      filename_evidence_hits: previewFilenameEvidence(container).length,
      download_actions: findPreviewDownloadActions(container).length,
      in_conversation_turn: isInsideConversationTurn(container),
      preexisting_before_opener_click: preClickSet.has(container),
      semantic_path: semanticPath(container)
    };
  }

  function matchingPreviewContainers(containers) {
    return containers.filter((container) =>
      !isInsideConversationTurn(container) && previewFilenameEvidence(container).length > 0);
  }

  function collectPreviewScan(preClickSet) {
    const visibleContainers = previewContainersInDom();
    const qualifying = [];
    for (const container of visibleContainers) {
      if (isInsideConversationTurn(container) || preClickSet.has(container)) {
        continue;
      }
      const evidence = previewFilenameEvidence(container);
      if (evidence.length === 0) {
        continue;
      }
      qualifying.push({
        container,
        evidence,
        preexisting: preClickSet.has(container),
        downloadActions: findPreviewDownloadActions(container)
      });
    }
    const candidates = qualifying.filter((candidate) => !qualifying.some((other) =>
      other !== candidate && other.container.contains(candidate.container)));
    return { candidates, visibleContainers };
  }

  async function waitForPreviewScan(preClickSet) {
    const deadline = Date.now() + PREVIEW_WAIT_TIMEOUT;
    let scan = collectPreviewScan(preClickSet);
    while (scan.candidates.length === 0 && Date.now() < deadline) {
      await delay(PREVIEW_POLL_INTERVAL);
      scan = collectPreviewScan(preClickSet);
    }
    if (scan.candidates.length > 0) {
      await delay(PREVIEW_SETTLE_MS);
      scan = collectPreviewScan(preClickSet);
    }
    return scan;
  }

  // A React preview can legitimately render its identity (container/title)
  // first and its toolbar Download action later. After exact preview
  // identity, poll the current live DOM instead of trusting the
  // identity-time action snapshot: exactly one qualifying action passes,
  // more than one fails closed immediately, zero keeps polling until the
  // bounded timeout. The preview itself is re-resolved every poll, so
  // re-renders that replace children (or the container element) are
  // observed rather than a stale control array.
  async function waitForPreviewDownloadActions(preClickSet) {
    const deadline = Date.now() + PREVIEW_WAIT_TIMEOUT;
    let lastPreview = null;
    let ambiguousCount = 0;
    let ambiguousContainers = [];
    while (Date.now() < deadline) {
      const scan = collectPreviewScan(preClickSet);
      if (scan.candidates.length === 1) {
        lastPreview = scan.candidates[0];
        ambiguousCount = 0;
        ambiguousContainers = [];
        const actions = findPreviewDownloadActions(lastPreview.container);
        if (actions.length >= 1) {
          return { preview: lastPreview, actions, ambiguousCount: 0, ambiguousContainers: [] };
        }
      } else if (scan.candidates.length > 1) {
        ambiguousCount = scan.candidates.length;
        ambiguousContainers = scan.candidates.map((item) => item.container);
      }
      await delay(PREVIEW_POLL_INTERVAL);
    }
    return { preview: lastPreview, actions: [], ambiguousCount, ambiguousContainers };
  }

  async function captureViaPreviewDownload(candidate, result, setStage, validateFrozenTarget) {
    if (typeof validateFrozenTarget === "function") {
      validateFrozenTarget();
    }
    const preClickPreviews = new Set(previewContainersInDom());
    const alreadyOpen = matchingPreviewContainers(Array.from(preClickPreviews));
    if (alreadyOpen.length > 0) {
      result.stage = "preview-identity";
      result.preview_already_open = true;
      result.errors.push("PREVIEW_ALREADY_OPEN");
      result.preview_dom = alreadyOpen.slice(0, DIAGNOSTIC_LIMIT).map((container) =>
        previewContainerScanDiagnostic(container, preClickPreviews));
      result.diagnostics = [candidate.diagnostic];
      return null;
    }

    setStage("preview-open");
    activateOnce(candidate.element);
    if (typeof validateFrozenTarget === "function") {
      validateFrozenTarget();
    }

    setStage("preview-identity");
    const scan = await waitForPreviewScan(preClickPreviews);
    if (typeof validateFrozenTarget === "function") {
      validateFrozenTarget();
    }
    if (scan.candidates.length !== 1) {
      result.errors.push(scan.candidates.length === 0
        ? "PREVIEW_NOT_FOUND"
        : `PREVIEW_AMBIGUOUS_${scan.candidates.length}`);
      result.preview_dom = scan.visibleContainers
        .slice(0, DIAGNOSTIC_LIMIT)
        .map((container) => previewContainerScanDiagnostic(container, preClickPreviews));
      result.diagnostics = [candidate.diagnostic];
      return null;
    }

    setStage("download-selection");
    const resolved = await waitForPreviewDownloadActions(preClickPreviews);
    if (typeof validateFrozenTarget === "function") {
      validateFrozenTarget();
    }
    if (resolved.ambiguousCount > 0) {
      // Late container-level ambiguity: fail closed, never auto-pick.
      result.errors.push(`PREVIEW_AMBIGUOUS_${resolved.ambiguousCount}`);
      result.preview_dom = resolved.ambiguousContainers
        .slice(0, DIAGNOSTIC_LIMIT)
        .map((container) => previewContainerScanDiagnostic(container, preClickPreviews));
      result.diagnostics = [candidate.diagnostic];
      return null;
    }
    const preview = resolved.preview;
    if (!preview) {
      result.errors.push("PREVIEW_NOT_FOUND");
      result.diagnostics = [candidate.diagnostic];
      return null;
    }
    result.preview_identity = previewIdentitySummary(preview.container, preview.evidence, preview.preexisting);
    result.preview_download_actions = resolved.actions.length;
    if (resolved.actions.length !== 1) {
      // Zero actions after the bounded window (or a transient non-unique
      // state) stays fail-closed: no arm, no download click, diagnostics
      // from the final live DOM state.
      result.errors.push(`PREVIEW_DOWNLOAD_ACTIONS_${resolved.actions.length}`);
      result.preview_controls = previewControlDiagnostic(preview.container);
      result.diagnostics = [candidate.diagnostic];
      return null;
    }

    const downloadAction = resolved.actions[0];
    result.selected_download_action = {
      tag: downloadAction.tagName.toLowerCase(),
      role: downloadAction.getAttribute("role") || "",
      aria_label: String(downloadAction.getAttribute("aria-label") || "").trim(),
      title: String(downloadAction.getAttribute("title") || "").trim()
    };

    let waiter = null;
    let armed = false;
    try {
      setStage("pre-arm");
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      await armDownloadCapture();
      armed = true;
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      waiter = waitForDownloadCapture();
      waiter.catch(() => {});
      setStage("click");
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      activateOnce(downloadAction);
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      setStage("download-intercept");
      const download = await waiter;
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      const urlRejectionReason = artifactCaptureUrlRejectionReason(download.url);
      if (urlRejectionReason) {
        throw new Error(urlRejectionReason);
      }
      setStage("blob-capture");
      const capture = await readBytesFromUrl(download.url);
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      return {
        ...capture,
        method: "chrome_downloads+" + capture.method,
        automaticCapture: true
      };
    } finally {
      cancelDownloadCaptureWaiter();
      if (armed) {
        await disarmDownloadCapture();
      }
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
    }
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  // ---- Popup page-status probe (read-only) ----------------------------------
  // Read-only snapshot for the popup product-state machine. Discovery uses the
  // latest artifact-bearing assistant scope; operation capture uses a separate
  // explicit freeze message and never calls this function again.
  function project100PageStatusSnapshot() {
    let projectSegment = "";
    try {
      const match = window.location.pathname.match(/\/g\/(g-p-[A-Za-z0-9-]+)(?:\/|$|\?)/);
      projectSegment = match ? match[1] : "";
    } catch (_error) {
      projectSegment = "";
    }
    const discovery = mvpDiscoverMarkdownSourcesInChat();
    return {
      status: "PASS",
      page: {
        isProject: Boolean(projectSegment),
        projectId: projectSegment,
        projectSegment,
        artifact: {
          // PC-1A: count is the Markdown set in the latest artifact-bearing
          // assistant scope only.
          count: discovery.sources.length,
          filename: discovery.sources.length === 1 ? discovery.sources[0].filename : "",
          filenames: discovery.sources.map((entry) => entry.filename),
          invalid: discovery.invalid,
          artifactScopes: discovery.artifactScopes || 0,
          winningScopeIndex: Number.isInteger(discovery.scopeIndex) ? discovery.scopeIndex : -1,
          error: discovery.error || ""
        }
      }
    };
  }

  // ---- Single-source v1: first-use onboarding watcher (P3) ------------------
  // Armed on the ACTIVE onboarding Sources tab right after the automatic
  // Drive-link copy. Runs the exact binding probe immediately, then keeps a
  // bounded, debounced page-local MutationObserver so the moment the user
  // finishes the native "Add source → Google Drive → Paste → Add" flow and
  // exactly one canonical Source matches, the binding is reported to the
  // service worker. No automated Add-Source clicking, no Drive-picker
  // automation, no coordinate automation, no visual reasoning.
  const PROJECT100_ONBOARDING_BANNER_ID = "project100-onboarding-banner";
  const PROJECT100_ONBOARDING_WATCH_WINDOW_MS = 600000;
  const PROJECT100_ONBOARDING_DEBOUNCE_MS = 600;
  let onboardingWatchState = null;

  function project100RemoveOnboardingBanner() {
    const banner = document.getElementById(PROJECT100_ONBOARDING_BANNER_ID);
    if (banner && banner.parentElement) {
      banner.parentElement.removeChild(banner);
    }
  }

  // Clearly extension-owned temporary banner (never imitates ChatGPT native
  // UI): fixed position, explicit data marker, bilingual instruction. The
  // banner text is TRUTHFUL: it claims "Drive link copied" only when the
  // popup actually reported a successful automatic copy; otherwise it tells
  // the user to copy the link from the extension popup first (Issue B
  // repair). Re-arming with a different clipboard outcome must update the
  // text, not keep the stale one.
  //
  // Multi-source v1: the banner carries the onboarding queue progress
  // ("i of N · filename") and, from the SECOND queue entry onward, one
  // extension-owned narrow "Copy next link" button that copies ONLY the
  // current queue head's Drive URL. No Source management capability is ever
  // added. The button uses the page gesture; failure updates the button text
  // truthfully and never claims a copy that did not happen.
  function project100ShowOnboardingBanner(options = {}) {
    project100RemoveOnboardingBanner();
    const banner = document.createElement("div");
    banner.id = PROJECT100_ONBOARDING_BANNER_ID;
    banner.setAttribute("data-project100-extension", "onboarding-hint");
    banner.setAttribute("role", "status");
    banner.style.cssText = [
      "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
      "max-width:320px", "padding:10px 14px", "border:2px solid #1a73e8",
      "border-radius:8px", "background:#ffffff", "color:#17202a",
      "font:13px/1.5 system-ui, sans-serif", "box-shadow:0 2px 10px rgba(0,0,0,0.25)"
    ].join(";");
    const zh = String(navigator.language || "").toLowerCase().indexOf("zh") === 0;
    const queueIndex = Number(options.queueIndex) || 0;
    const queueTotal = Number(options.queueTotal) || 0;
    const progress = queueTotal > 1
      ? `${queueIndex + 1} of ${queueTotal} · ${String(options.filename || "")} — `
      : "";
    banner.textContent = progress + (options.linkCopied
      ? (zh
        ? "Project Source Publisher 扩展：Drive 链接已复制。添加来源 → Google Drive → 粘贴 → 添加。"
        : "Project Source Publisher extension: Drive link copied. Add source → Google Drive → Paste → Add.")
      : (zh
        ? "Project Source Publisher 扩展：请在扩展弹窗复制 Drive 链接，然后添加来源 → Google Drive → 粘贴 → 添加。"
        : "Project Source Publisher extension: copy the Drive link in the extension popup, then Add source → Google Drive → Paste → Add."));
    if (options.driveUrl && queueIndex > 0) {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.textContent = zh ? "复制下一个链接" : "Copy next link";
      copyButton.style.cssText = [
        "display:block", "margin-top:8px", "padding:4px 10px",
        "border:1px solid #1a73e8", "border-radius:6px",
        "background:#ffffff", "color:#1a73e8", "cursor:pointer",
        "font:13px/1.4 system-ui, sans-serif"
      ].join(";");
      copyButton.addEventListener("click", async () => {
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) {
            throw new Error("CLIPBOARD_UNAVAILABLE");
          }
          await navigator.clipboard.writeText(String(options.driveUrl));
          copyButton.textContent = zh ? "已复制 ✓" : "Copied ✓";
        } catch (_error) {
          copyButton.textContent = zh ? "复制失败，请手动复制" : "Copy failed — copy manually";
        }
      });
      banner.append(copyButton);
    }
    (document.body || document.documentElement).appendChild(banner);
  }

  function project100StopOnboardingWatch(removeBanner = true) {
    if (onboardingWatchState) {
      if (onboardingWatchState.observer) {
        try {
          onboardingWatchState.observer.disconnect();
        } catch (_error) {
          // Already disconnected.
        }
      }
      if (onboardingWatchState.timeoutId) {
        window.clearTimeout(onboardingWatchState.timeoutId);
      }
      if (onboardingWatchState.debounceId) {
        window.clearTimeout(onboardingWatchState.debounceId);
      }
      onboardingWatchState = null;
    }
    if (removeBanner) {
      project100RemoveOnboardingBanner();
    }
  }

  function project100RunOnboardingWatch(validated) {
    project100StopOnboardingWatch();
    project100ShowOnboardingBanner({
      linkCopied: Boolean(validated.linkCopied),
      queueIndex: Number(validated.queueIndex) || 0,
      queueTotal: Number(validated.queueTotal) || 0,
      filename: validated.filename || "",
      driveUrl: validated.driveUrl || ""
    });
    const windowMs = Math.max(30000, Math.min(3600000, Number(validated.windowMs) || PROJECT100_ONBOARDING_WATCH_WINDOW_MS));
    const attemptBinding = () => {
      const probe = runMvpSourceBindingProbe(validated.filename, validated.driveFileId);
      if (probe.status !== "PASS") {
        return false;
      }
      // Binding succeeded: the onboarding hint must disappear automatically.
      project100StopOnboardingWatch();
      try {
        const notify = chrome.runtime.sendMessage({
          type: "PROJECT100_MVP_ONBOARDING_SOURCE_DETECTED",
          projectId: validated.projectId || "",
          filename: validated.filename,
          driveFileId: validated.driveFileId,
          sourcePageUrl: probe.sourcePageUrl
        });
        if (notify && typeof notify.catch === "function") {
          notify.catch(() => {});
        }
      } catch (_error) {
        // The service worker may be restarting; onboarding stays pending and
        // a later Continue connection re-arms the watcher.
      }
      return true;
    };
    if (attemptBinding()) {
      return { watching: false, bound: true };
    }
    const observer = new MutationObserver(() => {
      if (!onboardingWatchState || onboardingWatchState.debounceId) {
        return;
      }
      onboardingWatchState.debounceId = window.setTimeout(() => {
        if (onboardingWatchState) {
          onboardingWatchState.debounceId = 0;
          attemptBinding();
        }
      }, PROJECT100_ONBOARDING_DEBOUNCE_MS);
    });
    const watch = { observer, debounceId: 0, timeoutId: 0 };
    onboardingWatchState = watch;
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    } catch (_error) {
      // Without an observer the immediate probe already ran; the Continue
      // connection path can re-arm later.
    }
    watch.timeoutId = window.setTimeout(() => {
      const expired = onboardingWatchState === watch;
      project100StopOnboardingWatch();
      if (expired) {
        try {
          const notify = chrome.runtime.sendMessage({
            type: "PROJECT100_MVP_ONBOARDING_WATCH_EXPIRED",
            projectId: validated.projectId || "",
            filename: validated.filename,
            driveFileId: validated.driveFileId
          });
          if (notify && typeof notify.catch === "function") {
            notify.catch(() => {});
          }
        } catch (_error) {
          // Best-effort notification only.
        }
      }
    }, windowMs);
    return { watching: true, bound: false };
  }

  function extractField(text, name) {
    const expression = new RegExp(`(?:^|\\r?\\n)${name}=([^\\r\\n]*)`, "m");
    const match = text.match(expression);
    return match ? match[1].trim() : "";
  }

  function addArtifactValidationErrors(result, bytes) {
    result.final_lf = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0A;
    result.contains_cr = bytes.includes(0x0D);
    result.has_bom = bytes.byteLength >= 3 &&
      bytes[0] === 0xEF &&
      bytes[1] === 0xBB &&
      bytes[2] === 0xBF;
    result.utf8_valid = false;
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      result.utf8_valid = true;
    } catch (_error) {
      result.errors.push("INVALID_UTF8");
    }
    result.canary = extractField(text, "SOURCE_CANARY");
    result.revision = extractField(text, "REVISION");
    result.nonce = extractField(text, "NONCE");
    if (!result.final_lf) {
      result.errors.push("FINAL_LF_MISSING");
    }
    if (result.contains_cr) {
      result.errors.push("CR_BYTE_PRESENT");
    }
    if (result.has_bom) {
      result.errors.push("UTF8_BOM_PRESENT");
    }
    if (result.byte_length !== EXPECTED_ARTIFACT.byteLength) {
      result.errors.push("BYTE_LENGTH_MISMATCH");
    }
    if (result.sha256 !== EXPECTED_ARTIFACT.sha256) {
      result.errors.push("SHA256_MISMATCH");
    }
    if (result.canary !== EXPECTED_ARTIFACT.canary) {
      result.errors.push("CANARY_MISMATCH");
    }
    if (result.revision !== EXPECTED_ARTIFACT.revision) {
      result.errors.push("REVISION_MISMATCH");
    }
    if (result.nonce !== EXPECTED_ARTIFACT.nonce) {
      result.errors.push("NONCE_MISMATCH");
    }
    result.exact_bytes = result.errors.length === 0;
    return text;
  }

  function baseArtifactResult() {
    return {
      experiment: "artifact_capture",
      status: "BLOCKED",
      filename: TEST_FILENAME,
      stage: "identity",
      matching_artifacts: 0,
      preferred_download_actions: 0,
      preview_openers: 0,
      selected_action: null,
      preview_identity: null,
      preview_download_actions: 0,
      selected_download_action: null,
      identity_type: "",
      identity_source: "",
      capture_method: "none",
      automatic_capture: false,
      private_endpoint_used: false,
      download_diagnostic: null,
      byte_length: 0,
      sha256: "",
      canary: "",
      revision: "",
      nonce: "",
      utf8_valid: false,
      has_bom: false,
      final_lf: false,
      contains_cr: false,
      exact_bytes: false,
      errors: []
    };
  }

  async function runArtifactCapture() {
    const result = baseArtifactResult();
    const artifactDiscovery = collectArtifactCandidates();
    const candidates = artifactDiscovery.candidates;
    const rejectedCandidates = artifactDiscovery.rejected;
    result.matching_artifacts = candidates.length;
    result.preferred_download_actions = artifactDiscovery.preferredActions.length;

    if (result.preferred_download_actions !== 1) {
      result.stage = "action-resolution";
      result.errors.push("PREFERRED_DOWNLOAD_ACTIONS_" + result.preferred_download_actions);
      if (result.preferred_download_actions === 0) {
        result.errors.push("NO_GENERATED_ARTIFACT_IDENTITY");
      }
      result.diagnostics = candidates.concat(rejectedCandidates)
        .slice(0, DIAGNOSTIC_LIMIT)
        .map((candidate) => candidate.diagnostic);
      return result;
    }

    if (candidates.length !== 1) {
      result.stage = artifactDiscovery.preferredActions.length > 0 ? "action-resolution" : "identity";
      result.errors.push(candidates.length === 0 ? "NO_GENERATED_ARTIFACT_IDENTITY" : `MATCHING_ARTIFACTS_${candidates.length}`);
      result.diagnostics = candidates.concat(rejectedCandidates)
        .slice(0, DIAGNOSTIC_LIMIT)
        .map((candidate) => candidate.diagnostic);
      return result;
    }

    const candidate = candidates[0];
    result.stage = "action-resolution";
    result.preview_openers = 1;
    result.selected_action = {
      tag: candidate.element.tagName.toLowerCase(),
      aria_label: String(candidate.element.getAttribute("aria-label") || "").trim()
    };
    result.identity_type = candidate.identity ? candidate.identity.identityType : "preferred_download_button";
    result.identity_source = candidate.identity ? candidate.identity.identitySource : "button[aria-label]";

    try {
      const capture = await captureViaPreviewDownload(candidate, result, (stage) => {
        result.stage = stage;
      });
      if (!capture) {
        return result;
      }
      result.automatic_capture = Boolean(capture.automaticCapture);
      result.capture_method = capture.method;
      result.private_endpoint_used = capture.privateEndpointUsed;
      result.byte_length = capture.bytes.byteLength;
      result.sha256 = await sha256Hex(capture.bytes);
      result.stage = "verification";
      addArtifactValidationErrors(result, capture.bytes);
      result.status = result.errors.length === 0 ? "PASS" : "BLOCKED";
      if (result.errors.length > 0) {
        result.diagnostics = [candidate.diagnostic];
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? clippedText(error.message, 180) : "DIRECT_FETCH_FAILED");
      result.download_diagnostic = error && error.downloadDiagnostic ? error.downloadDiagnostic : null;
      result.diagnostics = [candidate.diagnostic];
      return result;
    }

    return result;
  }

  function extractDriveId(value) {
    const decoded = decodeMaybe(value);
    const patterns = [
      /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/i,
      /drive\.google\.com\/open\?[^#]*?\bid=([A-Za-z0-9_-]+)/i,
      /drive\.google\.com\/uc\?[^#]*?\bid=([A-Za-z0-9_-]+)/i
    ];
    for (const pattern of patterns) {
      const match = decoded.match(pattern);
      if (match) {
        return match[1];
      }
    }
    // No direct-token fallback: opaque strings such as the project title
    // "Project100-Drive-PoC" satisfy [A-Za-z0-9_-]{20,} and must never
    // become Drive identity.
    return "";
  }

  function driveEvidence(element) {
    if (!isElement(element)) {
      return null;
    }

    const entries = relevantAttributes(element);
    for (const { name, value } of entries) {
      if (/(?:href|url)/i.test(name)) {
        if (!/drive\.google\.com/i.test(value)) {
          continue;
        }
        const urlId = extractDriveId(value);
        if (urlId === EXPECTED_DRIVE_ID) {
          return {
            id: urlId,
            method: `${element.tagName.toLowerCase()}[${name}]`,
            display: sanitizeUrl(value)
          };
        }
        continue;
      }
      if (EXPLICIT_DRIVE_ID_ATTRIBUTE_RE.test(name) && value === EXPECTED_DRIVE_ID) {
        return {
          id: value,
          method: `${element.tagName.toLowerCase()}[${name}]`,
          display: value
        };
      }
    }

    const textId = extractDriveId(elementText(element));
    if (textId === EXPECTED_DRIVE_ID) {
      return {
        id: textId,
        method: `${element.tagName.toLowerCase()}[text]`,
        display: textId
      };
    }
    return null;
  }

  function driveEvidenceInSubtree(element) {
    const directEvidence = driveEvidence(element);
    if (directEvidence) {
      return directEvidence;
    }
    const descendants = element.querySelectorAll([
      "a[href]",
      "[data-url]",
      "[data-href]",
      "[data-source-url]",
      "[data-drive-url]",
      "[data-file-url]",
      "[data-drive-id]",
      "[data-file-id]",
      "[data-source-id]"
    ].join(","));
    for (const descendant of Array.from(descendants)) {
      const evidence = driveEvidence(descendant);
      if (evidence) {
        return evidence;
      }
    }
    return null;
  }

  function hasDriveEvidence(element) {
    return Boolean(driveEvidenceInSubtree(element));
  }

  function actionControlName(element) {
    const aria = element.getAttribute("aria-label") || "";
    const title = element.getAttribute("title") || "";
    const text = elementText(element);
    return normalizeText(`${aria} ${title} ${text}`);
  }

  function isSourceOpenerControl(element) {
    // Navigation/open-file semantics are not action-menu semantics: an
    // anchor whose href opens the Drive file itself is the Source opener,
    // never a source action menu trigger, whatever its accessible name says.
    if (element.tagName !== "A" || !element.hasAttribute("href")) {
      return false;
    }
    return /drive\.google\.com/i.test(element.getAttribute("href") || "");
  }

  function isActionControl(element) {
    if (!isVisible(element) || !["BUTTON", "A"].includes(element.tagName) && element.getAttribute("role") !== "button") {
      return false;
    }

    const name = actionControlName(element);
    const hasMenuRelationship = /^(?:menu|listbox)$/i.test(element.getAttribute("aria-haspopup") || "") ||
      element.getAttribute("data-menu-trigger") === "true";
    const ellipsis = /^(?:\.\.\.|…|⋮|⋯)$/.test(name);
    if (FORBIDDEN_ACTION_RE.test(name)) {
      return false;
    }
    if (isSourceOpenerControl(element)) {
      return false;
    }
    return hasMenuRelationship || ellipsis || ACTION_NAME_RE.test(name);
  }

  function findActionControls(container) {
    const elements = Array.from(container.querySelectorAll("button, a, [role=button]"));
    return elements.filter((element) => isActionControl(element));
  }

  function findSourceContainer(seed) {
    let current = seed;
    let depth = 0;
    let semanticFallback = null;
    let controlsFallback = null;
    let genericFallback = null;
    while (current && depth < 12 && current !== document.body) {
      if (hasExactFilename(elementText(current)) && hasDriveEvidence(current)) {
        // The smallest complete source-local container wins: a broad semantic
        // section that merely wraps several Source rows must never take
        // priority over the single row holding the evidence seed.
        if (isCompleteSourceContainer(current)) {
          return current;
        }
        if (current.matches(SOURCE_CONTAINER_SELECTOR)) {
          semanticFallback = semanticFallback || current;
        }
        genericFallback = genericFallback || current;
        const controls = findActionControls(current);
        if (controls.length > 0 && !controlsFallback) {
          controlsFallback = current;
        }
      }
      current = current.parentElement;
      depth += 1;
    }
    return semanticFallback || controlsFallback || genericFallback;
  }

  function sourceDiagnostic(source) {
    const container = source.container;
    const buttons = Array.from(container.querySelectorAll("button, a, [role=button]"))
      .filter((element) => isVisible(element))
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        href: element.tagName === "A" ? sanitizeUrl(element.getAttribute("href") || "") : "",
        aria_label: clippedText(element.getAttribute("aria-label"), 100),
        title: clippedText(element.getAttribute("title"), 100),
        name: clippedText(actionControlName(element), 120),
        aria_haspopup: element.getAttribute("aria-haspopup") || "",
        aria_controls: element.getAttribute("aria-controls") || "",
        data_menu_trigger: element.getAttribute("data-menu-trigger") || ""
      }));
    return {
      filename: TEST_FILENAME,
      drive_url_or_id: source.driveDisplay,
      semantic_container: {
        tag: container.tagName.toLowerCase(),
        role: container.getAttribute("role") || "",
        aria_label: clippedText(container.getAttribute("aria-label"), 100),
        title: clippedText(container.getAttribute("title"), 100),
        path: semanticPath(container)
      },
      buttons,
      aria: {
        container_label: clippedText(container.getAttribute("aria-label"), 100),
        container_role: container.getAttribute("role") || ""
      },
      menu_relationship: source.actionControls.map((element) => ({
        aria_haspopup: element.getAttribute("aria-haspopup") || "",
        aria_controls: element.getAttribute("aria-controls") || "",
        aria_expanded: element.getAttribute("aria-expanded") || ""
      }))
    };
  }

  // A source-local container is complete when it simultaneously holds the
  // exact filename, the exact Drive evidence, a source-local action control
  // and a readable source-local sync state.
  function isCompleteSourceContainer(container) {
    return hasExactFilename(elementText(container)) &&
      hasDriveEvidence(container) &&
      findActionControls(container).length > 0 &&
      readSyncState(container).readable;
  }

  // Nested ancestors around one real source must collapse onto the smallest
  // complete source-local container. Genuinely separate sources never contain
  // each other, so sibling duplicates survive and still fail closed.
  function canonicalizeSourceCandidates(sources) {
    return sources.filter((source) =>
      !sources.some((other) =>
        other !== source &&
        source.container.contains(other.container) &&
        isCompleteSourceContainer(other.container)));
  }

  function collectSourceCandidates() {
    const sourcesByContainer = new Map();
    const elements = Array.from(document.querySelectorAll(DRIVE_SELECTOR));

    for (const element of elements) {
      if (!isVisible(element) || !hasDriveEvidence(element)) {
        continue;
      }
      const container = findSourceContainer(element);
      if (!container || !hasExactFilename(elementText(container)) || !hasDriveEvidence(container)) {
        continue;
      }
      if (!sourcesByContainer.has(container)) {
        const evidence = driveEvidence(element) || driveEvidenceInSubtree(container);
        sourcesByContainer.set(container, {
          container,
          driveId: evidence ? evidence.id : "",
          driveIdentityMethod: evidence ? evidence.method : "",
          driveDisplay: evidence ? evidence.display : EXPECTED_DRIVE_ID,
          actionControls: findActionControls(container)
        });
      }
    }

    const sources = canonicalizeSourceCandidates(Array.from(sourcesByContainer.values()));
    for (const source of sources) {
      source.actionControls = findActionControls(source.container);
      source.diagnostic = sourceDiagnostic(source);
    }
    return sources;
  }

  function statusFromText(value) {
    const text = normalizeText(value);
    if (!text || text.length > 220 || hasExactFilename(text) && text.length > 80) {
      return null;
    }
    for (const status of STATUS_PATTERNS) {
      const match = text.match(status.re);
      if (match) {
        return {
          key: status.key,
          value: clippedText(text),
          matched: match[0]
        };
      }
    }
    return null;
  }

  function readSyncState(container) {
    const candidates = [];
    const push = (value, priority, source) => {
      const status = statusFromText(value);
      if (status) {
        candidates.push({ ...status, priority, source });
      }
    };

    const semanticNodes = Array.from(container.querySelectorAll([
      '[role="status"]',
      "[aria-live]",
      "[aria-busy]",
      "[data-sync-state]",
      "[data-sync-status]",
      "[data-status]",
      "[title]",
      "[aria-label]",
      "span",
      "small",
      "p"
    ].join(",")));

    for (const element of semanticNodes) {
      if (!isVisible(element)) {
        continue;
      }
      for (const name of ["aria-label", "title", "data-sync-state", "data-sync-status", "data-status"]) {
        const value = element.getAttribute(name);
        if (value) {
          push(value, name.startsWith("data-") ? 1 : name === "aria-label" ? 2 : 3, `${element.tagName.toLowerCase()}[${name}]`);
        }
      }
      const text = elementText(element);
      if (text && text.length <= 180) {
        push(text, element.getAttribute("role") === "status" || element.hasAttribute("aria-live") ? 0 : 4, `${element.tagName.toLowerCase()}[text]`);
      }
    }

    const busy = Array.from(container.querySelectorAll('[aria-busy="true"], [data-sync-state="syncing"], [data-sync-status="syncing"]')).some(isVisible);
    candidates.sort((left, right) => left.priority - right.priority || left.value.length - right.value.length);
    const selected = candidates[0];
    if (!selected) {
      return {
        readable: false,
        value: "",
        key: "",
        canonical: "",
        busy,
        evidence: ""
      };
    }

    return {
      readable: true,
      value: selected.value,
      key: `${selected.key}|${normalizeText(selected.value).toLowerCase()}`,
      canonical: selected.key,
      busy,
      evidence: selected.source
    };
  }

  function activateOnce(element) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    if (typeof element.focus === "function") {
      element.focus({ preventScroll: true });
    }
    element.click();
  }

  async function waitFor(predicate, timeoutMilliseconds, intervalMilliseconds = 120) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) {
        return value;
      }
      await delay(intervalMilliseconds);
    }
    return null;
  }

  function menuScopeFor(actionControl) {
    const controlledId = actionControl.getAttribute("aria-controls");
    if (controlledId) {
      const controlled = document.getElementById(controlledId);
      if (controlled && isVisible(controlled)) {
        return controlled;
      }
    }

    const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-menu]'))
      .filter((element) => isVisible(element));
    if (menus.length === 1) {
      return menus[0];
    }

    const nearby = actionControl.parentElement && actionControl.parentElement.querySelector('[role="menu"], [role="listbox"], [data-menu]');
    return nearby && isVisible(nearby) ? nearby : null;
  }

  function resyncActionsInScope(scope) {
    if (!scope) {
      return [];
    }
    const elements = Array.from(scope.querySelectorAll('button, [role="menuitem"], [role="option"], a, [role="button"]'))
      .filter((element) => isVisible(element));
    return elements.filter((element) => {
      const name = actionControlName(element);
      return RESYNC_NAME_RE.test(normalizeText(name)) && !FORBIDDEN_ACTION_RE.test(name);
    });
  }

  // Gate rule: only a persistent final settled state different from the
  // pre-sync state proves a successful Resync. Transient busy/syncing
  // activity alone must never yield PASS.
  // options (all optional): timeoutMs — window length (default: the full
  // legacy 45s settle window); expiryError — fixed error code reported when
  // the window expires without a strong PASS (default: legacy behaviour,
  // distinguishing transient-activity-only from never-changed).
  async function waitForSyncCompletion(initialSource, preState, options = {}) {
    const deadline = Date.now() +
      (Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : SYNC_COMPLETION_TIMEOUT);
    let transientActivity = false;
    let lastState = null;
    let stableState = null;
    let stableKey = "";
    let stableReads = 0;
    let source = initialSource;

    while (Date.now() < deadline) {
      const currentSources = collectSourceCandidates();
      if (currentSources.length !== 1) {
        return {
          ok: false,
          error: `POST_MATCHING_SOURCES_${currentSources.length}`,
          source,
          state: lastState,
          transient_activity_observed: transientActivity,
          final_state_changed: false
        };
      }
      source = currentSources[0];
      const state = readSyncState(source.container);
      if (state.readable) {
        lastState = state;
        if (state.busy !== preState.busy || state.canonical === "syncing") {
          transientActivity = true;
        }

        if (!state.busy && state.canonical !== "syncing") {
          if (state.key === stableKey) {
            stableReads += 1;
          } else {
            stableKey = state.key;
            stableState = state;
            stableReads = 1;
          }
          // Do not settle while no sync activity has been observed and the
          // stable state still equals the pre-sync state: the Resync may not
          // have started yet (delayed UI reaction). Wait for activity or a
          // different state; the deadline handles the never-starts case.
          const maySettle = transientActivity || stableKey !== preState.key;
          if (stableReads >= 2 && maySettle) {
            return {
              ok: true,
              source,
              state: stableState,
              transient_activity_observed: transientActivity,
              final_state_changed: stableKey !== preState.key
            };
          }
        } else {
          stableKey = "";
          stableState = null;
          stableReads = 0;
        }
      }
      await delay(180);
    }

    return {
      ok: false,
      error: options.expiryError ||
        (transientActivity ? "POST_SYNC_SETTLE_TIMEOUT" : "SYNC_STATE_UNCHANGED"),
      source,
      state: lastState,
      transient_activity_observed: transientActivity,
      final_state_changed: false
    };
  }

  function baseSourceResult() {
    return {
      experiment: "source_resync",
      status: "BLOCKED",
      expected_drive_id: EXPECTED_DRIVE_ID,
      matching_sources: 0,
      source_identity_method: "",
      action_controls_found: 0,
      resync_actions_found: 0,
      pre_sync: "",
      resync_click_count: 0,
      post_sync: "",
      transient_activity_observed: false,
      sync_state_changed: false,
      dom_fast_path_expired: false,
      errors: []
    };
  }

  async function runSourceResync() {
    const result = baseSourceResult();
    const sources = collectSourceCandidates();
    result.matching_sources = sources.length;

    if (sources.length !== 1) {
      result.errors.push(`MATCHING_SOURCES_${sources.length}`);
      result.diagnostics = sources.slice(0, DIAGNOSTIC_LIMIT).map((source) => source.diagnostic);
      return result;
    }

    let source = sources[0];
    result.source_identity_method = source.driveIdentityMethod;
    result.action_controls_found = source.actionControls.length;
    if (source.driveId !== EXPECTED_DRIVE_ID) {
      result.errors.push("DRIVE_ID_MISMATCH");
      result.diagnostics = [source.diagnostic];
      return result;
    }
    if (result.action_controls_found !== 1) {
      result.errors.push(`ACTION_CONTROLS_${result.action_controls_found}`);
      result.diagnostics = [source.diagnostic];
      return result;
    }

    const preState = readSyncState(source.container);
    if (!preState.readable) {
      result.errors.push("PRE_SYNC_UNREADABLE");
      result.diagnostics = [source.diagnostic];
      return result;
    }
    result.pre_sync = preState.value;

    try {
      const actionControl = source.actionControls[0];
      activateOnce(actionControl);

      const resyncActions = await waitFor(
        async () => {
          const actions = resyncActionsInScope(menuScopeFor(actionControl));
          return actions.length > 0 ? actions : null;
        },
        4500
      );
      result.resync_actions_found = resyncActions ? resyncActions.length : 0;
      if (!resyncActions || resyncActions.length !== 1) {
        result.errors.push(`RESYNC_ACTIONS_${result.resync_actions_found}`);
        result.diagnostics = [source.diagnostic];
        return result;
      }

      // Arm the MAIN-world network observer at the exact instant of the
      // one-time Resync click. Only observations from here on may qualify as
      // completion evidence; the click itself is never evidence.
      armNetworkObserver(source.driveId);
      activateOnce(resyncActions[0]);
      result.resync_click_count = 1;

      // HY8 latency cleanup: the click is the point of no return for the
      // trigger. Give the DOM detector only the short fast-path window; a
      // strong PASS inside it is terminal (the service worker publishes as
      // dom-state-changed), and expiry hands control to the Fresh Sources
      // completion phase immediately instead of blocking behind the old 45s
      // wait. Exactly one click either way — no retry, no fallback click.
      const completion = await waitForSyncCompletion(source, preState, {
        timeoutMs: SYNC_COMPLETION_FAST_PATH_TIMEOUT,
        expiryError: "POST_SYNC_FAST_PATH_EXPIRED"
      });
      source = completion.source || source;
      if (completion.state && completion.state.readable) {
        result.post_sync = completion.state.value;
      }
      result.transient_activity_observed = Boolean(completion.transient_activity_observed);
      result.sync_state_changed = Boolean(completion.final_state_changed);
      if (!completion.ok) {
        if (completion.error === "POST_SYNC_FAST_PATH_EXPIRED") {
          // Fast-path expiry is NOT a terminal failure: the one-time click
          // still happened, so the service worker may proceed straight to the
          // Fresh Sources phase (and later legacy channels stay eligible).
          result.dom_fast_path_expired = true;
        }
        result.errors.push(completion.error || "POST_SYNC_UNVERIFIABLE");
        result.diagnostics = [source.diagnostic];
        return result;
      }
      if (!result.post_sync) {
        result.errors.push("POST_SYNC_UNVERIFIABLE");
        result.diagnostics = [source.diagnostic];
        return result;
      }
      if (completion.state.canonical === "sync_error" || completion.state.canonical === "not_synced") {
        result.errors.push("POST_SYNC_ERROR_STATE");
        result.diagnostics = [source.diagnostic];
        return result;
      }
      result.status = result.sync_state_changed ? "PASS" : "BLOCKED";
      if (!result.sync_state_changed) {
        result.errors.push("SYNC_STATE_UNCHANGED");
      }
      return result;
    } catch (_error) {
      result.errors.push("RESYNC_ACTION_EXECUTION_FAILED");
      result.diagnostics = [source.diagnostic];
      return result;
    }
  }


  function validateMvpBinding(filenameInput, driveFileIdInput) {
    const filename = String(filenameInput || "").trim();
    const driveFileId = String(driveFileIdInput || "").trim();
    if (!filename || filename.length > 120 || filename.includes("/") || filename.includes("\\") || !/\.md$/i.test(filename)) {
      return { ok: false, error: "INVALID_FILENAME" };
    }
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(driveFileId)) {
      return { ok: false, error: "INVALID_DRIVE_FILE_ID" };
    }
    return { ok: true, filename, driveFileId };
  }

  function runMvpSourceBindingProbe(filenameInput, driveFileIdInput) {
    const validated = validateMvpBinding(filenameInput, driveFileIdInput);
    if (!validated.ok) {
      return { status: "BLOCKED", error: validated.error };
    }

    const previousFilename = TEST_FILENAME;
    const previousDriveId = EXPECTED_DRIVE_ID;
    TEST_FILENAME = validated.filename;
    EXPECTED_DRIVE_ID = validated.driveFileId;

    try {
      const sources = collectSourceCandidates();
      if (sources.length !== 1) {
        return {
          status: "BLOCKED",
          error: `MATCHING_SOURCES_${sources.length}`,
          matchingSources: sources.length
        };
      }
      const source = sources[0];
      if (source.driveId !== validated.driveFileId) {
        return { status: "BLOCKED", error: "DRIVE_ID_MISMATCH" };
      }
      if (source.actionControls.length !== 1) {
        return {
          status: "BLOCKED",
          error: `ACTION_CONTROLS_${source.actionControls.length}`,
          diagnostic: source.diagnostic
        };
      }
      const syncState = readSyncState(source.container);
      if (!syncState.readable) {
        return { status: "BLOCKED", error: "SYNC_STATE_UNREADABLE" };
      }
      return {
        status: "PASS",
        filename: validated.filename,
        driveFileId: validated.driveFileId,
        sourceIdentityMethod: source.driveIdentityMethod,
        syncState: syncState.value,
        sourcePageUrl: window.location.href
      };
    } finally {
      TEST_FILENAME = previousFilename;
      EXPECTED_DRIVE_ID = previousDriveId;
    }
  }

  const MVP_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

  // Backend completion receipt (recon 2026-09-05): ChatGPT exposes a
  // structured per-source sync receipt on the same endpoint the Sources UI
  // renders from. Read-only, same-origin, session-authenticated; correlated
  // to the bound Source by canonical_handle === Drive fileId. Never logs
  // cookies/headers/account data; only the fields below are surfaced.
  function project100ResolveProjectId(sourcePageUrl) {
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

  // The live First Add shape is an object containing { items: [...], cursor }
  // plus connector-scope identity metadata. The older top-level array and
  // { items: [...] } forms remain parseable for the ordinary receipt path, but
  // they never receive First Add lifecycle trust without the real identity
  // fields below.
  function project100NormalizeScopeItems(payload) {
    return Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.items)
        ? payload.items
        : null;
  }

  function project100NormalizeReceiptItem(item) {
    const raw = item && typeof item === "object" ? item : {};
    const scopeId = typeof raw.scope_id === "string" ? raw.scope_id.trim() : "";
    const legacyScopeId = typeof raw.server_id === "string" ? raw.server_id.trim() : "";
    const connectorFiles = Array.isArray(raw.connector_files)
      ? raw.connector_files.filter((file) => file && typeof file === "object").map((file) => ({
        remoteId: typeof file.remote_id === "string" ? file.remote_id.trim() : "",
        projectId: typeof file.project_id === "string" ? file.project_id.trim() : ""
      }))
      : [];
    return {
      // The current API uses scope_id. server_id remains a compatibility
      // alias, but a disagreement is retained as a conflict and never
      // resolved by choosing one field.
      scopeId: scopeId || legacyScopeId,
      legacyScopeId,
      scopeIdConflict: Boolean(scopeId && legacyScopeId && scopeId !== legacyScopeId),
      connectorType: typeof raw.connector_type === "string" ? raw.connector_type : "",
      scopeType: typeof raw.scope_type === "string" ? raw.scope_type : "",
      projectId: typeof raw.project_id === "string" ? raw.project_id.trim() : "",
      canonicalHandle: typeof raw.canonical_handle === "string"
        ? raw.canonical_handle : "",
      connectorFiles,
      createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
      last_sync_status: typeof raw.last_sync_status === "string" ? raw.last_sync_status : "",
      last_sync_started_at: typeof raw.last_sync_started_at === "string" ? raw.last_sync_started_at : "",
      last_sync_completed_at: typeof raw.last_sync_completed_at === "string" ? raw.last_sync_completed_at : "",
      last_synced_at: typeof raw.last_synced_at === "string" ? raw.last_synced_at : "",
      sync_error_code: raw.sync_error_code == null ? "" : String(raw.sync_error_code),
      sync_error_message: raw.sync_error_message == null ? "" : String(raw.sync_error_message),
      last_sync_detail_message: raw.last_sync_detail_message == null ? "" : String(raw.last_sync_detail_message)
    };
  }

  function project100InitialReceiptIdentityError(item, normalized, driveFileId, projectId) {
    if (!normalized || normalized.scopeIdConflict || !normalized.scopeId) {
      return normalized && normalized.scopeIdConflict
        ? "RECEIPT_SCOPE_ID_CONFLICT" : "RECEIPT_SCOPE_ID_UNAVAILABLE";
    }
    if (normalized.connectorType !== "google_drive" ||
        normalized.scopeType !== "google_drive_file" ||
        normalized.canonicalHandle !== driveFileId ||
        (normalized.projectId && normalized.projectId !== projectId)) {
      return "RECEIPT_SOURCE_IDENTITY_MISMATCH";
    }
    // First Add pre-sync receipts can precede connector_files materialization.
    // Keep this allowlist deliberately narrow: only the observed not_synced
    // and running lifecycle states may carry an empty array as PROGRESS.
    // Completion still requires the exact remote/Project mapping, with no
    // conflicting entries.
    const lifecycleStatus = String(normalized.last_sync_status || "").toLowerCase();
    if (!new Set(["not_synced", "running", "completed"]).has(lifecycleStatus)) {
      return "RECEIPT_INITIAL_COMPLETION_UNPROVEN";
    }
    const emptyConnectorFilesAllowed = lifecycleStatus === "not_synced" ||
      lifecycleStatus === "running";
    if (!Array.isArray(item.connector_files) ||
        item.connector_files.length !== normalized.connectorFiles.length ||
        (!emptyConnectorFilesAllowed && normalized.connectorFiles.length === 0)) {
      return "RECEIPT_SOURCE_IDENTITY_MISMATCH";
    }
    if (normalized.connectorFiles.some((file) =>
      file.remoteId !== driveFileId || file.projectId !== projectId)) {
      return "RECEIPT_SOURCE_IDENTITY_MISMATCH";
    }
    if (!normalized.createdAt) {
      return "RECEIPT_INITIAL_COMPLETION_UNPROVEN";
    }
    return "";
  }

  // A connector_scopes response is a trustworthy inventory only when the
  // response positively says that no more items remain.  A top-level array,
  // a short page, cursor=null, or absent metadata proves only the observed
  // window and must stay UNKNOWN.  Conflicting signals fail closed too.
  function project100ReceiptCoverage(payload) {
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      return "UNKNOWN";
    }
    const explicitlyIncomplete = payload.coverage_complete === false ||
      payload.complete === false ||
      payload.has_more === true ||
      (payload.cursor !== undefined && payload.cursor !== null &&
        String(payload.cursor).trim() !== "") ||
      Boolean(payload.next_cursor) ||
      Boolean(payload.nextCursor);
    if (explicitlyIncomplete) {
      return "INCOMPLETE";
    }
    if (payload.coverage_complete === true ||
        payload.complete === true ||
        payload.has_more === false) {
      return "COMPLETE";
    }
    return "UNKNOWN";
  }

  async function runMvpConnectorScopeReceipt(
    filenameInput, driveFileIdInput, sourcePageUrl, options = {}) {
    const firstAdd = Boolean(options && options.firstAdd);
    const validated = validateMvpBinding(filenameInput, driveFileIdInput);
    if (!validated.ok) {
      return { status: "BLOCKED", error: validated.error };
    }
    const projectId = project100ResolveProjectId(sourcePageUrl);
    if (!/^g-p-[A-Za-z0-9]+$/.test(projectId)) {
      // Backend receipt unavailable: never guess another Project.
      return { status: "BLOCKED", error: "BACKEND_RECEIPT_UNAVAILABLE" };
    }
    let items = null;
    let coverage = "UNKNOWN";
    try {
      const response = await fetch(
        `/backend-api/projects/${encodeURIComponent(projectId)}/connector_scopes?limit=100`,
        { credentials: "include", cache: "no-store" }
      );
      if (!response.ok) {
        return { status: "BLOCKED", error: "BACKEND_RECEIPT_UNAVAILABLE" };
      }
      const payload = await response.json();
      items = project100NormalizeScopeItems(payload);
      coverage = project100ReceiptCoverage(payload);
      if (firstAdd && (!payload || Array.isArray(payload))) {
        // First Add does not need a global inventory, but it does need the
        // current object shape that carries connector_files/project identity.
        return { status: "BLOCKED", error: "RECEIPT_COVERAGE_INCOMPLETE" };
      }
      if (firstAdd && coverage === "INCOMPLETE") {
        // A cursor or explicit incomplete marker is still a partial window;
        // the First Add exception only covers an object with no completeness
        // claim, such as {items, cursor:null, project_connectors_enabled}.
        return { status: "BLOCKED", error: "RECEIPT_COVERAGE_INCOMPLETE" };
      }
    } catch (_error) {
      return { status: "BLOCKED", error: "BACKEND_RECEIPT_UNAVAILABLE" };
    }
    if (!items) {
      return { status: "BLOCKED", error: "BACKEND_RECEIPT_UNAVAILABLE" };
    }
    if (firstAdd) {
      const exactItems = items.filter((item) =>
        Boolean(item) && item.canonical_handle === validated.driveFileId);
      if (exactItems.length === 0) {
        return { status: "BLOCKED", error: "RECEIPT_SOURCE_NOT_FOUND" };
      }
      if (exactItems.length > 1) {
        return { status: "BLOCKED", error: "RECEIPT_SOURCE_AMBIGUOUS" };
      }
      const normalized = project100NormalizeReceiptItem(exactItems[0]);
      const projectIdForIdentity = project100ResolveProjectId(sourcePageUrl);
      const identityError = project100InitialReceiptIdentityError(
        exactItems[0], normalized, validated.driveFileId, projectIdForIdentity);
      if (identityError) {
        return { status: "BLOCKED", error: identityError };
      }
      if (normalized.sync_error_code || normalized.sync_error_message) {
        return { status: "BLOCKED", error: "RECEIPT_SOURCE_SYNC_ERROR" };
      }
      const receipt = {
        ...normalized,
        projectId: projectIdForIdentity,
        connectorType: "google_drive",
        canonicalHandle: validated.driveFileId
      };
      if (String(normalized.last_sync_status || "").toLowerCase() === "completed" &&
          normalized.last_sync_completed_at) {
        return { status: "PASS", receipt };
      }
      return { status: "PROGRESS", receipt };
    }
    const canonicalMatches = items.filter((item) =>
      Boolean(item) && item.canonical_handle === validated.driveFileId);
    const wrongConnector = canonicalMatches.some((item) =>
      String(item.connector_type || "") !== "google_drive");
    if (wrongConnector) {
      return { status: "BLOCKED", error: "RECEIPT_SOURCE_IDENTITY_MISMATCH" };
    }
    const matches = canonicalMatches.filter((item) => {
      const normalized = project100NormalizeReceiptItem(item);
      return String(item.connector_type || "") === "google_drive" &&
        Boolean(normalized.scopeId);
    });
    if (matches.length === 0) {
      return {
        status: "BLOCKED",
        error: coverage === "COMPLETE"
          ? "RECEIPT_SOURCE_NOT_FOUND" : "RECEIPT_COVERAGE_INCOMPLETE"
      };
    }
    if (matches.length > 1) {
      // Ambiguity fails closed; never take the first Source blindly.
      return { status: "BLOCKED", error: "RECEIPT_SOURCE_AMBIGUOUS" };
    }
    if (coverage !== "COMPLETE") {
      // An exact row in a partial or unknown inventory is only an observed
      // candidate; it cannot establish Source identity or completion.
      return { status: "BLOCKED", error: "RECEIPT_COVERAGE_INCOMPLETE" };
    }
    return {
      status: "PASS",
      receipt: {
        ...project100NormalizeReceiptItem(matches[0]),
        projectId,
        connectorType: "google_drive",
        canonicalHandle: validated.driveFileId
      }
    };
  }

  // ---- MAIN-world network observation (PASS 1: OBSERVE ONLY) ----------------
  // network-observer-main.js runs in the MAIN world on the temporary Sources
  // tab (registered at document_start before the tab is created) and watches
  // the traffic the ChatGPT page itself initiates. It can only report a small
  // allowlisted set of structured sync/identity fields; this file never
  // initiates any request, never reads headers or credentials, and PASS 1
  // never lets observed traffic change a product verdict — it only classifies
  // and reports bounded diagnostics.
  const NETWORK_RECORD_LIMIT = 64;
  const NETWORK_CHANNEL_RECORD = "PROJECT100_NETWORK_OBSERVATION_RECORD";
  const NETWORK_CHANNEL_COMMAND = "PROJECT100_NETWORK_OBSERVER_COMMAND";

  const networkObservation = {
    observerInstalled: false,
    observerFailed: false,
    armed: false,
    windowId: "",
    records: [],
    dropped: 0
  };
  // Arm context delivered by the service worker before the Resync message so
  // the observation window, its identity and its absolute deadline stay under
  // the service worker's control (never tied to SYNC_COMPLETION_TIMEOUT).
  let pendingNetworkArm = null;

  function networkObserverChannelAvailable() {
    return typeof window !== "undefined" &&
      typeof window.postMessage === "function" &&
      typeof window.addEventListener === "function";
  }

  function postNetworkCommand(command, payload) {
    if (!networkObserverChannelAvailable()) {
      return false;
    }
    try {
      const origin = window.location && window.location.origin ? window.location.origin : "*";
      window.postMessage({ type: NETWORK_CHANNEL_COMMAND, command, ...(payload || {}) }, origin);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function handleNetworkObservationEvent(event) {
    let data = null;
    try {
      data = event && event.data ? event.data : null;
    } catch (_error) {
      return;
    }
    if (!data || data.type !== NETWORK_CHANNEL_RECORD) {
      return;
    }
    const incoming = Array.isArray(data.records) ? data.records : (data.record ? [data.record] : []);
    for (const record of incoming) {
      if (!record || typeof record !== "object") {
        continue;
      }
      if (record.kind === "observer-state") {
        networkObservation.observerInstalled = record.installed !== false;
        networkObservation.observerFailed = Boolean(record.failed);
        networkObservation.armed = Boolean(record.armed);
        if (typeof record.windowId === "string" && record.windowId) {
          networkObservation.windowId = record.windowId;
        }
        continue;
      }
      networkObservation.records.push(record);
      if (networkObservation.records.length > NETWORK_RECORD_LIMIT) {
        networkObservation.records.splice(0, networkObservation.records.length - NETWORK_RECORD_LIMIT);
        networkObservation.dropped += 1;
      }
    }
  }

  function installNetworkObservationListener() {
    if (!networkObserverChannelAvailable()) {
      return;
    }
    try {
      window.addEventListener("message", handleNetworkObservationEvent, false);
    } catch (_error) {
      // A page-level listener failure must never break the content script.
    }
    // Drain whatever the observer buffered before this content script loaded
    // (bootstrap traffic happens at document_start, we run at document_idle).
    postNetworkCommand("hello");
  }

  // Armed immediately before the exact one-time Resync click. Never disarmed
  // from here: the observer stays eligible until the service worker's terminal
  // disarm, the original absolute deadline, or the temporary tab teardown.
  function armNetworkObserver(driveFileId) {
    const context = pendingNetworkArm || {};
    const windowId = String(context.windowId || `p100-${Date.now()}`);
    const armed = {
      windowId,
      driveFileId: String(context.driveFileId || driveFileId || EXPECTED_DRIVE_ID),
      projectId: String(context.projectId || project100ResolveProjectId(window.location.href)),
      deadline: Number(context.deadline) || 0
    };
    postNetworkCommand("arm", armed);
    networkObservation.armed = true;
    networkObservation.windowId = armed.windowId;
    return armed.windowId;
  }

  function disarmNetworkObserver() {
    postNetworkCommand("disarm");
    networkObservation.armed = false;
  }

  function networkIdentityMatches(item, driveFileId, knownScopeIds) {
    if (!item || typeof item !== "object") {
      return false;
    }
    if (driveFileId && item.canonical_handle === driveFileId) {
      return true;
    }
    // A scope/server id only counts once a page-issued response proved its
    // mapping to the exact bound Drive file id.
    return Boolean(item.server_id) && knownScopeIds.has(item.server_id);
  }

  function networkTrimItem(item) {
    if (!item || typeof item !== "object") {
      return null;
    }
    return {
      canonical_handle: String(item.canonical_handle || ""),
      server_id: String(item.server_id || ""),
      last_sync_status: String(item.last_sync_status || ""),
      last_sync_started_at: String(item.last_sync_started_at || ""),
      last_sync_completed_at: String(item.last_sync_completed_at || ""),
      last_synced_at: String(item.last_synced_at || ""),
      sync_error_code: String(item.sync_error_code || ""),
      sync_error_message: String(item.sync_error_message || "")
    };
  }

  // ---- HY6 PoC: fresh Sources reload/reopen evidence (diagnostics only) -----
  // After the exact one-time Resync click, a fresh reload/reopen of the
  // temporary Sources tab makes the ChatGPT page ITSELF re-issue its
  // authenticated connector_scopes GET. The records classified here come
  // ONLY from the page-owned passive observer of ONE post-Resync document —
  // this code path never issues any fetch of its own. Freshness is judged
  // against the ORIGINAL pre-Resync baseline (T1) held by the service worker
  // across reloads; a fresh document's own first state is never treated as a
  // new baseline.
  function freshSourcesRelevantRecord(rec) {
    if (!rec || typeof rec !== "object" || rec.kind === "observer-state") {
      return false;
    }
    if (String(rec.method || "").toUpperCase() !== "GET") {
      return false;
    }
    const path = String(rec.path || "");
    return path.indexOf("/backend-api/") === 0 &&
      /connector_scopes(?:\/|$|\?)/i.test(path);
  }

  function project100ClassifyFreshSourcesEvidence(records, context) {
    const driveFileId = String((context && context.driveFileId) || "");
    const projectId = String((context && context.projectId) || "");
    const originalPreCompletedAt = String((context && context.originalPreCompletedAt) || "");
    const list = Array.isArray(records) ? records : [];
    const attempt = {
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
      noPreBaselineCandidate: false
    };
    // Records arrive in observation order; the newest matched state wins.
    // Identity lock: canonical_handle === exact bound Drive file id. Never
    // filename, array position, first result, timing or server_id alone.
    for (const rec of list) {
      if (!freshSourcesRelevantRecord(rec)) {
        continue;
      }
      const path = String(rec.path || "");
      const pathProjectMatch = path.match(/g-p-[A-Za-z0-9]+/);
      const pathProject = pathProjectMatch ? pathProjectMatch[0] : "";
      if (pathProject && projectId && pathProject !== projectId) {
        continue;
      }
      attempt.relevantGetObserved = true;
      attempt.httpStatus = Number(rec.status) || 0;
      const items = Array.isArray(rec.items) ? rec.items : [];
      const matches = driveFileId
        ? items.filter((item) => item && typeof item === "object" &&
            item.canonical_handle === driveFileId)
        : [];
      if (matches.length > 1) {
        // Ambiguity fails closed; never pick the first Source.
        attempt.exactMatchCount = matches.length;
        attempt.ambiguousObserved = true;
        continue;
      }
      if (matches.length === 0) {
        // 0 matches = absence of evidence in this response.
        continue;
      }
      attempt.exactMatchCount = 1;
      attempt.exactMatchObserved = true;
      const item = matches[0];
      attempt.lastObservedStatus = String(item.last_sync_status || "");
      attempt.lastObservedStartedAt = String(item.last_sync_started_at || "");
      attempt.lastObservedCompletedAt = String(item.last_sync_completed_at || "");
      if (String(item.sync_error_code || "") !== "" ||
          String(item.sync_error_message || "") !== "") {
        attempt.explicitErrorObserved = true;
        continue;
      }
      if (attempt.lastObservedStatus !== "completed" ||
          !attempt.lastObservedCompletedAt) {
        // running / pending / started-only: progress evidence, never completion.
        continue;
      }
      if (!originalPreCompletedAt) {
        // No ORIGINAL pre-Resync baseline: freshness is undecidable.
        attempt.noPreBaselineCandidate = true;
        continue;
      }
      if (attempt.lastObservedCompletedAt !== originalPreCompletedAt) {
        attempt.completionCandidateObserved = true;
      }
      // completed-but-stale (same server-side completion value as the
      // ORIGINAL baseline) is never completion.
    }
    if (attempt.ambiguousObserved || attempt.explicitErrorObserved) {
      // An ambiguous or error observation anywhere in this document's
      // page-owned traffic fails the attempt closed.
      attempt.completionCandidateObserved = false;
    }
    return attempt;
  }

  // Classification only. Returning completionCandidateObserved = true proves
  // nothing about content freshness and never changes a verdict in PASS 1.
  function project100ClassifyNetworkEvidence(records, context) {
    const driveFileId = String((context && context.driveFileId) || "");
    const projectId = String((context && context.projectId) || "");
    const windowId = String((context && context.windowId) || "");
    const list = Array.isArray(records) ? records : [];
    const knownScopeIds = new Set();
    let exactIdentityObserved = false;
    let exactIdentityMethod = "";
    let bootstrapRelevantEvents = 0;
    let armedRelevantEvents = 0;
    let preCompletedAt = "";
    let postCompletedAt = "";
    let completionCandidateObserved = false;
    let explicitErrorObserved = false;
    let ambiguousObserved = false;
    let projectMismatchEvents = 0;
    let startedOnlyEvents = 0;
    let noPreBaselineEvents = 0;

    // Pass 1 — bootstrap / pre-arm records: identity mapping + baseline only.
    // Bootstrap traffic can never prove post-click completion.
    for (const record of list) {
      if (!record || record.kind === "observer-state") {
        continue;
      }
      if (windowId && record.windowId === windowId) {
        continue;
      }
      bootstrapRelevantEvents += 1;
      const items = Array.isArray(record.items) ? record.items : [];
      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        if (driveFileId && item.canonical_handle === driveFileId) {
          exactIdentityObserved = true;
          exactIdentityMethod = exactIdentityMethod || "canonical_handle";
          if (item.server_id) {
            knownScopeIds.add(item.server_id);
          }
          if (item.last_sync_completed_at) {
            preCompletedAt = item.last_sync_completed_at;
          }
        }
      }
    }

    // Pass 2 — armed records: the only place completion evidence can come from.
    for (const record of list) {
      if (!record || record.kind === "observer-state") {
        continue;
      }
      if (!windowId || record.windowId !== windowId) {
        continue;
      }
      armedRelevantEvents += 1;
      const path = String(record.path || "");
      const pathProjectMatch = path.match(/g-p-[A-Za-z0-9]+/);
      const pathProject = pathProjectMatch ? pathProjectMatch[0] : "";
      if (pathProject && projectId && pathProject !== projectId) {
        projectMismatchEvents += 1;
        continue;
      }
      const items = Array.isArray(record.items) ? record.items : [];
      const matches = items.filter((item) => networkIdentityMatches(item, driveFileId, knownScopeIds));
      if (matches.length === 0) {
        continue;
      }
      if (matches.length > 1) {
        // Ambiguity fails closed; never pick the first Source.
        ambiguousObserved = true;
        continue;
      }
      const item = matches[0];
      if (item.sync_error_code || item.sync_error_message) {
        explicitErrorObserved = true;
        continue;
      }
      if (item.last_sync_status !== "completed") {
        // A trigger acknowledgement or a started-only status is not completion.
        if (item.last_sync_started_at) {
          startedOnlyEvents += 1;
        }
        continue;
      }
      if (!item.last_sync_completed_at) {
        continue;
      }
      if (!preCompletedAt) {
        // Audit §18 fix: a completed payload WITHOUT a non-empty pre-Resync
        // baseline can never prove freshness. UNKNOWN, never completion.
        noPreBaselineEvents += 1;
        continue;
      }
      if (item.last_sync_completed_at === preCompletedAt) {
        // Same server-side completion value as before the click: not
        // freshness. A changed last_sync_started_at here is started-only
        // evidence and must never count as completion.
        if (item.last_sync_started_at) {
          startedOnlyEvents += 1;
        }
        continue;
      }
      completionCandidateObserved = true;
      postCompletedAt = item.last_sync_completed_at;
    }

    return {
      observerInstalled: networkObservation.observerInstalled,
      observerFailed: networkObservation.observerFailed,
      armed: networkObservation.armed,
      windowId,
      projectId,
      driveFileId,
      bootstrapRelevantEvents,
      armedRelevantEvents,
      exactIdentityObserved,
      exactIdentityMethod: knownScopeIds.size > 0 && !exactIdentityMethod
        ? "server_id_mapping"
        : exactIdentityMethod,
      preCompletedAt,
      postCompletedAt,
      completionCandidateObserved,
      explicitErrorObserved,
      ambiguousObserved,
      projectMismatchEvents,
      startedOnlyEvents,
      noPreBaselineEvents,
      droppedRecords: networkObservation.dropped,
      sanitizedEvents: list
        .filter((record) => record && record.kind !== "observer-state")
        .slice(-NETWORK_RECORD_LIMIT)
        .map((record) => ({
          seq: Number(record.seq) || 0,
          phase: String(record.phase || ""),
          windowId: String(record.windowId || ""),
          method: String(record.method || ""),
          path: String(record.path || ""),
          status: Number(record.status) || 0,
          shape: String(record.shape || ""),
          items: (Array.isArray(record.items) ? record.items : [])
            .slice(0, 8)
            .map(networkTrimItem)
            .filter(Boolean)
        }))
    };
  }

  function project100NetworkEvidenceSnapshot() {
    const context = {
      driveFileId: (pendingNetworkArm && pendingNetworkArm.driveFileId) || EXPECTED_DRIVE_ID,
      projectId: (pendingNetworkArm && pendingNetworkArm.projectId) ||
        project100ResolveProjectId(window.location.href),
      windowId: networkObservation.windowId
    };
    const evidence = project100ClassifyNetworkEvidence(networkObservation.records, context);
    return evidence;
  }

  function runMvpSyncStateCheck(filenameInput, driveFileIdInput) {
    // Read-only sync-state snapshot for bounded background verification:
    // resolves the exact bound Source (one source, exact drive id, one
    // action control) and reports its current sync state. Never clicks,
    // never opens menus, never mutates state.
    const validated = validateMvpBinding(filenameInput, driveFileIdInput);
    if (!validated.ok) {
      return { status: "BLOCKED", error: validated.error };
    }
    const previousFilename = TEST_FILENAME;
    const previousDriveId = EXPECTED_DRIVE_ID;
    TEST_FILENAME = validated.filename;
    EXPECTED_DRIVE_ID = validated.driveFileId;
    try {
      const sources = collectSourceCandidates();
      if (sources.length !== 1) {
        return { status: "BLOCKED", error: `MATCHING_SOURCES_${sources.length}` };
      }
      const source = sources[0];
      if (source.driveId !== validated.driveFileId) {
        return { status: "BLOCKED", error: "DRIVE_ID_MISMATCH" };
      }
      if (source.actionControls.length !== 1) {
        return { status: "BLOCKED", error: `ACTION_CONTROLS_${source.actionControls.length}` };
      }
      const syncState = readSyncState(source.container);
      return {
        status: "PASS",
        syncState: {
          readable: syncState.readable,
          value: syncState.value,
          canonical: syncState.canonical,
          busy: syncState.busy
        }
      };
    } finally {
      TEST_FILENAME = previousFilename;
      EXPECTED_DRIVE_ID = previousDriveId;
    }
  }

  async function runMvpBoundResync(filename, driveFileId) {
    const previousFilename = TEST_FILENAME;
    const previousDriveId = EXPECTED_DRIVE_ID;
    TEST_FILENAME = filename;
    EXPECTED_DRIVE_ID = driveFileId;
    try {
      return await runSourceResync();
    } finally {
      TEST_FILENAME = previousFilename;
      EXPECTED_DRIVE_ID = previousDriveId;
    }
  }

  function mvpDownloadLabels(filename) {
    // Same live-proven opener labels as the frozen T1 preferred-download
    // check, parameterized by the bound filename.
    return new Set([`下载 ${filename}`, `Download ${filename}`]);
  }

  function isMvpPreferredDownloadAction(element) {
    if (!isElement(element) || !isVisible(element) || element.tagName !== "BUTTON") {
      return false;
    }
    const label = String(element.getAttribute("aria-label") || "").trim();
    return mvpDownloadLabels(TEST_FILENAME).has(label);
  }

  // ---- Artifact candidate extraction (PC-1A frozen operation helper) -------
  // The production artifact model selects exactly one latest artifact-bearing
  // assistant scope at operation start. This helper stays the ONLY candidate
  // source. Filename identity comes from the DETERMINISTIC live ChatGPT
  // artifact card (live DOM evidence,
  // 2026-09-08):
  //
  //   section[data-testid*="conversation-turn"]   <- assistant turn
  //     div[data-message-author-role="assistant"] <- role indicator
  //     div (file-list wrapper)
  //       div.border.rounded-2xl                  <- file-list card
  //         div.divide-y                          <- rows container
  //           div.group/artifact-row              <- ONE row per file
  //             button[aria-label=<exact filename>] (group/open-file)  <- Preview opener = identity
  //               span.text-token-text-primary = exact filename
  //               "文档" file-type metadata + "打开文件" label
  //             div.absolute.end-3.opacity-0.group-hover/artifact-row:opacity-100
  //               button[aria-label="下载文件"]   <- same-card direct-download action
  //
  // The old assumption — a button whose OWN aria-label must be
  // "Download <name>" / "下载 <name>" — was disproved on the real page and is
  // NO LONGER artifact identity. The direct-download control is always in the
  // DOM (revealed by pure CSS group-hover) and shares the exact same
  // artifact-row as the filename identity.
  function mvpArtifactRowsInTurn(turn) {
    if (!isElement(turn)) {
      return [];
    }
    return Array.from(turn.querySelectorAll('[class*="group/artifact-row"]'));
  }

  function mvpRowOpenFileButton(row) {
    if (!isElement(row)) {
      return null;
    }
    for (const button of Array.from(row.querySelectorAll("button"))) {
      const cls = typeof button.className === "string" ? button.className : "";
      if (cls.includes("open-file")) {
        return button;
      }
      const label = String(button.getAttribute("aria-label") || "").trim();
      if (/\.md$/i.test(label)) {
        return button;
      }
    }
    return null;
  }

  function mvpRowDirectDownloadButton(row, openFileButton) {
    if (!isElement(row)) {
      return null;
    }
    // Same-card semantic direct-download selection: exclude the open-file
    // identity button, then accept ONLY controls whose accessible identity is
    // an explicit download label (live DOM evidence 2026-09-08:
    // aria-label="下载文件"). The name is read from aria-label, falling back
    // to title. Exactly ONE match returns it; 0 or >1 matches return null so
    // a sole "More actions" button (or any non-download control) never gets
    // clicked — the caller falls back to the Preview chain. No fuzzy guessing.
    const downloadMatches = Array.from(row.querySelectorAll("button"))
      .filter((button) => button !== openFileButton)
      .filter((button) => {
        const aria = String(button.getAttribute("aria-label") || "").trim();
        const title = String(button.getAttribute("title") || "").trim();
        const accessibleName = (aria || title).toLowerCase();
        return accessibleName === "下载文件" || accessibleName === "download file";
      });
    return downloadMatches.length === 1 ? downloadMatches[0] : null;
  }

  function mvpSafeMarkdownFilename(value) {
    const filename = String(value || "").trim();
    if (!filename || filename.length > 120) {
      return "";
    }
    if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
      return "";
    }
    if (!/\.md$/i.test(filename)) {
      return "";
    }
    return filename;
  }

  function mvpMarkdownCandidatesInTurn(turn) {
    const valid = [];
    let invalid = 0;
    if (!isElement(turn)) {
      return { valid, invalid };
    }
    for (const row of mvpArtifactRowsInTurn(turn)) {
      const openFileButton = mvpRowOpenFileButton(row);
      if (!openFileButton) {
        continue;
      }
      const label = String(openFileButton.getAttribute("aria-label") || "").trim();
      const filename = mvpSafeMarkdownFilename(label);
      if (!filename) {
        // Frozen selection rule (Issue A repair): non-Markdown artifact rows
        // (PDF / TXT / CSV / ...) are ignored — neither candidates nor
        // invalid. Only an actual .md name can become a valid candidate or a
        // fail-closed invalid one.
        if (/\.md$/i.test(label)) {
          // A path-like / unsafe .md artifact row is counted, never silently
          // skipped: ambiguity/invalidity must fail closed.
          invalid += 1;
        }
        continue;
      }
      valid.push({
        element: openFileButton,
        row,
        filename,
        directButton: mvpRowDirectDownloadButton(row, openFileButton)
      });
    }
    return { valid, invalid };
  }

  function isAssistantConversationTurn(element) {
    if (!isElement(element)) {
      return false;
    }
    // DOM identity evidence only. Case 1: the element itself carries the
    // assistant role. Case 2: the element is an explicit conversation-turn
    // container ([data-testid*="conversation-turn"]) AND holds an
    // assistant-role descendant. A bare article containing assistant
    // content is never assistant identity; tag name, position or filename
    // presence prove nothing.
    if (element.getAttribute("data-message-author-role") === "assistant") {
      return true;
    }
    return element.matches('[data-testid*="conversation-turn"]') &&
      Boolean(element.querySelector('[data-message-author-role="assistant"]'));
  }

  // ---- Latest artifact-bearing assistant scope ------------------------------
  // PC-1A replaces the superseded whole-chat/newest-same-name model:
  //   - only the latest visible assistant scope containing at least one
  //     artifact row is eligible;
  //   - ordinary assistant text and later user turns do not change that scope;
  //   - a newer artifact-bearing scope containing only PDF/TXT/etc. yields
  //     NO_MARKDOWN and never falls back to an older Markdown scope;
  //   - same-scope same-filename ambiguity fails closed;
  //   - non-Markdown rows are ignored after they establish the winning scope;
  //   - the MAX 10 bound applies to the winning scope only.
  const MAX_MARKDOWN_SOURCES = 10;

  function mvpAssistantTurnsInChat() {
    return Array.from(document.querySelectorAll(ARTIFACT_TURN_SELECTOR))
      .filter(isVisible)
      .filter(isAssistantConversationTurn);
  }

  function mvpDiscoverMarkdownSourcesInChat() {
    const turns = mvpAssistantTurnsInChat();
    const artifactScopes = turns
      .map((turn, index) => ({
        turn,
        index,
        rows: mvpArtifactRowsInTurn(turn)
      }))
      .filter((scope) => scope.rows.length > 0);
    const winningScope = artifactScopes.length > 0
      ? artifactScopes[artifactScopes.length - 1]
      : null;
    if (!winningScope) {
      return {
        error: "NO_MARKDOWN",
        invalid: 0,
        turns: turns.length,
        artifactScopes: 0,
        scopeIndex: -1,
        scopeElement: null,
        sources: []
      };
    }

    const found = mvpMarkdownCandidatesInTurn(winningScope.turn);
    const seenInScope = new Map();
    const sources = found.valid.map((candidate) => {
      seenInScope.set(candidate.filename, (seenInScope.get(candidate.filename) || 0) + 1);
      return {
        filename: candidate.filename,
        firstIndex: winningScope.index,
        lastIndex: winningScope.index,
        scopeElement: winningScope.turn,
        row: candidate.row,
        element: candidate.element,
        directButton: candidate.directButton || null
      };
    });
    let invalid = 0;
    invalid += found.invalid;
    for (const entry of sources) {
      if ((seenInScope.get(entry.filename) || 0) > 1) {
        entry.duplicateInWinningTurn = true;
      }
    }
    if (invalid > 0) {
      return {
        error: "ARTIFACT_FILENAME_INVALID",
        invalid,
        turns: turns.length,
        artifactScopes: artifactScopes.length,
        scopeIndex: winningScope.index,
        scopeElement: winningScope.turn,
        sources: []
      };
    }
    if (sources.some((entry) => entry.duplicateInWinningTurn)) {
      return {
        error: "ARTIFACT_AMBIGUOUS",
        invalid,
        turns: turns.length,
        artifactScopes: artifactScopes.length,
        scopeIndex: winningScope.index,
        scopeElement: winningScope.turn,
        sources
      };
    }
    if (sources.length === 0) {
      return {
        error: "NO_MARKDOWN",
        invalid,
        turns: turns.length,
        artifactScopes: artifactScopes.length,
        scopeIndex: winningScope.index,
        scopeElement: winningScope.turn,
        sources: []
      };
    }
    if (sources.length > MAX_MARKDOWN_SOURCES) {
      return {
        error: "TOO_MANY_MARKDOWN",
        invalid,
        turns: turns.length,
        artifactScopes: artifactScopes.length,
        scopeIndex: winningScope.index,
        scopeElement: winningScope.turn,
        sources
      };
    }
    return {
      error: "",
      invalid,
      turns: turns.length,
      artifactScopes: artifactScopes.length,
      scopeIndex: winningScope.index,
      scopeElement: winningScope.turn,
      sources
    };
  }

  // Same-card direct-download capture (multi-source v1 preferred path).
  // Live DOM evidence (2026-09-08): the artifact row's direct-download button
  // is ALWAYS in the DOM (hidden via opacity-0 / pointer-events-none until the
  // pure-CSS group-hover/artifact-row reveal) and shares the exact same row as
  // the filename identity. We arm chrome.downloads FIRST, then click, then
  // correlate the exact filename. If no deterministic same-card direct action
  // exists (or the bounded direct attempt fails to produce a matching
  // download), we return null and the frozen Preview chain takes over.
  function isFrozenTargetIdentityError(error) {
    const code = error instanceof Error ? String(error.message) : String(error || "");
    return code === "ARTIFACT_TARGET_LOST" || code === "ARTIFACT_SCOPE_CHANGED";
  }

  async function captureViaDirectDownload(source, result, setStage, validateFrozenTarget) {
    if (typeof validateFrozenTarget === "function") {
      validateFrozenTarget();
    }
    const directButton = source && source.directButton;
    // Safety diagnostics: always record whether the semantic same-card direct
    // control was found and its sanitized accessible identity (aria-label,
    // falling back to title). Identity values only — never document content.
    result.direct_button_found = isElement(directButton);
    if (isElement(directButton)) {
      result.direct_button_identity = {
        aria: String(directButton.getAttribute("aria-label") || "").trim().slice(0, 80),
        title: String(directButton.getAttribute("title") || "").trim().slice(0, 80)
      };
    }
    if (!isElement(directButton)) {
      result.fallback_reason = "no_direct_button";
      return null;
    }
    let waiter = null;
    let armed = false;
    try {
      setStage("pre-arm");
      await armDownloadCapture();
      armed = true;
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      waiter = waitForDownloadCapture();
      waiter.catch(() => {});
      setStage("click");
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      result.direct_click_attempted = true;
      activateOnce(directButton);
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      setStage("download-intercept");
      const download = await waiter;
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      result.direct_download_event_seen = true;
      const urlRejectionReason = artifactCaptureUrlRejectionReason(download.url);
      if (urlRejectionReason) {
        result.errors.push("DIRECT_DOWNLOAD_URL_REJECTED:" + urlRejectionReason);
        result.fallback_reason = "direct_download_url_rejected";
        return null;
      }
      setStage("blob-capture");
      const capture = await readBytesFromUrl(download.url);
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
      result.fallback_reason = "";
      return {
        ...capture,
        method: "chrome_downloads+direct+" + capture.method,
        automaticCapture: true,
        directDownload: true
      };
    } catch (error) {
      if (isFrozenTargetIdentityError(error)) {
        throw error;
      }
      // Soft failure: the direct action did not produce a matching artifact
      // download within the bounded window. Record a diagnostic and let the
      // frozen Preview chain take over; a bounded direct attempt never
      // publishes anything by itself.
      const errorCode = error instanceof Error ? String(error.message) : "DIRECT_DOWNLOAD_FAILED";
      const eventSeen = Boolean(error && error.downloadDiagnostic && error.downloadDiagnostic.download_event_seen);
      result.direct_download_event_seen = result.direct_download_event_seen || eventSeen;
      result.fallback_reason = project100DirectFallbackReason(errorCode);
      result.direct_download_diagnostic = {
        error: clippedText(errorCode, 160),
        download_diagnostic: error && error.downloadDiagnostic ? error.downloadDiagnostic : null
      };
      return null;
    } finally {
      cancelDownloadCaptureWaiter();
      if (armed) {
        await disarmDownloadCapture();
      }
      if (typeof validateFrozenTarget === "function") {
        validateFrozenTarget();
      }
    }
  }

  // Compact fallback-reason classifier for the safety diagnostics. Maps the
  // bounded direct attempt's known outcomes to stable short codes; unknown
  // error text degrades to "direct_failed" (never the raw document body).
  function project100DirectFallbackReason(errorCode) {
    const code = String(errorCode || "");
    if (code.includes("DOWNLOAD_CAPTURE_TIMEOUT")) return "download_event_timeout";
    if (code.includes("DOWNLOAD_CAPTURE_CANCELLED")) return "download_capture_cancelled";
    if (code.includes("DOWNLOAD_CAPTURE_BUSY")) return "download_capture_busy";
    if (code.includes("DOWNLOAD_CAPTURE_AMBIGUOUS")) return "download_event_ambiguous";
    if (code.includes("DOWNLOAD_CAPTURE_FAILED")) return "download_capture_failed";
    if (code.includes("DOWNLOAD_URL_UNAVAILABLE")) return "download_url_unavailable";
    if (code.includes("DOWNLOAD_INTERRUPTED")) return "download_interrupted";
    return "direct_failed";
  }

  // Production capture (PC-1A) reuses the frozen page-lifetime target from
  // operation start. It never discovers the current chat again and never
  // chooses a same-name replacement. The requested logical filename arrives
  // via TEST_FILENAME (set by runMvpPublishCapture).
  async function runMvpArtifactCapture(frozenTargetIdentity) {
    const result = {
      status: "BLOCKED",
      stage: "identity",
      filename: TEST_FILENAME,
      matching_openers: 0,
      markdown_candidates: 0,
      markdown_invalid_candidates: 0,
      byte_length: 0,
      sha256: "",
      bytes: null,
      download_diagnostic: null,
      turn_identity: null,
      document_instance_id: "",
      frozen_operation_token: "",
      frozen_scope_token: "",
      frozen_target_token: "",
      opener_identity: null,
      preview_already_open: false,
      direct_download: false,
      direct_download_diagnostic: null,
      // Safety diagnostics (2026-09-08): whether the semantic same-card
      // direct control was found, its sanitized accessible identity, whether a
      // click was attempted, whether a qualifying download event was observed,
      // and the compact reason the frozen Preview chain took over. Identity
      // values only (aria-label/title); the document body is never recorded.
      direct_button_found: false,
      direct_button_identity: null,
      direct_click_attempted: false,
      direct_download_event_seen: false,
      fallback_reason: "",
      canary: "",
      revision: "",
      nonce: "",
      errors: []
    };
    const resolved = resolveFrozenArtifactTarget(frozenTargetIdentity, TEST_FILENAME);
    if (!resolved.ok) {
      result.errors.push(resolved.error);
      return result;
    }
    const selected = resolved.target;
    result.document_instance_id = documentInstanceId;
    result.frozen_operation_token = resolved.operation.frozenOperationToken;
    result.frozen_scope_token = resolved.operation.frozenScopeToken;
    result.frozen_target_token = selected.frozenTargetToken;
    result.turn_identity = {
      selection: "frozen_page_lifetime_target",
      scope_index: resolved.operation.scopeIndex,
      discovered_sources_at_freeze: resolved.operation.targets.size
    };
    result.markdown_candidates = resolved.operation.targets.size;
    result.markdown_invalid_candidates = 0;
    // The capture result must carry the ACTUAL generated artifact filename,
    // which is independent of the canonical Drive filename identity.
    result.filename = selected.exactFilename;
    result.opener_identity = {
      accessible_name: clippedText(selected.element.getAttribute("aria-label"), 120),
      selection_reason: "frozen_page_lifetime_target"
    };
    const candidate = makeFrozenArtifactCandidate(selected);
    const rejectionReason = artifactCandidateRejectionReason(candidate);
    if (rejectionReason) {
      result.errors.push(rejectionReason);
      return result;
    }
    const validateFrozenTarget = () => {
      const current = resolveFrozenArtifactTarget(
        frozenTargetIdentity, selected.exactFilename);
      if (!current.ok) {
        throw new Error(current.error || "ARTIFACT_TARGET_LOST");
      }
      return current.target;
    };
    // The frozen preview/download chain keys its exact-filename evidence and
    // the armed chrome.downloads capture on TEST_FILENAME; swap in the
    // selected artifact filename for the whole awaited capture, then restore.
    const previousFilename = TEST_FILENAME;
    TEST_FILENAME = selected.exactFilename;
    try {
      // Same-card direct-download is the preferred path when the live card
      // yields a deterministic direct action; the frozen Preview chain stays
      // the fallback (live-proven). A bounded failed direct attempt never
      // publishes anything by itself and always lets the fallback run.
      const directCapture = await captureViaDirectDownload(selected, result, (stage) => {
        result.stage = stage;
      }, validateFrozenTarget);
      // A direct soft failure may have crossed an asynchronous disarm/fallback
      // boundary. Revalidate before allowing the frozen Preview path to run.
      validateFrozenTarget();
      const capture = directCapture || await captureViaPreviewDownload(candidate, result, (stage) => {
        result.stage = stage;
      }, validateFrozenTarget);
      validateFrozenTarget();
      if (directCapture) {
        result.direct_download = true;
      }
      if (!capture) {
        return result;
      }
      const bytes = capture.bytes instanceof Uint8Array ? capture.bytes : new Uint8Array(capture.bytes);
      result.byte_length = bytes.byteLength;
      if (bytes.byteLength <= 0 || bytes.byteLength > MVP_MAX_ARTIFACT_BYTES) {
        result.errors.push("INVALID_ARTIFACT_BYTES");
        return result;
      }
      let text = "";
      let utf8Valid = false;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        utf8Valid = true;
      } catch (_error) {
        utf8Valid = false;
      }
      if (!utf8Valid) {
        result.errors.push("INVALID_ARTIFACT_BYTES");
        return result;
      }
      result.sha256 = await sha256Hex(bytes);
      validateFrozenTarget();
      // Freshness diagnostics only: the three canary field values, never the
      // surrounding document text.
      result.canary = extractField(text, "SOURCE_CANARY");
      result.revision = extractField(text, "REVISION");
      result.nonce = extractField(text, "NONCE");
      result.bytes = Array.from(bytes);
      result.status = "PASS";
      return result;
    } catch (error) {
      result.errors.push(error instanceof Error ? clippedText(error.message, 180) : "DIRECT_FETCH_FAILED");
      if (error && error.downloadDiagnostic) {
        result.download_diagnostic = error.downloadDiagnostic;
      }
      return result;
    } finally {
      TEST_FILENAME = previousFilename;
    }
  }

  // Identity swaps must span the whole awaited capture/resync: save, set,
  // await, restore in finally — never restore before the async work ends.
  async function runMvpPublishCapture(filename, driveFileId, frozenTargetIdentity) {
    const previousFilename = TEST_FILENAME;
    const previousDriveId = EXPECTED_DRIVE_ID;
    TEST_FILENAME = filename;
    EXPECTED_DRIVE_ID = driveFileId;
    try {
      return await runMvpArtifactCapture(frozenTargetIdentity);
    } finally {
      TEST_FILENAME = previousFilename;
      EXPECTED_DRIVE_ID = previousDriveId;
    }
  }

  // Page-lifetime T1 run state. Lets the popup recover the last result after
  // Chrome closes it during the automated UI sequence; gone on page refresh.
  let t1RunState = "idle";
  let lastT1Result = null;

  // Per-document identity (HY7 production hardening): a fresh Sources reload
  // creates a NEW document; the service worker must never classify a reload's
  // evidence against a PING answered by the PREVIOUS document. Generated once
  // per document lifetime, returned by PING, compared across navigations.
  const documentInstanceId =
    `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // PC-1A identity is intentionally page-lifetime only. The service worker
  // may retain the serializable tokens while the operation/onboarding state
  // is pending, but the DOM references themselves never leave this document.
  const frozenArtifactOperations = new Map();

  function pageLifetimeToken(prefix) {
    try {
      if (crypto && typeof crypto.randomUUID === "function") {
        return `${prefix}-${crypto.randomUUID()}`;
      }
    } catch (_error) {
      // bounded fallback below
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function nodeBelongsToCurrentDocument(node) {
    if (!isElement(node)) {
      return false;
    }
    if (node.ownerDocument && node.ownerDocument !== document) {
      return false;
    }
    if (typeof node.isConnected === "boolean") {
      return node.isConnected;
    }
    if (typeof document.contains === "function") {
      return document.contains(node);
    }
    // The production DOM exposes isConnected/document.contains. This
    // fallback exists only for the small VM DOM used by local harnesses.
    return Boolean(node.parentElement);
  }

  function nodeContains(container, node) {
    if (!isElement(container) || !isElement(node)) {
      return false;
    }
    if (container === node) {
      return true;
    }
    if (typeof container.contains === "function") {
      return container.contains(node);
    }
    let current = node.parentElement;
    let depth = 0;
    while (current && depth < 32) {
      if (current === container) {
        return true;
      }
      current = current.parentElement;
      depth += 1;
    }
    return false;
  }

  function freezeArtifactScope() {
    const discovery = mvpDiscoverMarkdownSourcesInChat();
    if (discovery.error) {
      return {
        status: "BLOCKED",
        error: discovery.error,
        documentInstanceId,
        frozenScopeToken: "",
        frozenOperationToken: "",
        targets: []
      };
    }

    const frozenScopeToken = pageLifetimeToken("scope");
    const frozenOperationToken = pageLifetimeToken("operation");
    const operation = {
      documentInstanceId,
      frozenScopeToken,
      frozenOperationToken,
      scopeIndex: discovery.scopeIndex,
      scopeElement: discovery.scopeElement,
      targets: new Map()
    };
    const publicTargets = [];
    for (const source of discovery.sources) {
      const frozenTargetToken = pageLifetimeToken("target");
      const target = {
        documentInstanceId,
        frozenScopeToken,
        frozenOperationToken,
        frozenTargetToken,
        exactFilename: source.filename,
        scopeElement: source.scopeElement,
        row: source.row,
        element: source.element,
        directButton: source.directButton || null
      };
      operation.targets.set(frozenTargetToken, target);
      publicTargets.push({
        documentInstanceId,
        frozenScopeToken,
        frozenOperationToken,
        frozenTargetToken,
        exactFilename: source.filename
      });
    }
    frozenArtifactOperations.set(frozenOperationToken, operation);
    return {
      status: "PASS",
      documentInstanceId,
      frozenScopeToken,
      frozenOperationToken,
      targets: publicTargets
    };
  }

  function frozenTargetIsStillOriginal(target) {
    if (!target || target.documentInstanceId !== documentInstanceId ||
        !nodeBelongsToCurrentDocument(target.scopeElement) ||
        !nodeBelongsToCurrentDocument(target.row) ||
        !nodeBelongsToCurrentDocument(target.element)) {
      return false;
    }
    if (!nodeContains(target.scopeElement, target.row) ||
        !nodeContains(target.row, target.element)) {
      return false;
    }
    const currentOpener = mvpRowOpenFileButton(target.row);
    const currentFilename = currentOpener
      ? String(currentOpener.getAttribute("aria-label") || "").trim()
      : "";
    return currentOpener === target.element && currentFilename === target.exactFilename &&
      mvpSafeMarkdownFilename(currentFilename) === target.exactFilename;
  }

  function resolveFrozenArtifactTarget(identity, expectedFilename) {
    const raw = identity && typeof identity === "object" ? identity : {};
    if (String(raw.documentInstanceId || "") !== documentInstanceId) {
      return { ok: false, error: "ARTIFACT_TARGET_LOST" };
    }
    const operation = frozenArtifactOperations.get(String(raw.frozenOperationToken || ""));
    if (!operation || operation.documentInstanceId !== documentInstanceId ||
        operation.frozenScopeToken !== String(raw.frozenScopeToken || "")) {
      return { ok: false, error: "ARTIFACT_TARGET_LOST" };
    }
    const target = operation.targets.get(String(raw.frozenTargetToken || ""));
    if (!target || target.frozenScopeToken !== operation.frozenScopeToken ||
        target.exactFilename !== String(raw.exactFilename || "") ||
        target.exactFilename !== String(expectedFilename || "")) {
      return { ok: false, error: "ARTIFACT_SCOPE_CHANGED" };
    }
    if (!frozenTargetIsStillOriginal(target)) {
      return { ok: false, error: "ARTIFACT_TARGET_LOST" };
    }
    return { ok: true, operation, target };
  }

  function makeFrozenArtifactCandidate(target) {
    const { identity, identityNode } = findArtifactIdentity(target.element);
    const directButton = target.directButton && nodeBelongsToCurrentDocument(target.directButton) &&
      nodeContains(target.row, target.directButton)
      ? target.directButton
      : mvpRowDirectDownloadButton(target.row, target.element);
    return {
      element: target.element,
      container: target.row,
      identity,
      identityNode,
      preferredAction: true,
      aliasCount: artifactAliasCount(target.row, target.element),
      candidateFileToken: target.exactFilename,
      directButton,
      frozenTarget: true
    };
  }

  const project100MessageListener = (message, _sender, sendResponse) => {
    if (message && message.type === "PROJECT100_DOWNLOAD_CAPTURE_RESULT") {
      settleDownloadCaptureMessage(message);
      return false;
    }
    if (message && message.type === "PROJECT100_BIND_CURRENT_SOURCE") {
      sendResponse(runMvpSourceBindingProbe(message.filename, message.driveFileId));
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_FREEZE_ARTIFACT_SCOPE") {
      // Operation start only: retain the structural DOM references in this
      // document and return only serializable identity tokens to the worker.
      sendResponse(freezeArtifactScope());
      return false;
    }
    if (message && message.type === "PROJECT100_PAGE_STATUS") {
      // Read-only popup page-status probe: never clicks, never mutates state.
      sendResponse(project100PageStatusSnapshot());
      return false;
    }
    if (message && message.type === "PROJECT100_ONBOARDING_ARM_WATCH") {
      // First-use onboarding: arm the exact-probe + bounded debounced watcher
      // on the ACTIVE onboarding Sources tab and show the extension-owned
      // hint banner. No native control is ever clicked by this code.
      const validated = validateMvpBinding(message.filename, message.driveFileId);
      if (!validated.ok) {
        sendResponse({ status: "BLOCKED", error: validated.error });
        return false;
      }
      const outcome = project100RunOnboardingWatch({
        filename: validated.filename,
        driveFileId: validated.driveFileId,
        projectId: String(message.projectId || ""),
        windowMs: Number(message.windowMs) || 0,
        linkCopied: Boolean(message.linkCopied),
        queueIndex: Number(message.queueIndex) || 0,
        queueTotal: Number(message.queueTotal) || 0,
        driveUrl: String(message.driveUrl || "")
      });
      sendResponse({
        status: "PASS",
        watching: outcome.watching,
        bound: outcome.bound,
        sourcePageUrl: outcome.bound ? window.location.href : ""
      });
      return false;
    }
    if (message && message.type === "PROJECT100_ONBOARDING_DISARM_WATCH") {
      project100StopOnboardingWatch();
      sendResponse({ status: "PASS" });
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_PING") {
      // documentInstanceId lets the service worker prove a reload actually
      // produced a NEW document before classifying that load's evidence.
      sendResponse({ status: "PASS", documentInstanceId });
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_SOURCE_READY") {
      // Read-only Source DOM readiness: reuse the exact binding resolution
      // (one source, exact drive id, one action control, readable sync
      // state). Never clicks, never opens menus, never mutates state — a
      // BLOCKED answer only means "not ready yet or structurally wrong".
      sendResponse(runMvpSourceBindingProbe(message.filename, message.driveFileId));
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_NETWORK_OBSERVER_PREPARE") {
      // Arm context for the upcoming Resync: window identity, exact bound
      // Source, project id and the ORIGINAL absolute deadline. Arming itself
      // happens inside runSourceResync at the click instant.
      pendingNetworkArm = {
        windowId: String(message.windowId || ""),
        driveFileId: String(message.driveFileId || ""),
        projectId: String(message.projectId || ""),
        deadline: Number(message.deadline) || 0
      };
      sendResponse({
        status: "PASS",
        windowId: pendingNetworkArm.windowId,
        observerInstalled: networkObservation.observerInstalled
      });
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_NETWORK_OBSERVER_DISARM") {
      // Terminal disarm, issued only by the service worker when the flow ends.
      disarmNetworkObserver();
      pendingNetworkArm = null;
      sendResponse({ status: "PASS", records: networkObservation.records.length });
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_NETWORK_EVIDENCE") {
      // PASS 1: bounded diagnostics only — never a verdict input. `records`
      // is a unit-harness hook: when supplied, those records are classified
      // instead of the locally collected ones.
      if (Array.isArray(message.records)) {
        sendResponse(project100ClassifyNetworkEvidence(message.records, message.context || {}));
        return false;
      }
      sendResponse(project100NetworkEvidenceSnapshot());
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_FRESH_SOURCES_COLLECT") {
      // HY6 PoC: classify THIS document's page-owned bootstrap traffic against
      // the ORIGINAL pre-Resync baseline delivered by the service worker.
      // Bounded per-load wait for the page-owned connector_scopes GET (the
      // observer already buffered document_start traffic; "hello" drained it
      // at install). No fetch is ever issued here, and this never influences
      // any product verdict. `records` is a unit-harness hook only.
      const safeRespondFresh = (payload) => {
        try {
          sendResponse(payload);
        } catch (_error) {
          // The orchestration tab may be closing as the response lands.
        }
      };
      const freshContext = {
        driveFileId: String(message.driveFileId ||
          (pendingNetworkArm && pendingNetworkArm.driveFileId) || EXPECTED_DRIVE_ID),
        projectId: String(message.projectId || project100ResolveProjectId(window.location.href)),
        originalPreCompletedAt: String(message.originalPreCompletedAt || "")
      };
      if (Array.isArray(message.records)) {
        safeRespondFresh({
          status: "PASS",
          attempt: project100ClassifyFreshSourcesEvidence(message.records, freshContext)
        });
        return false;
      }
      const perLoadTimeoutMs = Math.max(0, Math.min(30000, Number(message.perLoadTimeoutMs) || 0));
      const freshStartedAt = Date.now();
      const collectFreshSources = async () => {
        while (Date.now() - freshStartedAt < perLoadTimeoutMs) {
          const seen = networkObservation.records.some(freshSourcesRelevantRecord);
          if (seen) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return project100ClassifyFreshSourcesEvidence(networkObservation.records, freshContext);
      };
      collectFreshSources()
        .then((attempt) => safeRespondFresh({ status: "PASS", attempt }))
        .catch(() => safeRespondFresh({ status: "BLOCKED", error: "FRESH_SOURCES_COLLECT_FAILED" }));
      return true;
    }
    if (message && message.type === "PROJECT100_MVP_SYNC_STATE") {
      // Read-only sync-state snapshot consumed by bounded background
      // verification when the backend receipt is structurally unavailable.
      sendResponse(runMvpSyncStateCheck(message.filename, message.driveFileId));
      return false;
    }
    if (message && message.type === "PROJECT100_MVP_CONNECTOR_SCOPE_RECEIPT") {
      // Read-only backend completion receipt probe (GET connector_scopes).
      // Async; never clicks, never mutates state.
      const safeRespondReceipt = (payload) => {
        try {
          sendResponse(payload);
        } catch (_error) {
          // The orchestration tab may be gone by the time the probe returns.
        }
      };
      runMvpConnectorScopeReceipt(
        message.filename,
        message.driveFileId,
        message.sourcePageUrl,
        { firstAdd: message.firstAdd === true })
        .then(safeRespondReceipt)
        .catch(() => safeRespondReceipt({ status: "BLOCKED", error: "BACKEND_RECEIPT_UNAVAILABLE" }));
      return true;
    }
    if (message && (message.type === "PROJECT100_MVP_CAPTURE_ARTIFACT" || message.type === "PROJECT100_MVP_RESYNC_BOUND_SOURCE")) {
      const validated = validateMvpBinding(message.filename, message.driveFileId);
      if (!validated.ok) {
        sendResponse({ status: "BLOCKED", error: validated.error });
        return false;
      }
      const safeRespond = (payload) => {
        try {
          sendResponse(payload);
        } catch (_error) {
          // The orchestration tab may be closing as the response lands.
        }
      };
      const operation = message.type === "PROJECT100_MVP_CAPTURE_ARTIFACT"
        ? runMvpPublishCapture(
          validated.filename,
          validated.driveFileId,
          message.frozenTargetIdentity)
        : runMvpBoundResync(validated.filename, validated.driveFileId);
      operation.then(safeRespond).catch((error) => {
          safeRespond({
            status: "BLOCKED",
            error: error && typeof error.message === "string" ? clippedText(error.message, 180) : "UNEXPECTED_RUNTIME_ERROR"
          });
        });
      return true;
    }
    if (message && message.type === "PROJECT100_GET_T1_STATE") {
      sendResponse({
        run_state: t1RunState,
        result: lastT1Result
      });
      return false;
    }
    if (!message || !["PROJECT100_RUN_A", "PROJECT100_RUN_B"].includes(message.type)) {
      return false;
    }

    const isT1 = message.type === "PROJECT100_RUN_A";
    const operation = isT1 ? runArtifactCapture : runSourceResync;
    const safeRespond = (payload) => {
      try {
        sendResponse(payload);
      } catch (_error) {
        // The popup may have closed mid-run; page-side T1 state is already saved.
      }
    };
    if (isT1) {
      t1RunState = "running";
    }
    operation().then((result) => {
      if (isT1) {
        lastT1Result = result;
        t1RunState = "completed";
      }
      safeRespond(result);
    }).catch((error) => {
      const fallback = {
        experiment: isT1 ? "artifact_capture" : "source_resync",
        status: isT1 ? "BLOCKED" : "FAIL",
        stage: "runtime",
        errors: [error && typeof error.message === "string" ? clippedText(error.message, 180) : "UNEXPECTED_RUNTIME_ERROR"]
      };
      if (isT1) {
        lastT1Result = fallback;
        t1RunState = "completed";
      }
      safeRespond(fallback);
    });
    return true;
  };

  // Page-lifetime load guard (top of file) makes repeated or redundant
  // injection a no-op, so exactly one production listener is registered.
  installNetworkObservationListener();
  chrome.runtime.onMessage.addListener(project100MessageListener);
})();
