import { describe, expect, it } from "vitest";
import { CursorLifecycle, cursorYieldsToOverlay } from "../cursor-lifecycle";

const move = (x: number, y: number) => ({ x, y, durationMs: 0 });

describe("cursorYieldsToOverlay", () => {
  it("keeps the cursor while the agent is in control or a take-over is in flight", () => {
    // Control: the agent is driving.
    expect(cursorYieldsToOverlay("control", "aa11")).toBe(false);
    // Interrupting: the take-over is not confirmed, so input may still land.
    expect(cursorYieldsToOverlay("interrupting", "aa11")).toBe(false);
  });

  it("yields once the human drives or the session is gone", () => {
    expect(cursorYieldsToOverlay("paused", "aa11")).toBe(true);
    expect(cursorYieldsToOverlay("hidden", "aa11")).toBe(true);
    expect(cursorYieldsToOverlay("control", null)).toBe(true);
    expect(cursorYieldsToOverlay("paused", null)).toBe(true);
  });
});

describe("CursorLifecycle", () => {
  it("shows nothing until the agent points somewhere under its own control", () => {
    const lifecycle = new CursorLifecycle();
    expect(lifecycle.snapshot()).toBeNull();

    lifecycle.point(move(10, 20));
    // A point without ownership must not render: a session that does not own
    // this tab cannot move the page's cursor.
    expect(lifecycle.snapshot()).toBeNull();

    lifecycle.applyOverlayMode("control", "aa11");
    expect(lifecycle.snapshot()).toMatchObject({ x: 10, y: 20 });
  });

  it("keeps the last position across an idle gap between tool calls", () => {
    const lifecycle = new CursorLifecycle();
    lifecycle.applyOverlayMode("control", "aa11");
    lifecycle.point(move(5, 6));

    // Nothing else happens — no messages, no state changes — for a long time.
    // The cursor must still be where the agent left it.
    expect(lifecycle.snapshot()).toMatchObject({ x: 5, y: 6 });
  });

  it("hides on human take-over and restores where the agent left it on return", () => {
    const lifecycle = new CursorLifecycle();
    lifecycle.applyOverlayMode("control", "aa11");
    lifecycle.point(move(30, 40));
    expect(lifecycle.snapshot()).toMatchObject({ x: 30, y: 40 });

    lifecycle.applyOverlayMode("paused", "aa11");
    expect(lifecycle.snapshot()).toBeNull();
    // The position survives, so the agent does not lose its place.
    expect(lifecycle.isOwned).toBe(false);

    lifecycle.applyOverlayMode("control", "aa11");
    expect(lifecycle.snapshot()).toMatchObject({ x: 30, y: 40 });
  });

  it("keeps the cursor visible while a take-over is only in flight", () => {
    const lifecycle = new CursorLifecycle();
    lifecycle.applyOverlayMode("control", "aa11");
    lifecycle.point(move(7, 8));

    lifecycle.applyOverlayMode("interrupting", "aa11");
    expect(lifecycle.snapshot()).toMatchObject({ x: 7, y: 8 });
  });

  it("hides when the session ends and does not leak into a later one", () => {
    const lifecycle = new CursorLifecycle();
    lifecycle.applyOverlayMode("control", "aa11");
    lifecycle.point(move(1, 2));

    lifecycle.applyOverlayMode("hidden", null);
    expect(lifecycle.snapshot()).toBeNull();

    // A new session in the same document starts blank rather than inheriting
    // the old session's position.
    lifecycle.applyOverlayMode("control", "bb22");
    expect(lifecycle.snapshot()).toBeNull();
  });

  it("clears the remembered position on an explicit hide and on overlay reset", () => {
    const lifecycle = new CursorLifecycle();
    lifecycle.applyOverlayMode("control", "aa11");
    lifecycle.point(move(9, 9));

    lifecycle.clear();
    expect(lifecycle.snapshot()).toBeNull();
    lifecycle.applyOverlayMode("control", "aa11");
    expect(lifecycle.snapshot()).toBeNull();
  });
});
