import { describe, expect, it } from "vitest";
import { TRACE_VERSION_V3, VOM_FORMAT_VERSION } from "@/transport/types";
import { RecordingStateRegistry } from "../recording/state-registry";
import { buildTraceV3 } from "../recording/trace-builder-v3";
import { reduceTraceStepsV3 } from "../recording/trace-reducer-v3";
import { parseTraceStateFrontMatter } from "../recording/trace-state-body";
import type { RecordingDraftStep } from "../recording/types";

describe("trace reducer v3", () => {
  it("removes form literals when value redaction is requested", () => {
    const reduced = reduceTraceStepsV3(
      [
        {
          op: "fill",
          value: "private@example.com",
          preStateId: "s1",
          postStateId: "s1",
        },
        {
          op: "select",
          values: ["private-account-id"],
          labels: ["Private account"],
          preStateId: "s1",
          postStateId: "s1",
        },
      ],
      { redactValues: true },
    );

    expect(reduced.steps[0]).toMatchObject({ op: "fill", value: "***", redacted: true });
    expect(reduced.steps[1]).toMatchObject({ op: "select" });
    expect(reduced.steps[1]).not.toHaveProperty("selection");
    expect(JSON.stringify(reduced.steps)).not.toContain("private@example.com");
    expect(JSON.stringify(reduced.steps)).not.toContain("private-account-id");
  });

  it("emits tab transitions only for callers that advertised support", () => {
    const drafts: RecordingDraftStep[] = [
      {
        op: "switch_tab",
        preStateId: "s1",
        postStateId: "s2",
      },
    ];

    expect(reduceTraceStepsV3(drafts).steps).toEqual([]);
    expect(reduceTraceStepsV3(drafts, { includeTabSwitches: true }).steps).toEqual([
      { op: "switch_tab", id: 1, state: "s1", result: { state: "s2" } },
    ]);
  });

  it("keeps hover steps before menu clicks", () => {
    const drafts: RecordingDraftStep[] = [
      {
        op: "hover",
        captureTarget: { tag: "span", role: "button", name: "Account" },
        preStateId: "s1",
        postStateId: "s1",
      },
      {
        op: "click",
        captureTarget: { tag: "a", role: "link", name: "Profile" },
        preStateId: "s1",
        postStateId: "s1",
      },
    ];

    expect(reduceTraceStepsV3(drafts).steps.map((s) => s.op)).toEqual(["hover", "click"]);
  });

  it("does not export a tab transition without both observation endpoints", () => {
    const sourceOnly: RecordingDraftStep = { op: "switch_tab", preStateId: "s1" };
    const targetOnly: RecordingDraftStep = { op: "switch_tab", postStateId: "s2" };

    expect(
      reduceTraceStepsV3([sourceOnly, targetOnly], { includeTabSwitches: true }).steps,
    ).toEqual([]);
  });

  it("collapses redirect hops while retaining draft-to-step identity", () => {
    const drafts: RecordingDraftStep[] = [
      { op: "navigate", url: "https://example.com/start", preStateId: "s1", postStateId: "s2" },
      {
        op: "navigate",
        url: "https://example.com/final",
        transitionQualifiers: ["server_redirect"],
        preStateId: "s2",
        postStateId: "s3",
      },
    ];
    const before = structuredClone(drafts);
    const reduced = reduceTraceStepsV3(drafts);

    expect(drafts).toEqual(before);
    expect(reduced.steps).toEqual([
      expect.objectContaining({
        id: 1,
        op: "navigate",
        state: "s1",
        to: "https://example.com/final",
        result: { state: "s3" },
      }),
    ]);
    expect(reduced.stepIdByDraftId.get(1)).toBe(1);
    expect(reduced.stepIdByDraftId.get(2)).toBe(1);
  });

  it("flags a step whose pre-state observation was rejected as late", () => {
    // Regression for D3/M2: `state = preStateId ?? postStateId` silently made a
    // step look like "the page did not change", hiding that the observation
    // sampled for it was taken after the action had already run.
    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "li", role: "menuitem", name: "Option" },
        postStateId: "s2",
        preStateRejected: "late",
      },
    ];

    const reduced = reduceTraceStepsV3(drafts);
    expect(reduced.steps).toHaveLength(1);
    expect(reduced.steps[0]).toMatchObject({
      op: "click",
      id: 1,
      state: "s2",
      result: { state: "s2" },
      state_unbound: true,
    });
    expect(reduced.noObservationStepIds).toEqual([]);
  });

  it("counts a never-observed pre-state without marking it as unbound", () => {
    // R1-5: "no observation at all" is a different defect from "a late snapshot
    // was rejected". It gets no `state_unbound` marker (no false positive for
    // downstream needsReview) but is reported through the debug counter.
    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        captureTarget: { tag: "li", role: "menuitem", name: "Option" },
        postStateId: "s2",
        preStateRejected: "none",
      },
      { op: "scroll", preStateId: "s2", postStateId: "s2" },
    ];

    const reduced = reduceTraceStepsV3(drafts);
    expect(reduced.steps[0]).toMatchObject({ op: "click", state: "s2", result: { state: "s2" } });
    expect(reduced.steps[0]).not.toHaveProperty("state_unbound");
    expect(reduced.noObservationStepIds).toEqual([1]);
  });

  it("does not treat a bare missing pre-state as a rejected observation", () => {
    // Drafts built by callers that never ran the binder carry no reason, so the
    // reducer must not invent one.
    const drafts: RecordingDraftStep[] = [{ op: "scroll", postStateId: "s2" }];

    const reduced = reduceTraceStepsV3(drafts);
    expect(reduced.steps[0]).not.toHaveProperty("state_unbound");
    expect(reduced.noObservationStepIds).toEqual([]);
  });

  it("does not mark a step whose page genuinely did not change", () => {
    const drafts: RecordingDraftStep[] = [
      { op: "click", postStateId: "s2", preStateId: "s2" },
      { op: "scroll", preStateId: "s2" },
    ];

    for (const step of reduceTraceStepsV3(drafts).steps) {
      expect(step).not.toHaveProperty("state_unbound");
      expect(step.state).toBe(step.result.state);
    }
  });

  it("carries the pre-state marker into the wire trace", () => {
    const registry = new RecordingStateRegistry();
    const bound = registry.register({ url: "https://example.com", vomText: "@vom 1\nbound" });
    const late = registry.register({ url: "https://example.com", vomText: "@vom 1\nlate" });
    const trace = buildTraceV3({
      registry,
      drafts: [
        { op: "scroll", preStateId: bound.id, postStateId: bound.id },
        {
          op: "click",
          captureTarget: { tag: "li", role: "menuitem", name: "Option" },
          postStateId: late.id,
          preStateRejected: "late",
        },
      ],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.steps[0]).not.toHaveProperty("state_unbound");
    expect(trace.steps[1]).toMatchObject({ state_unbound: true });
    const dumped = JSON.stringify(trace);
    expect(dumped).toContain('"state_unbound":true');
    // The step-level key is dropped by the Rust structs on a CLI round trip, so
    // the body front matter is the only copy that survives it (R1-4).
    const lateState = trace.states.find((state) => state.id === trace.steps[1]!.state);
    expect(lateState?.body).toContain("state_unbound_steps: [2]");
    expect(trace.states[0]?.body).not.toContain("state_unbound_steps");
  });

  it("mirrors backfilled and fabricated post-states into the body front matter (R2-8 / R2-12)", () => {
    // R2-8: E9's only durable trace of a trailing backfill was a `steps_here`
    // line, which `steps_here` shares with ordinary binds — a replay could not
    // tell "this action's result really is s2" from "a coarser, later
    // observation was stamped onto it". R2-12: a fabricated landing was worse
    // still: `#fallbackMissingPostStates` reused an adjacent state with no mark
    // at all. Both are now visible where the pre-state marker already is.
    const registry = new RecordingStateRegistry();
    const bound = registry.register({ url: "https://example.com", vomText: "@vom 1\nbound" });
    const later = registry.register({ url: "https://example.com/next", vomText: "@vom 1\nnext" });
    const trace = buildTraceV3({
      registry,
      drafts: [
        {
          op: "fill",
          value: "a",
          captureTarget: { tag: "input" },
          preStateId: bound.id,
          postStateId: later.id,
          postStateBackfilled: true,
        },
        {
          op: "click",
          captureTarget: { tag: "button", name: "Go" },
          preStateId: bound.id,
          postStateId: later.id,
          postStateBackfilled: true,
        },
        {
          op: "select",
          values: ["x"],
          captureTarget: { tag: "select" },
          preStateId: later.id,
          postStateId: later.id,
          postStateFallback: true,
        },
      ],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    const nextState = trace.states.find((state) => state.id === trace.steps[0]!.result.state);
    const nextFrontMatter = parseTraceStateFrontMatter(nextState!.body);
    // Steps 1-2 were backfilled; step 3 was fabricated and reports separately.
    expect(nextFrontMatter.state_backfilled_steps).toEqual([1, 2]);
    expect(nextFrontMatter.post_state_fallback_steps).toEqual([3]);
    // `steps_here` is only filled by `registry.markStep`, i.e. by the controller;
    // the point of these two lines is that they exist independently of it, so a
    // body built without a controller still reports the provenance.
    expect(nextFrontMatter.steps_here).toBeUndefined();
    const previousState = trace.states.find((state) => state.id !== nextState!.id);
    expect(previousState?.body).not.toContain("state_backfilled_steps");
    expect(previousState?.body).not.toContain("post_state_fallback_steps");
    // Still no step-level key: it would not survive a CLI round trip (R1-4).
    expect(JSON.stringify(trace.steps)).not.toContain("postStateBackfilled");
    expect(JSON.stringify(trace.steps)).not.toContain("postStateFallback");
  });

  it("keeps the internal arrival clock and gap reason out of the wire trace", () => {
    // `arrivedAt` and `preStateRejected` are binder bookkeeping, not protocol
    // fields: only their `state_unbound` consequence may reach the trace.
    const registry = new RecordingStateRegistry();
    const state = registry.register({ url: "https://example.com", vomText: "@vom 1" });
    const trace = buildTraceV3({
      registry,
      drafts: [
        {
          op: "click",
          captureTarget: { tag: "button", role: "button", name: "Save" },
          preStateId: state.id,
          postStateId: state.id,
          arrivedAt: 1_000,
          preStateRejected: "late",
        },
      ],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    const dumped = JSON.stringify(trace);
    expect(dumped).not.toContain("arrivedAt");
    expect(dumped).not.toContain("preStateRejected");
    expect(trace.steps[0]).not.toHaveProperty("state_unbound");
  });

  it("builds the wire model from protocol constants", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({ url: "https://example.com", vomText: "@vom 1" });
    const trace = buildTraceV3({
      registry,
      drafts: [
        {
          op: "click",
          captureTarget: { tag: "button", role: "button", name: "Save" },
          preStateId: state.id,
          postStateId: state.id,
        },
      ],
      startedAt: "2026-08-12T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.version).toBe(TRACE_VERSION_V3);
    expect(trace.recorder.vom).toBe(VOM_FORMAT_VERSION);
    expect(trace.steps[0]).toMatchObject({
      op: "click",
      target: { role: "button", name: "Save", unmatched: true },
    });
  });
});
