import type { RecordStepPayload } from "../record-bridge";
import { hasRedirectQualifier, isAgentInitiatedNavigation } from "./navigation-policy";
import type { RecordingDraftStep, TargetMatchHint } from "./types";

export interface RecordingStepBuffer {
  steps: RecordingDraftStep[];
  navigation: RecordingNavigationCursor;
}

export interface RecordingNavigationCursor {
  currentUrl?: string;
  pendingNavigation: boolean;
  pendingNavigationDeadline?: number;
}

const NAVIGATION_TRIGGER_WINDOW_MS = 3_000;

function toDraftStep(
  payload: RecordStepPayload,
  targetHint?: TargetMatchHint,
  arrivedAt?: number,
): RecordingDraftStep | null {
  const pageUrl = payload.page_url;
  const common = {
    ...(pageUrl ? { pageUrl } : {}),
    ...(targetHint ? { targetHint } : {}),
    ...(arrivedAt !== undefined ? { arrivedAt } : {}),
  };
  switch (payload.op) {
    case "click":
      return payload.target ? { op: "click", captureTarget: payload.target, ...common } : null;
    case "hover":
      return payload.target ? { op: "hover", captureTarget: payload.target, ...common } : null;
    case "fill":
      return payload.target
        ? {
            op: "fill",
            captureTarget: payload.target,
            value: payload.value ?? "",
            ...(payload.commit ? { commit: payload.commit } : {}),
            ...(payload.redacted ? { redacted: true } : {}),
            ...common,
          }
        : null;
    case "press":
      return payload.key
        ? {
            op: "press",
            key: payload.key,
            ...(payload.target ? { captureTarget: payload.target } : {}),
            ...(payload.modifiers?.length ? { modifiers: payload.modifiers } : {}),
            ...common,
          }
        : null;
    case "select":
      return payload.target && payload.values
        ? {
            op: "select",
            captureTarget: payload.target,
            values: payload.values,
            ...(payload.labels?.length ? { labels: payload.labels } : {}),
            ...common,
          }
        : null;
    case "navigate":
      return null;
  }
}

function annotateLastStepNavigation(buffer: RecordingStepBuffer, url: string): number {
  for (let index = buffer.steps.length - 1; index >= 0; index -= 1) {
    const step = buffer.steps[index];
    if (!step) continue;
    if (step.op === "click" || step.op === "press" || step.op === "select" || step.op === "fill") {
      step.navigatedTo = url;
      return index;
    }
    break;
  }
  return -1;
}

export type NavigationObserveResult =
  | { kind: "noop" }
  | { kind: "annotated"; index: number }
  | { kind: "appended"; index: number }
  | { kind: "coalesce_redirect"; url: string };

export function observeRecordedNavigation(
  buffer: RecordingStepBuffer,
  url: string,
  causedByAction?: boolean,
  transitionType?: string,
  transitionQualifiers?: string[],
  arrivedAt?: number,
): NavigationObserveResult {
  const navigation = buffer.navigation;
  if (!url || url === navigation.currentUrl) return { kind: "noop" };
  // D5-1 fallback: recordings start from the Agent Window's `about:blank` page.
  // A commit observed while the buffer holds *nothing at all* is still part of
  // arming, whatever the cursor says — drop it instead of emitting a leading
  // navigate step. (The cursor is intentionally left alone so nothing has to be
  // undone when the real start URL arrives.)
  //
  // R2-14: this must stay narrower than "only navigate steps exist". An explicit
  // `bsk navigate` is a step of its own (E7), and the startup window is already
  // covered by E12's `acceptingNavigation` gate, so a user who really lands on
  // an `about:` page after that agent navigation must be recorded, not dropped.
  if (url.startsWith("about:") && buffer.steps.length === 0) {
    return { kind: "noop" };
  }
  navigation.currentUrl = url;

  const pendingIsCurrent =
    navigation.pendingNavigation &&
    (navigation.pendingNavigationDeadline === undefined ||
      navigation.pendingNavigationDeadline >= Date.now());

  // D2 §2.3: an explicit agent navigation (`bsk navigate`, address bar, typed)
  // is a step of its own. It must not be mistaken for the effect of an
  // earlier click whose intent is still pending — that annotation has no
  // landing in the v3 trace (`navigatedTo` is v2-only), so the navigation would
  // vanish entirely. Only a real action-caused or unattributed URL change may
  // consume the pending intent.
  const agentInitiated = isAgentInitiatedNavigation({
    causedByAction,
    transitionType,
    transitionQualifiers,
  });

  if (
    !agentInitiated &&
    (causedByAction === true || (causedByAction === undefined && pendingIsCurrent))
  ) {
    navigation.pendingNavigation = false;
    navigation.pendingNavigationDeadline = undefined;
    const annotatedIndex = annotateLastStepNavigation(buffer, url);
    if (annotatedIndex >= 0) return { kind: "annotated", index: annotatedIndex };
  } else {
    navigation.pendingNavigation = false;
    navigation.pendingNavigationDeadline = undefined;
  }

  if (hasRedirectQualifier(transitionQualifiers)) {
    return { kind: "coalesce_redirect", url };
  }
  buffer.steps.push({
    op: "navigate",
    url,
    pageUrl: url,
    transitionType,
    transitionQualifiers,
    ...(arrivedAt !== undefined ? { arrivedAt } : {}),
  });
  return { kind: "appended", index: buffer.steps.length - 1 };
}

/**
 * Append a recorded payload to `buffer`.
 *
 * `arrivedAt` is the wall clock at which the caller received the action, taken
 * before any `await`; it rides on the draft so the pre-state guard in
 * `RecordingObservationSession.bindDraft` can reject observations sampled after
 * the action (R1-2). Omitted means "unknown" and the guard falls back to its
 * own clock.
 */
export function appendRecordedPayload(
  buffer: RecordingStepBuffer,
  payload: RecordStepPayload,
  targetHint?: TargetMatchHint,
  arrivedAt?: number,
): number | null {
  if (payload.op === "navigate") {
    if (!payload.url) return null;
    const result = observeRecordedNavigation(
      buffer,
      payload.url,
      payload.navigation_caused_by_action,
      payload.transitionType,
      payload.transitionQualifiers,
      arrivedAt,
    );
    return result.kind === "appended" ? result.index : null;
  }
  const step = toDraftStep(
    { ...payload, page_url: payload.page_url ?? buffer.navigation.currentUrl },
    targetHint,
    arrivedAt,
  );
  if (!step) return null;
  buffer.steps.push(step);
  if (step.op === "click" || step.op === "press" || step.op === "select" || step.op === "fill") {
    buffer.navigation.pendingNavigation = payload.expects_navigation === true;
    buffer.navigation.pendingNavigationDeadline = buffer.navigation.pendingNavigation
      ? Date.now() + NAVIGATION_TRIGGER_WINDOW_MS
      : undefined;
  }
  return buffer.steps.length - 1;
}
