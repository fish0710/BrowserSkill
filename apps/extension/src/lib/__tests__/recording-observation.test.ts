import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import {
  type CapturedRecordingObservation,
  ObservationNodeIndex,
} from "../recording/observation-capture";
import { RecordingObservationSession } from "../recording/observation-session";
import { RecordingStateRegistry } from "../recording/state-registry";
import { buildTraceV3 } from "../recording/trace-builder-v3";
import type { RecordingDraftStep } from "../recording/types";

const captureRecordingObservation = vi.hoisted(() => vi.fn());

vi.mock("../recording/observation-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recording/observation-capture")>();
  return { ...actual, captureRecordingObservation };
});

const URL = "https://example.com/login";

function sessionWithInput(redactValues = false): RecordingObservationSession {
  const session = new RecordingObservationSession({ redactValues });
  const state = session.registry.register({
    url: URL,
    vomText: '@vom 1\ntextbox "Password" value="••••••" [ref=e1]',
  });
  session.cursor.lastSettled = {
    stateId: state.id,
    rootFrameId: "root",
    index: new ObservationNodeIndex({
      rootFrameId: "root",
      matchNodes: [
        {
          frameId: "root",
          backendNodeId: 42,
          tag: "input",
          rect: { x: 20, y: 40, w: 200, h: 30 },
          localRect: { x: 20, y: 40, w: 200, h: 30 },
        },
      ],
      refs: [{ ref: "e1", backendNodeId: 42, role: "textbox", name: "Password", line: 1 }],
    }),
    url: URL,
  };
  return session;
}

function finalizedFillTrace(value: string, redactValues: boolean) {
  const session = sessionWithInput(redactValues);
  const draft: RecordingDraftStep = {
    op: "fill",
    captureTarget: { tag: "input", role: "textbox", name: "Password" },
    value,
    targetHint: {
      geometry: { rect: { x: 20, y: 40, w: 200, h: 30 }, tag: "input" },
    },
  };
  session.bindDraft(draft, 1);
  draft.postStateId = draft.preStateId;
  return buildTraceV3({
    registry: session.registry,
    drafts: [draft],
    annotations: session.annotations,
    startedAt: "2026-08-12T00:00:00.000Z",
    stoppedBy: "user_finish",
    bskVersion: "test",
    redactValues,
  });
}

function finalizedFillBody(value: string, redactValues: boolean): string {
  return finalizedFillTrace(value, redactValues).states[0]!.body;
}

describe("record observation annotations", () => {
  it("omits a fill literal when values are redacted", () => {
    const secret = "hunter2-private";
    const dumped = JSON.stringify(finalizedFillTrace(secret, true));
    expect(dumped).toContain("step 1: fill");
    expect(dumped).not.toContain(secret);
  });

  it("scrubs the replayed URL, title and body at the builder exit (D3-1)", () => {
    const secret = "ALPHA-secret-123";
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: `https://example.com/result?text=${secret}`,
      title: `Result for ${secret}`,
      vomText: `@vom 1\nRootWebArea\n  paragraph "Received! ${secret}"`,
    });
    const trace = buildTraceV3({
      registry,
      drafts: [
        {
          op: "fill",
          value: secret,
          captureTarget: { tag: "input", role: "textbox", name: "Text input" },
          preStateId: state.id,
          postStateId: state.id,
        },
      ],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
      redactValues: true,
    });

    expect(JSON.stringify(trace)).not.toContain(secret);
    expect(trace.states[0]!.url).toBe("https://example.com/result?text=***");
    expect(trace.states[0]!.title).toBe("Result for ***");
    expect(trace.states[0]!.body).toContain('paragraph "Received! ***"');
    // The registry keeps the plaintext: `url\0vomText` is the state dedup key,
    // so scrubbing it in place would change which observations share a state.
    expect(state.url).toContain(secret);
    expect(state.vomText).toContain(secret);
  });

  it("keeps ordinary fill details", () => {
    expect(finalizedFillBody("ordinary text", false)).toContain('step 1: fill: "ordinary text"');
  });

  it("encodes title and URL so line breaks cannot corrupt state metadata", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: "https://example.com/a\nb",
      title: "hello\nworld",
      vomText: "@vom 1",
    });
    const trace = buildTraceV3({
      registry,
      drafts: [{ op: "scroll", preStateId: state.id, postStateId: state.id }],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });
    expect(trace.states[0]?.body).toContain('url: "https://example.com/a\\nb"');
    expect(trace.states[0]?.body).toContain('title: "hello\\nworld"');
  });
});

describe("recording state ownership", () => {
  it("deduplicates within one recording and isolates ids between recordings", () => {
    const first = new RecordingStateRegistry();
    const second = new RecordingStateRegistry();
    expect(first.register({ url: URL, vomText: "same" }).id).toBe("s1");
    expect(first.register({ url: URL, vomText: "same" }).id).toBe("s1");
    expect(second.register({ url: URL, vomText: "other" }).id).toBe("s1");
  });

  it("enriches metadata when a deduplicated observation becomes more complete", () => {
    const registry = new RecordingStateRegistry();
    registry.register({ url: URL, vomText: "same" });
    const state = registry.register({
      url: URL,
      title: "Login",
      vomText: "same",
      truncated: true,
    });
    expect(state).toMatchObject({ id: "s1", title: "Login", truncated: true });
  });
});

describe("draft binding", () => {
  it("keeps capture semantics when no observation exists", () => {
    const session = new RecordingObservationSession();
    const draft: RecordingDraftStep = {
      op: "hover",
      captureTarget: { tag: "button", role: "button", name: "新建" },
    };
    session.bindDraft(draft, 1);
    expect(draft.matchedTarget).toEqual({ role: "button", name: "新建", unmatched: true });
    expect(draft.preStateId).toBeUndefined();
    // "Nothing was ever observed" is recorded as its own reason, so the reducer
    // does not report it as a rejected late snapshot (R1-5).
    expect(draft.preStateRejected).toBe("none");
  });

  it("still binds the pre-state of an unmatched action while the previous action is pending", () => {
    // Regression for D3: the early `return` on `previousActionPending &&
    // unmatched` dropped `preStateId` *and* `markStep`, which is how a step
    // ended up with no pre-state at all.
    const session = sessionWithInput();
    const draft: RecordingDraftStep = {
      op: "click",
      captureTarget: { tag: "button", role: "button", name: "Confirm" },
      targetHint: {
        geometry: { rect: { x: 400, y: 300, w: 80, h: 30 }, tag: "button" },
      },
    };
    session.bindDraft(draft, 2);
    expect(draft.preStateId).toBe("s1");
    expect("matchedTarget" in draft ? draft.matchedTarget : undefined).toEqual({
      role: "button",
      name: "Confirm",
      unmatched: true,
    });
    expect(session.registry.values()[0]?.stepsHere).toContain(2);
  });

  it("does not use an observation that settled after the action as its pre-state", () => {
    const session = sessionWithInput();
    const arrivedAt = 1_000;
    // The observation was registered after the action arrived, so it shows the
    // panel this very action opened, not the state it started from.
    session.cursor.lastSettledAt = arrivedAt + 250;

    const draft: RecordingDraftStep = {
      op: "click",
      captureTarget: { tag: "button", role: "button", name: "Story" },
      targetHint: {
        geometry: { rect: { x: 400, y: 300, w: 80, h: 30 }, tag: "button" },
      },
    };
    session.bindDraft(draft, 3, arrivedAt);

    expect(draft.preStateId).toBeUndefined();
    expect(draft.preStateRejected).toBe("late");
    expect(draft.matchedTarget).toEqual({ role: "button", name: "Story", unmatched: true });
    expect(session.registry.values()[0]?.stepsHere).not.toContain(3);
  });

  it("binds a pre-state that settled before the action arrived", () => {
    const session = sessionWithInput();
    const arrivedAt = 1_000;
    session.cursor.lastSettledAt = arrivedAt - 1;

    const draft: RecordingDraftStep = { op: "scroll" };
    session.bindDraft(draft, 4, arrivedAt);

    expect(draft.preStateId).toBe("s1");
    expect(draft.preStateRejected).toBeUndefined();
    expect(session.registry.values()[0]?.stepsHere).toContain(4);
  });

  it('distinguishes "never observed" from "rejected a late observation"', () => {
    // R1-5: both end up without `preStateId`, but only the second one means the
    // guard discarded a snapshot sampled after the action.
    const never = new RecordingObservationSession();
    const draftNever: RecordingDraftStep = { op: "scroll" };
    never.bindDraft(draftNever, 5);
    expect(draftNever.preStateId).toBeUndefined();
    expect(draftNever.preStateRejected).toBe("none");

    const late = sessionWithInput();
    late.cursor.lastSettledAt = 2_000;
    const draftLate: RecordingDraftStep = { op: "scroll" };
    late.bindDraft(draftLate, 6, 1_000);
    expect(draftLate.preStateId).toBeUndefined();
    expect(draftLate.preStateRejected).toBe("late");

    const onTime = sessionWithInput();
    onTime.cursor.lastSettledAt = 1_000;
    const draftOnTime: RecordingDraftStep = { op: "scroll" };
    onTime.bindDraft(draftOnTime, 7, 1_000);
    expect(draftOnTime.preStateId).toBe("s1");
    expect(draftOnTime.preStateRejected).toBeUndefined();
  });
});

describe("observation sampling clock (E11)", () => {
  afterEach(() => captureRecordingObservation.mockReset());

  const cdp = { send: vi.fn() } as unknown as CdpRunner;
  const tabsApi = {
    get: vi.fn(async () => ({ id: 7, url: URL }) as chrome.tabs.Tab),
    query: vi.fn(async () => []),
  } as unknown as ChromeTabsApi;

  function captureResult(vomText: string): CapturedRecordingObservation {
    return {
      rootFrameId: "root",
      index: new ObservationNodeIndex({ rootFrameId: "root", matchNodes: [], refs: [] }),
      url: URL,
      vomText,
      truncated: false,
    };
  }

  it("accepts a pre-state whose sampling began before the action even though it settled after", async () => {
    // pace 500ms shape: the hover opens the Account menu and its sample takes a
    // while; the click on "Profile beta" arrives while that sample is still in
    // flight. The DOM read started before the click, so the menu it captured is
    // the click's legal pre-state — the old `settledAt > arrivedAt` guard threw
    // it away and fell back to the pre-hover state, where the target does not
    // exist (unmatched).
    captureRecordingObservation.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return captureResult('@vom 1\nmenu "Account"\n  menuitem "Profile beta"');
    });
    const session = new RecordingObservationSession();
    const pending = session.capture(cdp, tabsApi, 7);
    // The click is delivered while the hover's sample is still being read.
    const arrivedAt = Date.now();
    const observation = await pending;

    expect(observation.capturedAt).toBeLessThanOrEqual(arrivedAt);
    expect(observation.settledAt).toBeGreaterThan(arrivedAt);

    const draft: RecordingDraftStep = {
      op: "click",
      captureTarget: { tag: "menuitem", role: "menuitem", name: "Profile beta" },
    };
    session.bindDraft(draft, 1, arrivedAt);

    expect(draft.preStateId).toBe(observation.stateId);
    expect(draft.preStateRejected).toBeUndefined();
    expect(session.registry.values()[0]?.stepsHere).toContain(1);
  });

  it("rejects a pre-state whose sampling only began after the action arrived", async () => {
    // The second sample is started after the click was delivered, so it shows
    // the menu the click itself opened and can no longer describe where the
    // click started from.
    captureRecordingObservation.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return captureResult(`@vom 1\nstate ${captureRecordingObservation.mock.calls.length}`);
    });
    const session = new RecordingObservationSession();
    const hoverSample = await session.capture(cdp, tabsApi, 7);
    const arrivedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const clickSample = await session.capture(cdp, tabsApi, 7);
    expect(clickSample.capturedAt).toBeGreaterThan(arrivedAt);
    expect(hoverSample.stateId).not.toBe(clickSample.stateId);

    const draft: RecordingDraftStep = { op: "click", captureTarget: { tag: "menuitem" } };
    session.bindDraft(draft, 2, arrivedAt);

    expect(draft.preStateId).toBeUndefined();
    expect(draft.preStateRejected).toBe("late");
  });

  it("keeps injected observations without a sampling clock on the old semantics", () => {
    // Tests and transitional callers register observations by hand. They only
    // carry `settledAt` (or nothing), and must keep working: an absent
    // `capturedAt` falls back to `settledAt`, then to the cursor clock.
    const onlySettled = sessionWithInput();
    onlySettled.cursor.lastSettled = {
      ...onlySettled.cursor.lastSettled!,
      settledAt: 2_000,
    };
    onlySettled.cursor.lastSettledAt = undefined;
    const lateDraft: RecordingDraftStep = { op: "scroll" };
    onlySettled.bindDraft(lateDraft, 8, 1_000);
    expect(lateDraft.preStateRejected).toBe("late");

    const earlySettled = sessionWithInput();
    earlySettled.cursor.lastSettled = {
      ...earlySettled.cursor.lastSettled!,
      settledAt: 1_000,
    };
    earlySettled.cursor.lastSettledAt = undefined;
    const boundDraft: RecordingDraftStep = { op: "scroll" };
    earlySettled.bindDraft(boundDraft, 9, 1_000);
    expect(boundDraft.preStateId).toBe("s1");
    expect(boundDraft.preStateRejected).toBeUndefined();
  });
});
