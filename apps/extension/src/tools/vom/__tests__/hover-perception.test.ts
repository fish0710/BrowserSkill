import { afterEach, describe, expect, it, vi } from "vitest";
import { lastPointer, recordPointer, resetPointerState } from "@/lib/pointer-state";
import type { CdpRunner } from "../../shared";
import {
  clearHover,
  PARKED_POINTER,
  ProbeBudget,
  resetOverlayBypassDepth,
  restoreHoverPointer,
  withOverlayBypass,
} from "../hover-perception";

afterEach(() => {
  resetOverlayBypassDepth();
  resetPointerState();
});

/** Records the viewport point of every `mouseMoved` a probe dispatches. */
function fakeCdp(sent: Array<{ x: number; y: number }> = []): {
  cdp: CdpRunner;
  sent: Array<{ x: number; y: number }>;
} {
  return {
    sent,
    cdp: {
      send: async <T>(_tabId: number, method: string, params?: object) => {
        if (method === "Input.dispatchMouseEvent") {
          const p = params as { x: number; y: number };
          sent.push({ x: p.x, y: p.y });
        }
        return {} as T;
      },
    } as CdpRunner,
  };
}

describe("ProbeBudget", () => {
  it("refuses a candidate that cannot finish inside the budget", () => {
    const budget = new ProbeBudget(500);

    expect(budget.canAfford(400)).toBe(true);
    expect(budget.canAfford(600)).toBe(false);
  });

  it("stops admitting candidates once the remaining budget is smaller than one", async () => {
    const budget = new ProbeBudget(60);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // A top-of-loop `elapsed > total` check would still admit this candidate
    // and then overshoot by its full cost.
    expect(budget.canAfford(50)).toBe(false);
  });
});

describe("withOverlayBypass", () => {
  it("toggles the overlay once around nested probe phases", async () => {
    const bypass = vi.fn(async () => {});

    await withOverlayBypass(bypass, 4, async () => {
      await withOverlayBypass(bypass, 4, async () => {
        expect(bypass).toHaveBeenCalledTimes(1);
      });
      expect(bypass).toHaveBeenCalledTimes(1);
    });

    expect(bypass.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("restores the overlay when the probe throws", async () => {
    const bypass = vi.fn(async () => {});

    await expect(
      withOverlayBypass(bypass, 4, async () => {
        throw new Error("probe exploded");
      }),
    ).rejects.toThrow("probe exploded");

    expect(bypass).toHaveBeenLastCalledWith(4, false);
  });

  it("reports a failed restore instead of swallowing it", async () => {
    const onRestoreFailure = vi.fn();
    const bypass = vi.fn(async (_tabId: number, enabled: boolean) => {
      if (!enabled) throw new Error("tab is gone");
    });

    await withOverlayBypass(bypass, 4, async () => undefined, { onRestoreFailure });

    expect(onRestoreFailure).toHaveBeenCalledTimes(1);
  });

  it("does not pin the overlay off for the tab when a restore fails", async () => {
    const failing = vi.fn(async (_tabId: number, enabled: boolean) => {
      if (!enabled) throw new Error("tab is gone");
    });
    await withOverlayBypass(failing, 4, async () => undefined, { onRestoreFailure: () => {} });

    const bypass = vi.fn(async () => {});
    await withOverlayBypass(bypass, 4, async () => undefined);

    expect(bypass.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("runs the probe untouched when no bypass is wired up", async () => {
    await expect(withOverlayBypass(undefined, 4, async () => "done")).resolves.toBe("done");
  });
});

describe("probe pointer parking and restore", () => {
  it("parks the pointer off to the side without claiming it as an agent position", async () => {
    const { cdp, sent } = fakeCdp();
    await clearHover(cdp, 4);

    expect(sent).toEqual([PARKED_POINTER]);
    // Parking is not an agent action, so it must not overwrite the remembered
    // position a later restore depends on.
    expect(lastPointer(4)).toBeNull();
  });

  it("restores the agent's hover after a probe moved the pointer away", async () => {
    recordPointer(4, { x: 60, y: 40 });
    const { cdp, sent } = fakeCdp();

    await clearHover(cdp, 4);
    await restoreHoverPointer(cdp, 4);

    // The restore is a real leave-then-return transition, so Chrome re-fires
    // mouseenter and the hover-revealed menu comes back.
    expect(sent).toEqual([PARKED_POINTER, { x: 60, y: 40 }]);
    expect(lastPointer(4)).toMatchObject({ x: 60, y: 40 });
  });

  it("leaves the pointer parked when the agent never pointed at this tab", async () => {
    const { cdp, sent } = fakeCdp();
    await clearHover(cdp, 4);
    await restoreHoverPointer(cdp, 4);

    expect(sent).toEqual([PARKED_POINTER]);
  });

  it("never fails a probe because the restore was cancelled", async () => {
    recordPointer(4, { x: 60, y: 40 });
    const { cdp } = fakeCdp();
    const controller = new AbortController();
    controller.abort();

    await expect(restoreHoverPointer(cdp, 4, controller.signal)).resolves.toBeUndefined();
  });

  it("keeps tabs isolated: restoring one tab does not touch another", async () => {
    recordPointer(4, { x: 1, y: 2 });
    recordPointer(5, { x: 3, y: 4 });
    const { cdp, sent } = fakeCdp();

    await restoreHoverPointer(cdp, 5);

    expect(sent).toEqual([{ x: 3, y: 4 }]);
    expect(lastPointer(4)).toMatchObject({ x: 1, y: 2 });
  });
});
