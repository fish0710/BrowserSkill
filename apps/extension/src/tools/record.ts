// `tool.record_start` / `tool.record_stop` / `tool.record_await` — capture
// user actions in the Agent Window via the content script and return a
// semantic (LLM textbook) trace.

import {
  isRecordFinishMessage,
  isRecordQueryMessage,
  isRecordStepMessage,
  RECORD_CANCEL,
  RECORD_START,
  RECORD_STEP,
  RECORD_STOP,
  type RecordCancelMessage,
  type RecordFinishMessage,
  type RecordQueryResponse,
  type RecordStartAck,
  type RecordStartMessage,
  type RecordStepAck,
  type RecordStopMessage,
} from "@/lib/record-bridge";
import {
  clearAgentInitiatedNavigation,
  consumeAgentInitiatedNavigation,
  resetAgentInitiatedNavigationsForTests,
} from "@/lib/recording/agent-navigation";
import {
  type RecordFrameCoordinator,
  type RecordingCaptureScope,
  recordFrameCoordinator,
} from "@/lib/recording/frame-coordinator";
import { isAgentInitiatedNavigation } from "@/lib/recording/navigation-policy";
import { RecordingObservationRuntime } from "@/lib/recording/recording-runtime";
import {
  appendRecordedPayload,
  observeRecordedNavigation,
  type RecordingStepBuffer,
} from "@/lib/recording/step-buffer";
import { RecordingTabCoordinator, type TabActivation } from "@/lib/recording/tab-coordinator";
import { buildTraceV2 } from "@/lib/recording/trace-reducer-v2";
import type { RecordingDraftStep } from "@/lib/recording/types";
import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import { EXTENSION_VERSION } from "@/transport/handshake";
import type {
  RecordAwaitParams,
  RecordAwaitResult,
  RecordedTrace,
  RecordStartParams,
  RecordStartResult,
  RecordStopParams,
  RecordStopResult,
  RpcError,
  StopReason,
} from "@/transport/types";
import { TRACE_VERSION_V3 } from "@/transport/types";
import { handleNavigate } from "./navigation";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

interface ActiveRecording {
  requestId: string;
  tabs: RecordingTabCoordinator;
  agentWindowId: number;
  isTabAllowed: (tabId: number) => boolean;
  startUrl?: string;
  purpose?: string;
  steps: RecordingDraftStep[];
  startedAt: string;
  startedAtMs: number;
  traceVersion: 2 | 3;
  supportsTabSwitchSteps: boolean;
  finishPromise: Promise<RecordedTrace>;
  resolveFinish: (trace: RecordedTrace) => void;
  rejectFinish: (err: Error) => void;
  settled: boolean;
  finishAttempt: Promise<RecordedTrace | null> | null;
  observation: RecordingObservationRuntime | null;
  stoppedBy: StopReason;
  /**
   * True once a `record_await` took ownership of this recording's finish
   * promise. Such a caller receives the trace directly, so the finish path must
   * not also park it in `chrome.storage.session` — nothing would ever consume
   * that slot and its 10MB quota would be held for 24h.
   */
  awaited: boolean;
  /** Navigation callbacks tracked from event receipt through action enqueue. */
  navigationCallbacks: Set<Promise<void>>;
  /** Synchronous intake gate closed only after finish drains to stability. */
  acceptingNavigation: boolean;
  /**
   * Serializes step appends with navigation observation so a click is always
   * in `steps` before a same-turn `webNavigation` tries to annotate it.
   */
  actionQueue: Promise<void>;
  /** Last accepted sequence for each content-script document producer. */
  lastStepSequenceByProducer: Map<string, number>;
}

function enqueueRecordingAction(
  recording: ActiveRecording,
  task: () => Promise<void>,
): Promise<void> {
  const queued = recording.actionQueue.then(task, task);
  recording.actionQueue = queued.catch(() => {});
  return queued;
}

function isRecordingFinishing(recording: ActiveRecording): boolean {
  return recording.settled || recording.finishAttempt !== null;
}

const recordings = new Map<string, ActiveRecording>();

/**
 * Detach-mode stopgap (D3 缺陷 2): a `user_finish` trace has no in-process
 * consumer, so it used to die with the recording. Park the built trace here —
 * and mirror it into `chrome.storage.session` because an idle MV3 worker is
 * recycled long before the CLI's later `record stop` — until a stop collects it.
 * A blocking `record_await` *is* a consumer (see `ActiveRecording.awaited`), and
 * such a finish must not park a copy: the slot would never be read and would
 * hold the 10MB session quota for the whole TTL.
 */
const FINISHED_TRACE_STORAGE_KEY = "bsk_record_finished";
/** Recovery window; older entries are dropped rather than replayed. */
const FINISHED_TRACE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * One slot per session (R2-9). Two detached recordings can be parked at the
 * same time; a single fixed key let the second `user_finish` silently overwrite
 * the first one, so the first session's `record stop` saw a foreign `sessionId`
 * and reported `not_found` — losing that trace for good.
 */
function finishedTraceStorageKey(sessionId: string): string {
  return `${FINISHED_TRACE_STORAGE_KEY}:${sessionId}`;
}

/** Our slots plus the pre-R2-9 bare key, so a parked old-format slot still drains. */
function isFinishedTraceStorageKey(key: string): boolean {
  return key === FINISHED_TRACE_STORAGE_KEY || key.startsWith(`${FINISHED_TRACE_STORAGE_KEY}:`);
}

interface FinishedTraceStash {
  sessionId: string;
  trace: RecordedTrace;
  stoppedBy: StopReason;
  finishedAt: number;
  /** In-flight `chrome.storage.session` write, awaited before a storage read. */
  persisted: Promise<void>;
}

const finishedTraces = new Map<string, FinishedTraceStash>();

/** Subset of `chrome.storage.session` we use; absent when nothing is stubbed. */
interface FinishedTraceStorageApi {
  /** `null` reads every item, which is how the expiry sweep finds foreign slots. */
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function finishedTraceStorage(): FinishedTraceStorageApi | null {
  if (typeof chrome === "undefined") return null;
  const area = chrome.storage?.session;
  if (!area?.get || !area.set || !area.remove) return null;
  return {
    get: (key) => area.get(key) as Promise<Record<string, unknown>>,
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

function isFinishedTraceStash(value: unknown): value is Omit<FinishedTraceStash, "persisted"> {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<FinishedTraceStash>;
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.finishedAt === "number" &&
    typeof entry.trace === "object" &&
    entry.trace !== null
  );
}

function isFinishedTraceFresh(entry: { finishedAt: number }): boolean {
  return Date.now() - entry.finishedAt <= FINISHED_TRACE_TTL_MS;
}

interface StoredFinishedTraceSlot {
  key: string;
  entry: unknown;
}

/** Every finished-trace slot in `chrome.storage.session`, whatever its owner. */
async function readFinishedTraceSlots(): Promise<StoredFinishedTraceSlot[]> {
  const storage = finishedTraceStorage();
  if (!storage) return [];
  try {
    const all = await storage.get(null);
    return Object.entries(all)
      .filter(([key]) => isFinishedTraceStorageKey(key))
      .map(([key, entry]) => ({ key, entry }));
  } catch {
    return [];
  }
}

/**
 * Drop every expired (or unreadable) slot, whoever wrote it (R2-16). Without
 * this a 25h-old trace — which may still hold unscrubbed page text — sat in
 * `chrome.storage.session` until the browser restarted.
 */
async function sweepExpiredFinishedTraces(): Promise<void> {
  for (const [sessionId, entry] of finishedTraces) {
    if (!isFinishedTraceFresh(entry)) finishedTraces.delete(sessionId);
  }
  const storage = finishedTraceStorage();
  if (!storage) return;
  const slots = await readFinishedTraceSlots();
  const staleKeys = slots
    .filter(({ entry }) => !isFinishedTraceStash(entry) || !isFinishedTraceFresh(entry))
    .map(({ key }) => key);
  if (staleKeys.length === 0) return;
  try {
    await storage.remove(staleKeys);
  } catch {
    // A stale slot only costs one recovery miss; never fail the caller on it.
  }
}

/**
 * Drop this session's stored slot. New writes are per-session
 * (`bsk_record_finished:<sessionId>`), so no ownership check is needed; the
 * bare legacy key is only removed when it belongs to this session.
 */
async function removeStoredFinishedTrace(sessionId: string): Promise<void> {
  const storage = finishedTraceStorage();
  if (!storage) return;
  const ownKey = finishedTraceStorageKey(sessionId);
  const slots = await readFinishedTraceSlots();
  const keys = slots
    .filter(
      ({ key, entry }) =>
        key === ownKey || !isFinishedTraceStash(entry) || entry.sessionId === sessionId,
    )
    .map(({ key }) => key);
  if (!keys.includes(ownKey)) keys.push(ownKey);
  try {
    await storage.remove(keys);
  } catch {
    // Best effort: the caller must not fail because a recovery slot survived.
  }
}

/** Park a finished trace so a later `record stop` can still export it. */
function stashFinishedTrace(sessionId: string, trace: RecordedTrace, stoppedBy: StopReason): void {
  const storage = finishedTraceStorage();
  const entry = { sessionId, trace, stoppedBy, finishedAt: Date.now() };
  const persisted = storage
    ? storage.set({ [finishedTraceStorageKey(sessionId)]: entry }).catch((err) => {
        console.warn("[bsk record] could not persist finished trace", err);
      })
    : Promise.resolve();
  finishedTraces.set(sessionId, { ...entry, persisted });
}

async function clearFinishedTrace(sessionId: string): Promise<void> {
  finishedTraces.delete(sessionId);
  await removeStoredFinishedTrace(sessionId);
}

/**
 * Collect exactly one parked trace from `chrome.storage.session`, for the case
 * where this worker is a fresh process after an MV3 recycle.
 *
 * Freshness is decided **before** ownership (R2-16): every expired slot is
 * deleted regardless of which session wrote it, and only then is a fresh slot
 * matched against `sessionId` and consumed. Expired entries are never replayed.
 */
async function takeStoredFinishedTrace(sessionId: string): Promise<RecordedTrace | null> {
  const storage = finishedTraceStorage();
  const slots = await readFinishedTraceSlots();
  const staleKeys: string[] = [];
  let matchedKey: string | null = null;
  let matchedEntry: Omit<FinishedTraceStash, "persisted"> | null = null;
  for (const { key, entry } of slots) {
    if (!isFinishedTraceStash(entry) || !isFinishedTraceFresh(entry)) {
      staleKeys.push(key);
      continue;
    }
    if (entry.sessionId !== sessionId) continue;
    matchedKey = key;
    matchedEntry = entry;
  }
  const removals = matchedKey ? [...staleKeys, matchedKey] : staleKeys;
  if (storage && removals.length > 0) {
    try {
      await storage.remove(removals);
    } catch {
      // Same trade-off as above: a surviving slot only costs a recovery miss.
    }
  }
  if (matchedEntry) finishedTraces.delete(sessionId);
  return matchedEntry?.trace ?? null;
}

/**
 * Collect a parked trace exactly once: memory first (the same worker finished
 * it), then `chrome.storage.session` (this worker is a fresh one). `parked`
 * keeps priority so a failed storage write still recovers in-process.
 */
async function takeFinishedTrace(sessionId: string): Promise<RecordedTrace | null> {
  const parked = finishedTraces.get(sessionId);
  if (parked) {
    finishedTraces.delete(sessionId);
    // Chrome keeps the worker alive for a pending extension API call, so the
    // mirror is already written by the time this settles.
    await parked.persisted;
  }
  const stored = await takeStoredFinishedTrace(sessionId);
  if (parked) return isFinishedTraceFresh(parked) ? parked.trace : null;
  return stored;
}

/** Test seam: true while a finished trace is parked for a later `record stop`. */
export function hasFinishedTraceForTests(sessionId: string): boolean {
  return finishedTraces.has(sessionId);
}

/** Test seam: the storage key a session's parked trace is written under. */
export function finishedTraceStorageKeyForTests(sessionId: string): string {
  return finishedTraceStorageKey(sessionId);
}

/** Test seam: arrival clock carried by the newest draft of a live recording. */
export function lastDraftArrivedAtForTests(sessionId: string): number | undefined {
  const steps = recordings.get(sessionId)?.steps;
  return steps?.[steps.length - 1]?.arrivedAt;
}

/**
 * Test seam: simulate an MV3 worker recycle. In-flight storage writes settle
 * first, because Chrome keeps the worker alive for a pending extension API
 * call; only then does the in-memory map disappear.
 */
export async function recycleFinishedTracesForTests(): Promise<void> {
  await Promise.allSettled([...finishedTraces.values()].map((entry) => entry.persisted));
  finishedTraces.clear();
}

const RECORD_START_RETRIES = 3;
const RECORD_START_RETRY_DELAY_MS = 500;
const RECORD_REARM_DEBOUNCE_MS = 150;
const RECORD_REARM_MAX_ATTEMPTS = 12;
const RECORD_REARM_RETRY_DELAY_MS = 400;

const rearmTimers = new Map<number, ReturnType<typeof setTimeout>>();

function makeRequestId(tabId: number): string {
  return `rec-${tabId}-${Date.now().toString(36)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Recording producer version mirrored into trace.recorder.bsk. */
export const BSK_TRACE_VERSION = EXTENSION_VERSION;

/** Injectable http(s) landing page when `tool.record_start` omits `url`. */
export const RECORD_DEFAULT_START_URL = "https://example.com/";

/** Pages where MV3 content scripts cannot attach (Agent Window boots here). */
function isContentScriptRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower === "about:blank" ||
    lower.startsWith("about:") ||
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("devtools:") ||
    lower.startsWith("https://chrome.google.com/webstore")
  );
}

async function waitForTabReady(
  tabId: number,
  tabsApi: ChromeTabsApi,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    const tab = await tabsApi.get(tabId);
    if (tab.status === "complete") return;
  } catch {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("tab load timeout"));
    }, timeoutMs);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isRecordStartAck(response: unknown): response is RecordStartAck {
  return (
    typeof response === "object" &&
    response !== null &&
    "ok" in response &&
    (response as RecordStartAck).ok === true
  );
}

async function sendRecordStartWithAck(
  tabId: number,
  msg: RecordStartMessage,
  sendToTab: RecordDeps["sendToTab"],
  cancelled?: () => boolean,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RECORD_START_RETRIES; attempt += 1) {
    if (cancelled?.()) throw new Error("record start cancelled");
    try {
      const response = await sendToTab(tabId, msg);
      if (isRecordStartAck(response)) return;
      lastError = new Error("content script did not ack RECORD_START");
    } catch (err) {
      lastError = err;
    }
    if (cancelled?.()) throw new Error("record start cancelled");
    if (attempt + 1 < RECORD_START_RETRIES) {
      await sleep(RECORD_START_RETRY_DELAY_MS);
    }
  }
  throw lastError ?? new Error("failed to start recording in content script");
}

function negotiatedTraceVersion(params: RecordStartParams): 2 | 3 | RpcError {
  if (params.trace_version === undefined) return 2;
  if (params.trace_version === TRACE_VERSION_V3) return 3;
  return {
    code: "invalid_params",
    message: `unsupported trace_version ${params.trace_version}; supported values are omitted (v2) or ${TRACE_VERSION_V3} (v3)`,
  };
}

function buildTrace(recording: ActiveRecording): RecordedTrace {
  if (recording.traceVersion === 3 && recording.observation) {
    return recording.observation.buildTrace({
      drafts: recording.steps,
      startedAt: recording.startedAt,
      purpose: recording.purpose,
      startUrl: recording.startUrl,
      stoppedBy: recording.stoppedBy,
      bskVersion: BSK_TRACE_VERSION,
      includeTabSwitches: recording.supportsTabSwitchSteps,
    });
  }
  if (recording.traceVersion === 3) {
    throw new Error("trace v3 observation runtime is unavailable");
  }
  return buildTraceV2({
    steps: recording.steps,
    startedAt: recording.startedAt,
    ...(recording.startUrl ? { startUrl: recording.startUrl } : {}),
    ...(recording.purpose ? { purpose: recording.purpose } : {}),
  });
}

function stepBufferFor(
  recording: ActiveRecording,
  tabId: number,
  fallbackUrl?: string,
): RecordingStepBuffer {
  return {
    steps: recording.steps,
    navigation: recording.tabs.navigation(tabId, fallbackUrl),
  };
}

async function activateRecordingTab(
  recording: ActiveRecording,
  targetTabId: number,
): Promise<void> {
  if (recording.settled || !recording.isTabAllowed(targetTabId)) return;
  const previousTabId = recording.tabs.currentTabId;
  if (targetTabId === previousTabId) return;

  const transition = recording.observation
    ? await recording.observation.captureTabTransition(previousTabId, targetTabId)
    : {};
  const { targetUrl, ...stateLinks } = transition;
  const draft: Extract<RecordingDraftStep, { op: "switch_tab" }> = {
    op: "switch_tab",
    ...stateLinks,
  };
  recording.steps.push(draft);
  recording.observation?.bindTabTransition(draft, recording.steps.length);
  recording.tabs.commit(targetTabId, targetUrl);
}

async function processRecordedStep(
  recording: ActiveRecording,
  draftIndex: number,
  tabId: number,
  producerId?: string,
): Promise<void> {
  if (!recording.observation) return;
  try {
    await recording.observation.processDraft(tabId, recording.steps, draftIndex, producerId);
  } catch (err) {
    console.warn(`[bsk record] observation failed for step ${draftIndex + 1}`, err);
  }
}

export interface RecordDeps {
  tabsApi: ChromeTabsApi;
  sendToTab(
    tabId: number,
    msg: RecordStartMessage | RecordStopMessage | RecordCancelMessage,
  ): Promise<unknown>;
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  frameCoordinator?: Pick<
    RecordFrameCoordinator,
    "begin" | "armTab" | "sourceFor" | "stop" | "cancel"
  >;
  cdp?: CdpRunner;
  signal?: AbortSignal;
}

export type RecordRuntimeDeps = Omit<RecordDeps, "frameCoordinator" | "signal"> & {
  frameCoordinator: NonNullable<RecordDeps["frameCoordinator"]>;
};

let defaultDeps: RecordDeps | null = null;
function getDefaultDeps(): RecordDeps {
  if (!defaultDeps) {
    defaultDeps = {
      tabsApi: chromeTabsApi,
      sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
      frameCoordinator: recordFrameCoordinator,
    };
  }
  return defaultDeps;
}

/** Disposer for lazily attached tab / webNavigation observers. */
let detachBrowserObservation: (() => void) | null = null;

type AttachObservation = (deps: RecordDeps) => () => void;

// Deferred wrappers so we do not capture attach* before their declarations.
let attachTabObservation: AttachObservation = (deps) => attachRecordTabListener(deps);
let attachNavObservation: AttachObservation = (deps) => attachRecordNavigationListener(deps);

/** Test seam: swap real chrome listeners for fakes. */
export function setBrowserObservationAttachForTests(
  tab: AttachObservation | null,
  nav: AttachObservation | null,
): void {
  attachTabObservation = tab ?? ((deps) => attachRecordTabListener(deps));
  attachNavObservation = nav ?? ((deps) => attachRecordNavigationListener(deps));
}

export function isBrowserObservationAttachedForTests(): boolean {
  return detachBrowserObservation !== null;
}

export function resetBrowserObservationForTests(): void {
  detachBrowserObservation?.();
  detachBrowserObservation = null;
  recordings.clear();
  resetAgentInitiatedNavigationsForTests();
  finishedTraces.clear();
  void (async () => {
    const storage = finishedTraceStorage();
    if (!storage) return;
    const keys = (await readFinishedTraceSlots()).map((slot) => slot.key);
    if (keys.length > 0) await storage.remove(keys);
  })().catch(() => {});
  attachTabObservation = (deps) => attachRecordTabListener(deps);
  attachNavObservation = (deps) => attachRecordNavigationListener(deps);
}

/**
 * Attach tab/webNavigation listeners while any recording is active.
 * Must run before navigate-on-start so rearm observes the destination load.
 */
export function ensureBrowserObservationListeners(deps: RecordDeps = getDefaultDeps()): void {
  if (detachBrowserObservation) return;
  const detachTab = attachTabObservation(deps);
  const detachNav = attachNavObservation(deps);
  detachBrowserObservation = () => {
    detachTab();
    detachNav();
  };
}

/** Detach when the recordings map is empty. */
export function releaseBrowserObservationListenersIfIdle(): void {
  if (recordings.size > 0) return;
  if (!detachBrowserObservation) return;
  detachBrowserObservation();
  detachBrowserObservation = null;
}

export function attachRecordStepListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RecordStepAck) => void,
  ) => {
    if (!isRecordStepMessage(message)) return false;
    // Sample the arrival clock before any `await` and before the action is
    // queued (R1-2): the recording queue may first flush redirects and settle a
    // previous step, and an observation registered in that window was sampled
    // *after* this action, so it must not become its pre-state.
    const arrivedAt = Date.now();
    for (const recording of recordings.values()) {
      if (recording.requestId !== message.requestId) continue;
      const source: RecordingCaptureScope | null | undefined = deps.frameCoordinator
        ? deps.frameCoordinator.sourceFor(message.requestId, message.producerId, sender)
        : undefined;
      if (deps.frameCoordinator && !source) return false;
      const sourceTabId = source?.tabId ?? sender.tab?.id ?? recording.tabs.currentTabId;
      if (recording.settled || !recording.isTabAllowed(sourceTabId)) return false;
      const sourceWasActive = sender.tab?.active ?? sourceTabId === recording.tabs.activeTabId;
      const producerKey = source
        ? `${source.tabId}:${source.documentId}:${source.producerId}`
        : `${sourceTabId}:${message.producerId}`;
      const expectedSequence = (recording.lastStepSequenceByProducer.get(producerKey) ?? 0) + 1;
      if (message.sequence < expectedSequence) {
        sendResponse({ ok: true, sequence: message.sequence });
        return false;
      }
      if (message.sequence > expectedSequence) {
        sendResponse({
          ok: false,
          expectedSequence,
          error: `out-of-order recorded step ${message.sequence}`,
        });
        return false;
      }

      recording.lastStepSequenceByProducer.set(producerKey, message.sequence);
      enqueueRecordingAction(recording, async () => {
        if (recording.settled || !recording.isTabAllowed(sourceTabId)) return;
        if (sourceTabId !== recording.tabs.currentTabId) {
          if (!sourceWasActive) return;
          if (sourceTabId !== recording.tabs.activeTabId)
            recording.tabs.noteActivation(sourceTabId);
          await activateRecordingTab(recording, sourceTabId);
        }
        await recording.observation?.flushRedirects(sourceTabId);
        const targetHint = message.step.geometry ? { geometry: message.step.geometry } : undefined;
        const draftIndex = appendRecordedPayload(
          stepBufferFor(recording, sourceTabId, message.step.page_url),
          message.step,
          targetHint,
          arrivedAt,
        );
        if (draftIndex !== null) {
          await processRecordedStep(recording, draftIndex, sourceTabId, source?.producerId);
        }
      });
      sendResponse({ ok: true, sequence: message.sequence });
      return false;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function attachRecordFinishListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    _sendResponse: () => void,
  ) => {
    if (!isRecordFinishMessage(message)) return false;
    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;
    void finishRecordingByRequest(message.requestId, tabId, deps);
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function findRecordingByTabId(tabId: number): ActiveRecording | null {
  for (const recording of recordings.values()) {
    if (
      recording.tabs.currentTabId === tabId &&
      !recording.settled &&
      recording.isTabAllowed(tabId)
    )
      return recording;
  }
  return null;
}

async function findRecordingForTab(
  tabId: number,
  deps: RecordDeps,
): Promise<ActiveRecording | null> {
  const direct = findRecordingByTabId(tabId);
  if (direct) return direct;

  try {
    const tab = await deps.tabsApi.get(tabId);
    const windowId = tab.windowId;
    if (typeof windowId !== "number") return null;
    for (const recording of recordings.values()) {
      if (
        !recording.settled &&
        recording.agentWindowId === windowId &&
        recording.isTabAllowed(tabId)
      )
        return recording;
    }
  } catch {
    return null;
  }
  return null;
}

function clearRearmTimer(tabId: number): void {
  const timer = rearmTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    rearmTimers.delete(tabId);
  }
}

async function clearRearmTimersForRecording(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  clearRearmTimer(recording.tabs.currentTabId);
  try {
    const tabs = await deps.tabsApi.query({ windowId: recording.agentWindowId });
    for (const tab of tabs) {
      if (typeof tab.id === "number") clearRearmTimer(tab.id);
    }
  } catch {
    // Best-effort cleanup.
  }
}

async function stopRecordingOnAllAgentTabs(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  if (deps.frameCoordinator && !(await deps.frameCoordinator.stop(recording.requestId))) {
    throw new Error("failed to flush one or more recording documents");
  }
  const stopMsg: RecordStopMessage = { type: RECORD_STOP, requestId: recording.requestId };
  let tabIds = [recording.tabs.currentTabId];
  try {
    const tabs = await deps.tabsApi.query({ windowId: recording.agentWindowId });
    tabIds = [
      ...new Set([
        recording.tabs.currentTabId,
        ...tabs.flatMap((tab) => (typeof tab.id === "number" ? [tab.id] : [])),
      ]),
    ];
  } catch {
    // Fall back to the current recording tab.
  }

  for (const tabId of tabIds) {
    if (!recording.isTabAllowed(tabId)) continue;
    try {
      const response = await deps.sendToTab(tabId, stopMsg);
      if (tabId === recording.tabs.currentTabId && !isRecordStartAck(response)) {
        throw new Error("content script did not confirm recorded steps");
      }
    } catch {
      if (tabId === recording.tabs.currentTabId) {
        throw new Error("failed to flush recorded steps");
      }
    }
    if (deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(tabId, false);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

async function rearmRecording(
  recording: ActiveRecording,
  targetTabId: number,
  deps: RecordDeps,
  activation?: TabActivation,
): Promise<boolean> {
  // Do NOT toggle automation-bypass here: each retry used to increment the
  // content-script counter, and a single stop decrement left the ControlOverlay
  // stuck with pointer-events:none (page usable, Interrupt dead). RecordOverlay
  // already hides the control chrome while activeRecord is set.
  const isFinishing = () => isRecordingFinishing(recording) || !recording.isTabAllowed(targetTabId);
  for (let attempt = 0; attempt < RECORD_REARM_MAX_ATTEMPTS; attempt += 1) {
    if (isFinishing()) return false;
    const startMsg: RecordStartMessage = {
      type: RECORD_START,
      requestId: recording.requestId,
      startedAtMs: recording.startedAtMs,
    };
    try {
      if (deps.frameCoordinator) {
        const frameStarted = await deps.frameCoordinator.armTab(recording.requestId, targetTabId);
        if (!frameStarted) throw new Error("recording document did not start");
      }
      await sendRecordStartWithAck(targetTabId, startMsg, deps.sendToTab, isFinishing);
      if (isFinishing()) return false;
      if (activation) {
        if (!recording.tabs.isLatest(activation)) return true;
        await enqueueRecordingAction(recording, async () => {
          if (isFinishing() || !recording.tabs.isLatest(activation)) {
            return;
          }
          await activateRecordingTab(recording, targetTabId);
        });
      }
      return true;
    } catch {
      if (isFinishing()) return false;
      if (attempt + 1 < RECORD_REARM_MAX_ATTEMPTS) {
        await sleep(RECORD_REARM_RETRY_DELAY_MS);
      }
    }
  }
  return false;
}

function scheduleRearmForTab(tabId: number, deps: RecordDeps, activation?: TabActivation): void {
  const existing = rearmTimers.get(tabId);
  if (existing) clearTimeout(existing);
  rearmTimers.set(
    tabId,
    setTimeout(() => {
      rearmTimers.delete(tabId);
      void (async () => {
        const current = await findRecordingForTab(tabId, deps);
        if (current) await rearmRecording(current, tabId, deps, activation);
      })();
    }, RECORD_REARM_DEBOUNCE_MS),
  );
}

export function attachRecordTabListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const onCreated = (tab: chrome.tabs.Tab) => {
    const tabId = tab.id;
    const windowId = tab.windowId;
    if (tabId === undefined || windowId === undefined) return;
    for (const recording of recordings.values()) {
      if (
        isRecordingFinishing(recording) ||
        recording.agentWindowId !== windowId ||
        !recording.isTabAllowed(tabId)
      )
        continue;
      scheduleRearmForTab(tabId, deps);
      return;
    }
  };

  const onActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
    for (const recording of recordings.values()) {
      if (
        isRecordingFinishing(recording) ||
        recording.agentWindowId !== activeInfo.windowId ||
        !recording.isTabAllowed(activeInfo.tabId)
      )
        continue;
      const activation = recording.tabs.noteActivation(activeInfo.tabId);
      scheduleRearmForTab(activeInfo.tabId, deps, activation);
      return;
    }
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onActivated.addListener(onActivated);
  return () => {
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onActivated.removeListener(onActivated);
  };
}

export function attachRecordNavigationListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const observeMainFrame = (
    tabId: number,
    url: string | undefined,
    causedByAction: boolean | undefined,
    transitionType: string | undefined,
    transitionQualifiers: string[] | undefined,
    // Sampled at the listener entry, before any `await`. Assigning it here and
    // not in each listener body is deliberate: the fallback below must stay a
    // per-call default, not a shared mutable clock (R2-11).
    arrivedAt: number = Date.now(),
  ) => {
    if (!url) return;
    const candidates = [...recordings.values()].filter(
      (recording) =>
        !recording.settled &&
        recording.acceptingNavigation &&
        recording.tabs.activeTabId === tabId &&
        recording.isTabAllowed(tabId),
    );
    for (const recording of candidates) {
      const queued = enqueueRecordingAction(recording, async () => {
        if (recording.settled || !recording.isTabAllowed(tabId)) return;
        if (tabId !== recording.tabs.currentTabId) {
          await activateRecordingTab(recording, tabId);
        }
        const result = observeRecordedNavigation(
          stepBufferFor(recording, tabId, url),
          url,
          causedByAction,
          transitionType,
          transitionQualifiers,
          // R2-11: without this every webNavigation-driven draft carried
          // `arrivedAt === undefined`, so the pre-state guard let a sample
          // started *after* the navigation bind as that navigation's pre-state.
          arrivedAt,
        );
        if (result.kind === "coalesce_redirect") {
          recording.observation?.scheduleRedirect(tabId, recording.steps, result.url);
          return;
        }

        if (result.kind === "noop") return;
        recording.observation?.clearRedirect(tabId);
        if (result.kind === "appended") {
          await processRecordedStep(recording, result.index, tabId);
        } else {
          recording.observation?.scheduleSettle(tabId, recording.steps, result.index);
        }
      });
      const tracked = queued.catch(() => {});
      recording.navigationCallbacks.add(tracked);
      void tracked.finally(() => recording.navigationCallbacks.delete(tracked));
    }
  };
  const onMainFrameComplete = (tabId: number, url?: string) => {
    const arrivedAt = Date.now();
    void (async () => {
      observeMainFrame(tabId, url, undefined, undefined, undefined, arrivedAt);
      scheduleRearmForTab(tabId, deps);
    })();
  };

  if (chrome.webNavigation?.onCompleted) {
    const completedListener = (
      details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
    ) => {
      if (details.frameId !== 0) return;
      onMainFrameComplete(details.tabId, details.url);
    };
    const committedListener = (
      details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ) => {
      if (details.frameId !== 0) return;
      // R2-11: the arrival clock before this listener does any work.
      const arrivedAt = Date.now();
      // D2 §2.3: a `bsk navigate` (or any explicitly entered URL) commits with
      // Chrome's own `typed` / `from_address_bar` transition metadata. Report it
      // as *not* caused by the previously recorded action, so the step buffer
      // appends an independent navigate step instead of folding it into a
      // pending click intent that the trace cannot express.
      const agentInitiated =
        consumeAgentInitiatedNavigation(details.tabId) ||
        isAgentInitiatedNavigation({
          transitionType: details.transitionType,
          transitionQualifiers: details.transitionQualifiers,
        });
      observeMainFrame(
        details.tabId,
        details.url,
        agentInitiated ? false : undefined,
        details.transitionType,
        details.transitionQualifiers,
        arrivedAt,
      );
    };
    chrome.webNavigation.onCompleted.addListener(completedListener);
    chrome.webNavigation.onCommitted?.addListener(committedListener);
    return () => {
      chrome.webNavigation.onCompleted.removeListener(completedListener);
      chrome.webNavigation.onCommitted?.removeListener(committedListener);
    };
  }

  const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
    if (info.status !== "complete") return;
    onMainFrameComplete(tabId, info.url);
  };
  chrome.tabs.onUpdated.addListener(listener);
  return () => chrome.tabs.onUpdated.removeListener(listener);
}

const MAX_FINISH_DRAIN_ROUNDS = 10;

async function drainRecordingToStability(recording: ActiveRecording): Promise<boolean> {
  for (let round = 0; round < MAX_FINISH_DRAIN_ROUNDS; round += 1) {
    await Promise.all([...recording.navigationCallbacks]);
    const actionTail = recording.actionQueue;
    await actionTail;
    await recording.observation?.flush();

    if (recording.navigationCallbacks.size === 0 && recording.actionQueue === actionTail) {
      // No event or promise continuation can interleave with this synchronous
      // check-and-close, so work accepted before the cutoff is fully drained.
      recording.acceptingNavigation = false;
      return true;
    }
  }
  console.warn("[bsk record] navigation/action queues did not stabilize at stop");
  return false;
}

export function attachRecordQueryListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RecordQueryResponse) => void,
  ) => {
    if (!isRecordQueryMessage(message)) return false;
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ active: false });
      return false;
    }
    void (async () => {
      const recording = await findRecordingForTab(tabId, deps);
      if (!recording) {
        sendResponse({ active: false });
        return;
      }
      const activation = sender.tab?.active ? recording.tabs.noteActivation(tabId) : undefined;
      await rearmRecording(recording, tabId, deps, activation);
      sendResponse({
        active: true,
        requestId: recording.requestId,
        startedAtMs: recording.startedAtMs,
      });
    })();
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

async function finishRecordingByRequest(
  requestId: string,
  tabId: number,
  deps: RecordDeps,
): Promise<void> {
  for (const [sessionId, recording] of recordings) {
    if (recording.requestId !== requestId || recording.settled) continue;
    const match = await findRecordingForTab(tabId, deps);
    if (match !== recording) continue;
    await finishRecording(sessionId, deps, "user_finish");
    return;
  }
}

async function finishRecording(
  sessionId: string,
  deps: RecordDeps,
  stoppedBy: StopReason,
): Promise<RecordedTrace | null> {
  const recording = recordings.get(sessionId);
  if (!recording || recording.settled) return null;
  if (recording.finishAttempt) return recording.finishAttempt;
  recording.stoppedBy = stoppedBy;

  const attempt = finishRecordingAttempt(sessionId, recording, deps);
  recording.finishAttempt = attempt;
  try {
    return await attempt;
  } finally {
    if (!recording.settled) {
      recording.finishAttempt = null;
    }
  }
}

async function finishRecordingAttempt(
  sessionId: string,
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<RecordedTrace | null> {
  await clearRearmTimersForRecording(recording, deps);
  try {
    // Disposing content capture may commit a final dirty fill. Flush content
    // first so all resulting RECORD_STEP messages enter actionQueue before it
    // and the observation queues are drained.
    await stopRecordingOnAllAgentTabs(recording, deps);
  } catch {
    return null;
  }
  if (!(await drainRecordingToStability(recording))) {
    return null;
  }
  await recording.observation?.settleTrailing(recording.tabs.currentTabId, recording.steps);

  recording.settled = true;
  const trace = buildTrace(recording);
  // `user_finish` has no in-process consumer in detach mode, so park the trace
  // between building it and dropping the recording. A blocking `record_await`
  // is such a consumer: it already returned the trace to the CLI, and parking a
  // copy would leave the session's storage slot unconsumed for its whole TTL.
  if (recording.stoppedBy === "user_finish" && !recording.awaited) {
    stashFinishedTrace(sessionId, trace, "user_finish");
  }
  recordings.delete(sessionId);
  releaseBrowserObservationListenersIfIdle();
  recording.resolveFinish(trace);
  return trace;
}

export async function handleRecordStart(
  manager: SessionManager,
  params: RecordStartParams,
  deps: RecordDeps = getDefaultDeps(),
): Promise<RecordStartResult | RpcError> {
  const traceVersionOrErr = negotiatedTraceVersion(params);
  if (typeof traceVersionOrErr !== "number") return traceVersionOrErr;
  if (traceVersionOrErr === 3 && !deps.cdp) {
    return {
      code: "protocol_error",
      message: "trace v3 recording requires an active CDP connection",
    };
  }

  const ctxOrErr = lookupSession(manager, params, "record_start");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (recordings.has(params.session_id)) {
    return {
      code: "protocol_error",
      message: `session ${params.session_id} is already recording`,
    };
  }
  // A new recording takes over the session's recovery slot. Expired slots are
  // swept first (R2-16): nothing else ever revisits the ordinary path, because
  // `get(null)` is the only read that can see a foreign or orphaned slot.
  await sweepExpiredFinishedTraces();
  await clearFinishedTrace(params.session_id);
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;

  // Register the recording *before* navigate so content-script syncAgentOverlay
  // on the destination page can RECORD_QUERY → rearm → show RecordOverlay
  // instead of flashing ControlOverlay ("Agent 正在控制").
  const requestId = makeRequestId(target.tabId);
  let resolveFinish!: (trace: RecordedTrace) => void;
  let rejectFinish!: (err: Error) => void;
  const finishPromise = new Promise<RecordedTrace>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  // Cancellation can precede record_await; keep its rejection handled.
  void finishPromise.catch(() => {});
  const isTabAllowed = (tabId: number) =>
    !ctx.remote || (manager.get(ctx.sessionId) === ctx && isAgentControlledTab(ctx, tabId));
  const navigateUrl = params.url ?? RECORD_DEFAULT_START_URL;
  const startedAtMs = Date.now();
  const maxPageTokens = params.max_page_tokens;
  const redactValues = params.redact_values ?? false;
  recordings.set(params.session_id, {
    requestId,
    tabs: new RecordingTabCoordinator(target.tabId, navigateUrl),
    agentWindowId: ctx.agentWindowId,
    isTabAllowed,
    startUrl: navigateUrl,
    ...(params.purpose ? { purpose: params.purpose } : {}),
    steps: [],
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    traceVersion: traceVersionOrErr,
    supportsTabSwitchSteps: params.supports_tab_switch_steps === true,
    finishPromise,
    resolveFinish,
    rejectFinish,
    settled: false,
    finishAttempt: null,
    observation:
      traceVersionOrErr === 3 && deps.cdp
        ? new RecordingObservationRuntime({
            cdp: deps.cdp,
            tabsApi: deps.tabsApi,
            maxTokens: maxPageTokens,
            redactValues,
            isTabAllowed: ctx.remote ? isTabAllowed : undefined,
          })
        : null,
    stoppedBy: "user_finish",
    awaited: false,
    navigationCallbacks: new Set(),
    // D5-1: stay out of the navigation stream until the tab has actually
    // landed on the start URL. The Agent Window's about:blank commits and the
    // start navigation's own commit are arming artifacts, not user steps; the
    // window home page and `Page.navigate` can both commit while this recording
    // is still registered (listeners attach before the start navigate).
    acceptingNavigation: false,
    actionQueue: Promise.resolve(),
    lastStepSequenceByProducer: new Map(),
  });
  deps.frameCoordinator?.begin(requestId, startedAtMs, target.tabId, async (scope) => {
    const recording = recordings.get(params.session_id);
    if (
      !recording ||
      recording.requestId !== requestId ||
      recording.settled ||
      !recording.isTabAllowed(scope.tabId)
    )
      return;
    try {
      await recording.observation?.refreshDocument(scope.tabId, scope.producerId);
    } catch {
      // The normal action-time capture remains available if a child Document
      // is replaced while its readiness refresh is in flight.
    }
  });
  // Observe navigations for the whole recording lifetime; attach before
  // optional navigate so the destination load can rearm capture.
  ensureBrowserObservationListeners(deps);

  const abortPending = async (notifyContent: boolean) => {
    recordings.get(params.session_id)?.observation?.cancel();
    deps.frameCoordinator?.cancel(requestId);
    recordings.delete(params.session_id);
    releaseBrowserObservationListenersIfIdle();
    if (notifyContent) {
      try {
        await deps.sendToTab(target.tabId, {
          type: RECORD_CANCEL,
          requestId,
        });
      } catch {
        // Content may never have received RECORD_START.
      }
    }
    if (deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(target.tabId, false);
      } catch {
        // Ignore cleanup errors.
      }
    }
  };

  const cancelledError = (): RpcError => ({
    code: "cancelled",
    message: "record_start aborted",
  });

  /** Dispatcher may race-cancel while we still hold a provisional recording. */
  const abortIfCancelled = async (notifyContent: boolean): Promise<RpcError | null> => {
    if (!deps.signal?.aborted) return null;
    await abortPending(notifyContent);
    return cancelledError();
  };

  {
    const cancelled = await abortIfCancelled(false);
    if (cancelled) return cancelled;
  }

  if (deps.cdp) {
    const nav = await handleNavigate(
      manager,
      {
        session_id: params.session_id,
        url: navigateUrl,
        tab_id: target.tabId,
      },
      { cdp: deps.cdp, tabsApi: deps.tabsApi, signal: deps.signal },
    );
    if (isRpcError(nav)) {
      await abortPending(false);
      return nav;
    }
    // The start navigate is awaited to `load`, so its own commit (if any) has
    // already consumed the marker. Drop anything left so an uncommitted start
    // command cannot later misattribute the user's first navigation.
    clearAgentInitiatedNavigation(target.tabId);
    {
      const cancelled = await abortIfCancelled(false);
      if (cancelled) return cancelled;
    }
    try {
      await waitForTabReady(target.tabId, deps.tabsApi);
    } catch {
      // Proceed with retries even if the tab never reports complete.
    }
    {
      const cancelled = await abortIfCancelled(false);
      if (cancelled) return cancelled;
    }
  }

  let startUrl: string | undefined;
  try {
    const tab = await deps.tabsApi.get(target.tabId);
    startUrl = tab.url;
  } catch {
    startUrl = navigateUrl;
  }

  const active = recordings.get(params.session_id);
  if (!active) {
    // Cleared by a concurrent abort / session teardown.
    return cancelledError();
  }
  active.startUrl = startUrl;
  // D5-1: the start URL is where recording really begins. Sync the cursor to
  // the landing page and drop any pending intent left over from arming, then
  // open the gate so later navigations are observed as usual.
  const startCursor = active.tabs.navigation(target.tabId, startUrl);
  startCursor.currentUrl = startUrl;
  startCursor.pendingNavigation = false;
  startCursor.pendingNavigationDeadline = undefined;
  active.acceptingNavigation = true;

  if (isContentScriptRestrictedUrl(startUrl)) {
    await abortPending(false);
    return {
      code: "invalid_params",
      message: params.url
        ? `cannot record on restricted URL (${startUrl}); use an http(s) page`
        : `cannot record on restricted URL (${startUrl}); default start page https://example.com/ did not load — pass --url with a page you can open`,
    };
  }

  {
    const cancelled = await abortIfCancelled(false);
    if (cancelled) return cancelled;
  }

  if (deps.bypassOverlay) {
    try {
      // Single ref for the initial race before RecordOverlay mounts; rearm must
      // not stack additional refs (see rearmRecording). Cleared on stop.
      await deps.bypassOverlay(target.tabId, true);
    } catch {
      // Best-effort; activeRecord also hides the control overlay.
    }
  }

  {
    const cancelled = await abortIfCancelled(true);
    if (cancelled) return cancelled;
  }

  const startMsg: RecordStartMessage = { type: RECORD_START, requestId, startedAtMs };

  try {
    if (deps.frameCoordinator) {
      const frameStarted = await deps.frameCoordinator.armTab(requestId, target.tabId);
      if (!frameStarted) throw new Error("top recording document did not start");
    }
    await sendRecordStartWithAck(target.tabId, startMsg, deps.sendToTab);
  } catch {
    await abortPending(true);
    return {
      code: "protocol_error",
      message:
        "failed to start recording in content script — reload the BrowserSkill extension, then retry",
    };
  }

  if (active.observation) {
    const activeRecording = recordings.get(params.session_id);
    if (activeRecording) {
      try {
        await activeRecording.observation?.captureInitial(target.tabId);
      } catch {
        // Proceed without initial observation; steps may be dropped by reducer.
      }
    }
  }

  {
    const cancelled = await abortIfCancelled(true);
    if (cancelled) return cancelled;
  }

  return { tab_id: target.tabId, recording: true };
}

export async function handleRecordStop(
  manager: SessionManager,
  params: RecordStopParams,
  deps: RecordDeps = getDefaultDeps(),
): Promise<RecordStopResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "record_stop");
  if (isRpcError(ctxOrErr)) return ctxOrErr;

  const recording = recordings.get(params.session_id);
  if (!recording) {
    // The page already ended the recording (user_finish) and this process was
    // recycled since; the parked trace is what `record stop` came for.
    const parked = await takeFinishedTrace(params.session_id);
    if (parked) return { trace: parked };
    return {
      code: "not_found",
      message: `no active recording for session ${params.session_id}`,
    };
  }

  const trace = await finishRecording(params.session_id, deps, "cli_stop");
  if (!trace) {
    return {
      code: "protocol_error",
      message: `failed to flush recorded steps for session ${params.session_id}; the recording is still active — retry \`bsk record stop\``,
    };
  }
  // A concurrent browser finish for this session may have parked a copy; the
  // caller already holds it, and a later stop must not resurrect it.
  await clearFinishedTrace(params.session_id);
  return { trace };
}

export async function handleRecordAwait(
  manager: SessionManager,
  params: RecordAwaitParams,
  deps: RecordDeps = getDefaultDeps(),
): Promise<RecordAwaitResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "record_await");
  if (isRpcError(ctxOrErr)) return ctxOrErr;

  const recording = recordings.get(params.session_id);
  if (!recording) {
    return {
      code: "not_found",
      message: `no active recording for session ${params.session_id}`,
    };
  }

  if (deps.signal?.aborted) {
    return { code: "cancelled", message: "record_await aborted" };
  }

  // This caller is the consumer of the finish promise, so the finish path must
  // not park a copy of the trace in `chrome.storage.session` on its way out.
  recording.awaited = true;
  const outcome = await new Promise<{ trace: RecordedTrace } | { error: RpcError }>((resolve) => {
    let settled = false;
    const finish = (result: { trace: RecordedTrace } | { error: RpcError }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ error: { code: "cancelled", message: "record_await aborted" } });
    const timer =
      params.timeout_ms === undefined
        ? undefined
        : setTimeout(
            () =>
              finish({
                error: {
                  code: "timeout",
                  message: `record_await timed out after ${params.timeout_ms}ms`,
                },
              }),
            params.timeout_ms,
          );
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    void recording.finishPromise.then(
      (trace) => finish({ trace }),
      () =>
        finish({
          error: { code: "cancelled", message: "recording was cleared" },
        }),
    );
  });
  if ("trace" in outcome) {
    // Belt and braces: a concurrent `record stop` may still have parked a copy
    // (it wins the finish attempt but not the ownership flag), and a slot whose
    // trace the CLI already holds is dead weight.
    await clearFinishedTrace(params.session_id);
    return { trace: outcome.trace };
  }
  // We bailed out (timeout / abort) without receiving a trace, so ownership of
  // the finish must go back to the detach-mode parking path — the CLI has no
  // trace and a later `record stop` is the only way to collect it.
  if (recordings.get(params.session_id) === recording && !recording.settled) {
    // Still running: the finish attempt has not yet read `awaited`.
    recording.awaited = false;
  } else {
    // The attempt already decided not to park because it saw `awaited`; park
    // its product here instead (a concurrent `record stop` simply consumes it).
    void recording.finishPromise.then(
      (trace) => {
        if (recording.stoppedBy === "user_finish") {
          stashFinishedTrace(params.session_id, trace, "user_finish");
        }
      },
      () => {},
    );
  }
  return outcome.error;
}

export function clearRecordingForSession(sessionId: string): void {
  // Teardown does **not** touch the parked trace (R2-15): it is the finished
  // product of a session, not session state, and CLI teardown / an idle reaper
  // can land between the page's `user_finish` and the CLI's `record stop`. Only
  // a new `record start` (handleRecordStart) or a consuming `record stop`
  // (handleRecordStop) clears it.
  const recording = recordings.get(sessionId);
  if (!recording) {
    recordings.delete(sessionId);
    releaseBrowserObservationListenersIfIdle();
    return;
  }
  void clearRearmTimersForRecording(recording, getDefaultDeps());
  if (!recording.settled) {
    getDefaultDeps().frameCoordinator?.cancel(recording.requestId);
    recording.observation?.cancel();
    recording.settled = true;
    recording.rejectFinish(new Error("recording cleared"));
  }
  recordings.delete(sessionId);
  releaseBrowserObservationListenersIfIdle();
}

export type { RecordFinishMessage };
