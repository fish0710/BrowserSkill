import { afterEach, describe, expect, it } from "vitest";
import { clearPointer, lastPointer, recordPointer, resetPointerState } from "../pointer-state";

describe("pointer-state", () => {
  afterEach(() => {
    resetPointerState();
  });

  it("remembers the real pointer position per tab", () => {
    recordPointer(7, { x: 10, y: 20 });
    recordPointer(8, { x: 30, y: 40 });

    // Each tab keeps its own pointer: one tab's move never leaks into another.
    expect(lastPointer(7)).toMatchObject({ x: 10, y: 20 });
    expect(lastPointer(8)).toMatchObject({ x: 30, y: 40 });
  });

  it("reports nothing for a tab the agent never pointed at", () => {
    expect(lastPointer(99)).toBeNull();
  });

  it("replaces an earlier position for the same tab", () => {
    recordPointer(7, { x: 1, y: 2 });
    recordPointer(7, { x: 3, y: 4 });
    expect(lastPointer(7)).toMatchObject({ x: 3, y: 4 });
  });

  it("forgets a tab on clear", () => {
    recordPointer(7, { x: 1, y: 2 });
    clearPointer(7);
    expect(lastPointer(7)).toBeNull();
  });

  it("ignores non-finite coordinates instead of recording a poisoned position", () => {
    recordPointer(7, { x: Number.NaN, y: 0 });
    recordPointer(7, { x: 0, y: Number.POSITIVE_INFINITY });
    expect(lastPointer(7)).toBeNull();
  });

  it("invalidates a position recorded for a previous document attachment", () => {
    recordPointer(7, { x: 5, y: 6 }, "attachment-a");
    // Same document: still valid.
    expect(lastPointer(7, "attachment-a")).toMatchObject({ x: 5, y: 6 });
    // A reload/reattach: the old viewport coordinates no longer describe the page.
    expect(lastPointer(7, "attachment-b")).toBeNull();
  });

  it("returns a copy so callers cannot mutate stored state", () => {
    recordPointer(7, { x: 1, y: 2 });
    const first = lastPointer(7);
    if (!first) throw new Error("expected a remembered pointer");
    first.x = 999;
    expect(lastPointer(7)).toMatchObject({ x: 1, y: 2 });
  });
});
