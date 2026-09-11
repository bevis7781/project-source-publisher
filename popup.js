/* Source Publisher — popup logic (current-chat multi-source v1).
   Vanilla JS only. All visible copy comes from the centralized COPY
   dictionary (English default, optional Simplified Chinese). The pure
   helpers are exported as SourcePublisherUi so the UI contract tests can
   evaluate them without a real extension environment.

    The popup derives exactly one product state (no user-facing setup steps):
     A NOT_IN_PROJECT     — active page is not a ChatGPT Project
     B NO_MARKDOWN        — newest assistant turn has no valid Markdown
     C MARKDOWN_AMBIGUOUS — more than one Markdown candidate (fail closed)
     D READY_FIRST_PUBLISH— one artifact, no completed binding
     E ONBOARDING_PENDING — persisted unfinished Publish intent
     F READY_BOUND        — bound Project + exactly one artifact
     G PUBLISHING/SYNCING/PUBLISHED/FAILED/INTERRUPTED — truthful job states
   Canonical Drive filename, Drive file ID, connection and binding machinery
   are implementation details and are never surfaced. */

(() => {
  "use strict";

  const LANG_KEY = "project100UiLanguage";
  const PROJECT100_MVP_BINDING_KEY = "project100MvpBinding";
  const PROJECT100_MVP_ONBOARDING_KEY = "project100MvpOnboardingState";

  const COPY = {
    en: {
      title: "Project Source Publisher",
      langAria: "Language",
      langEn: "EN",
      langZh: "中文",
      // Product states A–F.
      stateProject: "Open a ChatGPT Project to publish a source.",
       stateNoMarkdown: "No Markdown is currently discovered in the loaded, visible assistant messages.",
      stateAmbiguous: "Generate or keep one Markdown file to publish.",
       stateTooMany: "More than 10 Markdown files are currently discovered. Keep 10 or fewer to publish.",
       stateMultiCount: "{n} Markdown files",
       discoverySummary: "Currently discovered: {n} Markdown {files}.",
       markdownFile: "file",
       markdownFiles: "files",
       discoveryBoundary: "Only loaded, visible assistant messages are scanned. Scroll to load older messages, then Rescan. Files not shown may still exist.",
       rescan: "Rescan",
       rescanBusy: "Scanning…",
       rescanDone: "Scan updated.",
       rescanFailed: "Couldn't rescan. Try again.",
       stateReadyFirst: "First publish requires Google Drive and a one-time Project Source connection.",
      stateOnboarding: "Finishing the one-time Project Source connection…",
      stateOnboardingHint: "Add the source on the Sources page — publishing continues automatically.",
      differentProject: "This is a different ChatGPT Project. Open the bound Project's chat to publish.",
      valueProjectSource: "Project Source",
      readySub: "Ready to publish",
      publish: "Publish",
      retryPublish: "Retry Publish",
      continueConnection: "Continue connection",
      copyLink: "Copy Drive link",
      linkCopied: "Drive link copied.",
      linkCopyFailed: "Couldn't copy automatically. Use Copy Drive link, then continue.",
      publishing: "Publishing…",
       publishingMany: "Publishing {n} files…",
       publishIncomplete: "Publish incomplete. {saved} of {total} files were saved.",
       publishInterrupted: "Publishing was interrupted. Saved progress is kept. Retry to continue.",
       publishInterruptedPartial: "Publishing was interrupted after partial progress. Retry to continue.",
       savedUpdating: "Saved ✓\nUpdating Project Source…",
       savedConfirmationUnavailable: "Saved to Drive\nProject Source confirmation unavailable. ChatGPT may still be syncing it.",
       published: "Published ✓",
      publishedSecondary: "Project Source is up to date.",
      readyIdle: "Ready.",
       lastPublished: "Last published: {time}",
       sourceProgressTitle: "File progress",
       sourceProgressCount: "{saved} of {total} saved · {confirmed} confirmed",
       sourceQueued: "Waiting to start",
       sourceWorking: "In progress",
       sourceCapturing: "Capturing",
       sourceSaving: "Saving to Drive",
       sourceSaved: "Saved to Drive",
       sourceSyncing: "Updating Project Source",
       sourceSavedUnconfirmed: "Saved to Drive · confirmation unavailable",
       sourceConfirmationUnavailable: "Confirmation unavailable",
       sourcePublished: "Published",
       sourceFailed: "Failed · retry available",
       sourceInterrupted: "Interrupted · retry available",
       sourceUncertain: "Needs evidence check before retry",
       sourceUnknown: "Status unavailable",
      // Failure copy mapping (internal codes are never rendered).
      failCapture: "Couldn't capture the generated file.\nTry Publish again.",
       failDrive: "Couldn't update the Drive file.\nYour Project Source was not changed.",
       failDriveMutationUnverified: "Drive accepted an update, but PSP couldn't verify the saved result.\nProject Source synchronization was not confirmed. Retry to reconcile and continue.",
      failSourceMissing: "The bound Project Source couldn't be found.\nCheck setup and rebind it.",
      failSourceAmbiguous: "The bound Project Source couldn't be uniquely identified.\nCheck setup and rebind it.",
      failUnconfirmed: "Saved to Drive, but Project Source update couldn't be confirmed.",
      failSyncError: "The Project Source sync reported an error.\nYour file is saved in Drive. Try again.",
       failConnect: "Couldn't connect Google Drive. Try again.",
       failCreate: "Couldn't create project-source.md in Drive. Try again.",
       failCreateOutcomeUnknown: "Drive file creation couldn't be confirmed. No duplicate will be created. Retry later to check Drive and continue.",
       failBind: "Couldn't bind the Project Source.\nMake sure your Project's Sources page is the active tab, then try again.",
       failGeneric: "Publish failed. Try again.",
       failBinding: "Could not complete setup. Try again.",
       failRecoveryAmbiguous: "More than one existing Project Source file was found in Drive.\nResolve it in Drive, then try again.",
       failRecoveryIdentityMismatch: "The recovery record doesn't match this Project or Source. Publishing is paused. Open the original Project and confirm its binding before retrying.",
       failCaptureTabGone: "The Project chat tab is gone.\nReturn to your Project chat and publish again."
    },
    "zh-CN": {
      title: "Project Source Publisher",
      langAria: "语言",
      langEn: "EN",
      langZh: "中文",
      stateProject: "请打开一个 ChatGPT Project 再发布来源。",
       stateNoMarkdown: "在当前已加载且可见的 assistant 消息中，暂未发现 Markdown。",
      stateAmbiguous: "请只保留一个 Markdown 文件再发布。",
       stateTooMany: "当前已发现的 Markdown 超过 10 个。请保留 10 个或更少再发布。",
       stateMultiCount: "{n} 个 Markdown 文件",
       discoverySummary: "当前已发现：{n} 个 Markdown{files}。",
       markdownFile: "文件",
       markdownFiles: "文件",
       discoveryBoundary: "只扫描已加载且可见的 assistant 消息。请向上滚动加载更早消息，再点“重新扫描”。未显示的文件不代表不存在。",
       rescan: "重新扫描",
       rescanBusy: "正在扫描…",
       rescanDone: "扫描结果已更新。",
       rescanFailed: "无法重新扫描，请重试。",
       stateReadyFirst: "首次发布需要 Google Drive 和一次性 Project Source 连接。",
      stateOnboarding: "正在完成一次性 Project Source 连接…",
      stateOnboardingHint: "请在来源页面添加该来源——发布会自动继续。",
      differentProject: "这是另一个 ChatGPT Project。请打开已绑定 Project 的对话再发布。",
      valueProjectSource: "Project Source",
      readySub: "可以发布",
      publish: "发布",
      retryPublish: "重新发布",
      continueConnection: "继续连接",
      copyLink: "复制 Drive 链接",
      linkCopied: "已复制 Drive 链接。",
      linkCopyFailed: "无法自动复制。请使用“复制 Drive 链接”，然后继续。",
      publishing: "正在发布…",
       publishingMany: "正在发布 {n} 个文件…",
       publishIncomplete: "发布未完成。已保存 {saved}/{total} 个文件。",
       publishInterrupted: "发布被中断。已保存的进度仍在，请点击“重新发布”继续。",
       publishInterruptedPartial: "发布在部分完成后中断，请点击“重新发布”继续。",
       savedUpdating: "已保存 ✓\n正在更新 Project Source…",
       savedConfirmationUnavailable: "已保存到 Drive\n暂时无法确认 Project Source 状态，ChatGPT 可能仍在同步。",
       published: "已发布 ✓",
      publishedSecondary: "Project Source 已更新。",
      readyIdle: "就绪。",
       lastPublished: "上次发布：{time}",
       sourceProgressTitle: "文件进度",
       sourceProgressCount: "已保存 {saved}/{total} · 已确认 {confirmed}/{total}",
       sourceQueued: "等待开始",
       sourceWorking: "进行中",
       sourceCapturing: "正在捕获",
       sourceSaving: "正在保存到 Drive",
       sourceSaved: "已保存到 Drive",
       sourceSyncing: "正在更新 Project Source",
       sourceSavedUnconfirmed: "已保存到 Drive · 暂时无法确认",
       sourceConfirmationUnavailable: "暂时无法确认",
       sourcePublished: "已发布",
       sourceFailed: "失败 · 可重试",
       sourceInterrupted: "已中断 · 可重试",
       sourceUncertain: "重试前需要核对证据",
       sourceUnknown: "状态不可用",
      failCapture: "无法捕获生成的文件。\n请重试发布。",
       failDrive: "无法更新 Drive 文件。\n你的 Project Source 未被修改。",
       failDriveMutationUnverified: "Drive 已接受一次写入，但 PSP 无法验证最终保存结果。\nProject Source 同步尚未确认，请重试以核对并继续。",
      failSourceMissing: "找不到已绑定的 Project Source。\n请检查设置并重新绑定。",
      failSourceAmbiguous: "无法唯一确认已绑定的 Project Source。\n请检查设置并重新绑定。",
      failUnconfirmed: "已保存到 Drive，但无法确认 Project Source 更新。",
      failSyncError: "Project Source 同步报告了错误。\n文件已保存到 Drive，请重试。",
       failConnect: "无法连接 Google Drive，请重试。",
       failCreate: "无法在 Drive 中创建 project-source.md，请重试。",
       failCreateOutcomeUnknown: "无法确认 Drive 文件是否创建成功。不会重复创建，请稍后重试以核对并继续。",
       failBind: "无法绑定 Project Source。\n请确认 Project 来源页面为当前活动标签页后重试。",
       failGeneric: "发布失败，请重试。",
       failBinding: "设置未完成，请重试。",
       failRecoveryAmbiguous: "在 Drive 中找到多个已有的 Project Source 文件。\n请先在 Drive 中处理，然后重试。",
       failRecoveryIdentityMismatch: "待恢复记录与当前 Project 或来源不匹配，发布已暂停。请打开原 Project，确认绑定后再重试。",
       failCaptureTabGone: "Project 对话标签页已关闭。\n请回到 Project 对话后重新发布。"
    }
  };

  function normalizeLanguage(value) {
    return value === "zh-CN" ? "zh-CN" : "en";
  }

  function copy(lang) {
    return COPY[normalizeLanguage(lang)];
  }

  function sourceFilename(entry) {
    if (!entry || typeof entry !== "object") {
      return "";
    }
    return String(entry.filename || entry.logicalFilename || entry.fileName || entry.name || "");
  }

  function uniqueFilenames(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const filename = typeof value === "string" ? value : sourceFilename(value);
      if (!filename || seen.has(filename)) {
        continue;
      }
      seen.add(filename);
      result.push(filename);
    }
    return result;
  }

  function artifactFilenames(artifact) {
    if (!artifact || typeof artifact !== "object") {
      return [];
    }
    if (Array.isArray(artifact.filenames)) {
      return uniqueFilenames(artifact.filenames);
    }
    if (Array.isArray(artifact.sources)) {
      return uniqueFilenames(artifact.sources);
    }
    return artifact.filename ? [String(artifact.filename)] : [];
  }

  function artifactCount(artifact) {
    const names = artifactFilenames(artifact);
    const count = Number(artifact && artifact.count);
    if (Number.isFinite(count) && count >= 0) {
      return count;
    }
    return names.length;
  }

  function discoveryMeta(page, artifact) {
    const candidates = [
      page && page.discovery,
      page && page.scan,
      artifact && artifact.discovery,
      artifact && artifact.scan
    ];
    return candidates.find((value) => value && typeof value === "object") || {};
  }

  function firstFiniteNumber(values) {
    for (const value of values || []) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) {
        return number;
      }
    }
    return null;
  }

  // The content script intentionally reports only the DOM it can currently
  // see. This helper keeps that boundary explicit even when a future page
  // probe adds loaded-node metadata. It never turns an unknown count into a
  // claim that the whole conversation has been searched.
  function deriveDiscoveryView(page, lang) {
    const text = copy(lang);
    if (!page || !page.isProject) {
      return { visible: false, count: 0, filenames: [], limited: true };
    }
    const artifact = page.artifact || {};
    const metadata = discoveryMeta(page, artifact);
    const filenames = artifactFilenames(artifact);
    const count = artifactCount(artifact);
    const loadedAssistantNodes = firstFiniteNumber([
      metadata.loadedAssistantNodes,
      metadata.loadedAssistantTurns,
      metadata.visibleAssistantNodes,
      metadata.visibleAssistantTurns,
      metadata.assistantNodes
    ]);
    const hasMore = metadata.hasMore === true || metadata.moreAvailable === true ||
      metadata.truncated === true || metadata.partial === true || metadata.complete === false;
    const summary = text.discoverySummary
      .replace("{n}", String(count))
      .replace("{files}", count === 1 ? text.markdownFile : text.markdownFiles);
    return {
      visible: true,
      count,
      filenames,
      summary,
      boundary: text.discoveryBoundary,
      limited: true,
      hasMore,
      loadedAssistantNodes,
      scope: "current-chat-loaded-visible-assistant"
    };
  }

  // Multi-source v1 binding completeness: one bound Project, many logical
  // Sources, every entry carrying a stable Drive file ID.
  function bindingComplete(binding) {
    if (!binding) {
      return false;
    }
    if (binding.version === 2) {
      return Boolean(binding.sourcePageUrl &&
        Array.isArray(binding.sources) && binding.sources.length > 0 &&
        binding.sources.every((entry) => entry.driveFileId && sourceFilename(entry)));
    }
    return Boolean(binding.filename && binding.driveFileId && binding.sourcePageUrl);
  }

  function projectSegmentOfUrl(urlValue) {
    try {
      const url = new URL(String(urlValue || ""));
      // Same segment class as the production network-observer match pattern
      // (g-p- ids may contain hyphens).
      const match = url.pathname.match(/\/g\/(g-p-[A-Za-z0-9-]+)(?:\/|$|\?)/);
      return match ? match[1] : "";
    } catch (_error) {
      return "";
    }
  }

  // Product-state machine (multi-source v1). Inputs:
  //   page         — null | { isProject, projectSegment, artifact:{count, filename, filenames, invalid, error} }
  //   binding      — stored V2 Project binding or null
  //   onboarding   — persisted onboarding state or null
  //   publishState — persisted publish job state or null
  // Multi-source semantics: 0 sources -> B; 1 -> D/F with the filename;
  // 2–10 -> D/F with the count; ambiguous/invalid -> C; >10 -> T.
  function deriveProductState({ page, binding, onboarding, publishState } = {}) {
    const bound = bindingComplete(binding);
    const status = publishState && publishState.status;
    if (status === "publishing" || status === "syncing" ||
        status === "published" || status === "failed" || status === "interrupted") {
      return { state: "G", status };
    }
    if (status === "onboarding" ||
        (onboarding && !(bound && binding.sourcePageUrl))) {
      return { state: "E" };
    }
    if (!page || !page.isProject) {
      return { state: "A" };
    }
    const artifact = page.artifact || { count: 0, filename: "", filenames: [], invalid: 0, error: "" };
    const count = artifactCount(artifact);
    if (artifact.error === "TOO_MANY_MARKDOWN") {
      return { state: "T", count: artifact.count };
    }
    const ambiguous = artifact.error === "ARTIFACT_AMBIGUOUS" ||
      artifact.error === "ARTIFACT_FILENAME_INVALID" || (artifact.invalid || 0) > 0;
    if (bound) {
      // One-project v1: a different Project must never publish into the
      // bound Project.
      if (projectSegmentOfUrl(binding.sourcePageUrl) !== page.projectSegment) {
        return { state: "MISMATCH" };
      }
      if (ambiguous) {
        return { state: "C" };
      }
      if (count >= 1) {
        return {
          state: "F",
          filename: count === 1 ? (artifact.filename || artifactFilenames(artifact)[0] || "") : "",
          count
        };
      }
      return { state: "B" };
    }
    if (ambiguous) {
      return { state: "C" };
    }
    if (count >= 1) {
      return {
        state: "D",
        filename: count === 1 ? (artifact.filename || artifactFilenames(artifact)[0] || "") : "",
        count
      };
    }
    return { state: "B" };
  }

  // Failure copy mapping — the single source of user-facing failure text.
  // The service worker persists an internal `error` code (and an English
  // partialMessage for development logs); the popup NEVER renders either
  // verbatim. Everything shown here is short, actionable and localized.
  function mapFailureCopy(publishState, lang) {
    const text = copy(lang);
    const mutationAccepted = Boolean(publishState &&
      publishState.status === "failed" &&
      publishState.driveMutationAccepted === true);
    if (mutationAccepted) {
      // A successful Drive PATCH is a real side effect even when a later
      // identity/readback check fails. This must outrank generic DRIVE_* copy.
      return text.failDriveMutationUnverified;
    }
    if (isInitialCompletionUnprovenPostSave(publishState)) {
      return text.savedConfirmationUnavailable;
    }
    const errorCode = publishState && typeof publishState.error === "string"
      ? publishState.error
      : "";
    const postSave = Boolean(publishState && publishState.driveUpdated);

    // Post-Save failures: Drive already holds the newest bytes, so every
    // message in this group must keep that fact visible.
    const postSaveTable = {
      RECEIPT_SOURCE_NOT_FOUND: text.failSourceMissing,
      RECEIPT_SOURCE_AMBIGUOUS: text.failSourceAmbiguous,
      SOURCE_PAGE_NOT_READY: text.failSourceMissing,
      POST_SYNC_ERROR_STATE: text.failSyncError,
      PROJECT_SOURCE_SYNC_UNCONFIRMED: text.failUnconfirmed,
      BACKEND_RECEIPT_UNAVAILABLE: text.failUnconfirmed,
      RESYNC_FAILED: text.failUnconfirmed,
      RESYNC_NOT_RESPONDING: text.failUnconfirmed,
      RECEIPT_NOT_RESPONDING: text.failUnconfirmed,
      POST_SYNC_SETTLE_TIMEOUT: text.failUnconfirmed,
      SYNC_STATE_UNCHANGED: text.failUnconfirmed
    };
    if (postSaveTable[errorCode]) {
      return postSaveTable[errorCode];
    }

    // Multi-source v1 pre-Save codes.
    if (errorCode === "NO_MARKDOWN") {
      return text.stateNoMarkdown;
    }
    if (errorCode === "MARKDOWN_AMBIGUOUS" || errorCode === "ARTIFACT_AMBIGUOUS") {
      return text.stateAmbiguous;
    }
    if (errorCode === "ARTIFACT_FILENAME_INVALID") {
      return text.failCapture;
    }
    if (errorCode === "TOO_MANY_MARKDOWN") {
      return text.stateTooMany;
    }
    if (errorCode === "PUBLISH_INCOMPLETE") {
      const saved = Number(publishState && (publishState.filesSaved ?? publishState.savedCount)) || 0;
      const total = Number(publishState && (publishState.fileCount ?? publishState.totalFiles)) || 0;
      return text.publishIncomplete
        .replace("{saved}", String(saved))
        .replace("{total}", String(total));
    }
    if (errorCode === "PUBLISH_INTERRUPTED" || errorCode === "WORKER_RESTARTED" ||
        errorCode === "PUBLISH_RECOVERY_INTERRUPTED") {
      const saved = Number(publishState && (publishState.filesSaved ?? publishState.savedCount)) || 0;
      return saved > 0 ? text.publishInterruptedPartial : text.publishInterrupted;
    }
    if (errorCode === "RESYNC_REQUIRES_EVIDENCE" || errorCode === "RESYNC_EVIDENCE_REQUIRED") {
      return text.sourceUncertain;
    }
    if (errorCode === "ARTIFACT_SET_CHANGED") {
      return text.failCapture;
    }
    if (errorCode === "NOT_IN_PROJECT") {
      return text.stateProject;
    }
    if (errorCode === "PROJECT_MISMATCH") {
      return text.differentProject;
    }
    if (errorCode === "CAPTURE_TAB_GONE") {
      return text.failCaptureTabGone;
    }
    if (errorCode === "CANONICAL_RECOVERY_AMBIGUOUS") {
      return text.failRecoveryAmbiguous;
    }
    if (errorCode === "SOURCE_CREATE_OUTCOME_UNKNOWN") {
      return text.failCreateOutcomeUnknown;
    }
    if (errorCode === "RECOVERY_IDENTITY_MISMATCH") {
      return text.failRecoveryIdentityMismatch;
    }
    if (errorCode === "ONBOARDING_OAUTH_FAILED") {
      return text.failConnect;
    }
    if (/^ONBOARDING_/.test(errorCode)) {
      return text.failBinding;
    }

    // Pre-Save failures.
    if (/^DRIVE_/.test(errorCode)) {
      return text.failDrive;
    }
    if (/ARTIFACT|CAPTURE/.test(errorCode)) {
      return text.failCapture;
    }
    if (/NO_BINDING|SOURCE_NOT_BOUND/.test(errorCode)) {
      return text.failSourceMissing;
    }
    return postSave ? text.failUnconfirmed : text.failGeneric;
  }

  // First Add can finish the Drive write while the observable connector
  // receipt remains unavailable. The service worker intentionally keeps its
  // fail-closed terminal state, so the popup must recognize this one exact
  // combination as a neutral, non-retryable user-facing outcome. Other
  // post-save errors (including explicit sync errors and identity failures)
  // remain failures.
  function isInitialCompletionUnprovenPostSave(publishState) {
    if (!publishState || typeof publishState !== "object") {
      return false;
    }
    if (publishState.status !== "failed" ||
        publishState.error !== "INITIAL_COMPLETION_UNPROVEN" ||
        publishState.driveUpdated !== true) {
      return false;
    }
    const lifecycleState = String(publishState.lifecycleState || "");
    const transaction = String(publishState.transaction || "");
    return (lifecycleState === "INITIALIZING" && transaction === "INITIALIZATION") ||
      (!lifecycleState && !transaction);
  }

  function sourceEntryHasExplicitFailure(entry) {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const raw = String(entry.status || entry.state || entry.phase || entry.progressState || "")
      .trim().toLowerCase().replace(/[\s_-]+/g, "");
    return Boolean(entry.error) || raw.includes("fail") || raw.includes("error");
  }

  function sourceEntryIsSaved(entry) {
    return Boolean(entry && typeof entry === "object" &&
      (entry.saved === true || entry.driveUpdated === true || entry.written === true));
  }

  function rawSourceEntries(publishState) {
    if (!publishState || typeof publishState !== "object") {
      return [];
    }
    return Array.isArray(publishState.perSource) ? publishState.perSource : [];
  }

  function publishFilenames(publishState) {
    if (!publishState || typeof publishState !== "object") {
      return [];
    }
    return Array.isArray(publishState.filenames)
      ? uniqueFilenames(publishState.filenames)
      : [];
  }

  function sourceStatusKey(entry, publishStatus) {
    if (!entry || typeof entry !== "object") {
      return "unknown";
    }
    const resyncStatus = String(entry.resyncStatus || entry.recoveryState || "")
      .trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (entry.uncertain === true || entry.evidenceRequired === true ||
        ["uncertain", "unknownafterrestart", "clickpending", "clickinflight", "observing"]
          .includes(resyncStatus)) {
      return "uncertain";
    }
    const raw = String(entry.status || entry.state || entry.phase || entry.progressState || "")
      .trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (entry.error || raw.includes("fail") || raw.includes("error")) {
      return "failed";
    }
    // "publishing" contains "publish", but it is still in progress. Use
    // exact terminal tokens only: `incomplete`, `unconfirmed` and
    // `unpublished` must never become Published by substring matching.
    if (raw.includes("incomplete") || raw.includes("unconfirm") || raw.includes("unpublish")) {
      return raw.includes("unconfirm") ? "uncertain" : "unknown";
    }
    const terminalStatuses = new Set([
      "published", "synced", "resynced", "confirmed",
      "sourcepublished", "publishcomplete", "synccomplete", "resynccomplete"
    ]);
    if (entry.synced === true || entry.resynced === true || terminalStatuses.has(raw)) {
      return "published";
    }
    if (entry.interrupted === true || entry.recoveryState === "interrupted" ||
        raw.includes("interrupt") || raw.includes("restart")) {
      return "interrupted";
    }
    if (raw.includes("uncertain") || raw.includes("evidence")) {
      return "uncertain";
    }
    // The coordinator's terminal batch state is evidence for a target record
    // that carries no contradictory per-source phase. A named phase still
    // needs its own exact/authoritative evidence.
    if (publishStatus === "published" && !raw) {
      return "published";
    }
    if (raw.includes("sync") || raw.includes("resync") || raw.includes("observ")) {
      return "syncing";
    }
    if (raw.includes("publish")) {
      return "working";
    }
    if (raw.includes("captur") || raw.includes("download")) {
      return "capturing";
    }
    if (raw.includes("save") || raw.includes("patch") || raw.includes("drive") ||
        entry.written === true || entry.driveUpdated === true) {
      return entry.saved === true ? "saved" : "saving";
    }
    if (entry.saved === true) {
      return "saved";
    }
    if (raw.includes("queue") || raw.includes("wait") || raw.includes("pending")) {
      return "queued";
    }
    if (publishStatus === "published") {
      return "published";
    }
    if (publishStatus === "interrupted") {
      return "interrupted";
    }
    if (publishStatus === "failed") {
      return "failed";
    }
    return (publishStatus === "publishing" || publishStatus === "syncing")
      ? "working" : "unknown";
  }

  function sourceStatusText(statusKey, text) {
    const table = {
      queued: text.sourceQueued,
      working: text.sourceWorking,
      capturing: text.sourceCapturing,
      saving: text.sourceSaving,
      saved: text.sourceSaved,
      "saved-unconfirmed": text.sourceSavedUnconfirmed,
      "confirmation-unavailable": text.sourceConfirmationUnavailable,
      syncing: text.sourceSyncing,
      published: text.sourcePublished,
      failed: text.sourceFailed,
      interrupted: text.sourceInterrupted,
      uncertain: text.sourceUncertain,
      unknown: text.sourceUnknown
    };
    return table[statusKey] || text.sourceUnknown;
  }

  function sourceStatusTone(statusKey) {
    if (statusKey === "published") {
      return "ok";
    }
    if (statusKey === "failed" || statusKey === "interrupted" || statusKey === "uncertain") {
      return "error";
    }
    if (statusKey === "working" || statusKey === "capturing" || statusKey === "saving" ||
        statusKey === "saved" || statusKey === "saved-unconfirmed" || statusKey === "syncing") {
      return "busy";
    }
    return "idle";
  }

  // Normalize the recovery-owned progress records into a UI-only shape. The
  // popup deliberately keeps IDs and diagnostics out of the DOM; only exact
  // logical filenames and localized status labels are returned.
  function deriveSourceProgress(publishState, page, binding, lang) {
    const text = copy(lang);
    if (!publishState || typeof publishState !== "object") {
      return { visible: false, rows: [], saved: 0, confirmed: 0, total: 0 };
    }
    // Progress belongs to this persisted publish batch only. The current page
    // and the complete binding can contain sources outside the job, so neither
    // may expand the list or manufacture a terminal status for a new file.
    const entries = rawSourceEntries(publishState);
    const names = publishFilenames(publishState);
    const orderedNames = uniqueFilenames(names);
    const declaredFileCount = Number(publishState.fileCount ?? publishState.totalFiles) || 0;
    const singleFileDriveSaved = isInitialCompletionUnprovenPostSave(publishState) &&
      Boolean(publishState.driveUpdated) && entries.length === 1 &&
      (declaredFileCount === 0 || declaredFileCount === 1) &&
      Boolean(sourceFilename(entries[0])) && !sourceEntryHasExplicitFailure(entries[0]);
    const rowsByName = new Map();
    const rows = [];
    for (const entry of entries) {
      const filename = sourceFilename(entry);
      if (!filename || rowsByName.has(filename)) {
        continue;
      }
      const entrySaved = sourceEntryIsSaved(entry);
      const savedBySingleFileDriveEvidence = singleFileDriveSaved;
      let status = sourceStatusKey(entry, publishState.status);
      if (isInitialCompletionUnprovenPostSave(publishState) &&
          !sourceEntryHasExplicitFailure(entry)) {
        status = entrySaved || savedBySingleFileDriveEvidence
          ? "saved-unconfirmed"
          : "confirmation-unavailable";
      }
      const row = {
        filename,
        status,
        statusText: sourceStatusText(status, text),
        tone: sourceStatusTone(status),
        saved: entrySaved || savedBySingleFileDriveEvidence,
        confirmed: status === "published"
      };
      rowsByName.set(filename, row);
      rows.push(row);
    }
    for (const filename of orderedNames) {
      if (rowsByName.has(filename)) {
        continue;
      }
      const status = isInitialCompletionUnprovenPostSave(publishState)
        ? "confirmation-unavailable"
        : sourceStatusKey(null, publishState.status);
      const row = {
        filename,
        status,
        statusText: sourceStatusText(status, text),
        tone: sourceStatusTone(status),
        saved: false,
        confirmed: status === "published"
      };
      rows.push(row);
      rowsByName.set(filename, row);
    }
    const total = Math.max(
      rows.length,
      Number(publishState.fileCount ?? publishState.totalFiles) || 0
    );
    const savedFromRows = rows.filter((row) => row.saved).length;
    const confirmed = rows.filter((row) => row.confirmed).length;
    const saved = Math.max(
      savedFromRows,
      Number(publishState.filesSaved ?? publishState.savedCount) || 0
    );
    return {
      visible: rows.length > 0,
      rows,
      saved,
      confirmed,
      total,
      countText: text.sourceProgressCount
        .replaceAll("{saved}", String(saved))
        .replaceAll("{total}", String(total))
        .replaceAll("{confirmed}", String(confirmed))
    };
  }

  function deriveStatusView(publishState, lang) {
    const text = copy(lang);
    const status = publishState && publishState.status;
    if (!status) {
      return { primary: text.readyIdle, tone: "idle", retry: false };
    }
    if (status === "publishing") {
      const progress = deriveSourceProgress(publishState, null, null, lang);
      const fileCount = Number(publishState && (publishState.fileCount ?? publishState.totalFiles)) ||
        progress.total;
      return {
        primary: fileCount > 1
          ? text.publishingMany.replace("{n}", String(fileCount))
          : text.publishing,
        tone: "busy",
        retry: false,
        progress
      };
    }
    if (status === "syncing") {
      const progress = deriveSourceProgress(publishState, null, null, lang);
      return { primary: text.savedUpdating, tone: "busy", retry: false, progress };
    }
    if (isInitialCompletionUnprovenPostSave(publishState)) {
      return {
        primary: text.savedConfirmationUnavailable,
        tone: "busy",
        retry: false,
        progress: deriveSourceProgress(publishState, null, null, lang)
      };
    }
    if (status === "published") {
      // P1 text-density fix: with a single confirmed source the receipt
      // ("Published ✓") plus the Last published footer are already the
      // completion statement, so the secondary sentence is dropped. The
      // multi-source aggregate completion sentence is retained (it is the
      // only aggregate fact there). The status row keeps its min-height
      // placeholder, so the layout geometry stays stable.
      const progress = deriveSourceProgress(publishState, null, null, lang);
      const singleFilePublished = progress.total === 1;
      return {
        primary: text.published,
        secondary: singleFilePublished ? "" : text.publishedSecondary,
        tone: "ok",
        retry: false,
        // Regression fix: the render-layer truthfulness guard reads
        // view.progress to keep the busy Saved/Updating presentation (and
        // withhold the overall Published receipt) until every source in the
        // batch is confirmed — the computed progress must stay on the view.
        progress
      };
    }
    if (status === "onboarding") {
      return { primary: text.stateOnboarding, tone: "idle", retry: false };
    }
    if (status === "interrupted") {
      const progress = deriveSourceProgress(publishState, null, null, lang);
      const saved = Number(publishState && (publishState.filesSaved ?? publishState.savedCount)) ||
        progress.saved;
      const identityMismatch = publishState &&
        publishState.error === "RECOVERY_IDENTITY_MISMATCH";
      return {
        primary: identityMismatch
          ? mapFailureCopy(publishState, lang)
          : (saved > 0 ? text.publishInterruptedPartial : text.publishInterrupted),
        tone: "error",
        retry: true,
        progress
      };
    }
    if (status !== "failed") {
      return {
        primary: text.sourceUnknown,
        tone: "error",
        retry: true,
        progress: deriveSourceProgress(publishState, null, null, lang)
      };
    }
    // failed — always the localized mapped copy; internal error codes and
    // diagnostic metadata are never rendered.
    return {
      primary: mapFailureCopy(publishState, lang),
      tone: "error",
      retry: true,
      progress: deriveSourceProgress(publishState, null, null, lang)
    };
  }

  function localizeDateTime(isoValue, lang) {
    try {
      const date = new Date(isoValue);
      if (Number.isNaN(date.getTime())) {
        return String(isoValue || "");
      }
      return date.toLocaleString(normalizeLanguage(lang) === "zh-CN" ? "zh-CN" : "en-US");
    } catch (_error) {
      return String(isoValue || "");
    }
  }

  const SourcePublisherUi = {
    LANG_KEY,
    PROJECT100_MVP_BINDING_KEY,
    PROJECT100_MVP_ONBOARDING_KEY,
    COPY,
    normalizeLanguage,
    copy,
    sourceFilename,
    artifactFilenames,
    artifactCount,
    deriveDiscoveryView,
    bindingComplete,
    projectSegmentOfUrl,
    deriveProductState,
    deriveStatusView,
    sourceStatusKey,
    deriveSourceProgress,
    mapFailureCopy,
    isInitialCompletionUnprovenPostSave,
    localizeDateTime
  };
  if (typeof globalThis !== "undefined") {
    globalThis.SourcePublisherUi = SourcePublisherUi;
  }

  // ---- DOM layer (extension popup only) ------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  let lang = "en";
  let binding = null;
  let onboarding = null;
  let publishState = null;
  let page = null;
  let currentProjectId = "";
  let publishPollTimer = 0;
  let pageRefreshTimer = 0;
  let busy = false;
  let rescanBusy = false;

  function text(id, value) {
    const element = $(id);
    if (element) {
      element.textContent = value;
    }
  }

  function setHidden(id, value) {
    const element = $(id);
    if (element) {
      element.hidden = Boolean(value);
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function applyLanguage() {
    const t = copy(lang);
    document.documentElement.setAttribute("lang", lang === "zh-CN" ? "zh-CN" : "en");
    text("app-title", t.title);
    $("publish").textContent = t.publish;
    $("continue-connection").textContent = t.continueConnection;
    $("copy-drive-link").textContent = t.copyLink;
    text("fallback-note", t.copyAutoFailedNote);
    text("rescan", rescanBusy ? t.rescanBusy : t.rescan);
    text("discovery-boundary", t.discoveryBoundary);
    $("info-dot").setAttribute("aria-label", t.discoveryBoundary);
    text("source-progress-title", t.sourceProgressTitle);
    const enPressed = lang !== "zh-CN";
    // LIVE REGRESSION 2026-09-06 (P1): the language buttons shipped empty —
    // applyLanguage set only aria-pressed, so EN / 中文 were clickable but
    // had no text in light AND dark mode. Their labels come from COPY
    // (langEn/langZh) and must be set on every language application.
    $("lang-en").textContent = t.langEn;
    $("lang-zh").textContent = t.langZh;
    $("lang-en").setAttribute("aria-pressed", enPressed ? "true" : "false");
    $("lang-zh").setAttribute("aria-pressed", enPressed ? "false" : "true");
    $("lang-switch").setAttribute("aria-label", t.langAria);
  }

  function publishJobRunning() {
    return Boolean(publishState &&
      (publishState.status === "publishing" || publishState.status === "syncing"));
  }

  function onboardingPending() {
    const derived = deriveProductState({ page, binding, onboarding, publishState });
    return derived.state === "E";
  }

  // ---- K3 "Quiet Ink" rendering primitives ---------------------------------
  // Action zone: one fixed 44px slot shared by four faces (Publish button,
  // Continue connection, live surface, receipt surface). Only the active
  // face is visible and focusable; faces crossfade via the .on class where a
  // real rendering DOM exists, and settle synchronously in test stubs.

  const FACE_IDS = ["publish", "continue-connection", "live-surface", "receipt-surface"];
  let activeFace = null;

  function setFace(nextId) {
    activeFace = nextId;
    for (const id of FACE_IDS) {
      const element = $(id);
      if (!element) {
        continue;
      }
      if (id === nextId) {
        element.hidden = false;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            if (activeFace === id) {
              element.classList.add("on");
            }
          });
        } else {
          element.classList.add("on");
        }
      } else {
        element.classList.remove("on");
        if (element.hidden) {
          continue;
        }
        if (typeof requestAnimationFrame === "function") {
          // Real DOM: keep the outgoing face in the tree just long enough to
          // fade it out. The delayed hide is cancelled by a state flip.
          setTimeout(() => {
            if (activeFace !== id) {
              element.hidden = true;
            }
          }, 300);
        } else {
          element.hidden = true;
        }
      }
    }
  }

  function flowSet({ live = false, indet = false, done = false, pct = null } = {}) {
    const flow = $("flow");
    const fill = $("flow-fill");
    flow.classList.toggle("live", Boolean(live));
    flow.classList.toggle("indet", Boolean(live && indet));
    flow.classList.toggle("done", Boolean(live && done));
    if (live && indet) {
      fill.style.width = "";
    } else if (live && pct != null) {
      fill.style.width = pct + "%";
    } else if (!live) {
      fill.style.width = "0%";
    }
  }

  function renderStatus({ lead = "", second = "", tone = "", live = false } = {}) {
    const root = $("publish-status");
    root.classList.toggle("ok", tone === "ok");
    root.classList.toggle("error", tone === "error");
    root.classList.toggle("busy", tone === "busy");
    root.classList.toggle("neutral", tone === "neutral");
    const leadElement = $("status-lead");
    const secondElement = $("status-second");
    leadElement.textContent = lead || "";
    if (second) {
      secondElement.hidden = false;
      secondElement.textContent = second;
    } else {
      secondElement.hidden = true;
      secondElement.textContent = "";
    }
    setHidden("status-dots", !live);
  }

  function splitLines(value) {
    const lines = String(value == null ? "" : value).split("\n");
    return [lines[0] || "", lines.slice(1).join("\n")];
  }

  // Per-file lifecycle glyphs (DESIGN_SPEC §7.2): queued ring, half-arc
  // spinner, drawn check, fail dot, amber pause, breathing dot.
  const GLYPH_MARKUP = {
    queued: '<span class="g-queued"></span>',
    half: '<span class="g-half"></span>',
    check: '<svg class="g-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6 6.6 12 12.8 4.6"/></svg>',
    fail: '<span class="g-fail"></span>',
    pause: '<span class="g-pause"></span>',
    dot: '<span class="g-dot"></span>'
  };

  function rowStageClass(status) {
    if (status === "published" || status === "saved") {
      return "check";
    }
    if (status === "failed") {
      return "fail";
    }
    if (status === "interrupted") {
      return "pause";
    }
    if (status === "saved-unconfirmed" || status === "confirmation-unavailable" ||
        status === "uncertain") {
      return "dot";
    }
    if (status === "working" || status === "capturing" || status === "saving" ||
        status === "syncing") {
      return "half";
    }
    return "queued";
  }

  function rowTextClass(status) {
    if (status === "published" || status === "saved") {
      return "ok";
    }
    if (status === "failed") {
      return "error";
    }
    if (status === "interrupted" || status === "working" || status === "capturing" ||
        status === "saving" || status === "syncing") {
      return "live";
    }
    return "";
  }

  // Hairline total progress = mean of per-file stage fractions (§10).
  const STAGE_FRACTION = {
    queued: 0, unknown: 0, working: 0.18, capturing: 0.18, saving: 0.4,
    saved: 0.6, "saved-unconfirmed": 0.7, "confirmation-unavailable": 0.7,
    syncing: 0.8, published: 1, failed: 0.6, interrupted: 0.4, uncertain: 0.7
  };

  function progressFraction(progress) {
    if (!progress || !progress.visible || !progress.rows || progress.rows.length === 0) {
      return null;
    }
    const sum = progress.rows.reduce(
      (acc, row) => acc + (STAGE_FRACTION[row.status] != null ? STAGE_FRACTION[row.status] : 0), 0);
    return Math.round((sum / progress.rows.length) * 100);
  }

  function publishHeroIdentity(t) {
    const names = publishFilenames(publishState);
    const declared = Number(publishState && (publishState.fileCount ?? publishState.totalFiles)) || 0;
    const count = declared || names.length;
    if (count > 1) {
      return t.stateMultiCount.replace("{n}", String(count));
    }
    if (names.length > 0) {
      return names[0];
    }
    return "";
  }

  // ---- product rendering ----------------------------------------------------

  function renderPublishControls() {
    const t = copy(lang);
    const derived = deriveProductState({ page, binding, onboarding, publishState });
    let view = deriveStatusView(publishState, lang);
    const jobRunning = publishJobRunning();
    const isJob = derived.state === "G";
    const confirmationUnavailable = isInitialCompletionUnprovenPostSave(publishState);

    renderDiscovery();
    renderSourceProgress();

    // Truthfulness guard: the overall Published receipt may appear only once
    // every file in the batch is confirmed. If the persisted state ever said
    // "published" while per-file evidence lags, keep the busy flow instead of
    // showing a premature receipt (fail closed, never lie early).
    const progress = view.progress || null;
    if (publishState && publishState.status === "published" && progress &&
        progress.rows.length > 0 && progress.confirmed < progress.total) {
      view = { primary: t.savedUpdating, tone: "busy", retry: false, progress };
    }

    // ---- hero: artifact identity or fail-closed guidance ----
    const nameRow = $("hero-name-row");
    const glyphEl = $("hero-glyph");
    const filenameEl = $("state-filename");
    const subEl = $("state-sub");
    const guidanceEl = $("state-guidance");
    let heroName = "";
    let heroSub = "";
    let guidance = "";
    let showGlyph = true;
    if (derived.state === "D" || derived.state === "F") {
      const count = Number(derived.count) || 0;
      heroName = count > 1
        ? t.stateMultiCount.replace("{n}", String(count))
        : (derived.filename || "");
      // P1 text-density fix: Bound Ready (F) is fully expressed by the real
      // filename/count plus the usable Publish button — the constant
      // "Ready to publish" subtext is redundant. Ready-first (D) keeps its
      // contractual first-publish explanation.
      heroSub = derived.state === "D" ? t.stateReadyFirst : "";
    } else if (derived.state === "E") {
      heroName = t.valueProjectSource;
      heroSub = t.stateOnboardingHint;
      showGlyph = false;
    } else if (isJob) {
      heroName = publishHeroIdentity(t);
    } else if (derived.state === "A") {
      guidance = t.stateProject;
    } else if (derived.state === "B") {
      guidance = t.stateNoMarkdown;
    } else if (derived.state === "C") {
      guidance = t.stateAmbiguous;
    } else if (derived.state === "T") {
      guidance = t.stateTooMany;
    } else if (derived.state === "MISMATCH") {
      guidance = t.differentProject;
    }
    if (guidance) {
      nameRow.hidden = true;
      filenameEl.textContent = "";
      subEl.hidden = true;
      subEl.textContent = "";
      guidanceEl.hidden = false;
      guidanceEl.textContent = guidance;
    } else if (heroName) {
      nameRow.hidden = false;
      filenameEl.textContent = heroName;
      glyphEl.hidden = !showGlyph;
      subEl.hidden = !heroSub;
      subEl.textContent = heroSub;
      guidanceEl.hidden = true;
      guidanceEl.textContent = "";
    } else {
      nameRow.hidden = true;
      filenameEl.textContent = "";
      subEl.hidden = true;
      subEl.textContent = "";
      guidanceEl.hidden = true;
      guidanceEl.textContent = "";
    }

    // ---- action zone face ----
    let face = null;
    if (isJob && confirmationUnavailable) {
      face = "receipt-neutral";
    } else if (isJob && publishState.status === "published" && view.tone === "ok") {
      face = "receipt";
    } else if (isJob && (publishState.status === "publishing" ||
        publishState.status === "syncing" || publishState.status === "published")) {
      face = "live";
    } else if (isJob) {
      face = "publish"; // Retry Publish — the only Publish affordance left
    } else if (derived.state === "E") {
      face = "continue";
    } else if (derived.state === "D" || derived.state === "F") {
      face = "publish";
    }

    if (face === "publish") {
      const publishButton = $("publish");
      publishButton.textContent = (view.retry ||
        (publishState && publishState.status === "failed" && !confirmationUnavailable))
        ? t.retryPublish
        : t.publish;
      publishButton.disabled = busy || jobRunning || rescanBusy;
      setFace("publish");
    } else if (face === "continue") {
      $("continue-connection").disabled = busy;
      setFace("continue-connection");
    } else if (face === "live") {
      const savedFace = publishState.status !== "publishing";
      setHidden("live-spin", savedFace);
      setHidden("live-check", !savedFace);
      const lines = splitLines(view.primary);
      $("live-label").textContent = savedFace ? lines[0] : view.primary;
      setFace("live-surface");
    } else if (face === "receipt" || face === "receipt-neutral") {
      const surface = $("receipt-surface");
      surface.classList.toggle("ok", face === "receipt");
      surface.classList.toggle("neutral", face === "receipt-neutral");
      setHidden("receipt-check", face !== "receipt");
      setHidden("receipt-dots", face === "receipt");
      $("receipt-label").textContent = face === "receipt"
        ? view.primary
        : splitLines(view.primary)[0];
      setFace("receipt-surface");
    } else {
      setFace(null);
    }

    // Fallback Copy: reachable only while onboarding is pending AND a Drive
    // link exists to copy — a failure fallback, never a setup step.
    const fallbackVisible = derived.state === "E" &&
      Boolean(onboarding && onboarding.driveUrl);
    setHidden("fallback-row", !fallbackVisible);
    setHidden("copy-drive-link", !fallbackVisible);

    // ---- flow strip + status line ----
    let flowVisible = Boolean(face);
    let flowState = { live: false };
    let status = { lead: "", second: "", tone: "", live: false };
    if (derived.state === "E") {
      flowState = { live: true, indet: true };
      status = { lead: t.stateOnboarding, tone: "", live: true };
    } else if (isJob) {
      const rows = progress && Array.isArray(progress.rows) ? progress.rows : [];
      const pct = progressFraction(progress);
      if (publishState.status === "publishing") {
        flowState = rows.length > 0 ? { live: true, pct } : { live: true, indet: true };
        const activeStages = ["capturing", "saving", "syncing", "working"];
        status = { lead: "", tone: "", live: true };
        if (rows.length === 1 && activeStages.includes(rows[0].status)) {
          status.lead = rows[0].statusText;
        }
      } else if (publishState.status === "syncing" ||
          (publishState.status === "published" && view.tone === "busy")) {
        flowState = { live: true, pct: pct != null ? pct : 70 };
        const lines = splitLines(view.primary);
        status = { lead: lines[1] || lines[0], tone: "busy", live: true };
      } else if (publishState.status === "published") {
        flowState = { live: true, done: true, pct: 100 };
        // P1: single-source Published clears the secondary sentence; the
        // empty lead keeps the reserved min-height, geometry unchanged.
        status = { lead: view.secondary || "", tone: "", live: false };
      } else if (confirmationUnavailable) {
        // Neutral terminal state: saved to Drive, completion unprovable.
        // Never rendered as an error, never retryable (fail-closed truth).
        const lines = splitLines(view.primary);
        flowState = { live: false };
        status = { lead: lines[1] || lines[0], tone: "neutral", live: false };
      } else {
        // failed / interrupted / unknown — truthful error, retry available
        const lines = splitLines(view.primary);
        flowState = publishState.status === "interrupted" && pct != null
          ? { live: true, pct }
          : { live: false };
        status = { lead: lines[0], second: lines[1] || "", tone: "error", live: false };
      }
    }
    setHidden("flow", !flowVisible);
    if (flowVisible) {
      flowSet(flowState);
    }
    renderStatus(status);

    // ---- footer ----
    $("last-published").textContent =
      (publishState && publishState.publishedAt)
        ? t.lastPublished.replace(
          "{time}",
          localizeDateTime(publishState.publishedAt, lang))
        : "";
  }

  function render() {
    renderPublishControls();
  }

  function renderDiscovery() {
    const view = deriveDiscoveryView(page, lang);
    // P1 text-density fix: while a publish job is running (Publishing /
    // Saved-Updating) the whole discovery row is hidden — the contract allows
    // this for running states, Rescan is already disabled there, and the row
    // is pure noise (and a "1 vs N" contradiction with the running batch).
    // It returns normally as soon as the running phase ends (any terminal
    // state, including failed / interrupted). Rescan semantics and discovery
    // logic are untouched.
    const jobRunning = publishJobRunning();
    setHidden("discovery-view", !view.visible || jobRunning);
    const button = $("rescan");
    button.textContent = rescanBusy ? copy(lang).rescanBusy : copy(lang).rescan;
    button.disabled = rescanBusy || busy || jobRunning;
    if (!view.visible) {
      text("discovery-summary", "");
      return;
    }
    // P1 text-density fix: for a normal (non-fail-closed) single-source
    // state the count line duplicates the hero filename verbatim, so only
    // the quiet Rescan + ⓘ affordance remains. Fail-closed states (No
    // Markdown / Ambiguous / Too Many) keep their full discovery facts —
    // there the discovered count IS the primary fact. Multi-source counts
    // remain.
    const derived = deriveProductState({ page, binding, onboarding, publishState });
    const failClosedDiscovery = derived.state === "B" || derived.state === "C" ||
      derived.state === "T";
    const quietSingleSource = view.count === 1 && !failClosedDiscovery;
    text("discovery-summary", view.summary);
    setHidden("discovery-summary", quietSingleSource);
    setHidden("discovery-sep", quietSingleSource);
    button.setAttribute("aria-label", copy(lang).rescan);
  }

  let lastProgressMarkup = null;

  function renderSourceProgress() {
    const view = deriveSourceProgress(publishState, page, binding, lang);
    // P1 text-density fix: a single-file batch is fully expressed by the hero
    // filename + live/receipt surface + status line, so the per-file card is
    // visually suppressed HERE — in the display layer only. The semantic
    // deriveSourceProgress contract is untouched: its rows / saved / confirmed
    // / total data still drive the hairline progress math and the truthful
    // Published guard, and the rendered content stays populated for evidence
    // parity (the section is merely hidden).
    const displayVisible = view.visible && view.rows.length !== 1;
    setHidden("source-progress-view", !displayVisible);
    const list = $("source-progress-list");
    const count = $("source-progress-count");
    if (!view.visible) {
      list.textContent = "";
      list.innerHTML = "";
      count.textContent = "";
      lastProgressMarkup = null;
      return;
    }
    count.textContent = view.countText || "";
    const markup = view.rows.map((row) => {
      const stage = rowStageClass(row.status);
      const dim = stage === "queued" ? " dim" : "";
      return `<li class="pitem${dim}">` +
        `<span class="pglyph">${GLYPH_MARKUP[stage]}</span>` +
        `<span class="pname">${escapeHtml(row.filename)}</span>` +
        `<span class="pstat ${rowTextClass(row.status)}">${escapeHtml(row.statusText)}</span>` +
        `</li>`;
    }).join("");
    // Skip DOM writes when nothing changed: rebuilding identical rows would
    // restart the glyph animations on every 2s poll.
    if (markup === lastProgressMarkup) {
      return;
    }
    lastProgressMarkup = markup;
    // Setting textContent first keeps the VM contract harness useful; assigning
    // innerHTML then gives the real popup semantic per-file rows.
    list.textContent = view.rows.map((row) => `${row.filename}: ${row.statusText}`).join("\n");
    list.innerHTML = markup;
  }

  let gstatusTimer = 0;

  function setGlobalStatus(value, isError) {
    const element = $("global-status");
    element.textContent = value;
    element.classList.toggle("error", Boolean(isError));
    element.classList.remove("fade");
    if (gstatusTimer) {
      clearTimeout(gstatusTimer);
    }
    // Transient feedback: fades out after 2.4s (DESIGN_SPEC §7.4). The text
    // itself stays in the live region — only its opacity drops.
    gstatusTimer = setTimeout(() => element.classList.add("fade"), 2400);
  }

  async function runtimeMessage(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result) {
      throw new Error("EMPTY_EXTENSION_RESPONSE");
    }
    if (result.status !== "PASS") {
      throw new Error(result.error || "OPERATION_BLOCKED");
    }
    return result;
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || typeof tab.id !== "number") {
      throw new Error("ACTIVE_TAB_NOT_FOUND");
    }
    return tab;
  }

  async function refreshBinding() {
    if (!currentProjectId) {
      binding = null;
      return;
    }
    const result = await runtimeMessage({
      type: "PROJECT100_MVP_GET_BINDING",
      projectId: currentProjectId
    });
    binding = result.binding || null;
  }

  async function refreshPublishState() {
    if (!currentProjectId) {
      publishState = null;
      return;
    }
    const result = await runtimeMessage({
      type: "PROJECT100_MVP_GET_PUBLISH_STATE",
      projectId: currentProjectId
    });
    publishState = result.publishState || null;
  }

  async function refreshOnboarding() {
    if (!currentProjectId) {
      onboarding = null;
      return;
    }
    try {
      const result = await runtimeMessage({
        type: "PROJECT100_MVP_GET_ONBOARDING",
        projectId: currentProjectId
      });
      onboarding = result.onboarding || null;
    } catch (_error) {
      onboarding = null;
    }
  }

  // Read-only page probe via the content script: is this a ChatGPT Project,
  // and which Markdown files are currently discovered in loaded, visible
  // assistant nodes. Rescan uses this same read-only evidence channel.
  // A page loaded before install self-heals with exactly one injection.
  async function refreshPage({ rescan = false } = {}) {
    try {
      const tab = await activeTab();
      const url = typeof tab.url === "string" ? tab.url : "";
      if (!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(url)) {
        page = null;
        return false;
      }
      let response = null;
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: "PROJECT100_PAGE_STATUS",
          // `rescan` is a hint only. The content script always recomputes the
          // current DOM snapshot and never performs a mutating action here.
          rescan: Boolean(rescan),
          forceRescan: Boolean(rescan)
        });
      } catch (_error) {
        if (chrome.scripting && chrome.scripting.executeScript) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["content.js"]
            });
            response = await chrome.tabs.sendMessage(tab.id, {
              type: "PROJECT100_PAGE_STATUS",
              rescan: Boolean(rescan),
              forceRescan: Boolean(rescan)
            });
          } catch (_retryError) {
            response = null;
          }
        }
      }
      page = response && response.page ? response.page : null;
      return Boolean(page);
    } catch (_error) {
      page = null;
      return false;
    }
  }

  function projectIdFromPage(value) {
    if (!value || !value.isProject) {
      return "";
    }
    return String(value.projectId || value.projectSegment || "").trim();
  }

  function updateProjectContext() {
    const nextProjectId = projectIdFromPage(page);
    if (nextProjectId === currentProjectId) {
      return false;
    }
    currentProjectId = nextProjectId;
    // A navigation boundary must clear all old in-memory state before the
    // new namespace is read. This prevents A's progress from being rendered
    // for the first frame of Project B.
    binding = null;
    publishState = null;
    onboarding = null;
    return true;
  }

  async function refreshPersistedState() {
    if (!currentProjectId) {
      binding = null;
      publishState = null;
      onboarding = null;
      return;
    }
    try {
      await refreshBinding();
    } catch (_error) {
      binding = null;
    }
    try {
      await refreshPublishState();
    } catch (_error) {
      publishState = null;
    }
    await refreshOnboarding();
  }

  async function refreshAll(options = {}) {
    const pageAvailable = await refreshPage(options);
    updateProjectContext();
    await refreshPersistedState();
    render();
    return pageAvailable;
  }

  function stopPublishStatePolling() {
    if (publishPollTimer) {
      clearInterval(publishPollTimer);
      publishPollTimer = 0;
    }
  }

  function startPublishStatePolling() {
    if (publishPollTimer) {
      return;
    }
    publishPollTimer = setInterval(async () => {
      try {
        await refreshPublishState();
        render();
        if (!publishJobRunning()) {
          stopPublishStatePolling();
        }
      } catch (_error) {
        // Transient read failure; keep polling. A restarted worker will
        // reconcile an active persisted job to `interrupted` on the next
        // successful read instead of leaving the popup busy forever.
      }
    }, 2000);
  }

  function stopPageRefresh() {
    if (pageRefreshTimer) {
      clearInterval(pageRefreshTimer);
      pageRefreshTimer = 0;
    }
  }

  function startPageRefresh() {
    if (pageRefreshTimer) {
      return;
    }
    pageRefreshTimer = setInterval(async () => {
      try {
        await refreshPage();
        const contextChanged = updateProjectContext();
        if (contextChanged) {
          await refreshPersistedState();
        }
        render();
      } catch (_error) {
        // Popup-lifetime refresh only.
      }
    }, 2500);
  }

  // The automatic Drive-link copy belongs to the original Publish click (P2).
  // On failure the pending intent is kept, no second canonical file is ever
  // created, and the popup exposes the Copy fallback control.
  async function attemptAutoClipboard() {
    const t = copy(lang);
    if (!onboarding || !onboarding.driveUrl) {
      return false;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(onboarding.driveUrl);
        setGlobalStatus(t.linkCopied);
        return true;
      }
    } catch (_error) {
      // Fall through to the truthful failure status.
    }
    setGlobalStatus(t.linkCopyFailed, true);
    return false;
  }

  async function proceedOnboarding() {
    const t = copy(lang);
    const operationProjectId = currentProjectId;
    try {
      await refreshOnboarding();
      if (!onboarding) {
        return;
      }
      // The onboarding Sources tab opens ACTIVE, which closes this popup —
      // so the Drive link must actually be on the clipboard BEFORE
      // proceeding. A failed copy must not claim success and must not
      // proceed: the popup stays in state E with the truthful status and
      // the usable Copy fallback, and the pending intent is never lost.
      const copied = await attemptAutoClipboard();
      if (!copied) {
        return;
      }
      const result = await runtimeMessage({
        type: "PROJECT100_MVP_ONBOARDING_PROCEED",
        projectId: operationProjectId,
        linkCopied: true
      });
      if (currentProjectId === operationProjectId) {
        onboarding = result.onboarding || null;
      }
      render();
      // The auto-resumed Publish continues in the background; keep reading
      // its truthful state while this popup is open.
      startPublishStatePolling();
    } catch (_error) {
      setGlobalStatus(t.failBinding, true);
    }
  }

  function optimisticPublishingState(firstPublish) {
    const artifact = page && page.artifact ? page.artifact : null;
    const names = artifactFilenames(artifact);
    const prior = publishState && typeof publishState === "object" ? publishState : {};
    return {
      ...prior,
      // Ready-first enters Onboarding before any normal Publishing flow:
      // an unbound first publish shows the one-time-connection state instead
      // of pretending a routine publish job already started. A blocked RPC
      // still falls back to the truthful failed state (UI26).
      status: firstPublish ? "onboarding" : "publishing",
      error: "",
      driveUpdated: false,
      resynced: false,
      fileCount: names.length || Number(prior.fileCount || prior.totalFiles) || 0,
      // Interrupted retry: already saved/confirmed per-file progress stays
      // visible while the retry runs; the worker's real batch state replaces
      // it as soon as it reports.
      filesSaved: Number(prior.filesSaved ?? prior.savedCount) || 0,
      filenames: names.length > 0 ? names : (Array.isArray(prior.filenames) ? prior.filenames : []),
      perSource: Array.isArray(prior.perSource) ? prior.perSource : []
    };
  }

  function blockedPublishState(result) {
    const prior = publishState && typeof publishState === "object" ? publishState : {};
    const error = result && typeof result.error === "string" && result.error
      ? result.error
      : "PUBLISH_FAILED";
    return {
      ...prior,
      status: "failed",
      error,
      driveUpdated: Boolean(result && result.publishState && result.publishState.driveUpdated),
      resynced: Boolean(result && result.publishState && result.publishState.resynced),
      perSource: result && result.publishState && Array.isArray(result.publishState.perSource)
        ? result.publishState.perSource
        : (Array.isArray(prior.perSource) ? prior.perSource : [])
    };
  }

  function wireEvents() {
    $("lang-en").addEventListener("click", async () => {
      lang = "en";
      await chrome.storage.local.set({ [LANG_KEY]: lang });
      applyLanguage();
      render();
    });
    $("lang-zh").addEventListener("click", async () => {
      lang = "zh-CN";
      await chrome.storage.local.set({ [LANG_KEY]: lang });
      applyLanguage();
      render();
    });

    $("copy-drive-link").addEventListener("click", async () => {
      const t = copy(lang);
      // Truthful fallback: "copied" is claimed only after a write that
      // actually happened. A missing clipboard API, a missing pending intent
      // or a denied write all report the truthful failure status instead.
      try {
        if (!onboarding || !onboarding.driveUrl ||
            !navigator.clipboard || !navigator.clipboard.writeText) {
          throw new Error("CLIPBOARD_UNAVAILABLE");
        }
        await navigator.clipboard.writeText(onboarding.driveUrl);
        setGlobalStatus(t.linkCopied);
      } catch (_error) {
        setGlobalStatus(t.linkCopyFailed, true);
      }
    });

    $("continue-connection").addEventListener("click", () => {
      busy = true;
      render();
      void proceedOnboarding().finally(() => {
        busy = false;
        render();
      });
    });

    $("rescan").addEventListener("click", async () => {
      if (rescanBusy || busy || publishJobRunning()) {
        return;
      }
      const t = copy(lang);
      rescanBusy = true;
      render();
      try {
        const available = await refreshAll({ rescan: true });
        setGlobalStatus(available ? t.rescanDone : t.rescanFailed, !available);
      } catch (_error) {
        setGlobalStatus(t.rescanFailed, true);
      } finally {
        rescanBusy = false;
        render();
      }
    });

    // Info affordance: the discovery boundary lives behind one quiet ⓘ —
    // hover, focus and click all reveal it; aria-expanded stays in sync.
    const infoDot = $("info-dot");
    const infoPop = $("discovery-boundary");
    const showInfo = (on) => {
      infoPop.classList.toggle("on", Boolean(on));
      infoDot.setAttribute("aria-expanded", on ? "true" : "false");
    };
    infoDot.addEventListener("mouseenter", () => showInfo(true));
    infoDot.addEventListener("mouseleave", () => showInfo(false));
    infoDot.addEventListener("focus", () => showInfo(true));
    infoDot.addEventListener("blur", () => showInfo(false));
    infoDot.addEventListener("click", () => {
      showInfo(infoDot.getAttribute("aria-expanded") !== "true");
    });

    $("publish").addEventListener("click", async () => {
      const t = copy(lang);
      if (busy || rescanBusy || publishJobRunning()) {
        return;
      }
      const operationProjectId = currentProjectId;
      const firstPublish =
        deriveProductState({ page, binding, onboarding, publishState }).state === "D";
      busy = true;
      render();
      publishState = optimisticPublishingState(firstPublish);
      render();
      try {
        const result = await chrome.runtime.sendMessage({
          type: "PROJECT100_MVP_PUBLISH",
          projectId: operationProjectId
        });
        if (currentProjectId === operationProjectId && result && result.publishState) {
          publishState = result.publishState;
        } else if (currentProjectId === operationProjectId) {
          await refreshPublishState().catch(() => {
            publishState = blockedPublishState(result);
          });
        }
        if (!result || result.status !== "PASS") {
          if (currentProjectId === operationProjectId && (!result || !result.publishState)) {
            publishState = blockedPublishState(result);
          }
          return;
        }
        if (currentProjectId === operationProjectId && result && result.onboarding) {
          onboarding = result.onboarding;
        }
        if (currentProjectId === operationProjectId && onboardingPending()) {
          // First publish: automatic Drive-link copy inside this click
          // gesture. Success continues straight to the ACTIVE onboarding
          // Sources tab (no Copy step in the normal flow). Failure never
          // claims "copied" and never opens the Sources tab with a link the
          // user may not have — the ACTIVE tab would close this popup and
          // make the Copy fallback unreachable. Instead the pending intent
          // is kept, the popup stays in state E with the truthful status and
          // the usable Copy fallback: no intent loss, no second canonical
          // file, and the onboarding continues after a successful fallback
          // copy via Continue connection.
          const copied = await attemptAutoClipboard();
          if (copied) {
            try {
              const proceed = await runtimeMessage({
                type: "PROJECT100_MVP_ONBOARDING_PROCEED",
                projectId: operationProjectId,
                linkCopied: true
              });
              if (currentProjectId === operationProjectId) {
                onboarding = proceed.onboarding || onboarding;
              }
            } catch (_proceedError) {
              setGlobalStatus(t.failBinding, true);
            }
          }
        }
      } catch (error) {
        publishState = {
          ...((publishState && typeof publishState === "object") ? publishState : {}),
          status: "failed",
          error: error && error.message ? error.message : "PUBLISH_FAILED"
        };
      } finally {
        busy = false;
        await refreshPage().catch(() => {});
        const contextChanged = updateProjectContext();
        if (contextChanged) {
          await refreshPersistedState();
        }
        render();
        if (publishJobRunning()) {
          startPublishStatePolling();
        }
      }
    });
  }

  async function init() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get([LANG_KEY]);
    } catch (_error) {
      stored = {};
    }
    lang = normalizeLanguage(stored[LANG_KEY]);
    applyLanguage();
    wireEvents();
    await refreshAll();
    if (publishJobRunning()) {
      startPublishStatePolling();
    }
    startPageRefresh();
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", () => {
      void init();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void refreshAll();
      }
    });
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("unload", () => {
        stopPublishStatePolling();
        stopPageRefresh();
      });
    }
  }
})();
