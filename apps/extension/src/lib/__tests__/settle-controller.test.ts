import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import { ObservationNodeIndex, type RegisteredObservation } from "../recording/observation-capture";
import { RecordingObservationSession } from "../recording/observation-session";
import { inferMissingPostStates, SettleController } from "../recording/settle-controller";
import type { RecordingDraftStep } from "../recording/types";

const OBSERVATION: RegisteredObservation = {
  stateId: "s-next",
  rootFrameId: "root",
  index: new ObservationNodeIndex({ rootFrameId: "root", matchNodes: [], refs: [] }),
  url: "https://example.com/next",
};

describe("SettleController", () => {
  afterEach(() => vi.useRealTimers());

  it("backfills a superseded action from the next observation instead of the next pre-state", async () => {
    // E9: during a burst the previously pending action must NOT be stamped with
    // the *next* action's pre-state. That landing is the snapshot shared by the
    // whole burst (`cursor.lastSettled` reuse), i.e. a state from before every
    // action in it, so `result.state` ended up identical to `state` for every
    // action but the last.
    // E19: the burst here is spaced so that every supersede lands while the
    // previous settle is still *waiting* for the document to go quiet — nothing
    // has been read yet, so the abort-and-backfill path below is still exactly
    // right and the next action pays no waiting time for it.
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    vi.spyOn(session, "capture").mockImplementation(async (_cdp, _tabs, _tabId, signal) => {
      if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
      return { ...OBSERVATION, settledAt: Date.now() };
    });

    const burstAt = Date.now();
    const drafts: RecordingDraftStep[] = [
      {
        op: "fill",
        value: "a",
        captureTarget: { tag: "input" },
        preStateId: "s1",
        arrivedAt: burstAt,
      },
      {
        op: "fill",
        value: "b",
        captureTarget: { tag: "input" },
        preStateId: "s1",
        arrivedAt: burstAt + 10,
      },
      {
        op: "select",
        values: ["b"],
        captureTarget: { tag: "select" },
        preStateId: "s1",
        arrivedAt: burstAt + 20,
      },
      {
        op: "click",
        captureTarget: { tag: "button", name: "Pick" },
        preStateId: "s1",
        arrivedAt: burstAt + 30,
      },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    controller.schedule(drafts, 0);
    await vi.advanceTimersByTimeAsync(100);
    controller.schedule(drafts, 1);
    await vi.advanceTimersByTimeAsync(100);
    controller.schedule(drafts, 2);
    await vi.advanceTimersByTimeAsync(10);
    controller.schedule(drafts, 3);

    // Nothing has been sampled yet: the first three settles were aborted while
    // still watching the page, the drafts are superseded and merely marked,
    // never landed on their own pre-state.
    expect(controller.hasInFlightSample).toBe(false);
    expect(session.capture).not.toHaveBeenCalled();
    expect(drafts.slice(0, 3).map((draft) => draft.postStateId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(drafts.slice(0, 3).map((draft) => draft.postStatePending)).toEqual([true, true, true]);

    await vi.advanceTimersByTimeAsync(500);
    await controller.flush();

    // Only the last action's settle completed, and its observation backfills
    // every superseded draft that arrived before it was sampled.
    expect(drafts.slice(0, 3).map((draft) => draft.postStateId)).toEqual([
      "s-next",
      "s-next",
      "s-next",
    ]);
    expect(drafts[3]?.postStateId).toBe("s-next");
    // The click had no newer observation to serve as its pre-state, so it keeps
    // the stale-but-honest "s1" — its result state is still the post-burst one.
    expect(drafts[3]?.preStateId).toBe("s1");
    for (const draft of drafts) expect(draft.postStatePending).toBeUndefined();
    expect(drafts.slice(0, 3).map((draft) => draft.postStateBackfilled)).toEqual([
      true,
      true,
      true,
    ]);
    expect(drafts[3]?.postStateBackfilled).toBeUndefined();
  });

  it("does not consume a newer redirect while reading the prior landing URL", async () => {
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    let resolveFirstTab!: (tab: chrome.tabs.Tab) => void;
    const firstTab = new Promise<chrome.tabs.Tab>((resolve) => {
      resolveFirstTab = resolve;
    });
    const tabsApi: ChromeTabsApi = {
      get: vi
        .fn()
        .mockImplementationOnce(() => firstTab)
        .mockResolvedValue({ id: 7, url: OBSERVATION.url }),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    session.cursor.lastSettled = OBSERVATION;
    const drafts: RecordingDraftStep[] = [];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });

    controller.scheduleRedirect(drafts, "https://example.com/intermediate");
    await vi.advanceTimersByTimeAsync(180);
    expect(tabsApi.get).toHaveBeenCalledTimes(1);

    controller.scheduleRedirect(drafts, OBSERVATION.url);
    resolveFirstTab({ id: 7, url: "https://example.com/intermediate" } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(500);
    await controller.flushRedirects();

    expect(drafts).toEqual([]);
    expect(controller.hasPending).toBe(false);
  });

  it("keeps one observation per action when every settle completes", async () => {
    // Regression for the slow cadence: with a real gap between actions the
    // trailing backfill must stay out of the way and each draft keeps its own
    // post-state.
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    let capture = 0;
    vi.spyOn(session, "capture").mockImplementation(async () => {
      capture += 1;
      return { ...OBSERVATION, stateId: `s${capture + 1}`, settledAt: Date.now() };
    });
    const drafts: RecordingDraftStep[] = [
      {
        op: "fill",
        value: "a",
        captureTarget: { tag: "input" },
        preStateId: "s1",
        arrivedAt: Date.now(),
      },
      {
        op: "fill",
        value: "b",
        captureTarget: { tag: "input" },
        preStateId: "s2",
        arrivedAt: Date.now(),
      },
      { op: "click", captureTarget: { tag: "button" }, preStateId: "s3", arrivedAt: Date.now() },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    for (let index = 0; index < drafts.length; index += 1) {
      controller.schedule(drafts, index);
      await vi.advanceTimersByTimeAsync(2_000);
      await controller.flush();
    }

    expect(drafts.map((draft) => draft.postStateId)).toEqual(["s2", "s3", "s4"]);
    expect(drafts.map((draft) => draft.postStateBackfilled)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(drafts.map((draft) => draft.postStatePending)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("refuses to backfill a superseded draft from an observation sampled before it", async () => {
    vi.useFakeTimers();
    const base = Date.now();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    vi.spyOn(session, "capture")
      .mockResolvedValueOnce({ ...OBSERVATION, stateId: "s2", settledAt: base + 1 })
      .mockResolvedValueOnce({ ...OBSERVATION, stateId: "s3", settledAt: base + 200_000 });
    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "button", name: "Future" },
        preStateId: "s1",
        arrivedAt: base + 100_000,
      },
      {
        op: "click",
        captureTarget: { tag: "button", name: "Now" },
        preStateId: "s1",
        arrivedAt: base,
      },
      {
        op: "click",
        captureTarget: { tag: "button", name: "Next" },
        preStateId: "s1",
        arrivedAt: base + 50,
      },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    controller.schedule(drafts, 0);
    controller.schedule(drafts, 1);
    await vi.advanceTimersByTimeAsync(500);
    await controller.flush();

    // The first observation was sampled before draft 0 arrived, so it is not
    // allowed to describe what happened after it; the draft stays pending.
    expect(drafts[0]?.postStateId).toBeUndefined();
    expect(drafts[0]?.postStatePending).toBe(true);
    expect(drafts[1]?.postStateId).toBe("s2");

    controller.schedule(drafts, 2);
    await vi.advanceTimersByTimeAsync(500);
    await controller.flush();

    // A later observation that *is* sampled after draft 0 binds it.
    expect(drafts[0]?.postStateId).toBe("s3");
    expect(drafts[0]?.postStateBackfilled).toBe(true);
    expect(drafts[2]?.postStateId).toBe("s3");
  });

  it("backfills every unbound draft at stop, not just an unbroken suffix", async () => {
    const cdp: CdpRunner = { send: vi.fn() as unknown as CdpRunner["send"] };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    vi.spyOn(session, "capture").mockResolvedValue({ ...OBSERVATION, settledAt: Date.now() });
    const drafts: RecordingDraftStep[] = [
      { op: "fill", value: "a", captureTarget: { tag: "input" }, preStateId: "s1", arrivedAt: 1 },
      {
        op: "click",
        captureTarget: { tag: "button" },
        preStateId: "s1",
        postStateId: "s9",
        arrivedAt: 2,
      },
      {
        op: "select",
        values: ["x"],
        captureTarget: { tag: "select" },
        preStateId: "s9",
        arrivedAt: 3,
      },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    await controller.settleTrailing(drafts);

    // The old suffix-only scan stopped at draft 1 (already bound) and left
    // draft 0 unbound.
    expect(drafts[0]?.postStateId).toBe("s-next");
    expect(drafts[1]?.postStateId).toBe("s9");
    expect(drafts[2]?.postStateId).toBe("s-next");
  });

  it("falls back to an adjacent state when the final observation fails", async () => {
    // E9: `trace-reducer-v3` drops a step whose pre-state *and* post-state are
    // both missing. The stop-time fallback must keep every step addressable so
    // "misaligned" never becomes "lost step".
    // R2-12: the fabricated landing must not pass for an observation — the pre
    // side has had an explicit marker since R1-5, and the post side needs one
    // too, so every reused draft carries `postStateFallback`.
    const cdp: CdpRunner = { send: vi.fn() as unknown as CdpRunner["send"] };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    vi.spyOn(session, "capture").mockRejectedValue(new Error("document swapped"));
    const drafts: RecordingDraftStep[] = [
      { op: "click", captureTarget: { tag: "button", name: "Lost" }, arrivedAt: 1 },
      {
        op: "fill",
        value: "b",
        captureTarget: { tag: "input" },
        preStateId: "s2",
        arrivedAt: 2,
      },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    await controller.settleTrailing(drafts);

    expect(drafts[0]?.postStateId).toBe("s2");
    expect(drafts[1]?.postStateId).toBe("s2");
    expect(drafts[0]?.postStateFallback).toBe(true);
    expect(drafts[0]?.postStateBackfilled).toBeUndefined();
    expect(drafts[0]?.postStatePending).toBeUndefined();
  });

  it("marks a post-state inferred from the next draft's pre-state as a fallback", () => {
    // R2-12: `inferMissingPostStates` is the other fabrication path (used when
    // the controller never ran). It reuses a neighbour exactly like
    // `#fallbackMissingPostStates`, so it must be marked the same way instead of
    // producing an unlabelled step.
    const drafts: RecordingDraftStep[] = [
      { op: "click", captureTarget: { tag: "button" }, arrivedAt: 1 },
      { op: "scroll", preStateId: "s2", postStateId: "s2" },
    ];

    inferMissingPostStates(drafts);

    expect(drafts[0]?.postStateId).toBe("s2");
    expect(drafts[0]?.postStateFallback).toBe(true);
  });

  it("clears the fallback flag when a real observation later backfills the draft", async () => {
    // R2-12 must not stick: a draft fabricated at stop, then served by a genuine
    // trailing observation, is a backfill (a real-but-coarser observation) and
    // has to stop reporting itself as never observed.
    const cdp: CdpRunner = { send: vi.fn() as unknown as CdpRunner["send"] };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    vi.spyOn(session, "capture").mockResolvedValue({ ...OBSERVATION, settledAt: Date.now() });
    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "button" },
        preStateId: "s1",
        postStateId: "s1",
        postStateFallback: true,
        arrivedAt: 1,
      },
      { op: "scroll", preStateId: "s1", arrivedAt: 2 },
    ];

    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    await controller.settleTrailing(drafts);

    // Draft 1 already had a (fabricated) landing, so it is not re-bound here; the
    // flag is what keeps the wire trace honest about it.
    expect(drafts[0]?.postStateFallback).toBe(true);
    expect(drafts[1]?.postStateId).toBe(OBSERVATION.stateId);
    expect(drafts[1]?.postStateBackfilled).toBe(true);
    expect(drafts[1]?.postStateFallback).toBeUndefined();
  });

  it("shares a DOM read that is already in flight with the next action", async () => {
    // E19 pace-500ms shape: the hover opens a menu and its settle has already
    // finished waiting for the document, so the DOM is being read when the click
    // on a menu item arrives. Aborting that read (the pre-E19 behaviour) threw
    // away the only observation that can be the hover's result *and* the click's
    // pre-state. Here both ends share it and neither is marked as a backfill.
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    const menu = session.registry.register({
      url: OBSERVATION.url,
      vomText: '@vom 1\nRootWebArea "Account menu"',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sampleSignal: AbortSignal | undefined;
    let sampledAt = 0;
    vi.spyOn(session, "capture").mockImplementation(async (_cdp, _tabs, _tabId, signal) => {
      sampleSignal = signal;
      sampledAt = Date.now();
      await gate;
      if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
      const observation: RegisteredObservation = {
        ...OBSERVATION,
        stateId: menu.id,
        // Stand-in for what the real `capture()` does: the sampling clock is
        // taken on entry, before any DOM read.
        capturedAt: sampledAt,
        settledAt: Date.now(),
      };
      session.cursor.lastSettled = observation;
      session.cursor.lastSettledAt = observation.settledAt;
      return observation;
    });

    const start = Date.now();
    const drafts: RecordingDraftStep[] = [
      {
        op: "hover",
        captureTarget: { tag: "button", name: "Account" },
        preStateId: "s-old",
        arrivedAt: start,
      },
      {
        op: "click",
        captureTarget: { tag: "menuitem", name: "Profile beta" },
        preStateId: "s-old",
        arrivedAt: start + 500,
      },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    controller.schedule(drafts, 0);
    // Past the 150ms settle floor: the hover's settle is reading the DOM now, so
    // 500ms later the click must not be able to abort it.
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.hasInFlightSample).toBe(true);

    let shared: RegisteredObservation | null | undefined;
    const waiting = controller.awaitInFlightSample(drafts[1]!.arrivedAt!).then((value) => {
      shared = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(shared).toBeUndefined();
    expect(sampleSignal?.aborted).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(0);
    const observation = await waiting;
    expect(observation).toMatchObject({ stateId: menu.id });
    expect(sampleSignal?.aborted).toBe(false);
    // No retry, no second sample: the click waited for the read instead of
    // forcing a fresh one.
    expect(session.capture).toHaveBeenCalledTimes(1);

    // The click binds the shared sample through the ordinary E11 guard: sampling
    // began (t0+150) before the click arrived (t0+500).
    const click = drafts[1]!;
    session.bindDraft(click, 2, click.arrivedAt!);
    expect(click.preStateId).toBe(menu.id);
    expect(click.preStateRejected).toBeUndefined();

    // The hover's own settle bound the same observation as its result — plainly,
    // not as a backfill.
    await controller.flush();
    expect(drafts[0]?.postStateId).toBe(menu.id);
    expect(drafts[0]?.postStateBackfilled).toBeUndefined();
    expect(drafts[0]?.postStatePending).toBeUndefined();
    expect(drafts[0]?.postStateFallback).toBeUndefined();
    // The click bound the shared state as a pre-state, so it appears in that
    // state's `steps_here` line (the hover itself is bound to `s-old`).
    expect(menu.stepsHere).toEqual([2]);

    controller.schedule(drafts, 1);
    await vi.advanceTimersByTimeAsync(500);
    await controller.flush();
    expect(drafts[1]?.postStateId).toBe(menu.id);
    expect(drafts[1]?.postStateBackfilled).toBeUndefined();
    expect(controller.hasInFlightSample).toBe(false);
  });

  it("still aborts a settle that is only waiting, without making the next action pay for it", async () => {
    // E19 must not slow down an ordinary burst: a settle that has not finished
    // waiting for the document has read nothing, so a later action aborts it at
    // once and the draft is backfilled exactly as it was under E9.
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    let sampleSignal: AbortSignal | undefined;
    vi.spyOn(session, "capture").mockImplementation(async (_cdp, _tabs, _tabId, signal) => {
      sampleSignal = signal;
      if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
      return { ...OBSERVATION, stateId: "s-after", capturedAt: Date.now(), settledAt: Date.now() };
    });
    const drafts: RecordingDraftStep[] = [
      { op: "fill", value: "a", captureTarget: { tag: "input" }, arrivedAt: 1 },
      { op: "fill", value: "b", captureTarget: { tag: "input" }, arrivedAt: 2 },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    controller.schedule(drafts, 0);
    // 40ms in: still inside the settle wait, so nothing is being read yet.
    await vi.advanceTimersByTimeAsync(40);
    expect(controller.hasInFlightSample).toBe(false);

    const before = Date.now();
    await expect(controller.awaitInFlightSample(drafts[1]!.arrivedAt!)).resolves.toBeNull();
    // Resolved immediately: there was nothing to wait for.
    expect(Date.now()).toBe(before);

    controller.schedule(drafts, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await controller.flush();

    expect(drafts[0]?.postStateId).toBe("s-after");
    expect(drafts[0]?.postStateBackfilled).toBe(true);
    expect(sampleSignal?.aborted).toBe(false);
  });

  it("falls back to a backfill when an in-flight read never lands", async () => {
    // E19 (c): the bounded wait must not deadlock the serial settle queue. Past
    // the bound the sample is abandoned (and aborted, so the queue drains) and
    // the draft takes the E9 path again.
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    let stalledSignal: AbortSignal | undefined;
    vi.spyOn(session, "capture")
      .mockImplementationOnce(
        (_cdp, _tabs, _tabId, signal) =>
          new Promise<RegisteredObservation>((_resolve, reject) => {
            stalledSignal = signal;
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("observation aborted", "AbortError")),
              { once: true },
            );
          }),
      )
      .mockImplementation(async () => ({
        ...OBSERVATION,
        stateId: "s-after",
        capturedAt: Date.now(),
        settledAt: Date.now(),
      }));
    const drafts: RecordingDraftStep[] = [
      { op: "hover", captureTarget: { tag: "button", name: "Account" }, arrivedAt: 1 },
      {
        op: "click",
        captureTarget: { tag: "menuitem", name: "Profile beta" },
        // Arrives after the hover's DOM read began, so E19 is willing to wait
        // for it — the wait is what has to be bounded here.
        arrivedAt: Date.now() + 600_000,
      },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    controller.schedule(drafts, 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.hasInFlightSample).toBe(true);

    let shared: RegisteredObservation | null | undefined;
    const waiting = controller.awaitInFlightSample(drafts[1]!.arrivedAt!, 1_500).then((value) => {
      shared = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(shared).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await expect(waiting).resolves.toBeNull();
    expect(stalledSignal?.aborted).toBe(true);

    controller.schedule(drafts, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await controller.flush();

    expect(drafts[0]?.postStateId).toBe("s-after");
    expect(drafts[0]?.postStateBackfilled).toBe(true);
    expect(drafts[0]?.postStatePending).toBeUndefined();
    expect(drafts[1]?.postStateId).toBe("s-after");
  });

  it("never makes a fast burst wait: the bound is only spent on a usable read", async () => {
    // E19 (d): the wait is the exception, not the rule. A 20ms cadence must not
    // pay for it — not when the previous settle is still waiting on the document
    // (nothing has been read), and not when the read in flight *started after*
    // the action arrived (E11 would reject it as `late` anyway). The bound is
    // spent only on the one shape that can actually become a pre-state.
    vi.useFakeTimers();
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        result: { value: { idleMs: 1_000, readyState: "complete" } },
      })) as unknown as CdpRunner["send"],
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(session, "capture").mockImplementation(async () => {
      await gate;
      return { ...OBSERVATION, stateId: "s2", capturedAt: Date.now(), settledAt: Date.now() };
    });
    const base = Date.now();
    const drafts: RecordingDraftStep[] = [
      {
        op: "fill",
        value: "a",
        captureTarget: { tag: "input" },
        preStateId: "s1",
        arrivedAt: base,
      },
      {
        op: "fill",
        value: "b",
        captureTarget: { tag: "input" },
        preStateId: "s1",
        arrivedAt: base + 20,
      },
      {
        op: "select",
        values: ["b"],
        captureTarget: { tag: "select" },
        preStateId: "s1",
        arrivedAt: base + 40,
      },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    controller.schedule(drafts, 0);
    // 20ms in: still inside the settle wait, so nothing is being read and the
    // second action must not be delayed by a single millisecond.
    await vi.advanceTimersByTimeAsync(20);
    const beforeSettleWait = Date.now();
    await expect(controller.awaitInFlightSample(drafts[1]!.arrivedAt!)).resolves.toBeNull();
    expect(Date.now()).toBe(beforeSettleWait);

    // Past the settle floor the read is in flight, but it *started* after the
    // third action arrived (t0+40 is before t0+150). E11 would call it `late`,
    // so the wait is skipped rather than spent.
    controller.schedule(drafts, 1);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.hasInFlightSample).toBe(true);
    const beforeLateSkip = Date.now();
    await expect(controller.awaitInFlightSample(drafts[2]!.arrivedAt!)).resolves.toBeNull();
    expect(Date.now()).toBe(beforeLateSkip);

    // The one shape worth waiting for: a read that began at t0+150 and an action
    // that arrived later. The default bound is what caps it.
    const beforeBound = Date.now();
    const waiting = controller.awaitInFlightSample(base + 500);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(Date.now() - beforeBound).toBe(1_499);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBeNull();
    expect(Date.now() - beforeBound).toBe(1_500);

    release();
    controller.cancel();
  });

  it("settles an action in its own OOPIF document scope", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sendToTarget = vi.fn(async (_target, method: string) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 39 };
      return { result: { value: { idleMs: 1_000, readyState: "complete" } } };
    });
    const cdp: CdpRunner = {
      send: send as unknown as CdpRunner["send"],
      sendToTarget: sendToTarget as unknown as NonNullable<CdpRunner["sendToTarget"]>,
    };
    const tabsApi: ChromeTabsApi = {
      get: vi.fn(async () => ({ id: 7, url: OBSERVATION.url }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
    };
    const session = new RecordingObservationSession();
    vi.spyOn(session, "capture").mockResolvedValue(OBSERVATION);
    const drafts: RecordingDraftStep[] = [
      { op: "click", captureTarget: { tag: "button", name: "Inside frame" } },
    ];
    const controller = new SettleController({ session, cdp, tabsApi, tabId: 7 });
    const target = { tabId: 7, sessionId: "oopif-session" };

    controller.schedule(drafts, 0, { target, frameId: "oopif-frame" });
    await vi.advanceTimersByTimeAsync(180);
    await controller.flush();

    expect(send).not.toHaveBeenCalled();
    expect(sendToTarget).toHaveBeenCalledWith(
      target,
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 39 }),
    );
    expect(drafts[0]?.postStateId).toBe("s-next");
  });
});
