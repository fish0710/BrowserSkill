import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";

const captureVomObservation = vi.hoisted(() => vi.fn());

vi.mock("@/tools/capture-vom-observation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/tools/capture-vom-observation")>();
  return { ...actual, captureVomObservation };
});

import { captureRecordingObservation } from "../recording/observation-capture";

function captured(overrides: Record<string, unknown> = {}) {
  return {
    text: '@vom 1\n@view 800x600\n@layers 1 focus=L1\nL1 page\nbutton "Save" [ref=e1]',
    refs: [{ ref: "e1", backendNodeId: 1, role: "button", name: "Save", line: 5 }],
    truncated: false,
    rootFrameId: "root",
    frames: [],
    matchNodes: [
      {
        frameId: "root",
        backendNodeId: 1,
        tag: "button",
        rect: { x: 0, y: 0, w: 80, h: 24 },
        localRect: { x: 0, y: 0, w: 80, h: 24 },
      },
      {
        frameId: "root",
        backendNodeId: 2,
        tag: "div",
        rect: { x: 0, y: 0, w: 0, h: 0 },
        localRect: null,
      },
      { frameId: "root", backendNodeId: 3, tag: "span", rect: null, localRect: null },
    ],
    ...overrides,
  };
}

const deps = {
  cdp: { send: vi.fn() } as unknown as CdpRunner,
  tabsApi: {
    get: vi.fn(async () => ({ url: "https://example.com/", title: "Example" })),
  } as unknown as ChromeTabsApi,
  tabId: 4,
  maxTokens: 3000,
  redactValues: false,
};

describe("recording observation debug counters", () => {
  afterEach(() => {
    captureVomObservation.mockReset();
    vi.restoreAllMocks();
  });

  it("counts pre-render nodes and unpaintable nodes without occluded layers", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    captureVomObservation.mockResolvedValueOnce(captured());

    const result = await captureRecordingObservation(deps);

    expect(result.debug).toEqual({
      preRenderNodes: 3,
      renderedFalseNodes: 2,
      hiddenCount: 0,
      doubleLayer: false,
      renderedRefs: 1,
    });
    // Counts never touch the rendered payload the trace is built from, and
    // `debug` is the only extra key added to the capture contract.
    expect(result.vomText).not.toContain("preRenderNodes");
    expect(Object.keys(result).sort()).toEqual([
      "debug",
      "index",
      "rootFrameId",
      "title",
      "truncated",
      "url",
      "vomText",
    ]);
    expect(debugSpy).toHaveBeenCalledWith("[record-observe]", result.debug);
  });

  it("reads the double-layer hidden count back from the occluded line", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    captureVomObservation.mockResolvedValueOnce(
      captured({
        text: '@vom 1\n@layers 2 focus=L1\nL1 modal cover=90%\ndialog "Hi" [ref=e1]\nL2 page … occluded by L1 (~7 nodes, not actionable)',
        matchNodes: [
          {
            frameId: "root",
            backendNodeId: 9,
            tag: "div",
            rect: { x: 1, y: 1, w: 10, h: 10 },
            localRect: { x: 1, y: 1, w: 10, h: 10 },
          },
        ],
      }),
    );

    const result = await captureRecordingObservation(deps);

    expect(result.debug?.doubleLayer).toBe(true);
    expect(result.debug?.hiddenCount).toBe(7);
    expect(result.debug?.preRenderNodes).toBe(1);
    expect(result.debug?.renderedFalseNodes).toBe(0);
    expect(result.debug?.renderedRefs).toBe(1);
  });
});
