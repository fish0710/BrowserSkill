import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORD_FINISH, RECORD_START, RECORD_STEP, RECORD_STOP } from "@/lib/record-bridge";
import { noteAgentInitiatedNavigation } from "@/lib/recording/agent-navigation";
import type { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { EXTENSION_VERSION } from "@/transport/handshake";
import type {
  RecordAwaitResult,
  RecordedTrace,
  RecordStopResult,
  TraceV3,
} from "@/transport/types";
import {
  attachRecordFinishListener,
  attachRecordStepListener,
  clearRecordingForSession,
  finishedTraceStorageKeyForTests,
  handleRecordAwait,
  handleRecordStart,
  handleRecordStop,
  hasFinishedTraceForTests,
  lastDraftArrivedAtForTests,
  recycleFinishedTracesForTests,
  resetBrowserObservationForTests,
} from "../record";

const AGENT_WINDOW_ID = 100;
const TAB_ID = 4;
const START_URL = "https://example.com/";
/** R2-9: one parked-trace slot per session, not one shared key. */
const PARKED_TRACE_KEY = "bsk_record_finished:abcd";
const RECORD_START_V3 = {
  session_id: "abcd",
  url: START_URL,
  trace_version: 3 as const,
  supports_tab_switch_steps: true,
};
const stepSequenceByProducer = new Map<string, number>();

function asTraceV3(trace: RecordedTrace): TraceV3 {
  if (!("version" in trace)) {
    throw new Error("expected v3 trace");
  }
  return trace;
}

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

function chromeEvent<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

/**
 * In-memory stand-in for `chrome.storage.session`. Values are JSON round-tripped
 * so a parked trace must be serializable, and the area survives a simulated
 * service-worker recycle as long as the fake lives.
 */
function makeSessionStorage() {
  const items: Record<string, unknown> = {};
  return {
    items,
    get: vi.fn(async (key: string | null) => {
      // `null` reads the whole area, which is how the expiry sweep finds slots
      // owned by other sessions (R2-16).
      if (key === null) return JSON.parse(JSON.stringify(items)) as Record<string, unknown>;
      return key in items ? { [key]: JSON.parse(JSON.stringify(items[key])) } : {};
    }),
    set: vi.fn(async (next: Record<string, unknown>) => {
      Object.assign(items, next);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete items[key];
    }),
  };
}

function installChrome() {
  const runtimeOnMessage = chromeEvent<RuntimeListener>();
  const storageSession = makeSessionStorage();
  const tabsOnActivated = chromeEvent<(activeInfo: chrome.tabs.TabActiveInfo) => unknown>();
  const webNavigationOnCompleted =
    chromeEvent<(details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => unknown>();
  const webNavigationOnCommitted =
    chromeEvent<
      (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => unknown
    >();
  vi.stubGlobal("chrome", {
    runtime: { onMessage: runtimeOnMessage },
    tabs: {
      onActivated: tabsOnActivated,
      onCreated: chromeEvent(),
      onUpdated: chromeEvent(),
    },
    webNavigation: {
      onCompleted: webNavigationOnCompleted,
      onCommitted: webNavigationOnCommitted,
    },
    storage: { session: storageSession },
  });
  return {
    runtimeOnMessage,
    tabsOnActivated,
    webNavigationOnCompleted,
    webNavigationOnCommitted,
    storageSession,
  };
}

function fakeManager() {
  return {
    get: (id: string) =>
      id === "abcd"
        ? {
            sessionId: "abcd",
            agentWindowId: AGENT_WINDOW_ID,
            refStore: { resolve: () => null, replace: () => {} },
            borrowedTabs: new Map(),
          }
        : null,
    findByWindowId: (windowId: number) =>
      windowId === AGENT_WINDOW_ID ? { sessionId: "abcd" } : null,
  } as unknown as SessionManager;
}

/** One AX tree per capture; the last one repeats once the script runs out. */
function axTree(rootName: string, controls: string[] = []): unknown {
  return {
    nodes: [
      {
        nodeId: "1",
        backendDOMNodeId: 1,
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computed", value: rootName },
        childIds: controls.map((_, index) => `${index + 2}`),
      },
      ...controls.map((name, index) => ({
        nodeId: `${index + 2}`,
        parentId: "1",
        backendDOMNodeId: index + 2,
        role: { type: "role", value: "button" },
        name: { type: "computed", value: name },
      })),
    ],
  };
}

type FakeCdp = CdpRunner & {
  /** Simulate captures racing a document swap. */
  setCaptureFailure(failing: boolean): void;
  /** Keep the page reporting DOM churn for this long, as a slow render would. */
  setBusyFor(ms: number): void;
};

/** Long enough that the recorder treats the page as done reacting. */
const LONG_IDLE_MS = 10_000;

/** AX-only page: DOMSnapshot calls throw so capture falls back to the AX tree. */
function makeFakeCdp(
  trees?: unknown[],
  options?: {
    failCaptures?: boolean;
    treesByTab?: Record<number, unknown>;
    /** Runs inside `Page.navigate`, before its lifecycle events. */
    onNavigate?: () => void;
  },
): FakeCdp {
  type EventListener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => void;
  const events: EventListener[] = [];
  const script = [...(trees ?? [])];
  let failing = options?.failCaptures ?? false;
  let busyUntil = 0;
  const handlers: Record<string, (params: unknown, tabId: number) => unknown> = {
    "Page.enable": () => ({}),
    "Page.setLifecycleEventsEnabled": () => ({}),
    "Page.getFrameTree": () => ({
      frameTree: { frame: { id: "frame-1", loaderId: "loader-before" } },
    }),
    "Page.navigate": (_params, tabId) => {
      options?.onNavigate?.();
      for (const listener of [...events]) {
        listener({ tabId }, "Page.lifecycleEvent", {
          name: "load",
          frameId: "frame-1",
          loaderId: "loader-after",
        });
      }
      return { frameId: "frame-1", loaderId: "loader-after" };
    },
    "Page.getLayoutMetrics": () => ({
      cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 },
    }),
    "Runtime.enable": () => ({}),
    "Runtime.evaluate": (params: unknown) => {
      const expression = String((params as { expression?: string })?.expression ?? "");
      if (!expression.includes("__bskRecordQuiet")) return { result: { value: "complete" } };
      const idleMs = Date.now() >= busyUntil ? LONG_IDLE_MS : 0;
      return { result: { value: { idleMs, readyState: "complete" } } };
    },
    "Accessibility.enable": () => ({}),
    "Accessibility.getFullAXTree": (_params, _tabId) => {
      if (failing) throw new Error("Execution context was destroyed");
      const tabTree = options?.treesByTab?.[_tabId];
      if (tabTree) return tabTree;
      if (script.length === 0) return axTree("Example Domain", ["Submit"]);
      return script.length === 1 ? script[0] : script.shift();
    },
  };

  return {
    send: (async (_tabId: number, method: string, params: unknown) => {
      const handler = handlers[method];
      if (!handler) throw new Error(`unsupported CDP call ${method}`);
      return handler(params, _tabId);
    }) as CdpRunner["send"],
    setCaptureFailure: (next: boolean) => {
      failing = next;
    },
    setBusyFor: (ms: number) => {
      busyUntil = Date.now() + ms;
    },
    trackSessionTab: () => {},
    onEvent: (handler: EventListener) => {
      events.push(handler);
      return {
        dispose: () => {
          const index = events.indexOf(handler);
          if (index >= 0) events.splice(index, 1);
        },
      };
    },
  };
}

/**
 * Two detached recordings, each in its own Agent Window, running at once
 * (R2-9). The shared `fakeManager` only knows one session, so the concurrency
 * tests build their own owner map.
 */
function makeTwoSessionManager() {
  const makeContext = (sessionId: string, agentWindowId: number) => ({
    sessionId,
    agentWindowId,
    refStore: { resolve: () => null, replace: () => {} },
    borrowedTabs: new Map(),
  });
  const sessions = new Map([
    ["abcd", makeContext("abcd", AGENT_WINDOW_ID)],
    ["efgh", makeContext("efgh", 200)],
  ]);
  return {
    get: (id: string) => sessions.get(id) ?? null,
    findByWindowId: (windowId: number) =>
      windowId === AGENT_WINDOW_ID
        ? { sessionId: "abcd" }
        : windowId === 200
          ? { sessionId: "efgh" }
          : null,
  } as unknown as SessionManager;
}

function makeTabsApi() {
  const tab = {
    id: TAB_ID,
    windowId: AGENT_WINDOW_ID,
    active: true,
    status: "complete",
    url: START_URL,
    title: "Example Domain",
  } as chrome.tabs.Tab;
  return {
    get: async () => tab,
    query: async () => [tab],
    /** Mirror the browser moving the tab, so captures record the live URL. */
    goTo(url: string, title: string) {
      Object.assign(tab, { url, title });
    },
  };
}

function makeMultiTabsApi(tabs: chrome.tabs.Tab[]) {
  const byId = new Map(tabs.flatMap((tab) => (typeof tab.id === "number" ? [[tab.id, tab]] : [])));
  return {
    get: async (tabId: number) => {
      const tab = byId.get(tabId);
      if (!tab) throw new Error(`tab ${tabId} closed`);
      return tab;
    },
    query: async (query: chrome.tabs.QueryInfo) =>
      [...byId.values()].filter(
        (tab) =>
          (query.windowId === undefined || tab.windowId === query.windowId) &&
          (query.active === undefined || tab.active === query.active),
      ),
    activate(tabId: number) {
      for (const tab of byId.values()) tab.active = tab.id === tabId;
    },
    goTo(tabId: number, url: string, title: string) {
      const tab = byId.get(tabId);
      if (!tab) throw new Error(`tab ${tabId} closed`);
      Object.assign(tab, { url, title });
    },
  };
}

/** Outlast a settle on a quiet page plus the per-tab observation cooldown. */
function settleWait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 800));
}

function runtimeOnMessageEmit(
  chromeApi: ReturnType<typeof installChrome>,
  requestId: string,
  step: unknown,
  tabId = TAB_ID,
  active = true,
): ReturnType<typeof vi.fn> {
  const producerId = `test-producer-${tabId}`;
  const producerKey = `${requestId}:${producerId}`;
  const sequence = (stepSequenceByProducer.get(producerKey) ?? 0) + 1;
  stepSequenceByProducer.set(producerKey, sequence);
  const sendResponse = vi.fn();
  chromeApi.runtimeOnMessage.emit(
    { type: RECORD_STEP, requestId, producerId, sequence, step },
    { tab: { id: tabId, active } } as chrome.runtime.MessageSender,
    sendResponse,
  );
  return sendResponse;
}

describe("recorded user steps reach the exported trace", () => {
  afterEach(() => {
    stepSequenceByProducer.clear();
    resetBrowserObservationForTests();
    vi.unstubAllGlobals();
  });

  it("keeps a click captured after start, even when the step listener has no cdp", async () => {
    const { runtimeOnMessage } = installChrome();
    const manager = fakeManager();
    const cdp = makeFakeCdp();
    const tabsApi = makeTabsApi();

    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });

    const startDeps = { tabsApi, sendToTab, cdp };
    const started = await handleRecordStart(manager, RECORD_START_V3, startDeps);
    expect(started).toEqual({ tab_id: TAB_ID, recording: true });
    expect(requestId).not.toBe("");

    // Background attaches this listener at service-worker startup, where no
    // CDP runner is available — the recording must supply its own.
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessage.emit(
      {
        type: RECORD_STEP,
        requestId,
        producerId: "test-producer-4",
        sequence: 1,
        step: {
          op: "click",
          page_url: START_URL,
          target: { role: "button", name: "Submit", tag: "button" },
          geometry: {
            rect: { x: 0, y: 0, w: 10, h: 10 },
            tag: "button",
          },
        },
      },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.recorder.bsk).toBe(EXTENSION_VERSION);
    expect(trace.steps).toHaveLength(1);
    const [step] = trace.steps;
    expect(step?.op).toBe("click");
    expect(step?.state).toBeTruthy();
    expect(step?.result.state).toBeTruthy();
    expect(trace.states.length).toBeGreaterThan(0);
  });

  it("keeps a fill followed by a click in recorded order", async () => {
    const { runtimeOnMessage } = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();

    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });
    attachRecordStepListener({ tabsApi, sendToTab });

    let sequence = 0;
    const emit = (step: unknown) => {
      sequence += 1;
      runtimeOnMessage.emit(
        { type: RECORD_STEP, requestId, producerId: "test-producer-4", sequence, step },
        { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
        () => {},
      );
    };

    const fill = {
      op: "fill",
      page_url: START_URL,
      target: { role: "textbox", name: "Search", tag: "input" },
      value: "hello",
      commit: "enter",
    };
    emit(fill);
    const duplicateAck = vi.fn();
    runtimeOnMessage.emit(
      {
        type: RECORD_STEP,
        requestId,
        producerId: "test-producer-4",
        sequence: 1,
        step: fill,
      },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      duplicateAck,
    );
    expect(duplicateAck).toHaveBeenCalledWith({ ok: true, sequence: 1 });
    emit({
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "Submit", tag: "button" },
    });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["fill", "click"]);
    expect(trace.steps.map((step) => step.id)).toEqual([1, 2]);
    for (const step of trace.steps) {
      expect(step.state).toBeTruthy();
      expect(step.result.state).toBeTruthy();
    }
  });

  it("keeps a browser-observed navigation as a step", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async () => ({ ok: true }));

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });

    const destination = "https://example.com/next";
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: destination,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    // Let findRecordingForTab's tab lookup and the settle capture resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toHaveLength(1);
    const [step] = trace.steps;
    expect(step?.op).toBe("navigate");
    expect(step?.state).toBeTruthy();
    expect(step?.result.state).toBeTruthy();
  });

  it("drops the arming about:blank and start-url commits, then records an explicit navigate", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async () => ({ ok: true }));
    const commit = (url: string, transitionType: string) =>
      chromeApi.webNavigationOnCommitted.emit({
        tabId: TAB_ID,
        frameId: 0,
        url,
        transitionType,
        transitionQualifiers: [],
      } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    // D5 §1.1: the Agent Window home page and the start navigation itself can
    // both commit while `Page.navigate` is in flight, i.e. while the recording
    // exists but has not armed on the start URL yet.
    const cdp = makeFakeCdp([axTree("Start page")], {
      onNavigate: () => {
        commit("about:blank", "link");
        commit("about:blank", "browser");
        commit(START_URL, "typed");
      },
    });

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp });
    attachRecordStepListener({ tabsApi, sendToTab });

    // Late arming reports must not turn into leading navigate steps either:
    // the buffer has no action step yet and a stale about:blank commit is
    // dropped, while the start URL already is the cursor.
    commit("about:blank", "link");
    commit(START_URL, "typed");
    await settleWait();

    // An explicit navigation after start is still its own step (E7).
    const destination = "https://example.com/navigation/start";
    tabsApi.goTo(destination, "Start page");
    noteAgentInitiatedNavigation(TAB_ID);
    commit(destination, "typed");
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = asTraceV3((stopped as RecordStopResult).trace);

    expect(trace.steps.map((step) => step.op)).toEqual(["navigate"]);
    expect(trace.steps[0]).toMatchObject({ op: "navigate", to: destination });
  }, 20_000);

  it("keeps an explicit typed navigation as its own step after a click that did not navigate", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("Account", ["Profile beta"]), axTree("Start page", ["Details"])]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    // A click on a panel control: `expects_navigation` defaults to true, but the
    // page never navigates, so the intent stays unconsumed.
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "link", name: "Profile beta", tag: "a" },
      expects_navigation: true,
    });
    await settleWait();

    // Then the agent issues `bsk navigate`: Chrome commits it as a typed /
    // address-bar navigation (D2 §2.2).
    const destination = "https://example.com/navigation/start";
    tabsApi.goTo(destination, "Start page");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: destination,
      transitionType: "typed",
      transitionQualifiers: ["from_address_bar"],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click", "navigate"]);
    expect(trace.steps[1]).toMatchObject({
      op: "navigate",
      to: destination,
      cause: "user_typed",
    });
  }, 15_000);

  it("appends the navigation as its own step when the agent marker explains the commit", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("Account", ["Profile beta"]), axTree("Start page")]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "link", name: "Profile beta", tag: "a" },
      expects_navigation: true,
    });
    await settleWait();

    // `handleNavigate` marks the tab; simulate that, then commit with metadata
    // that does *not* identify an address-bar navigation, so only the marker
    // can explain the commit.
    const destination = "https://example.com/navigation/start";
    noteAgentInitiatedNavigation(TAB_ID);
    tabsApi.goTo(destination, "Start page");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: destination,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click", "navigate"]);
  }, 15_000);

  it("still merges a click-driven link navigation into the click", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("Start page", ["Details"]), axTree("Detail page")]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "link", name: "Details", tag: "a" },
      expects_navigation: true,
    });
    const destination = "https://example.com/navigation/detail";
    tabsApi.goTo(destination, "Detail page");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: destination,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    const resultState = trace.states.find((state) => state.id === trace.steps[0]?.result.state);
    expect(resultState?.url).toBe(destination);
  }, 15_000);

  it("reports an address-bar navigation from the page it started on, not the redirect hop", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([
        axTree("Example Domain", ["Learn more"]),
        axTree("腾讯 iWiki"),
        axTree("工作台 - 腾讯iWiki", ["文档C+D"]),
      ]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    const commit = (url: string, transitionType: string, transitionQualifiers: string[] = []) => {
      chromeApi.webNavigationOnCommitted.emit({
        tabId: TAB_ID,
        frameId: 0,
        url,
        transitionType,
        transitionQualifiers,
      } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    };

    // Typed https://iwiki.woa.com/ in the address bar; the site bounces to
    // /dashboard, so the bare host is a hop the flow never acts on.
    tabsApi.goTo("https://iwiki.woa.com/", "腾讯 iWiki");
    commit("https://iwiki.woa.com/", "typed");
    await settleWait();

    tabsApi.goTo("https://iwiki.woa.com/dashboard", "工作台 - 腾讯iWiki");
    commit("https://iwiki.woa.com/dashboard", "link", ["server_redirect"]);
    await settleWait();

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: "https://iwiki.woa.com/dashboard",
      target: { role: "button", name: "文档C+D", tag: "button" },
    });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.states.map((state) => state.url)).toEqual([
      START_URL,
      "https://iwiki.woa.com/dashboard",
    ]);
    expect(trace.states.map((state) => state.id)).toEqual(["s1", "s2"]);
    expect(trace.steps[0]).toMatchObject({
      op: "navigate",
      id: 1,
      state: "s1",
      result: { state: "s2" },
      to: "https://iwiki.woa.com/dashboard",
      cause: "user_typed",
    });
    expect(trace.steps[1]).toMatchObject({ op: "click", id: 2, state: "s2" });
    // The dashboard page lists the click performed on it, numbered as shipped.
    expect(trace.states[1]?.body).toContain("steps_here: [2]");
  }, 15_000);

  it("coalesces OAuth redirect hops into one navigate so the next click binds to the landing page", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const loginUrl = "https://passport.example/login";
    const callbackUrl = "https://passport.example/callback";
    const dashboardUrl = "https://app.example/dashboard";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([
        axTree("Example Domain"),
        axTree("OA登录", ["发起验证"]),
        axTree("工作台", ["新建"]),
        axTree("工作台", ["新建", "文档"]),
      ]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    const commit = (url: string, transitionType: string, transitionQualifiers: string[] = []) => {
      chromeApi.webNavigationOnCommitted.emit({
        tabId: TAB_ID,
        frameId: 0,
        url,
        transitionType,
        transitionQualifiers,
      } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    };

    tabsApi.goTo(loginUrl, "OA登录");
    commit(loginUrl, "link");
    await settleWait();

    // Phone / IdP confirmation comes back as a redirect chain — intermediate
    // hops must not leave lastSettled stuck on the login page.
    tabsApi.goTo(callbackUrl, "OA登录");
    commit(callbackUrl, "link", ["server_redirect"]);
    tabsApi.goTo(dashboardUrl, "工作台");
    commit(dashboardUrl, "link", ["client_redirect"]);
    await settleWait();

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: dashboardUrl,
      target: { role: "button", name: "新建", tag: "button" },
    });
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    // Login → dashboard may collapse into one navigate in the reducer; what
    // matters is the click is bound to the dashboard observation, not login.
    const click = trace.steps.find((step) => step.op === "click");
    expect(click).toMatchObject({
      op: "click",
      target: { role: "button", name: "新建" },
    });
    const clickState = trace.states.find((state) => state.id === click?.state);
    expect(clickState?.url).toBe(dashboardUrl);
    expect(trace.steps.some((step) => step.op === "navigate" && step.to === dashboardUrl)).toBe(
      true,
    );
  }, 15_000);

  it("keeps the final action when recording stops before it has settled", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("编辑", ["发布"]), axTree("已发布")]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    // Click 发布, the page navigates to the published doc, and the user hits
    // finish immediately — no time for the post-action capture to land.
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    tabsApi.goTo("https://example.com/published", "已发布");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.com/published",
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]).toMatchObject({ target: { name: "发布" } });
  }, 15_000);

  it("keeps an action whose post-action capture keeps failing", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    // Only the initial observation succeeds; every later capture throws.
    const cdp = makeFakeCdp([axTree("编辑", ["发布"])]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    cdp.setCaptureFailure(true);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    // No post-action observation exists anywhere, but the action still happened.
    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]?.state).toBe("s1");
    expect(trace.steps[0]?.result.state).toBe("s1");
  }, 15_000);

  it("retries a post-action capture that lost its execution context", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([axTree("编辑", ["发布"]), axTree("已发布", ["编辑"])]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    // The document swaps while the settle capture runs, then the published
    // page becomes available.
    cdp.setCaptureFailure(true);
    tabsApi.goTo("https://example.com/published", "已发布");
    setTimeout(() => cdp.setCaptureFailure(false), 450);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]?.result.state).toBe("s2");
    expect(trace.states[1]?.url).toBe("https://example.com/published");
  }, 15_000);

  it("settles a still-unsettled action against the page as it stands at stop", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([axTree("编辑", ["发布"]), axTree("已发布", ["编辑"])]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    // Every settle attempt fails; only the page as it stands at stop is
    // readable.
    cdp.setCaptureFailure(true);
    await settleWait();
    tabsApi.goTo("https://example.com/published", "已发布");
    cdp.setCaptureFailure(false);

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]?.state).toBe("s1");
    expect(trace.steps[0]?.result.state).toBe("s2");
    expect(trace.states[1]?.url).toBe("https://example.com/published");
  }, 15_000);

  it("keeps the observation of an action that navigates while it settles", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([
      axTree("列表", ["deepsearch"]),
      axTree("分组", ["添加配置"]),
      axTree("分组 已展开", ["添加配置", "确认"]),
      axTree("停止时的页面", ["无关"]),
    ]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "treeitem", name: "deepsearch", tag: "div" },
      expects_navigation: true,
    });
    // The SPA swaps the URL while the settle for that click is still waiting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    tabsApi.goTo("https://example.com/list?group=deepsearch", "分组");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.com/list?group=deepsearch",
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await settleWait();

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: "https://example.com/list?group=deepsearch",
      target: { role: "button", name: "添加配置", tag: "button" },
    });
    await settleWait();

    // Whatever the page looks like when the user stops must not become the
    // landing state of an earlier step.
    tabsApi.goTo("https://example.com/elsewhere", "停止时的页面");
    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click", "click"]);
    const [first, second] = trace.steps;
    expect(first?.result.state).toBe(second?.state);
    const landing = trace.states.find((state) => state.id === first?.result.state);
    expect(landing?.url).toBe("https://example.com/list?group=deepsearch");
  }, 15_000);

  it("lands a mid-flow step on where the flow continued, not on the page at stop", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([
      axTree("列表", ["deepsearch"]),
      axTree("分组", ["添加配置"]),
      axTree("分组 已展开", ["确认"]),
      axTree("停止时的页面", ["无关"]),
    ]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    // First click: its own settle never produces an observation.
    cdp.setCaptureFailure(true);
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "treeitem", name: "deepsearch", tag: "div" },
    });
    await settleWait();

    // The flow visibly continues on the group page, which is therefore where
    // the first click landed.
    cdp.setCaptureFailure(false);
    tabsApi.goTo("https://example.com/list?group=deepsearch", "分组");
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: "https://example.com/list?group=deepsearch",
      target: { role: "button", name: "添加配置", tag: "button" },
    });
    await settleWait();

    tabsApi.goTo("https://example.com/elsewhere", "停止时的页面");
    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click", "click"]);
    const [first, second] = trace.steps;
    // E9: with a failed capture in between, the failed step is backfilled from
    // the next observation that was genuinely sampled after it arrived. That is
    // the group page the second click ran on, and it must NOT be the page that
    // only exists because the recording stopped (the old landing write could
    // produce exactly that). Note the pre-state is no longer required to equal
    // the previous result: the second click's pre-state was rejected as "late"
    // (it was sampled after the click arrived) and falls back to the burst-wide
    // snapshot, while its *result* is the real one.
    expect(first?.result.state).not.toBe(first?.state);
    const landing = trace.states.find((state) => state.id === first?.result.state);
    expect(landing?.url).toBe("https://example.com/list?group=deepsearch");
    expect(trace.states.some((state) => state.url === "https://example.com/elsewhere")).toBe(false);
  }, 15_000);

  it("waits for a slow page to stop changing before recording where a click landed", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([axTree("列表", ["打开"]), axTree("详情", ["返回"])]);
    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp });
    attachRecordStepListener({ tabsApi, sendToTab });

    // The click starts a render that runs well past any fixed settle delay.
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "打开", tag: "button" },
    });
    cdp.setBusyFor(900);
    setTimeout(() => tabsApi.goTo("https://example.com/detail", "详情"), 800);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    const [step] = trace.steps;
    const landing = trace.states.find((state) => state.id === step?.result.state);
    expect(landing?.url).toBe("https://example.com/detail");
  }, 15_000);

  it("lets the next action end a settle that is still waiting on the page", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([
      axTree("编辑器 弹窗", ["输入标题", "确定"]),
      axTree("编辑器", ["发布"]),
    ]);
    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp });
    attachRecordStepListener({ tabsApi, sendToTab });

    // Typing keeps the page busy, so the fill has not settled when the user
    // confirms the dialog — the confirmation closes it and changes the page.
    cdp.setBusyFor(600);
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "fill",
      page_url: START_URL,
      target: { role: "textbox", name: "输入标题", tag: "input" },
      value: "标题",
      commit: "blur",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "确定", tag: "button" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["fill", "click"]);
    const [fill, click] = trace.steps;
    // E9: the fill's own settle was superseded by the click, so the fill is
    // backfilled from the first observation sampled after the burst. At stop that
    // is the closed-dialog page, not the page the click produced by itself: the
    // result must be a state that was actually observed after the fill arrived.
    expect(fill?.result.state).not.toBe(fill?.state);
    expect(click?.result.state).not.toBe(click?.state);
    const fillLanding = trace.states.find((state) => state.id === fill?.result.state);
    expect(fillLanding?.body).not.toContain("输入标题");
    expect(fillLanding?.body).toContain("发布");
  }, 15_000);

  it("ignores a capture that yields no step instead of rewriting the previous one", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([
        axTree("Example Domain", ["Submit"]),
        axTree("Loading"),
        axTree("Done", ["Next"]),
      ]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "Submit", tag: "button" },
      expects_navigation: true,
    });
    // Let the click settle on the page it led to, so the current observation
    // is no longer the page the click happened on.
    tabsApi.goTo("https://example.com/next", "Done");
    await settleWait();

    // A click on an element the capture cannot name produces no step at all.
    runtimeOnMessageEmit(chromeApi, requestId, { op: "click", page_url: START_URL });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toMatchObject({
      op: "click",
      state: "s1",
      result: { state: "s2" },
      target: { name: "Submit" },
    });
    expect(trace.states.map((state) => state.url)).toEqual([START_URL, "https://example.com/next"]);
  }, 15_000);

  it("flushes content capture before draining the final recorded action", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      if (typed.type === RECORD_STOP) {
        runtimeOnMessageEmit(chromeApi, requestId, {
          op: "fill",
          page_url: START_URL,
          target: { role: "textbox", name: "Draft", tag: "input" },
          value: "saved at stop",
          commit: "blur",
        });
      }
      return { ok: true };
    });

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });
    attachRecordStepListener({ tabsApi, sendToTab });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toEqual([expect.objectContaining({ op: "fill", value: "saved at stop" })]);
  });

  it("drains a redirect landing when stop begins during coalescing", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async () => ({ ok: true }));
    const intermediateUrl = "https://idp.example/callback";
    const finalUrl = "https://app.example/home";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("Start"), axTree("Home")]),
    });

    tabsApi.goTo(finalUrl, "Home");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: intermediateUrl,
      transitionType: "link",
      transitionQualifiers: ["server_redirect"],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await Promise.resolve();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toEqual([expect.objectContaining({ op: "navigate", to: finalUrl })]);
  }, 15_000);

  it("registers a settled action capture under the live final URL", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const intermediateUrl = "https://example.com/loading";
    const finalUrl = "https://example.com/result";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("Search", ["Go"]), axTree("Result", ["Open"])]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "Go", tag: "button" },
      expects_navigation: true,
    });
    tabsApi.goTo(intermediateUrl, "Loading");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: intermediateUrl,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    tabsApi.goTo(finalUrl, "Result");

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;
    const resultState = trace.states.find((state) => state.id === trace.steps[0]?.result.state);

    expect(resultState?.url).toBe(finalUrl);
  }, 15_000);

  it("lets a concurrent CLI stop await the browser finish winner", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    let releaseStop!: () => void;
    const stopReleased = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let announceStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      announceStop = resolve;
    });
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      if (typed.type === RECORD_STOP) {
        announceStop();
        await stopReleased;
      }
      return { ok: true };
    });

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });
    attachRecordFinishListener({ tabsApi, sendToTab });
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await stopStarted;

    const cliStop = handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    releaseStop();
    const stopped = await cliStop;

    expect(asTraceV3((stopped as RecordStopResult).trace).stopped_by).toBe("user_finish");
  });

  it("hands a user_finish trace to a later record stop after the page ended it", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    // Nobody calls handleRecordAwait: this is the detach path.
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await vi.waitFor(() => expect(hasFinishedTraceForTests("abcd")).toBe(true));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);

    expect(trace.stopped_by).toBe("user_finish");
    expect(trace.recorder.bsk).toBe(EXTENSION_VERSION);
    // Collecting the trace consumes the recovery slot exactly once.
    expect(hasFinishedTraceForTests("abcd")).toBe(false);
    expect(chromeApi.storageSession.items[PARKED_TRACE_KEY]).toBeUndefined();
    expect(await handleRecordStop(manager, { session_id: "abcd" }, deps)).toMatchObject({
      code: "not_found",
    });
  });

  it("does not park the trace a blocking record_await already holds", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    // The blocking consumer: this is the CLI, which receives the trace inline.
    const awaited = handleRecordAwait(manager, { session_id: "abcd" }, deps);
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );

    const result = (await awaited) as RecordAwaitResult;
    expect(asTraceV3(result.trace).stopped_by).toBe("user_finish");
    // No second consumer exists, so nothing may occupy the 10MB-quota slot.
    expect(hasFinishedTraceForTests("abcd")).toBe(false);
    await Promise.resolve();
    expect(chromeApi.storageSession.items[PARKED_TRACE_KEY]).toBeUndefined();
    expect(await handleRecordStop(manager, { session_id: "abcd" }, deps)).toMatchObject({
      code: "not_found",
    });
  });

  it("hands the trace to a later stop when record_await times out", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    // The CLI waits with a short timeout; the page ends the recording after it
    // gave up, so the trace is still outstanding and must stay recoverable.
    expect(
      await handleRecordAwait(manager, { session_id: "abcd", timeout_ms: 1 }, deps),
    ).toMatchObject({ code: "timeout" });
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await vi.waitFor(() => expect(hasFinishedTraceForTests("abcd")).toBe(true));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    expect(asTraceV3((stopped as RecordStopResult).trace).stopped_by).toBe("user_finish");
  });

  it("recovers a parked user_finish trace after an MV3 worker recycle", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await vi.waitFor(() => expect(hasFinishedTraceForTests("abcd")).toBe(true));

    // The worker is recycled: the in-memory map dies, storage.session lives on.
    await recycleFinishedTracesForTests();
    expect(hasFinishedTraceForTests("abcd")).toBe(false);
    expect(chromeApi.storageSession.items[PARKED_TRACE_KEY]).toMatchObject({
      sessionId: "abcd",
      stoppedBy: "user_finish",
    });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);

    expect(trace.stopped_by).toBe("user_finish");
    expect(trace.recorder.bsk).toBe(EXTENSION_VERSION);
    expect(chromeApi.storageSession.items[PARKED_TRACE_KEY]).toBeUndefined();
    expect(await handleRecordStop(manager, { session_id: "abcd" }, deps)).toMatchObject({
      code: "not_found",
    });
  });

  it("drops a parked trace older than the recovery window", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await vi.waitFor(() => expect(hasFinishedTraceForTests("abcd")).toBe(true));

    const staleAt = Date.now() - 25 * 60 * 60 * 1000;
    (chromeApi.storageSession.items[PARKED_TRACE_KEY] as { finishedAt: number }).finishedAt =
      staleAt;
    await recycleFinishedTracesForTests();

    expect(await handleRecordStop(manager, { session_id: "abcd" }, deps)).toMatchObject({
      code: "not_found",
    });
    // The expired slot is discarded rather than kept for the next stop.
    expect(chromeApi.storageSession.items[PARKED_TRACE_KEY]).toBeUndefined();
  });

  it("drops a parked trace when a new recording starts for the session", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await vi.waitFor(() => expect(hasFinishedTraceForTests("abcd")).toBe(true));

    await handleRecordStart(manager, RECORD_START_V3, deps);

    expect(hasFinishedTraceForTests("abcd")).toBe(false);
    expect(chromeApi.storageSession.items[PARKED_TRACE_KEY]).toBeUndefined();
    // The fresh recording owns the session, so stop reports its own trace.
    await recycleFinishedTracesForTests();
    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    expect(asTraceV3((stopped as RecordStopResult).trace).stopped_by).toBe("cli_stop");
  });

  it("keeps both traces when two detached recordings finish concurrently", async () => {
    const chromeApi = installChrome();
    const manager = makeTwoSessionManager();
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
      {
        id: 7,
        windowId: 200,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
    ]);
    const requestIds = new Map<number, string>();
    const sendToTab = vi.fn(async (tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestIds.set(tabId, typed.requestId);
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp([axTree("First"), axTree("Second")]) };

    await handleRecordStart(manager, { ...RECORD_START_V3, purpose: "first" }, deps);
    await handleRecordStart(
      manager,
      { ...RECORD_START_V3, session_id: "efgh", purpose: "second" },
      deps,
    );
    attachRecordFinishListener(deps);

    const finishFromTab = (tabId: number) => {
      chromeApi.runtimeOnMessage.emit(
        { type: RECORD_FINISH, requestId: requestIds.get(tabId) },
        { tab: { id: tabId } } as chrome.runtime.MessageSender,
        () => {},
      );
    };
    finishFromTab(TAB_ID);
    await vi.waitFor(() => expect(hasFinishedTraceForTests("abcd")).toBe(true));
    finishFromTab(7);
    await vi.waitFor(() => expect(hasFinishedTraceForTests("efgh")).toBe(true));

    // R2-9: one slot per session, so the second finish cannot overwrite the first.
    expect(chromeApi.storageSession.items[finishedTraceStorageKeyForTests("abcd")]).toBeDefined();
    expect(chromeApi.storageSession.items[finishedTraceStorageKeyForTests("efgh")]).toBeDefined();
    await recycleFinishedTracesForTests();

    const first = asTraceV3(
      ((await handleRecordStop(manager, { session_id: "abcd" }, deps)) as RecordStopResult).trace,
    );
    const second = asTraceV3(
      ((await handleRecordStop(manager, { session_id: "efgh" }, deps)) as RecordStopResult).trace,
    );
    expect(first.stopped_by).toBe("user_finish");
    expect(first.purpose).toBe("first");
    expect(second.stopped_by).toBe("user_finish");
    expect(second.purpose).toBe("second");
    expect(hasFinishedTraceForTests("abcd")).toBe(false);
    expect(hasFinishedTraceForTests("efgh")).toBe(false);
  }, 15_000);

  it("sweeps expired parked slots whoever owns them", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const deps = { tabsApi, sendToTab: vi.fn(async () => ({ ok: true })), cdp: makeFakeCdp() };
    const staleAt = Date.now() - 25 * 60 * 60 * 1000;
    const parked = (sessionId: string) => ({
      sessionId,
      trace: {},
      stoppedBy: "user_finish",
      finishedAt: staleAt,
    });

    chromeApi.storageSession.items[finishedTraceStorageKeyForTests("abcd")] = parked("abcd");
    chromeApi.storageSession.items[finishedTraceStorageKeyForTests("zzzz")] = parked("zzzz");

    // R2-16: freshness is decided before ownership, so the foreign slot goes too.
    expect(await handleRecordStop(manager, { session_id: "abcd" }, deps)).toMatchObject({
      code: "not_found",
    });
    expect(chromeApi.storageSession.items).toEqual({});

    // A new recording sweeps the whole area, not just its own session's slot.
    chromeApi.storageSession.items[finishedTraceStorageKeyForTests("zzzz")] = parked("zzzz");
    await handleRecordStart(manager, RECORD_START_V3, deps);
    expect(chromeApi.storageSession.items).toEqual({});
  });

  it("keeps a parked user_finish trace across session teardown", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await vi.waitFor(() => expect(hasFinishedTraceForTests("abcd")).toBe(true));

    // R2-15: session_stop / the idle reaper / a tab return must not destroy the
    // product of a recording that already finished in the page.
    clearRecordingForSession("abcd");
    expect(hasFinishedTraceForTests("abcd")).toBe(true);
    expect(chromeApi.storageSession.items[PARKED_TRACE_KEY]).toBeDefined();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    expect(asTraceV3((stopped as RecordStopResult).trace).stopped_by).toBe("user_finish");
    expect(hasFinishedTraceForTests("abcd")).toBe(false);
  });

  it("carries an arrival clock on webNavigation drafts", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const deps = { tabsApi, sendToTab: vi.fn(async () => ({ ok: true })), cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);

    const before = Date.now();
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.com/next",
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    const after = Date.now();

    await vi.waitFor(() => expect(lastDraftArrivedAtForTests("abcd")).toBeDefined());
    // R2-11: the clock comes from the listener entry, not from the queue slot,
    // so the pre-state guard can reject a sample started after the navigation.
    const arrivedAt = lastDraftArrivedAtForTests("abcd")!;
    expect(arrivedAt).toBeGreaterThanOrEqual(before);
    expect(arrivedAt).toBeLessThanOrEqual(after);

    await handleRecordStop(manager, { session_id: "abcd" }, deps);
  }, 15_000);

  it("returns a shared finish failure to a concurrent CLI stop", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    let releaseStop!: () => void;
    const stopReleased = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let announceStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      announceStop = resolve;
    });
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      if (typed.type === RECORD_STOP) {
        announceStop();
        await stopReleased;
        return { ok: false, error: "final capture failed" };
      }
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordFinishListener(deps);
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await stopStarted;

    const cliStop = handleRecordStop(manager, { session_id: "abcd" }, deps);
    releaseStop();
    const result = await Promise.race([
      cliStop,
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 500)),
    ]);

    expect(result).not.toBe("timed_out");
    expect(result).toMatchObject({ code: "protocol_error" });
  });

  it("defaults to legacy trace v2 without starting observation capture", async () => {
    const { runtimeOnMessage } = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, { session_id: "abcd", url: START_URL }, deps);
    attachRecordStepListener(deps);
    runtimeOnMessage.emit(
      {
        type: RECORD_STEP,
        requestId,
        producerId: "test-producer-4",
        sequence: 1,
        step: {
          op: "hover",
          page_url: START_URL,
          target: { role: "button", name: "Submit", tag: "button" },
        },
      },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    runtimeOnMessage.emit(
      {
        type: RECORD_STEP,
        requestId,
        producerId: "test-producer-4",
        sequence: 2,
        step: {
          op: "click",
          page_url: START_URL,
          target: { role: "button", name: "Submit", tag: "button" },
        },
      },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = (stopped as RecordStopResult).trace;
    expect("version" in trace).toBe(false);
    expect("pages" in trace && trace.pages.length).toBeGreaterThan(0);
    // `hover` has no v2 counterpart on peers that negotiate v2.
    expect("steps" in trace && trace.steps.map((step) => step.op)).toEqual(["click"]);
  });

  it("rejects unsupported trace_version values", async () => {
    const manager = fakeManager();
    const result = await handleRecordStart(
      manager,
      { session_id: "abcd", url: START_URL, trace_version: 99 },
      { tabsApi: makeTabsApi(), sendToTab: vi.fn(), cdp: makeFakeCdp() },
    );
    expect(result).toMatchObject({ code: "invalid_params" });
  });

  it("does not record an unclaimed user tab inside a remote Agent Window", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const context = { ...manager.get("abcd")!, remote: true, agentCreatedTabs: new Set([TAB_ID]) };
    manager.get = (id) => (id === "abcd" ? context : null);
    const privateUrl = "https://private.example/secret";
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
      {
        id: 5,
        windowId: AGENT_WINDOW_ID,
        active: false,
        status: "complete",
        url: privateUrl,
      } as chrome.tabs.Tab,
    ]);
    const cdp = makeFakeCdp(undefined, {
      treesByTab: { [TAB_ID]: axTree("Allowed"), 5: axTree("Private secret") },
    });
    const send = vi.spyOn(cdp, "send");
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, message: unknown) => {
      const typed = message as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp };
    const started = await handleRecordStart(manager, RECORD_START_V3, deps);
    expect(started).toMatchObject({ recording: true });
    attachRecordStepListener(deps);
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    runtimeOnMessageEmit(
      chromeApi,
      requestId,
      {
        op: "click",
        page_url: privateUrl,
        target: { role: "button", name: "Secret", tag: "button" },
      },
      5,
    );
    chromeApi.webNavigationOnCompleted.emit({
      tabId: 5,
      frameId: 0,
      url: privateUrl,
    } as chrome.webNavigation.WebNavigationFramedCallbackDetails);
    await settleWait();
    tabsApi.activate(TAB_ID);
    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    expect(JSON.stringify(trace)).not.toContain(privateUrl);
    expect(JSON.stringify(trace)).not.toContain("Private secret");
    expect(sendToTab.mock.calls.some(([tabId]) => tabId === 5)).toBe(false);
    expect(send.mock.calls.some(([tabId]) => tabId === 5)).toBe(false);
  });

  it("records tab transitions and binds actions to each tab's observation", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const secondUrl = "https://example.com/second";
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
        title: "First tab",
      } as chrome.tabs.Tab,
      {
        id: 5,
        windowId: AGENT_WINDOW_ID,
        active: false,
        status: "complete",
        url: secondUrl,
        title: "Second tab",
      } as chrome.tabs.Tab,
    ]);
    const cdp = makeFakeCdp(undefined, {
      treesByTab: {
        [TAB_ID]: axTree("First tab", ["First action"]),
        5: axTree("Second tab", ["Second action"]),
      },
    });
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, message: unknown) => {
      const typed = message as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordStepListener(deps);
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    await settleWait();
    runtimeOnMessageEmit(
      chromeApi,
      requestId,
      {
        op: "click",
        page_url: secondUrl,
        target: { role: "button", name: "Second action", tag: "button" },
      },
      5,
    );
    await settleWait();

    tabsApi.activate(TAB_ID);
    chromeApi.tabsOnActivated.emit({ tabId: TAB_ID, windowId: AGENT_WINDOW_ID });
    await settleWait();
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "First action", tag: "button" },
    });
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    const stateUrl = (stateId: string) => trace.states.find((state) => state.id === stateId)?.url;
    const switches = trace.steps.filter((step) => step.op === "switch_tab");
    const clicks = trace.steps.filter((step) => step.op === "click");

    expect(switches).toHaveLength(2);
    expect(clicks).toHaveLength(2);
    expect(stateUrl(switches[0]!.state)).toBe(START_URL);
    expect(stateUrl(switches[0]!.result.state)).toBe(secondUrl);
    expect(stateUrl(clicks[0]!.state)).toBe(secondUrl);
    expect(stateUrl(switches[1]!.result.state)).toBe(START_URL);
    expect(stateUrl(clicks[1]!.state)).toBe(START_URL);
  });

  it("keeps switch_tab internal when the v3 caller did not advertise support", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
      {
        id: 5,
        windowId: AGENT_WINDOW_ID,
        active: false,
        status: "complete",
        url: "https://example.com/second",
      } as chrome.tabs.Tab,
    ]);
    const deps = { tabsApi, sendToTab: vi.fn(async () => ({ ok: true })), cdp: makeFakeCdp() };

    await handleRecordStart(
      manager,
      { session_id: "abcd", url: START_URL, trace_version: 3 },
      deps,
    );
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    expect(trace.steps.some((step) => step.op === "switch_tab")).toBe(false);
  });

  it("keeps the latest rapid tab activation when an earlier rearm acknowledges late", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeMultiTabsApi(
      [TAB_ID, 5, 6].map(
        (id) =>
          ({
            id,
            windowId: AGENT_WINDOW_ID,
            active: id === TAB_ID,
            status: "complete",
            url: id === TAB_ID ? START_URL : `https://example.com/tab-${id}`,
          }) as chrome.tabs.Tab,
      ),
    );
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let announceSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      announceSecond = resolve;
    });
    const sendToTab = vi.fn(async (tabId: number, message: unknown) => {
      if ((message as { type?: string }).type === RECORD_START && tabId === 5) {
        announceSecond();
        await secondGate;
      }
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    await secondStarted;
    tabsApi.activate(6);
    chromeApi.tabsOnActivated.emit({ tabId: 6, windowId: AGENT_WINDOW_ID });
    await settleWait();
    releaseSecond();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    const switches = trace.steps.filter((step) => step.op === "switch_tab");
    const stateUrl = (stateId: string) => trace.states.find((state) => state.id === stateId)?.url;
    expect(switches).toHaveLength(1);
    expect(stateUrl(switches[0]!.result.state)).toBe("https://example.com/tab-6");
  });

  it("does not retry an in-flight tab rearm after recording stops", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
      {
        id: 5,
        windowId: AGENT_WINDOW_ID,
        active: false,
        status: "complete",
        url: "https://example.com/second",
      } as chrome.tabs.Tab,
    ]);
    let failRearm!: () => void;
    const rearmGate = new Promise<never>((_resolve, reject) => {
      failRearm = () => reject(new Error("rearm failed after stop"));
    });
    let announceRearm!: () => void;
    const rearmStarted = new Promise<void>((resolve) => {
      announceRearm = resolve;
    });
    const sendToTab = vi.fn(async (tabId: number, message: unknown) => {
      if ((message as { type?: string }).type === RECORD_START && tabId === 5) {
        announceRearm();
        await rearmGate;
      }
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    await rearmStarted;

    const stoppedPromise = handleRecordStop(manager, { session_id: "abcd" }, deps);
    await vi.waitFor(() => {
      expect(sendToTab).toHaveBeenCalledWith(5, expect.objectContaining({ type: RECORD_STOP }));
    });
    failRearm();
    const stopped = await stoppedPromise;
    await new Promise((resolve) => setTimeout(resolve, 600));

    const startsForSecondTab = sendToTab.mock.calls.filter(
      ([tabId, message]) => tabId === 5 && (message as { type?: string }).type === RECORD_START,
    );
    expect(startsForSecondTab).toHaveLength(1);
    expect(asTraceV3((stopped as RecordStopResult).trace).steps).toHaveLength(0);
  });

  it("keeps pending action settles scoped to their tab during an immediate switch", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const secondUrl = "https://example.com/second";
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
      {
        id: 5,
        windowId: AGENT_WINDOW_ID,
        active: false,
        status: "complete",
        url: secondUrl,
      } as chrome.tabs.Tab,
    ]);
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, message: unknown) => {
      const typed = message as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordStepListener(deps);
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "First action", tag: "button" },
    });
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    runtimeOnMessageEmit(
      chromeApi,
      requestId,
      {
        op: "click",
        page_url: secondUrl,
        target: { role: "button", name: "Second action", tag: "button" },
      },
      5,
    );
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    const stateUrl = (stateId: string) => trace.states.find((state) => state.id === stateId)?.url;

    expect(trace.steps.map((step) => step.op)).toEqual(["click", "switch_tab", "click"]);
    expect(stateUrl(trace.steps[0]!.result.state)).toBe(START_URL);
    expect(stateUrl(trace.steps[1]!.result.state)).toBe(secondUrl);
    expect(stateUrl(trace.steps[2]!.state)).toBe(secondUrl);
  });

  it("tracks the same navigation URL independently for each tab", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
      {
        id: 5,
        windowId: AGENT_WINDOW_ID,
        active: false,
        status: "complete",
        url: "https://example.com/second",
      } as chrome.tabs.Tab,
    ]);
    const deps = { tabsApi, sendToTab: vi.fn(async () => ({ ok: true })), cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    await settleWait();
    tabsApi.goTo(5, START_URL, "Same URL in second tab");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: 5,
      frameId: 0,
      url: START_URL,
      transitionType: "typed",
      transitionQualifiers: ["from_address_bar"],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    expect(
      trace.steps.filter((step) => step.op === "navigate" && step.to === START_URL),
    ).toHaveLength(1);
  });

  it("drops late input and frame navigation from an inactive tab", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const secondUrl = "https://example.com/second";
    const tabsApi = makeMultiTabsApi([
      {
        id: TAB_ID,
        windowId: AGENT_WINDOW_ID,
        active: true,
        status: "complete",
        url: START_URL,
      } as chrome.tabs.Tab,
      {
        id: 5,
        windowId: AGENT_WINDOW_ID,
        active: false,
        status: "complete",
        url: secondUrl,
      } as chrome.tabs.Tab,
    ]);
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, message: unknown) => {
      const typed = message as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordStepListener(deps);
    tabsApi.activate(5);
    chromeApi.tabsOnActivated.emit({ tabId: 5, windowId: AGENT_WINDOW_ID });
    await settleWait();
    const lateAck = runtimeOnMessageEmit(
      chromeApi,
      requestId,
      {
        op: "fill",
        page_url: START_URL,
        target: { role: "textbox", name: "Draft", tag: "input" },
        value: "late",
      },
      TAB_ID,
      false,
    );
    expect(lateAck).toHaveBeenCalledWith({ ok: true, sequence: 1 });
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.com/late",
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    chromeApi.webNavigationOnCommitted.emit({
      tabId: 5,
      frameId: 7,
      url: "https://frame.example/late",
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    expect(trace.steps.map((step) => step.op)).toEqual(["switch_tab"]);
  });
});
