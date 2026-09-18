const REDIRECT_QUALIFIERS = new Set(["client_redirect", "server_redirect"]);

export function hasRedirectQualifier(qualifiers?: readonly string[]): boolean {
  return (qualifiers ?? []).some((qualifier) => REDIRECT_QUALIFIERS.has(qualifier));
}

/**
 * Transition types Chrome reports for a navigation the *agent* asked for
 * (`Page.navigate` / `chrome.tabs.update`): the browser classifies them like an
 * address-bar navigation. A link or form submission carries `link` /
 * `form_submit` instead.
 */
const AGENT_TRANSITION_TYPES = new Set(["typed", "generated", "keyword", "keyword_generated"]);

/** Qualifier Chrome adds when the address bar (or the agent) typed the URL. */
const AGENT_TRANSITION_QUALIFIERS = new Set(["from_address_bar"]);

/**
 * Whether an observed URL change was asked for *explicitly* by the agent
 * rather than produced by the recorded action it follows (D2 §2.3).
 *
 * Evidence, in order of strength:
 *
 * - `causedByAction === false`: the caller already knows it drove the
 *   navigation (the `bsk navigate` commit path in `tools/record.ts`).
 * - `from_address_bar` / `typed` / `generated` / `keyword`: Chrome's own
 *   transition metadata for an explicitly entered URL.
 *
 * Missing metadata (`undefined`) is deliberately *not* agent-driven: a
 * same-document soft navigation reported by the content script carries no
 * transitions at all, and that one is exactly the case where a pending click
 * intent must still be consumed.
 */
export function isAgentInitiatedNavigation(input: {
  causedByAction?: boolean;
  transitionType?: string;
  transitionQualifiers?: readonly string[];
}): boolean {
  if (input.causedByAction === false) return true;
  if ((input.transitionQualifiers ?? []).some((q) => AGENT_TRANSITION_QUALIFIERS.has(q))) {
    return true;
  }
  return input.transitionType !== undefined && AGENT_TRANSITION_TYPES.has(input.transitionType);
}
