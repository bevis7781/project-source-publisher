(() => {
  "use strict";

  // Project Source Publisher — MAIN-world network observer.
  //
  // PASSIVE CHANNEL (page-owned traffic only). This file never:
  //   - alters the page's request, response, promise or timing,
  //   - reads or copies Authorization / Cookie / bearer material,
  //   - reads request or response headers,
  //   - reads request bodies, conversation content or document content,
  //   - changes any product verdict.
  // It only watches traffic the ChatGPT page itself initiates, and it can only
  // ever emit a small allowlisted set of structured sync/identity fields.
  //
  // ACTIVE CHANNEL (bounded PoC). On an explicit command from this extension's
  // own content script it performs a same-origin read-only GET of the exact
  //   /backend-api/projects/<project-id>/connector_scopes?limit=100
  // endpoint with page-native fetch semantics (credentials: "include",
  // cache: "no-store", NO auth headers of any kind) so the request inherits
  // the page's authenticated browser context. It never mutates anything, never
  // replays any mutation request, and never extracts authentication material.
  // Every code path is failure-contained: if the observer breaks, the page
  // keeps working exactly as before.

  if (typeof window === "undefined" || window.__project100NetworkObserverInstalled) {
    return;
  }
  window.__project100NetworkObserverInstalled = true;

  const OBSERVER_VERSION = 1;
  const CHANNEL_RECORD = "PROJECT100_NETWORK_OBSERVATION_RECORD";
  const CHANNEL_COMMAND = "PROJECT100_NETWORK_OBSERVER_COMMAND";

  const MAX_RECORDS = 64;
  const MAX_ITEMS_PER_RECORD = 8;
  const MAX_TEXT_CHARS = 20000;
  const MAX_FIELD_CHARS = 160;
  const MAX_PATH_CHARS = 200;
  const MAX_FAILURES_BEFORE_UNINSTALL = 8;

  // Lifetime leak mitigation (audit §17): unregisterContentScripts() does not
  // remove a script already injected into another matching tab. An observer
  // that never receives this flow's arm command therefore stops recording all
  // by itself after this absolute installation lifetime. Armed observation
  // windows carry their own absolute deadline and are unaffected.
  const BOOTSTRAP_LIFETIME_MS = 180000;

  // Active receipt polling cadence (PoC): modest and bounded, never faster
  // than 1 second. The loop always terminates on the caller's absolute
  // deadline — the ORIGINAL driveUpdatedAt + 120000 window, never extended.
  const ACTIVE_POLL_CADENCE_MS = 2500;
  const ACTIVE_POLL_MIN_CADENCE_MS = 1000;
  const ACTIVE_POLL_MAX_CADENCE_MS = 10000;
  const ACTIVE_RECEIPT_RESULT_LIMIT = 100;

  // document_start gate: install nothing at all unless this really is a
  // Project Sources page of a ChatGPT Project. The registered match pattern is
  // already narrow; this second gate keeps unrelated same-path tabs untouched.
  const GATE_PATH_RE = /^\/g\/g-p-[A-Za-z0-9-]+\/project(?:\/|$)/;
  // Only Source / connector / sync surface traffic is ever recorded.
  const RELEVANT_PATH_RE = /\/(?:connector_scopes?|project_sources?|sources?)(?:\/|$)/i;

  const ALLOWED_HOSTNAMES = ["chatgpt.com", "chat.openai.com"];

  const state = {
    version: OBSERVER_VERSION,
    installed: false,
    failed: false,
    recording: false,
    armed: false,
    windowId: "",
    driveFileId: "",
    projectId: "",
    deadline: 0,
    expired: false,
    installExpiresAt: 0,
    records: [],
    dropped: 0,
    relevantSeen: 0,
    ignoredSeen: 0,
    failures: 0,
    seq: 0,
    active: {
      running: false,
      timer: 0,
      windowId: "",
      projectId: "",
      driveFileId: "",
      preCompletedAt: "",
      deadline: 0,
      cadenceMs: ACTIVE_POLL_CADENCE_MS,
      attempted: false,
      httpReachable: false,
      firstHttpStatus: 0,
      pollCount: 0,
      lastObservedStatus: "",
      lastObservedStartedAt: "",
      lastObservedCompletedAt: "",
      exactMatchObserved: false,
      ambiguousObserved: false,
      explicitErrorObserved: false,
      completionCandidateObserved: false,
      terminalReason: ""
    }
  };

  function noteFailure() {
    state.failures += 1;
    if (state.failures >= MAX_FAILURES_BEFORE_UNINSTALL) {
      state.failed = true;
      uninstall();
    }
  }

  function targetOrigin() {
    try {
      return window.location && window.location.origin ? window.location.origin : "*";
    } catch (_error) {
      return "*";
    }
  }

  function post(message) {
    try {
      if (typeof window.postMessage !== "function") {
        return;
      }
      window.postMessage(message, targetOrigin());
    } catch (_error) {
      // Never let reporting break the page.
    }
  }

  function emitRecord(record) {
    post({ type: CHANNEL_RECORD, record });
  }

  function emitState(reason) {
    post({
      type: CHANNEL_RECORD,
      record: {
        kind: "observer-state",
        version: OBSERVER_VERSION,
        installed: state.installed,
        failed: state.failed,
        recording: state.recording,
        armed: state.armed,
        windowId: state.windowId,
        reason: String(reason || "")
      }
    });
  }

  function passGate() {
    try {
      const location = window.location;
      if (!location || ALLOWED_HOSTNAMES.indexOf(String(location.hostname || "")) < 0) {
        return false;
      }
      if (!GATE_PATH_RE.test(String(location.pathname || ""))) {
        return false;
      }
      // The temporary Sources tab is opened on the Sources surface; a plain
      // project conversation on the same path is not an observation target.
      return /tab=sources/.test(String(location.search || ""));
    } catch (_error) {
      return false;
    }
  }

  function clip(value, limit) {
    const text = value == null ? "" : String(value);
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function sanitizePath(rawUrl) {
    let pathname = "";
    try {
      const url = new URL(String(rawUrl), window.location.href);
      if (ALLOWED_HOSTNAMES.indexOf(url.hostname) < 0) {
        return "";
      }
      pathname = String(url.pathname || "");
    } catch (_error) {
      let text = String(rawUrl || "");
      const cut = text.search(/[?#]/);
      text = cut >= 0 ? text.slice(0, cut) : text;
      const originStripped = text.match(/^https?:\/\/[^/]+(\/.*)?$/i);
      pathname = originStripped ? (originStripped[1] || "/") : text;
    }
    return clip(pathname, MAX_PATH_CHARS);
  }

  function isRelevantPath(pathname) {
    if (!pathname || pathname.indexOf("/backend-api/") !== 0) {
      return false;
    }
    return RELEVANT_PATH_RE.test(pathname);
  }

  function shapeOf(payload) {
    if (Array.isArray(payload)) {
      return "array";
    }
    if (payload && typeof payload === "object") {
      return Array.isArray(payload.items) ? "items" : "object";
    }
    return "unknown";
  }

  function itemsOf(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && typeof payload === "object") {
      return Array.isArray(payload.items) ? payload.items : [payload];
    }
    return [];
  }

  // The ONLY fields allowed to leave MAIN world. No headers, no bodies, no
  // filenames, no conversation or document content, no account data.
  function allowlistedItem(item) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const serverId = typeof item.server_id === "string"
      ? item.server_id
      : (typeof item.scope_id === "string" ? item.scope_id : "");
    return {
      canonical_handle: clip(item.canonical_handle, MAX_FIELD_CHARS),
      server_id: clip(serverId, MAX_FIELD_CHARS),
      last_sync_status: clip(item.last_sync_status, MAX_FIELD_CHARS),
      last_sync_started_at: clip(item.last_sync_started_at, MAX_FIELD_CHARS),
      last_sync_completed_at: clip(item.last_sync_completed_at, MAX_FIELD_CHARS),
      last_synced_at: clip(item.last_synced_at, MAX_FIELD_CHARS),
      sync_error_code: item.sync_error_code == null ? "" : clip(item.sync_error_code, MAX_FIELD_CHARS),
      sync_error_message: item.sync_error_message == null ? "" : clip(item.sync_error_message, MAX_FIELD_CHARS)
    };
  }

  function buildRecord(phase, method, path, status, payloadText) {
    let shape = "unparsed";
    let items = [];
    if (payloadText === null) {
      shape = "unreadable";
    } else if (payloadText.length > MAX_TEXT_CHARS) {
      // Never hold or emit an oversized body, not even in truncated form.
      shape = "oversized";
    } else {
      try {
        const payload = JSON.parse(payloadText);
        shape = shapeOf(payload);
        items = itemsOf(payload)
          .slice(0, MAX_ITEMS_PER_RECORD)
          .map(allowlistedItem)
          .filter(Boolean);
      } catch (_error) {
        shape = "unparsed";
        items = [];
      }
    }
    state.seq += 1;
    return {
      version: OBSERVER_VERSION,
      seq: state.seq,
      t: Date.now(),
      phase,
      windowId: state.armed ? state.windowId : "",
      method: clip(method, 16).toUpperCase(),
      path: path,
      status: Number(status) || 0,
      shape,
      items
    };
  }

  function pushRecord(record) {
    if (state.records.length >= MAX_RECORDS) {
      // Keep the newest evidence: drop the oldest non-armed record first.
      let index = -1;
      for (let i = 0; i < state.records.length; i += 1) {
        if (state.records[i].phase !== "armed") {
          index = i;
          break;
        }
      }
      state.records.splice(index >= 0 ? index : 0, 1);
      state.dropped += 1;
    }
    state.records.push(record);
  }

  function maybeExpire() {
    if (state.armed && state.deadline && Date.now() > state.deadline) {
      state.armed = false;
      state.recording = false;
      state.expired = true;
      emitState("deadline");
      return true;
    }
    return false;
  }

  function observe(method, rawUrl, status, payloadText) {
    try {
      if (!state.recording) {
        return;
      }
      if (enforceBootstrapLifetime()) {
        return;
      }
      if (maybeExpire()) {
        return;
      }
      const path = sanitizePath(rawUrl);
      if (!isRelevantPath(path)) {
        state.ignoredSeen += 1;
        return;
      }
      state.relevantSeen += 1;
      const record = buildRecord(state.armed ? "armed" : "bootstrap", method, path, status, payloadText);
      pushRecord(record);
      emitRecord(record);
    } catch (_error) {
      noteFailure();
    }
  }

  // Lifetime leak mitigation check: a never-armed observer (e.g. the
  // unrelated same-project Sources tab) goes dormant after the
  // absolute bootstrap lifetime. Dormancy is enforced BEFORE any clone, so a
  // dormant observer is a pure passthrough — no clone, no record, no
  // page-visible change. Armed observation windows are unaffected.
  function enforceBootstrapLifetime() {
    if (state.armed || !state.installExpiresAt || Date.now() <= state.installExpiresAt) {
      return false;
    }
    if (state.recording) {
      state.recording = false;
      emitState("bootstrap_expired");
    }
    return true;
  }

  function observeFetchResponse(args, response) {
    try {
      if (!state.recording || !response) {
        return;
      }
      if (enforceBootstrapLifetime()) {
        return;
      }
      const rawUrl = requestUrl(args, response);
      const status = typeof response.status === "number" ? response.status : 0;
      if (typeof response.clone !== "function") {
        // Nothing to read without disturbing the page.
        observe(requestMethod(args), rawUrl, status, null);
        return;
      }
      const clone = response.clone();
      clone.text().then((text) => {
        observe(requestMethod(args), rawUrl, status, text);
      }, () => {
        observe(requestMethod(args), rawUrl, status, null);
      });
    } catch (_error) {
      noteFailure();
    }
  }

  function requestUrl(args, response) {
    try {
      const first = args && args.length > 0 ? args[0] : "";
      if (typeof first === "string") {
        return first;
      }
      if (first && typeof first.url === "string") {
        return first.url;
      }
      if (response && typeof response.url === "string" && response.url) {
        return response.url;
      }
    } catch (_error) {
      // Fall through to empty: an unresolvable URL is simply not recorded.
    }
    return "";
  }

  function requestMethod(args) {
    try {
      const init = args && args.length > 1 ? args[1] : null;
      if (init && typeof init.method === "string" && init.method) {
        return init.method;
      }
      const first = args && args.length > 0 ? args[0] : null;
      if (first && typeof first === "object" && typeof first.method === "string" && first.method) {
        return first.method;
      }
    } catch (_error) {
      // Default below.
    }
    return "GET";
  }

  function observeXhr(xhr) {
    try {
      if (!state.recording) {
        return;
      }
      if (enforceBootstrapLifetime()) {
        return;
      }
      const responseType = String(xhr.responseType || "");
      if (responseType !== "" && responseType !== "text") {
        // Never touch blob / arraybuffer / document / stream responses.
        return;
      }
      const rawUrl = xhr.responseURL || (xhr.__project100Request ? xhr.__project100Request.url : "");
      observe(
        xhr.__project100Request ? xhr.__project100Request.method : "GET",
        rawUrl,
        typeof xhr.status === "number" ? xhr.status : 0,
        typeof xhr.responseText === "string" ? xhr.responseText : null
      );
    } catch (_error) {
      noteFailure();
    }
  }

  // ---- active receipt polling (bounded PoC channel) -------------------------
  // One narrowly scoped same-origin read-only GET per tick, performed by the
  // page's own (unwrapped) fetch so the request inherits the page's
  // authenticated browser context. No auth material is ever read, copied or
  // attached; no mutation request is ever issued. The loop self-terminates on
  // the caller's absolute deadline and emits exactly one bounded result.

  function activeReceiptPath(projectId) {
    // Only the exact, already live-proven connector_scopes listing endpoint.
    return "/backend-api/projects/" + encodeURIComponent(projectId) +
      "/connector_scopes?limit=" + ACTIVE_RECEIPT_RESULT_LIMIT;
  }

  function activeReceiptEvidence() {
    const a = state.active;
    return {
      kind: "active-receipt",
      windowId: clip(a.windowId, 60),
      projectId: clip(a.projectId, 80),
      driveFileId: clip(a.driveFileId, MAX_FIELD_CHARS),
      attempted: Boolean(a.attempted),
      httpReachable: Boolean(a.httpReachable),
      firstHttpStatus: Number(a.firstHttpStatus) || 0,
      pollCount: Number(a.pollCount) || 0,
      preCompletedAt: clip(a.preCompletedAt, 60),
      lastObservedStatus: clip(a.lastObservedStatus, MAX_FIELD_CHARS),
      lastObservedStartedAt: clip(a.lastObservedStartedAt, 60),
      lastObservedCompletedAt: clip(a.lastObservedCompletedAt, 60),
      exactMatchObserved: Boolean(a.exactMatchObserved),
      ambiguousObserved: Boolean(a.ambiguousObserved),
      explicitErrorObserved: Boolean(a.explicitErrorObserved),
      completionCandidateObserved: Boolean(a.completionCandidateObserved),
      terminalReason: clip(a.terminalReason, 40)
    };
  }

  function finishActiveReceipt(reason) {
    const a = state.active;
    if (!a.running) {
      return;
    }
    a.running = false;
    if (a.timer) {
      try {
        clearTimeout(a.timer);
      } catch (_error) {
        // Timer already gone.
      }
      a.timer = 0;
    }
    a.terminalReason = String(reason || "DEADLINE");
    post({ type: CHANNEL_RECORD, record: activeReceiptEvidence() });
  }

  function stopActiveReceipt() {
    if (state.active.running) {
      finishActiveReceipt("DISARMED");
    }
  }

  function classifyActiveReceiptBody(payloadText) {
    const a = state.active;
    a.pollCount += 1;
    if (!payloadText || payloadText.length > MAX_TEXT_CHARS) {
      // Unreadable/oversized body: absence of evidence, keep polling.
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(payloadText);
    } catch (_error) {
      return;
    }
    const items = itemsOf(payload)
      .map(allowlistedItem)
      .filter(Boolean);
    // Identity lock: canonical_handle === exact bound Drive file id. Never
    // filename, array position, first result, timing or server_id alone.
    const matches = items.filter((item) => a.driveFileId && item.canonical_handle === a.driveFileId);
    if (matches.length === 0) {
      // 0 matches = absence of evidence; keep polling inside the window.
      return;
    }
    if (matches.length > 1) {
      a.ambiguousObserved = true;
      finishActiveReceipt("SOURCE_AMBIGUOUS");
      return;
    }
    const item = matches[0];
    a.exactMatchObserved = true;
    a.lastObservedStatus = item.last_sync_status;
    a.lastObservedStartedAt = item.last_sync_started_at;
    a.lastObservedCompletedAt = item.last_sync_completed_at;
    if (item.sync_error_code !== "" || item.sync_error_message !== "") {
      a.explicitErrorObserved = true;
      finishActiveReceipt("EXPLICIT_SYNC_ERROR");
      return;
    }
    if (item.last_sync_status !== "completed" || !item.last_sync_completed_at) {
      // running / pending / starting / completed-without-timestamp:
      // progress evidence only. Keep polling until the original deadline.
      return;
    }
    if (!a.preCompletedAt) {
      // No pre-Resync baseline: freshness is undecidable. UNKNOWN, never PASS.
      finishActiveReceipt("NO_PRE_BASELINE");
      return;
    }
    if (item.last_sync_completed_at !== a.preCompletedAt) {
      a.completionCandidateObserved = true;
      finishActiveReceipt("COMPLETED_FRESH");
      return;
    }
    // completed-but-stale (same server-side completion value as before the
    // click) is never completion; keep polling.
  }

  function scheduleActivePoll() {
    const a = state.active;
    if (!a.running) {
      return;
    }
    a.timer = setTimeout(activeReceiptTick, a.cadenceMs);
  }

  function activeReceiptTick() {
    const a = state.active;
    if (!a.running) {
      return;
    }
    a.timer = 0;
    if (a.deadline && Date.now() > a.deadline) {
      finishActiveReceipt("DEADLINE");
      return;
    }
    if (typeof originalFetch !== "function") {
      finishActiveReceipt("FETCH_FAILED");
      return;
    }
    let promise = null;
    try {
      // Same-origin, page-native, read-only. credentials: "include" lets the
      // browser attach its own cookies; no auth header is ever constructed.
      promise = originalFetch.call(window, activeReceiptPath(a.projectId), {
        method: "GET",
        credentials: "include",
        cache: "no-store"
      });
    } catch (_error) {
      finishActiveReceipt("FETCH_FAILED");
      return;
    }
    Promise.resolve(promise).then((response) => {
      try {
        if (!a.running) {
          return;
        }
        const status = response && typeof response.status === "number" ? response.status : 0;
        a.attempted = true;
        if (status) {
          a.httpReachable = true;
          if (!a.firstHttpStatus) {
            a.firstHttpStatus = status;
          }
        }
        if (status === 401) {
          // Never probe why; never extract authentication material.
          finishActiveReceipt("HTTP_401");
          return;
        }
        if (status === 403) {
          finishActiveReceipt("HTTP_403");
          return;
        }
        if (status !== 200) {
          finishActiveReceipt("HTTP_OTHER");
          return;
        }
        if (!response || typeof response.clone !== "function") {
          scheduleActivePoll();
          return;
        }
        response.clone().text().then((text) => {
          if (!a.running) {
            return;
          }
          try {
            classifyActiveReceiptBody(text);
          } catch (_error) {
            noteFailure();
          }
          scheduleActivePoll();
        }, () => {
          if (a.running) {
            scheduleActivePoll();
          }
        });
      } catch (_error) {
        noteFailure();
        if (a.running) {
          scheduleActivePoll();
        }
      }
    }, () => {
      // Network failure: terminal for the PoC route; the page is unaffected.
      if (a.running) {
        finishActiveReceipt("FETCH_FAILED");
      }
    });
  }

  function armActiveReceipt(data) {
    const a = state.active;
    const projectId = String(data.projectId || "");
    const driveFileId = String(data.driveFileId || "");
    const deadline = Number(data.deadline) || 0;
    if (!/^g-p-[A-Za-z0-9-]+$/.test(projectId) || !driveFileId) {
      emitState("active_rejected");
      return;
    }
    if (!deadline || Date.now() > deadline) {
      a.exactMatchObserved = false;
      emitState("active_deadline_passed");
      return;
    }
    a.running = false;
    a.windowId = String(data.windowId || "");
    a.projectId = projectId;
    a.driveFileId = driveFileId;
    a.preCompletedAt = String(data.preCompletedAt || "");
    a.deadline = deadline;
    a.cadenceMs = Math.min(
      ACTIVE_POLL_MAX_CADENCE_MS,
      Math.max(ACTIVE_POLL_MIN_CADENCE_MS, Number(data.cadenceMs) || ACTIVE_POLL_CADENCE_MS)
    );
    a.attempted = false;
    a.httpReachable = false;
    a.firstHttpStatus = 0;
    a.pollCount = 0;
    a.lastObservedStatus = "";
    a.lastObservedStartedAt = "";
    a.lastObservedCompletedAt = "";
    a.exactMatchObserved = false;
    a.ambiguousObserved = false;
    a.explicitErrorObserved = false;
    a.completionCandidateObserved = false;
    a.terminalReason = "";
    a.running = true;
    scheduleActivePoll();
    emitState("active_armed");
  }

  let originalFetch = null;
  let originalOpen = null;
  let originalSend = null;

  function uninstall() {
    try {
      stopActiveReceipt();
      if (originalFetch && typeof originalFetch === "function") {
        window.fetch = originalFetch;
      }
      if (originalOpen && window.XMLHttpRequest) {
        window.XMLHttpRequest.prototype.open = originalOpen;
      }
      if (originalSend && window.XMLHttpRequest) {
        window.XMLHttpRequest.prototype.send = originalSend;
      }
    } catch (_error) {
      // Nothing more we can do; the page keeps its own reference anyway.
    }
    state.installed = false;
    state.recording = false;
    state.armed = false;
  }

  function installFetchObserver() {
    if (typeof window.fetch !== "function") {
      return false;
    }
    originalFetch = window.fetch;
    window.fetch = function project100ObservingFetch(...args) {
      // The page's own call, unchanged arguments, unchanged return value.
      const result = originalFetch.apply(this, args);
      try {
        if (result && typeof result.then === "function") {
          result.then((response) => {
            observeFetchResponse(args, response);
          }, () => {
            // Network failure: nothing to observe, page behavior untouched.
          });
        }
      } catch (_error) {
        noteFailure();
      }
      return result;
    };
    return true;
  }

  function installXhrObserver() {
    if (typeof window.XMLHttpRequest !== "function") {
      return false;
    }
    const prototype = window.XMLHttpRequest.prototype;
    if (typeof prototype.open !== "function" || typeof prototype.send !== "function") {
      return false;
    }
    originalOpen = prototype.open;
    originalSend = prototype.send;
    prototype.open = function project100ObservingOpen(method, url, ...rest) {
      try {
        this.__project100Request = { method: String(method || "GET"), url: String(url || "") };
      } catch (_error) {
        // Non-extensible instance: the URL can still come from responseURL.
      }
      return originalOpen.call(this, method, url, ...rest);
    };
    prototype.send = function project100ObservingSend(...args) {
      try {
        this.addEventListener("load", () => {
          observeXhr(this);
        });
      } catch (_error) {
        noteFailure();
      }
      return originalSend.apply(this, args);
    };
    return true;
  }

  function onCommand(event) {
    let data = null;
    try {
      data = event && event.data ? event.data : null;
    } catch (_error) {
      return;
    }
    if (!data || data.type !== CHANNEL_COMMAND) {
      return;
    }
    try {
      if (data.command === "hello") {
        post({ type: CHANNEL_RECORD, records: state.records.slice() });
        emitState("hello");
        return;
      }
      if (data.command === "arm") {
        const deadline = Number(data.deadline) || 0;
        if (deadline && Date.now() > deadline) {
          state.armed = false;
          state.recording = false;
          state.expired = true;
          emitState("deadline_passed");
          return;
        }
        state.windowId = String(data.windowId || "");
        state.driveFileId = String(data.driveFileId || "");
        state.projectId = String(data.projectId || "");
        state.deadline = deadline;
        state.expired = false;
        state.recording = true;
        state.armed = Boolean(state.windowId);
        emitState("armed");
        return;
      }
      if (data.command === "disarm") {
        stopActiveReceipt();
        state.armed = false;
        state.windowId = "";
        state.recording = false;
        emitState("disarmed");
        return;
      }
      if (data.command === "armActiveReceipt") {
        armActiveReceipt(data);
        return;
      }
    } catch (_error) {
      noteFailure();
    }
  }

  function install() {
    if (!passGate()) {
      // Not an observation target: leave the page completely untouched.
      return;
    }
    try {
      installFetchObserver();
      installXhrObserver();
      state.installed = true;
      state.recording = true;
      state.installExpiresAt = Date.now() + BOOTSTRAP_LIFETIME_MS;
      if (typeof window.addEventListener === "function") {
        window.addEventListener("message", onCommand, false);
      }
      emitState("installed");
    } catch (_error) {
      noteFailure();
    }
  }

  install();
})();
