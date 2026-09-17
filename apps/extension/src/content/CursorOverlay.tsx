/**
 * Cosmetic in-page agent cursor. Rendered by the content script inside the
 * existing `browser-skill-overlay` shadow tree, so it inherits the host's
 * `pointer-events: none` and is removed from compositing while a capture is
 * suppressed (`data-bsk-capture-hidden`).
 *
 * The background sends one {@link CursorState} per action: `move` glides the
 * arrow to the target before the real CDP event fires, `click` adds a ripple
 * at the same point. The cursor is *not* hidden on idle: while an agent session
 * owns the tab the arrow stays where the last action left it, so a human
 * watching between two tool calls can still see where the agent is. Only an
 * explicit `null` state removes it — session end, page navigation (the content
 * script is rebuilt), tab return, or the user taking over. Because it is
 * cosmetic and lives in the overlay host, screenshots stay clean via the
 * host-level capture suppression rather than by hiding the cursor itself.
 */

export interface CursorRipple {
  /** Monotonic per-tab id; each new id replays the ripple animation. */
  id: number;
  button: string;
}

export interface CursorState {
  /** Viewport CSS pixel, same space as `Input.dispatchMouseEvent`. */
  x: number;
  y: number;
  /** Glide time for this move; 0 means jump straight to the point. */
  durationMs: number;
  label?: string;
  ripple?: CursorRipple;
}

export interface CursorOverlayProps {
  state: CursorState | null;
}

const RIPPLE_MS = 400;
const RIPPLE_SIZE_PX = 40;
const MAX_LABEL_CHARS = 40;

function rippleColor(button: string): string {
  if (button === "right") return "59,130,246";
  if (button === "middle") return "168,85,247";
  return "249,115,22";
}

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS)}…` : label;
}

export function CursorOverlay({ state }: CursorOverlayProps) {
  // The cursor stays visible for as long as `state` is non-null. Idle time
  // between tool calls must not hide it: only an explicit `null` state does.
  if (!state) return null;

  const ripple = state.ripple;

  return (
    <div
      data-slot="agent-cursor"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        zIndex: 2147483647,
        pointerEvents: "none",
        transform: `translate3d(${state.x}px, ${state.y}px, 0)`,
        // The glide animates the arrow towards the point the real CDP pointer
        // was already placed on (see `moveCursor` in tools/interaction.ts), so
        // the arrow and the live page hover state stay in step.
        transition: `transform ${Math.max(state.durationMs, 0)}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        willChange: "transform",
      }}
    >
      <style>{`
        @keyframes bsk-agent-cursor-ripple {
          0% { transform: scale(0.25); opacity: 0.55; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      `}</style>

      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden="true"
        style={{
          display: "block",
          overflow: "visible",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))",
        }}
      >
        <path
          d="M1.5 1.2 L1.5 16.1 L5.4 12.4 L8.2 18.6 L10.9 17.4 L8.1 11.3 L13.6 11.1 Z"
          fill="#ffffff"
          stroke="#1f2937"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>

      {state.label ? (
        <div
          data-slot="agent-cursor-label"
          className="truncate rounded-md bg-slate-900/85 px-2 py-0.5 text-[12px] font-medium text-white"
          style={{
            position: "absolute",
            left: 14,
            top: 16,
            maxWidth: 240,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {truncateLabel(state.label)}
        </div>
      ) : null}

      {ripple ? (
        <div
          key={ripple.id}
          data-slot="agent-cursor-ripple"
          data-button={ripple.button}
          style={{
            position: "absolute",
            left: -RIPPLE_SIZE_PX / 2,
            top: -RIPPLE_SIZE_PX / 2,
            width: RIPPLE_SIZE_PX,
            height: RIPPLE_SIZE_PX,
            borderRadius: "50%",
            pointerEvents: "none",
            backgroundColor: `rgba(${rippleColor(ripple.button)},0.45)`,
            border: `1.5px solid rgba(${rippleColor(ripple.button)},0.85)`,
            animation: `bsk-agent-cursor-ripple ${RIPPLE_MS}ms ease-out forwards`,
          }}
        />
      ) : null}
    </div>
  );
}
