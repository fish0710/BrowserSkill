/**
 * Content-script-side lifecycle for the cosmetic agent cursor.
 *
 * The cursor is a single per-document piece of state (see {@link CursorOverlay}).
 * Two independent things drive it:
 *
 * - the background's per-action `bsk/cursor` messages (where to point), and
 * - the tab's control mode (whether the agent is the one driving).
 *
 * Keeping them in one place makes the "who owns the pointer right now" rules
 * explicit and testable instead of being scattered across message handlers:
 *
 * | overlay mode            | cursor                                    |
 * |-------------------------|-------------------------------------------|
 * | `control`               | agent drives → show at the last position  |
 * | `interrupting`          | take-over in flight, input may still land → keep |
 * | `paused`                | the human drives → hide, remember where   |
 * | `hidden` / no session   | session over → hide, remember where       |
 *
 * "Remember where" is what lets a session that returns to `control` in the same
 * document restore the arrow exactly where the agent left it. A new document
 * (navigation, tab return, reload) builds a fresh content script with a fresh
 * store, so nothing can leak across documents, tabs, or sessions.
 */
import type { OverlayMode } from "@/lib/overlay-bridge";
import type { CursorState } from "./CursorOverlay";

/**
 * Whether the agent cursor must give way for this tab state.
 *
 * The agent keeps the cursor while it is in control, and also while a take-over
 * request is in flight — the daemon has not confirmed the interruption yet, so
 * input may still be landing on the page. A `paused` tab and a gone session both
 * mean the agent is no longer driving.
 */
export function cursorYieldsToOverlay(mode: OverlayMode, sessionId: string | null): boolean {
  if (sessionId === null) return true;
  return mode === "paused" || mode === "hidden";
}

export class CursorLifecycle {
  /** Last position the agent pointed at, kept for a later restore. */
  private last: CursorState | null = null;
  /** Whether the agent currently owns the pointer in this document. */
  private owned = false;
  /**
   * The session the remembered position belongs to. A different session taking
   * over the same document must not inherit the previous one's position, so the
   * point is dropped when the owner changes.
   */
  private ownerSessionId: string | null = null;

  /** Record a background `move`/`click`; the agent pointed somewhere. */
  point(state: CursorState): void {
    this.last = state;
  }

  /** Forget the position entirely (explicit `hide`, or overlay reset). */
  clear(): void {
    this.last = null;
    this.owned = false;
  }

  /**
   * Apply the tab's authoritative control state. A tab the agent does not own
   * hides the arrow but keeps its last position, so handing control back to the
   * *same* session restores it where it was.
   */
  applyOverlayMode(mode: OverlayMode, sessionId: string | null): void {
    // Only an actual *change* of owning session invalidates the remembered
    // position. `null` means "no known owner yet", which must not throw away a
    // point that arrived before the tab's overlay state did.
    if (this.ownerSessionId !== null && sessionId !== this.ownerSessionId) {
      this.last = null;
    }
    this.ownerSessionId = sessionId;
    this.owned = !cursorYieldsToOverlay(mode, sessionId);
  }

  /** The cursor to render right now, or `null` to render nothing. */
  snapshot(): CursorState | null {
    return this.owned ? this.last : null;
  }

  /** Whether the agent currently owns the pointer (exposed for tests). */
  get isOwned(): boolean {
    return this.owned;
  }
}
