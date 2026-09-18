import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The recording facade is the *only* place that defaults `keepRedundantRefChildren`
 * on. These assertions pin the boundary directly on the option object so a future
 * refactor cannot quietly move the default back into `./observation` (where it would
 * change `snapshot`/`observe` too — the Fable review's medium finding).
 */
const captureVomObservationRaw = vi.hoisted(() =>
  vi.fn(async (_cdp: never, _tabId: number, _url?: string, _options?: unknown) => ({
    text: "",
    refs: [],
  })),
);

vi.mock("../observation", () => ({ captureVomObservation: captureVomObservationRaw }));

import { captureVomObservation as captureRecordingVomObservation } from "../capture-vom-observation";

beforeEach(() => {
  captureVomObservationRaw.mockClear();
});

describe("recording observation facade render options", () => {
  it("defaults keepRedundantRefChildren to true on the recording path", async () => {
    await captureRecordingVomObservation({} as never, 4, "https://example.com");

    expect(captureVomObservationRaw).toHaveBeenCalledTimes(1);
    expect(captureVomObservationRaw.mock.calls[0]?.[3]).toMatchObject({
      keepRedundantRefChildren: true,
    });
  });

  it("forwards every other option untouched", async () => {
    await captureRecordingVomObservation({} as never, 4, "https://example.com", {
      maxTokens: 3000,
      redactValues: true,
      conditionalSurfaceProbe: false,
    });

    expect(captureVomObservationRaw.mock.calls[0]?.[3]).toEqual({
      maxTokens: 3000,
      redactValues: true,
      conditionalSurfaceProbe: false,
      keepRedundantRefChildren: true,
    });
  });

  it("lets an explicit keepRedundantRefChildren win", async () => {
    await captureRecordingVomObservation({} as never, 4, "https://example.com", {
      keepRedundantRefChildren: false,
    });

    expect(captureVomObservationRaw.mock.calls[0]?.[3]).toMatchObject({
      keepRedundantRefChildren: false,
    });
  });
});
