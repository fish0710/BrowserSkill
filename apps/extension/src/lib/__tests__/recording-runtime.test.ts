import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";

const captureRecordingObservation = vi.hoisted(() => vi.fn());
const waitForDocumentSettled = vi.hoisted(() => vi.fn(async () => "quiet" as const));

vi.mock("../recording/observation-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recording/observation-capture")>();
  return { ...actual, captureRecordingObservation };
});

vi.mock("../recording/document-settle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recording/document-settle")>();
  return { ...actual, waitForDocumentSettled };
});

import { ObservationNodeIndex } from "../recording/observation-capture";
import { RecordingObservationRuntime } from "../recording/recording-runtime";
import { parseTraceStateFrontMatter } from "../recording/trace-state-body";
import type { RecordingDraftStep } from "../recording/types";

function observation(url = "https://example.com/") {
  return {
    rootFrameId: "root",
    index: new ObservationNodeIndex({ rootFrameId: "root", matchNodes: [], refs: [] }),
    url,
    title: "Example",
    vomText: '@vom 1\nRootWebArea "Example"',
    truncated: false,
  };
}

function runtime(): RecordingObservationRuntime {
  return new RecordingObservationRuntime({
    cdp: { send: vi.fn() as unknown as CdpRunner["send"] },
    tabsApi: { get: vi.fn(), query: vi.fn() } as unknown as ChromeTabsApi,
  });
}

describe("RecordingObservationRuntime", () => {
  afterEach(() => {
    captureRecordingObservation.mockReset();
    waitForDocumentSettled.mockReset();
    waitForDocumentSettled.mockImplementation(async () => "quiet" as const);
  });

  it("rejects an observation whose sampling began after the payload arrived", async () => {
    // R1-2/E11: the queue may flush redirects before `processDraft`, so an
    // observation can be *sampled* after the action yet still be in place by
    // the time this slot runs. The guard must use the payload's arrival clock,
    // not the queue slot's clock, or that snapshot silently becomes the
    // pre-state.
    captureRecordingObservation.mockResolvedValue(observation());
    const recording = runtime();
    await recording.captureInitial(7);

    const stale: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "Open" },
        arrivedAt: Date.now() - 10_000,
      },
    ];
    await recording.processDraft(7, stale, 0, "producer-1");
    recording.cancel();

    // The observation's sampling started now, i.e. after the action arrived, so
    // it shows the panel the click itself opened and cannot be the pre-state.
    expect(stale[0]?.preStateId).toBeUndefined();
    expect(stale[0]?.preStateRejected).toBe("late");
  });

  it("binds the same observation when the payload arrived after its sampling began", async () => {
    captureRecordingObservation.mockResolvedValue(observation());
    const recording = runtime();
    await recording.captureInitial(7);

    const bound: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "Open" },
        arrivedAt: Date.now() + 10_000,
      },
    ];
    await recording.processDraft(7, bound, 0, "producer-1");
    recording.cancel();

    expect(bound[0]?.preStateId).toBeTruthy();
    expect(bound[0]?.preStateRejected).toBeUndefined();
  });

  it("binds a pre-state whose sampling began before the action but settled after it", async () => {
    // E11 pace-500ms shape end to end: the hover's sample is already being read
    // when the click on a menu item is delivered. The observation must survive
    // as the click's pre-state — the whole point of the `capturedAt` guard —
    // because the DOM it read had the menu open and the target is matchable in
    // it, whereas the previous state (before the hover) has no such menu.
    const slow = observation();
    slow.index = new ObservationNodeIndex({
      rootFrameId: "root",
      matchNodes: [
        {
          frameId: "root",
          backendNodeId: 77,
          tag: "menuitem",
          rect: { x: 30, y: 60, w: 120, h: 24 },
          localRect: { x: 30, y: 60, w: 120, h: 24 },
        },
      ],
      refs: [{ ref: "e9", backendNodeId: 77, role: "menuitem", name: "Profile beta", line: 3 }],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    captureRecordingObservation.mockImplementation(async () => {
      await gate;
      return slow;
    });
    const recording = runtime();
    const initial = recording.captureInitial(7);
    // The click arrives while the hover-triggered sample is still in flight.
    const arrivedAt = Date.now();
    release();
    await initial;

    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "menuitem", role: "menuitem", name: "Profile beta" },
        targetHint: {
          geometry: { rect: { x: 30, y: 60, w: 120, h: 24 }, tag: "menuitem" },
        },
        arrivedAt,
      },
    ];
    // No producer id: an unresolved Document scope would mark the draft
    // unmatched for reasons unrelated to this guard.
    await recording.processDraft(7, drafts, 0);
    recording.cancel();

    const draft = drafts[0];
    if (!draft || draft.op !== "click") throw new Error("expected click draft");
    expect(draft.preStateRejected).toBeUndefined();
    expect(draft.preStateId).toBeTruthy();
    expect(draft.matchedTarget).toMatchObject({ ref: "e9", name: "Profile beta" });
  });

  it("shares one initial capture and includes it in flush", async () => {
    let release!: (value: ReturnType<typeof observation>) => void;
    captureRecordingObservation.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const recording = runtime();

    const first = recording.captureInitial(7);
    const second = recording.captureInitial(7);
    const flushed = recording.flush();
    let flushCompleted = false;
    void flushed.then(() => {
      flushCompleted = true;
    });

    await Promise.resolve();
    expect(captureRecordingObservation).toHaveBeenCalledTimes(1);
    expect(flushCompleted).toBe(false);

    release(observation());
    await Promise.all([first, second, flushed]);
    expect(flushCompleted).toBe(true);
  });

  it("cancels an in-flight initial capture", async () => {
    captureRecordingObservation.mockImplementationOnce(
      (input: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("observation aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const recording = runtime();

    const pending = recording.captureInitial(7);
    recording.cancel();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries a failed initial capture when the recording settles at stop", async () => {
    captureRecordingObservation
      .mockRejectedValueOnce(new Error("document swapped"))
      .mockResolvedValueOnce(observation());
    const recording = runtime();

    await expect(recording.captureInitial(7)).rejects.toThrow("document swapped");
    await recording.settleTrailing(7, []);
    const trace = recording.buildTrace({
      drafts: [],
      startedAt: "2026-08-19T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "0.1.6",
    });

    expect(captureRecordingObservation).toHaveBeenCalledTimes(2);
    expect(trace.states).toHaveLength(1);
  });

  it("keeps runtime matching data out of the serialized trace", async () => {
    const captured = observation();
    captured.index = new ObservationNodeIndex({
      rootFrameId: "root",
      matchNodes: [
        {
          frameId: "root",
          backendNodeId: 42,
          tag: "button",
          rect: { x: 10, y: 20, w: 100, h: 30 },
          localRect: { x: 10, y: 20, w: 100, h: 30 },
        },
      ],
      refs: [{ ref: "e1", backendNodeId: 42, role: "button", name: "Submit", line: 1 }],
    });
    captureRecordingObservation.mockResolvedValueOnce(captured);
    const recording = runtime();

    await recording.captureInitial(7);
    const dumped = JSON.stringify(
      recording.buildTrace({
        drafts: [],
        startedAt: "2026-08-19T00:00:00.000Z",
        stoppedBy: "user_finish",
        bskVersion: "0.1.6",
      }),
    );

    expect(dumped).toContain("RootWebArea");
    expect(dumped).not.toContain("matchNodes");
    expect(dumped).not.toContain("localRect");
    expect(dumped).not.toContain("backendNodeId");
    expect(dumped).not.toContain("ObservationNodeIndex");
  });

  it("captures a tab transition without sharing observation cursors", async () => {
    captureRecordingObservation
      .mockResolvedValueOnce(observation("https://example.com/first"))
      .mockResolvedValueOnce(observation("https://example.com/second"));
    const recording = runtime();

    await recording.captureInitial(4);
    const transition = await recording.captureTabTransition(4, 5);
    await recording.captureInitial(4);
    await recording.captureInitial(5);

    expect(transition).toEqual({
      preStateId: "s1",
      postStateId: "s2",
      targetUrl: "https://example.com/second",
    });
    expect(captureRecordingObservation.mock.calls.map(([input]) => input.tabId)).toEqual([4, 5]);
  });

  it("binds an iframe draft to its marked CDP Document scope", async () => {
    captureRecordingObservation.mockResolvedValueOnce({
      ...observation(),
      index: new ObservationNodeIndex({
        rootFrameId: "root",
        frames: [
          {
            frameId: "child",
            target: { tabId: 7, sessionId: "oopif-session" },
            recordingDocumentId: "producer-1",
          },
        ],
        matchNodes: [
          {
            backendNodeId: 42,
            frameId: "child",
            tag: "button",
            rect: { x: 410, y: 20, w: 100, h: 30 },
            localRect: { x: 10, y: 20, w: 100, h: 30 },
          },
        ],
        refs: [{ ref: "e1", backendNodeId: 42, frameId: "child", line: 1 }],
      }),
    });
    const recording = runtime();
    const drafts: RecordingDraftStep[] = [
      {
        op: "click" as const,
        captureTarget: { tag: "button", role: "button", name: "Save" },
        targetHint: {
          geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" },
        },
      },
    ];

    await recording.captureInitial(7);
    await recording.processDraft(7, drafts, 0, "producer-1");
    recording.cancel();

    const draft = drafts[0];
    expect(draft?.op).toBe("click");
    if (!draft || draft.op !== "click") throw new Error("expected click draft");
    expect(draft.targetHint).toMatchObject({
      frameId: "child",
      geometrySpace: "local",
    });
    expect(draft.matchedTarget?.ref).toBe("e1");
  });

  it("refreshes a late iframe before matching its first action", async () => {
    const iframeObservation = {
      ...observation(),
      index: new ObservationNodeIndex({
        rootFrameId: "root",
        frames: [
          {
            frameId: "child",
            target: { tabId: 7, sessionId: "oopif-session" },
            recordingDocumentId: "producer-1",
          },
        ],
        matchNodes: [
          {
            backendNodeId: 42,
            frameId: "child",
            tag: "button",
            rect: { x: 410, y: 20, w: 100, h: 30 },
            localRect: { x: 10, y: 20, w: 100, h: 30 },
          },
        ],
        refs: [
          {
            ref: "e1",
            backendNodeId: 42,
            frameId: "child",
            role: "button",
            name: "表格视图",
            line: 1,
          },
        ],
      }),
    };
    captureRecordingObservation
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(iframeObservation)
      .mockResolvedValueOnce(iframeObservation);
    const recording = runtime();

    await recording.captureInitial(7);
    await recording.refreshDocument(7, "producer-1");
    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "表格视图" },
        targetHint: {
          geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" },
        },
      },
    ];
    await recording.processDraft(7, drafts, 0, "producer-1");
    recording.cancel();

    expect(captureRecordingObservation).toHaveBeenCalledTimes(3);
    expect(waitForDocumentSettled).toHaveBeenCalledWith(
      expect.anything(),
      { frameId: "child", target: { tabId: 7, sessionId: "oopif-session" } },
      { signal: expect.any(AbortSignal) },
    );
    const draft = drafts[0];
    expect(draft?.op).toBe("click");
    if (!draft || draft.op !== "click") throw new Error("expected click draft");
    expect(draft.matchedTarget).toMatchObject({ ref: "e1", name: "表格视图" });
  });

  it("does not poison final flush when a frame readiness refresh fails", async () => {
    captureRecordingObservation
      .mockResolvedValueOnce(observation())
      .mockRejectedValueOnce(new Error("child Document replaced"));
    const recording = runtime();

    await recording.captureInitial(7);
    await expect(recording.refreshDocument(7, "producer-1")).rejects.toThrow(
      "child Document replaced",
    );
    await expect(recording.flush()).resolves.toBeUndefined();
  });

  it("gives a burst of four actions the post-burst observation, not the shared pre-state", async () => {
    // E9 offline replay of the probe3 shape: fill -> fill -> select -> click
    // inside ~30ms. Before the fix every step but the last was stamped with the
    // pre-state shared by the whole burst, so `state` and `result.state` were
    // the same id and the trace claimed the document never changed.
    captureRecordingObservation.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return observation(`https://example.com/s${++captures}`);
    });
    let captures = 0;
    const recording = runtime();
    await recording.captureInitial(7);

    const arrivedAt = Date.now();
    const drafts: RecordingDraftStep[] = [
      {
        op: "fill",
        value: "q",
        captureTarget: { tag: "input", role: "textbox", name: "Search" },
        arrivedAt,
      },
      {
        op: "fill",
        value: "qq",
        captureTarget: { tag: "input", role: "textbox", name: "Search" },
        arrivedAt: arrivedAt + 10,
      },
      {
        op: "select",
        values: ["b"],
        captureTarget: { tag: "select", role: "combobox", name: "Kind" },
        arrivedAt: arrivedAt + 20,
      },
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "Apply" },
        arrivedAt: arrivedAt + 30,
      },
    ];
    for (let index = 0; index < drafts.length; index += 1) {
      await recording.processDraft(7, drafts, index, "producer-1");
    }
    await recording.flush();
    await recording.settleTrailing(7, drafts);

    const trace = recording.buildTrace({
      drafts,
      startedAt: "2026-09-17T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.steps).toHaveLength(4);
    // Every step is bound to a pre-state that is not its own result, and every
    // result state is a snapshot that was really observed.
    for (const step of trace.steps) expect(step.result.state).not.toBe(step.state);
    for (const step of trace.steps) expect(step.result.state).toBeTruthy();
    // E9/E11 monotonicity: a draft's result is only taken from a sample whose
    // *sampling* began at or after the draft arrived. The first sample started
    // after draft 1 arrived, so draft 1 owns it; the second sample started after
    // drafts 2-4 arrived, so it serves the rest. Note the shape differs from
    // before E19 only in *when* each draft is bound, not in the grouping.
    expect(trace.steps[0]!.result.state).toBe("s2");
    expect(trace.steps[1]!.result.state).toBe("s3");
    expect(trace.steps[2]!.result.state).toBe("s3");
    // The later two are bound by the trailing observation, and the trace says so
    // through `steps_here` plus the R2-8 front matter — the downgrade is visible
    // rather than a silent inference.
    const early = trace.states.find((state) => state.id === "s2");
    const late = trace.states.find((state) => state.id === "s3");
    expect(late?.body).toContain("steps_here: [2, 3]");
    expect(parseTraceStateFrontMatter(late!.body).state_backfilled_steps).toEqual([2, 3]);
    expect(parseTraceStateFrontMatter(early!.body).post_state_fallback_steps).toBeUndefined();
    expect(drafts[1]?.postStateBackfilled).toBe(true);
    expect(drafts[3]?.postStatePending).toBeUndefined();
  });

  it("shares an in-flight sample with the action that arrives during it", async () => {
    // E19 pace-500ms shape end to end: the hover opens a menu, its settle has
    // finished waiting for the document and is reading the DOM, and only then
    // does the click on the menu item arrive. Before this job the arrival
    // aborted that read, so the click could only bind the snapshot from *before*
    // the hover — a DOM without the menu, in which the menu item cannot match.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captures = 0;
    // Each read renders a distinct document, so the registry gives each one its
    // own state id (identity is URL + body text).
    const page = (url: string, body: string) => ({
      ...observation(url),
      title: body,
      vomText: `@vom 1\nRootWebArea "${body}"`,
    });
    captureRecordingObservation.mockImplementation(async () => {
      captures += 1;
      // The hover's sample is the one that blocks; the click's own sample (the
      // third capture) is a plain, fast read.
      if (captures === 2) {
        await gate;
        return page("https://example.com/", "Account menu open");
      }
      if (captures === 3) return page("https://example.com/profile", "Profile beta");
      return page("https://example.com/", "Account menu closed");
    });
    const recording = runtime();
    await recording.captureInitial(7);

    const arrivedAt = Date.now();
    const drafts: RecordingDraftStep[] = [
      { op: "hover", captureTarget: { tag: "button", name: "Account" }, arrivedAt },
      {
        op: "click",
        captureTarget: { tag: "menuitem", name: "Profile beta" },
        // 500ms later, i.e. while the hover's read is blocked in the gate.
        arrivedAt: arrivedAt + 500,
      },
    ];
    await recording.processDraft(7, drafts, 0);
    // Wait until the hover's settle is actually reading the DOM, so the click
    // below really does arrive "during" it rather than before it.
    await vi.waitFor(() => expect(captures).toBe(2));

    let clickSettled = false;
    const click = recording.processDraft(7, drafts, 1).then(() => {
      clickSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The click is parked on the hover's sample instead of aborting it.
    expect(clickSettled).toBe(false);
    expect(captures).toBe(2);

    release();
    await click;
    await recording.flush();
    recording.cancel();

    // The hover's own result and the click's pre-state are the same observation
    // of the open menu.
    expect(drafts[0]?.postStateId).toBe("s2");
    expect(drafts[1]?.preStateId).toBe("s2");
    expect(drafts[1]?.preStateRejected).toBeUndefined();
    // Shared, therefore plain: neither end is a backfill, and the click's own
    // settle still produced its own result.
    expect(drafts[0]?.postStateBackfilled).toBeUndefined();
    expect(drafts[1]?.postStateBackfilled).toBeUndefined();
    expect(drafts[0]?.postStatePending).toBeUndefined();
    expect(drafts[1]?.postStateId).toBe("s3");
  });
});
