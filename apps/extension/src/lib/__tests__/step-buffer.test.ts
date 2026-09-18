import { describe, expect, it } from "vitest";
import {
  appendRecordedPayload,
  observeRecordedNavigation,
  type RecordingStepBuffer,
} from "../recording/step-buffer";

describe("recording-step-buffer", () => {
  it("stores semantic click without summary", () => {
    const buffer = { steps: [], navigation: { pendingNavigation: false } };
    appendRecordedPayload(buffer, {
      op: "click",
      target: { tag: "button", role: "button", name: "发布" },
      expects_navigation: true,
    });
    expect(buffer.steps).toEqual([
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "发布" },
      },
    ]);
    expect(buffer.navigation.pendingNavigation).toBe(true);
  });

  it("rides the arrival clock onto the draft so a late observation is rejected", () => {
    const buffer = { steps: [], navigation: { pendingNavigation: false } };
    appendRecordedPayload(
      buffer,
      { op: "click", target: { tag: "button", role: "button", name: "Save" } },
      undefined,
      1_000,
    );
    expect(buffer.steps[0]).toMatchObject({ op: "click", arrivedAt: 1_000 });
  });

  it("omits the arrival clock when the caller has none", () => {
    const buffer = { steps: [], navigation: { pendingNavigation: false } };
    appendRecordedPayload(buffer, {
      op: "click",
      target: { tag: "button", role: "button", name: "Save" },
    });
    expect(buffer.steps[0]).not.toHaveProperty("arrivedAt");
  });

  it("keeps the hovered element description as a capture fallback", () => {
    const buffer = { steps: [], navigation: { pendingNavigation: false } };
    appendRecordedPayload(
      buffer,
      {
        op: "hover",
        target: { tag: "button", role: "button", name: "新建" },
        geometry: {
          rect: { x: 900, y: 8, w: 60, h: 32 },
          tag: "button",
        },
      },
      {
        geometry: {
          rect: { x: 900, y: 8, w: 60, h: 32 },
          tag: "button",
        },
      },
    );
    expect(buffer.steps).toEqual([
      {
        op: "hover",
        captureTarget: { tag: "button", role: "button", name: "新建" },
        targetHint: {
          geometry: {
            rect: { x: 900, y: 8, w: 60, h: 32 },
            tag: "button",
          },
        },
      },
    ]);
  });

  it("annotates navigated_to on action-caused navigation instead of wait_for_navigation", () => {
    const buffer = {
      steps: [
        {
          op: "click" as const,
          captureTarget: { tag: "button", role: "button", name: "发布" },
        },
      ],
      navigation: {
        currentUrl: "https://example.com/a",
        pendingNavigation: true,
        pendingNavigationDeadline: Date.now() + 5_000,
      },
    };
    observeRecordedNavigation(buffer, "https://example.com/b", true);
    expect(buffer.steps).toEqual([
      {
        op: "click",
        captureTarget: { tag: "button", role: "button", name: "发布" },
        navigatedTo: "https://example.com/b",
      },
    ]);
    expect(JSON.stringify(buffer.steps)).not.toContain("wait_for_navigation");
  });

  it("annotates navigated_to onto a select that auto-submits a navigation", () => {
    const buffer = {
      steps: [
        {
          op: "select" as const,
          captureTarget: { tag: "select", role: "combobox", name: "分类" },
          values: ["tech"],
        },
      ],
      navigation: {
        currentUrl: "https://example.com/list",
        pendingNavigation: true,
        pendingNavigationDeadline: Date.now() + 5_000,
      },
    };
    observeRecordedNavigation(buffer, "https://example.com/list?cat=tech", true);
    expect(buffer.steps).toEqual([
      {
        op: "select",
        captureTarget: { tag: "select", role: "combobox", name: "分类" },
        values: ["tech"],
        navigatedTo: "https://example.com/list?cat=tech",
      },
    ]);
  });

  it("emits navigate for uncaused URL changes", () => {
    const buffer = {
      steps: [],
      navigation: { currentUrl: "https://example.com/a", pendingNavigation: false },
    };
    const result = observeRecordedNavigation(buffer, "https://example.com/b", false);
    expect(result).toEqual({ kind: "appended", index: 0 });
    expect(buffer.steps[0]).toMatchObject({
      op: "navigate",
      url: "https://example.com/b",
    });
  });

  it("asks the recorder to coalesce redirect hops instead of emitting each one", () => {
    const buffer = {
      steps: [],
      navigation: {
        currentUrl: "https://passport.example/login",
        pendingNavigation: false,
      },
    };
    const hop1 = observeRecordedNavigation(
      buffer,
      "https://passport.example/callback",
      false,
      "link",
      ["server_redirect"],
    );
    expect(hop1).toEqual({
      kind: "coalesce_redirect",
      url: "https://passport.example/callback",
    });
    expect(buffer.steps).toEqual([]);

    const hop2 = observeRecordedNavigation(buffer, "https://app.example/dashboard", false, "link", [
      "client_redirect",
    ]);
    expect(hop2).toEqual({
      kind: "coalesce_redirect",
      url: "https://app.example/dashboard",
    });
    expect(buffer.steps).toEqual([]);
    expect(buffer.navigation.currentUrl).toBe("https://app.example/dashboard");
  });

  it("does not reuse redirect metadata for a later content-observed URL change", () => {
    const buffer = {
      steps: [],
      navigation: {
        currentUrl: "https://example.com/redirect",
        pendingNavigation: false,
      },
    };

    const result = observeRecordedNavigation(buffer, "https://example.com/spa");

    expect(result).toEqual({ kind: "appended", index: 0 });
    expect(buffer.steps[0]).toMatchObject({ op: "navigate", url: "https://example.com/spa" });
  });

  it("drops an arming about:blank commit that arrives before any action step", () => {
    const buffer: RecordingStepBuffer = {
      steps: [],
      navigation: { currentUrl: "https://example.com/", pendingNavigation: false },
    };

    const result = observeRecordedNavigation(buffer, "about:blank", false, "link", []);

    expect(result).toEqual({ kind: "noop" });
    expect(buffer.steps).toEqual([]);
    // The cursor is untouched so the real start URL still lands normally.
    expect(buffer.navigation.currentUrl).toBe("https://example.com/");
  });

  it("still emits about:blank as a step once the recording has action steps", () => {
    const buffer: RecordingStepBuffer = {
      steps: [{ op: "click", captureTarget: { tag: "a", role: "link", name: "Home" } }],
      navigation: { currentUrl: "https://example.com/", pendingNavigation: false },
    };

    const result = observeRecordedNavigation(buffer, "about:blank", false, "link", []);

    expect(result).toEqual({ kind: "appended", index: 1 });
    expect(buffer.steps[1]).toMatchObject({ op: "navigate", url: "about:blank" });
  });

  it("records a user landing on about:blank after an explicit agent navigate (R2-14)", () => {
    // E7: `bsk navigate` is a step of its own, so the buffer holds nothing but a
    // navigate step right after recording arms. The startup window is covered by
    // E12's `acceptingNavigation` gate, so the buffer's content must not be used
    // to infer "still arming": the user really navigating to about:blank must be
    // recorded instead of being dropped as a noop.
    const buffer: RecordingStepBuffer = { steps: [], navigation: { pendingNavigation: false } };
    const observed = observeRecordedNavigation(
      buffer,
      "https://example.com/start",
      true,
      "link",
      [],
    );
    expect(observed).toEqual({ kind: "appended", index: 0 });
    expect(buffer.steps.map((step) => step.op)).toEqual(["navigate"]);

    const result = observeRecordedNavigation(buffer, "about:blank", false, "link", []);

    expect(result).toEqual({ kind: "appended", index: 1 });
    expect(buffer.steps[1]).toMatchObject({ op: "navigate", url: "about:blank" });
    expect(buffer.navigation.currentUrl).toBe("about:blank");
  });

  // D2 §2.2/§2.3: `expects_navigation` defaults to true for every click, so a
  // pending intent is usually present when the agent issues an explicit
  // `bsk navigate` right after a click that never navigated. Chrome reports that
  // commit as `typed` + `from_address_bar`; it must produce its own navigate
  // step, not be absorbed by (and then lost in) the click annotation.
  it("appends an explicit agent navigation as its own step instead of consuming a click intent", () => {
    const buffer: RecordingStepBuffer = {
      steps: [],
      navigation: { pendingNavigation: false },
    };
    appendRecordedPayload(buffer, {
      op: "click",
      target: { tag: "button", role: "button", name: "Profile beta" },
      expects_navigation: true,
    });
    expect(buffer.navigation.pendingNavigation).toBe(true);

    const result = observeRecordedNavigation(
      buffer,
      "https://example.com/navigation/start",
      false,
      "typed",
      ["from_address_bar"],
    );

    expect(result).toEqual({ kind: "appended", index: 1 });
    expect(buffer.steps.map((step) => step.op)).toEqual(["click", "navigate"]);
    expect(buffer.steps[0]).not.toHaveProperty("navigatedTo");
    expect(buffer.steps[1]).toMatchObject({
      op: "navigate",
      url: "https://example.com/navigation/start",
      transitionType: "typed",
      transitionQualifiers: ["from_address_bar"],
    });
    expect(buffer.navigation.pendingNavigation).toBe(false);
  });

  it("appends a typed navigation even when the caller left causedByAction unset", () => {
    const buffer: RecordingStepBuffer = {
      steps: [
        { op: "click", captureTarget: { tag: "button", role: "button", name: "Profile beta" } },
      ],
      navigation: {
        currentUrl: "https://example.com/a",
        pendingNavigation: true,
        pendingNavigationDeadline: Date.now() + 5_000,
      },
    };

    const result = observeRecordedNavigation(buffer, "https://example.com/b", undefined, "typed", [
      "from_address_bar",
    ]);

    expect(result).toEqual({ kind: "appended", index: 1 });
    expect(buffer.steps.map((step) => step.op)).toEqual(["click", "navigate"]);
    expect(buffer.steps[0]).not.toHaveProperty("navigatedTo");
  });

  it("still annotates a click-driven link navigation with no agent metadata", () => {
    const buffer: RecordingStepBuffer = {
      steps: [{ op: "click", captureTarget: { tag: "a", role: "link", name: "Details" } }],
      navigation: {
        currentUrl: "https://example.com/navigation/start",
        pendingNavigation: true,
        pendingNavigationDeadline: Date.now() + 5_000,
      },
    };

    const result = observeRecordedNavigation(
      buffer,
      "https://example.com/navigation/detail",
      undefined,
      "link",
      [],
    );

    expect(result).toEqual({ kind: "annotated", index: 0 });
    expect(buffer.steps).toHaveLength(1);
    expect(buffer.steps[0]).toMatchObject({
      op: "click",
      navigatedTo: "https://example.com/navigation/detail",
    });
  });
});
