import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ObservationNodeIndex,
  type RegisteredObservation,
} from "@/lib/recording/observation-capture";
import { matchObservationTarget } from "@/lib/recording/target-matcher";
import { captureVomObservation } from "../capture-vom-observation";
import { type CdpAxNode, captureVomObservation as captureTersObservation } from "../observation";
import {
  ensureBrowserObservationListeners,
  isBrowserObservationAttachedForTests,
  RECORD_DEFAULT_START_URL,
  releaseBrowserObservationListenersIfIdle,
  resetBrowserObservationForTests,
  setBrowserObservationAttachForTests,
} from "../record";

describe("record defaults", () => {
  it("uses example.com as the default injectable start URL", () => {
    expect(RECORD_DEFAULT_START_URL).toBe("https://example.com/");
  });
});

describe("browser observation lifecycle", () => {
  afterEach(() => {
    resetBrowserObservationForTests();
  });

  it("does not attach listeners until ensure is called", () => {
    const tab = vi.fn(() => () => undefined);
    const nav = vi.fn(() => () => undefined);
    setBrowserObservationAttachForTests(tab, nav);

    expect(isBrowserObservationAttachedForTests()).toBe(false);
    expect(tab).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it("attaches once on ensure and detaches when idle", () => {
    const detachTab = vi.fn();
    const detachNav = vi.fn();
    const tab = vi.fn(() => detachTab);
    const nav = vi.fn(() => detachNav);
    setBrowserObservationAttachForTests(tab, nav);

    ensureBrowserObservationListeners({
      tabsApi: { get: vi.fn(), query: vi.fn(), create: vi.fn() } as never,
      sendToTab: vi.fn(),
    });
    expect(isBrowserObservationAttachedForTests()).toBe(true);
    expect(tab).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledTimes(1);

    // Idempotent.
    ensureBrowserObservationListeners({
      tabsApi: { get: vi.fn(), query: vi.fn(), create: vi.fn() } as never,
      sendToTab: vi.fn(),
    });
    expect(tab).toHaveBeenCalledTimes(1);

    releaseBrowserObservationListenersIfIdle();
    expect(isBrowserObservationAttachedForTests()).toBe(false);
    expect(detachTab).toHaveBeenCalledTimes(1);
    expect(detachNav).toHaveBeenCalledTimes(1);
  });
});

/**
 * D2-rootcause.md §3: the picker input is a child of a named `combobox`.
 * `render.ts`'s name-covering prune used to drop every descendant of a ref node,
 * so the input never received an `@eN`, `refByNode` had no entry for its
 * backendNodeId, and `target-matcher` reported `unmatched: true` even though the
 * recorded geometry hit exactly one candidate. Recording observation now opts in
 * to `keepRedundantRefChildren`, so the child is rendered and indexable.
 */

const VP_METRICS = {
  visualViewport: { clientWidth: 1000 },
  cssVisualViewport: { clientWidth: 1000 },
  cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
};

// html > body > div(role=combobox, name="Story [expanded]") > input
function pickerSnapshotReply() {
  const S = ["html", "body", "div", "input", "position", "static", "pointer-events", "auto"];
  const i = (s: string) => S.indexOf(s);
  return {
    strings: S,
    documents: [
      {
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        frameId: "root",
        nodes: {
          parentIndex: [-1, 0, 1, 2],
          nodeName: [i("html"), i("body"), i("div"), i("input")],
          backendNodeId: [10, 11, 12, 13],
          attributes: [[], [], [], []],
        },
        layout: {
          nodeIndex: [0, 1, 2, 3],
          styles: [
            [i("static"), i("auto")],
            [i("static"), i("auto")],
            [i("static"), i("auto")],
            [i("static"), i("auto")],
          ],
          bounds: [
            [0, 0, 1000, 800],
            [0, 0, 1000, 800],
            [100, 100, 200, 40],
            [110, 110, 180, 20],
          ],
          paintOrders: [0, 0, 1, 2],
        },
      },
    ],
  };
}

function pickerDeps() {
  const axNodes: CdpAxNode[] = [
    {
      nodeId: "root",
      backendDOMNodeId: 10,
      role: { type: "role", value: "RootWebArea" },
      childIds: ["combobox"],
    },
    {
      nodeId: "combobox",
      parentId: "root",
      backendDOMNodeId: 12,
      role: { type: "role", value: "combobox" },
      name: { type: "computedString", value: "Story [expanded]" },
      childIds: ["input"],
    },
    {
      nodeId: "input",
      parentId: "combobox",
      backendDOMNodeId: 13,
      role: { type: "role", value: "textbox" },
      name: { type: "computedString", value: "Story" },
    },
  ];
  const send = vi.fn(async (_tabId: number, method: string) => {
    if (method === "Accessibility.enable") return {};
    if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
    if (method === "DOMSnapshot.enable") return {};
    if (method === "DOMSnapshot.captureSnapshot") return pickerSnapshotReply();
    if (method === "Page.getLayoutMetrics") return VP_METRICS;
    throw new Error(`unexpected CDP method ${method}`);
  });
  return {
    cdp: {
      send: send as unknown as <T>(tabId: number, method: string, params?: object) => Promise<T>,
      trackSessionTab: vi.fn(),
    },
  };
}

describe("recording observation keeps picker child refs (D2 §3)", () => {
  it("renders the input behind a named combobox with its own ref and tag", async () => {
    const { cdp } = pickerDeps();
    const result = await captureVomObservation(cdp, 4, "https://example.com", {
      keepRedundantRefChildren: true,
    });

    const child = result.refs.find((ref) => ref.backendNodeId === 13);
    expect(child).toBeDefined();
    expect(child?.ref).toMatch(/^e\d+$/);
    expect(child?.name).toBe("Story");
    expect(result.text).toContain(`@${child!.ref} textbox "Story"`);
    // The named container is still rendered as its own ref.
    expect(result.text).toContain('combobox "Story [expanded]"');
  });

  it("resolves the recorded geometry hit to the child ref instead of unmatched", async () => {
    const { cdp } = pickerDeps();
    const result = await captureVomObservation(cdp, 4, "https://example.com", {
      keepRedundantRefChildren: true,
    });
    const observation: RegisteredObservation = {
      stateId: "s2",
      rootFrameId: result.rootFrameId,
      index: new ObservationNodeIndex(result),
      url: "https://example.com",
    };

    const target = matchObservationTarget({
      observation,
      hint: { geometry: { rect: { x: 110, y: 110, w: 180, h: 20 }, tag: "input" } },
      fallback: { tag: "input", name: "Story" },
    });

    expect(target.unmatched).toBeUndefined();
    expect(target.ref).toMatch(/^e\d+$/);
    expect(
      observation.index
        .candidates(result.rootFrameId, "input")
        .find((candidate) => candidate.ref?.ref === target.ref)?.geometry.backendNodeId,
    ).toBe(13);
  });

  it("would be unmatched when the child ref is pruned (regression guard)", async () => {
    const { cdp } = pickerDeps();
    const pruned = await captureVomObservation(cdp, 4, "https://example.com", {
      keepRedundantRefChildren: false,
    });
    expect(pruned.refs.some((ref) => ref.backendNodeId === 13)).toBe(false);

    const target = matchObservationTarget({
      observation: {
        stateId: "s2",
        rootFrameId: pruned.rootFrameId,
        index: new ObservationNodeIndex(pruned),
        url: "https://example.com",
      },
      hint: { geometry: { rect: { x: 110, y: 110, w: 180, h: 20 }, tag: "input" } },
      fallback: { tag: "input", name: "Story" },
    });
    expect(target).toMatchObject({ unmatched: true, name: "Story" });
  });

  it("still prunes plain text children covered by the container name", async () => {
    const { cdp } = pickerDeps();
    const result = await captureVomObservation(cdp, 4, "https://example.com", {
      keepRedundantRefChildren: true,
    });
    // Only the child control gains a ref; nothing else about the render changed.
    expect(result.refs.map((ref) => ref.backendNodeId).sort()).toEqual([12, 13]);
  });

  it("keeps one ref set across the text and visual branches (R2-4)", async () => {
    const { cdp } = pickerDeps();
    // Both branches feed the same `refStore`, so the recording opt-in must reach the
    // visual renderer too (`observe` renders visuals; the text branch is `snapshot`).
    const result = await captureVomObservation(cdp, 4, "https://example.com", {
      includeVisualFacts: true,
    });
    expect(result.visualOutput).toBeDefined();
    const rows = result.visualOutput!.render.rows;
    const visualRefs: NonNullable<ReturnType<typeof rows.next>["value"]>["ref"][] = [];
    for (let next = rows.next(); !next.done; next = rows.next()) {
      if (next.value.ref) visualRefs.push(next.value.ref);
    }
    const withoutVisual = pickerDeps();
    const textRefs = (await captureVomObservation(withoutVisual.cdp, 4, "https://example.com"))
      .refs;
    expect(visualRefs.map((ref) => ref.backendNodeId)).toEqual(
      textRefs.map((ref) => ref.backendNodeId),
    );
    expect(visualRefs.map((ref) => ref.ref)).toEqual(textRefs.map((ref) => ref.ref));
    expect(visualRefs.some((ref) => ref.backendNodeId === 13)).toBe(true);
  });

  it("opts into keepRedundantRefChildren on the recording path only", async () => {
    // The recording facade must hand the renderer `true` …
    const recorded = await captureVomObservation(pickerDeps().cdp, 4, "https://example.com");
    expect(recorded.refs.map((ref) => ref.backendNodeId)).toEqual([12, 13]);

    // … while the shared `snapshot`/`observe` entry point keeps HEAD's terse render:
    // the same fixture through `../observation` yields only the named container.
    const terse = await captureTersObservation(pickerDeps().cdp, 4, "https://example.com");
    expect(terse.refs.map((ref) => ref.backendNodeId)).toEqual([12]);
  });
});

describe("recording facade forwards the render options", () => {
  it("defaults keepRedundantRefChildren to true and lets an explicit value win", async () => {
    const recorded = await captureVomObservation(pickerDeps().cdp, 4, "https://example.com");
    expect(recorded.refs.map((ref) => ref.backendNodeId)).toEqual([12, 13]);

    const forcedOff = await captureVomObservation(pickerDeps().cdp, 4, "https://example.com", {
      keepRedundantRefChildren: false,
    });
    expect(forcedOff.refs.map((ref) => ref.backendNodeId)).toEqual([12]);
  });
});
