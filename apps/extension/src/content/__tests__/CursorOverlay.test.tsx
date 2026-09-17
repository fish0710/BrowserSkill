import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorOverlay, type CursorState } from "../CursorOverlay";

describe("CursorOverlay", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("positions the cursor at the requested viewport point", () => {
    const { container } = render(<CursorOverlay state={{ x: 120, y: 42, durationMs: 200 }} />);

    const cursor = container.querySelector("[data-slot='agent-cursor']") as HTMLElement;
    expect(cursor).toBeTruthy();
    expect(cursor.style.transform).toContain("120px");
    expect(cursor.style.transform).toContain("42px");
    // The glide is a transform transition, not top/left.
    expect(cursor.style.transition).toContain("transform 200ms");
    expect(cursor.style.pointerEvents).toBe("none");
  });

  it("renders a label pill beside the cursor", () => {
    const { container } = render(
      <CursorOverlay state={{ x: 10, y: 20, durationMs: 0, label: "e12" }} />,
    );

    const label = container.querySelector("[data-slot='agent-cursor-label']") as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toBe("e12");
  });

  it("draws a ripple for a click and a fresh one for the next click id", () => {
    const first: CursorState = { x: 5, y: 6, durationMs: 0, ripple: { id: 1, button: "left" } };
    const { container, rerender } = render(<CursorOverlay state={first} />);

    const ripple = container.querySelector("[data-slot='agent-cursor-ripple']");
    expect(ripple).toBeTruthy();
    expect((ripple as HTMLElement).dataset.button).toBe("left");

    const second: CursorState = { x: 5, y: 6, durationMs: 0, ripple: { id: 2, button: "left" } };
    rerender(<CursorOverlay state={second} />);

    const rerippled = container.querySelector("[data-slot='agent-cursor-ripple']");
    expect(rerippled).toBeTruthy();
    // `key={ripple.id}` remounts the node, so the animation replays.
    expect(rerippled).not.toBe(ripple);
    expect(container.querySelectorAll("[data-slot='agent-cursor-ripple']")).toHaveLength(1);
  });

  it("renders nothing for a null state", () => {
    const { container } = render(<CursorOverlay state={null} />);
    expect(container.querySelector("[data-slot='agent-cursor']")).toBeNull();
  });

  it("stays visible while the agent is idle and only disappears on a null state", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<CursorOverlay state={{ x: 1, y: 2, durationMs: 0 }} />);

    const cursor = container.querySelector("[data-slot='agent-cursor']") as HTMLElement;
    expect(cursor).toBeTruthy();
    // No opacity animation: the arrow is not faded out on idle.
    expect(cursor.style.opacity).toBe("");

    act(() => {
      // A long idle window between two tool calls must not hide the cursor: a
      // human watching the Agent Window still needs to see where the agent is.
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector("[data-slot='agent-cursor']")).toBe(cursor);

    // The next action moves the same node instead of remounting it.
    act(() => {
      rerender(<CursorOverlay state={{ x: 30, y: 40, durationMs: 0 }} />);
    });
    const moved = container.querySelector("[data-slot='agent-cursor']") as HTMLElement;
    expect(moved).toBe(cursor);
    expect(moved.style.transform).toContain("30px");

    // Only an explicit null state (session end, tab return, user takeover,
    // page navigation) removes it.
    act(() => {
      rerender(<CursorOverlay state={null} />);
    });
    expect(container.querySelector("[data-slot='agent-cursor']")).toBeNull();
  });
});
