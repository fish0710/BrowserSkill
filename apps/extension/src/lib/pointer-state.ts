/**
 * Last *real* CDP pointer position per tab.
 *
 * CDP `Input.dispatchMouseEvent` is the only thing that can actually hover or
 * click a page, but the browser offers no way to ask where the logical pointer
 * currently sits. The agent therefore remembers it itself, because several
 * paths care:
 *
 * - the cosmetic cursor must not claim a position the real pointer never
 *   reached, and its glide is sized from the real distance travelled;
 * - a hover latch reassert wants to know whether the pointer already sits on
 *   the latch point (a same-point `mouseMoved` is a no-op in Chrome, so it
 *   neither helps nor hurts);
 * - a perception probe that parks the pointer off to the side must put it back
 *   afterwards instead of leaving the page hover-less.
 *
 * Positions are viewport CSS pixels, the same space `Input.dispatchMouseEvent`
 * takes, scoped per tab so tabs never leak into each other. A missing entry
 * just means "unknown", never an error. The attached CDP attachment id is kept
 * alongside the point: a fresh attachment (page load, detach/reattach) means
 * the recorded point no longer describes this document.
 */

export interface PointerPoint {
  x: number;
  y: number;
}

export interface PointerState extends PointerPoint {
  attachmentId?: string;
}

const lastPointerPoints = new Map<number, PointerState>();

/** Remember where the real CDP pointer was last placed in `tabId`. */
export function recordPointer(tabId: number, point: PointerPoint, attachmentId?: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  lastPointerPoints.set(tabId, {
    x: point.x,
    y: point.y,
    ...(attachmentId ? { attachmentId } : {}),
  });
}

/**
 * Last known real pointer position for `tabId`, or `null` when unknown.
 * Returns `null` as well when the document's CDP attachment changed since the
 * point was recorded: the coordinates no longer describe the live page.
 */
export function lastPointer(tabId: number, attachmentId?: string): PointerState | null {
  const point = lastPointerPoints.get(tabId);
  if (!point) return null;
  if (attachmentId && point.attachmentId && point.attachmentId !== attachmentId) return null;
  return { ...point };
}

/** Forget a tab's pointer position (tab closed / returned / navigated away). */
export function clearPointer(tabId: number): void {
  lastPointerPoints.delete(tabId);
}

/** Test seam: drop every remembered pointer position. */
export function resetPointerState(): void {
  lastPointerPoints.clear();
}
