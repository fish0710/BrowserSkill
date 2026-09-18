// D2 §2.3, third change: an explicit `bsk navigate` marks the tab before the
// command is dispatched. The recording-side `webNavigation.onCommitted` listener
// then knows the commit it is about to see was commanded by the agent, even
// when Chrome reports no transition metadata (or reports the URL as `link`).
//
// This lives in its own module rather than in `tools/record.ts` because
// `tools/navigation.ts` (which issues the command) must mark it, and
// `tools/record.ts` already imports `tools/navigation.ts` — a shared leaf
// module keeps that edge one-directional.

/** A command whose commit is this late is no longer attributable to it. */
const AGENT_NAVIGATION_MARKER_TTL_MS = 30_000;

const pendingAgentNavigations = new Map<number, number>();

/** Record that the agent commanded a navigation for `tabId`. */
export function noteAgentInitiatedNavigation(tabId: number): void {
  const now = Date.now();
  for (const [id, at] of pendingAgentNavigations) {
    if (now - at > AGENT_NAVIGATION_MARKER_TTL_MS) pendingAgentNavigations.delete(id);
  }
  pendingAgentNavigations.set(tabId, now);
}

/**
 * Consume the marker for `tabId`. True when the agent commanded a navigation
 * for this tab recently enough to explain the commit being handled.
 */
export function consumeAgentInitiatedNavigation(tabId: number): boolean {
  const at = pendingAgentNavigations.get(tabId);
  if (at === undefined) return false;
  pendingAgentNavigations.delete(tabId);
  return Date.now() - at <= AGENT_NAVIGATION_MARKER_TTL_MS;
}

/** Test seam: drop every outstanding marker. */
export function resetAgentInitiatedNavigationsForTests(): void {
  pendingAgentNavigations.clear();
}

/**
 * Drop any marker still outstanding for `tabId`.
 *
 * The recording-start navigate is awaited until the tab reports ready, so its
 * own commit (if it happened at all) has already consumed the marker by then.
 * Anything left is a command whose commit never arrived — keeping it would let
 * it misattribute a later user navigation as agent-initiated.
 */
export function clearAgentInitiatedNavigation(tabId: number): void {
  pendingAgentNavigations.delete(tabId);
}
