import {
  type CaptureTargetDescriptor,
  describeEventTarget,
  describeTarget,
  isMeaningfulClickTarget,
  resolveClickableElement,
  resolveHoverElement,
} from "@/lib/describe-target";
import {
  evaluateHoverTrigger,
  type HoverTriggerDecision,
  type HoverTriggerRect,
  hasDirectHoverInteractiveSignal,
  hasStrongHoverExpansionSignal,
} from "@/lib/hover-trigger-policy";
import type { RecordStepPayload } from "@/lib/record-bridge";
import { shouldRecordPress } from "@/lib/recording/draft-policy";
import {
  closestHoverSurfaceCandidate,
  collectHoverSurfaceStates,
  decideHoverSurfaceRelation,
  type HoverSurfaceState,
  isHoverSurfaceCandidateElement,
  isLikelyHoverSurfaceOwner,
} from "./record-hover-surface";

export interface RecordCaptureController {
  dispose(): void;
}

interface FillSession {
  element: FillableElement;
  target: CaptureTargetDescriptor;
  baselineValue: string;
  lastValue: string;
  pendingCommit?: "enter" | "suggestion" | "blur";
}

interface HoverCandidate {
  element: Element;
  target: CaptureTargetDescriptor;
  recordedAt: number;
  score: number;
  eligible: boolean;
}

interface HoverSurfaceNode {
  element: Element;
  signature: string;
  owner: HoverCandidate;
  parent?: HoverSurfaceNode;
}

/**
 * The element and descriptor a click is about to record, resolved before the
 * step is emitted so the pre-action hover replay can tell whether a candidate
 * is the very target of that click (D5-2).
 */
interface PendingClickRecord {
  element: Element;
  target: CaptureTargetDescriptor;
}

type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const HOVER_BEFORE_CLICK_MAX_MS = 10_000;
// M4: how long a mouseover candidate may still act as the opener of a later
// action. Only candidate liveness is bounded by this window (R1-7).
const HOVER_CANDIDATE_MAX_MS = 10_000;
// How long a revealed surface stays bound to the opener that revealed it.
// Deliberately wider than the candidate window: a menu that only appears much
// later is still the same opener's surface, and the binding must not be
// dropped early (R1-7).
const HOVER_SURFACE_CONTEXT_MAX_MS = 30_000;
const HOVER_REPLACE_SCORE_MARGIN = 50;
const HOVER_CANDIDATE_LIMIT = 24;
const HOVER_TRIGGER_LABEL_MAX = 48;
// D5-2: one action's `mouseMoved` and the `mousePressed` it precedes share an
// event batch. A candidate recorded inside this window is the pointer merely
// travelling to the click target, not a separate, deliberate user hover.
const SAME_ACTION_HOVER_MAX_MS = 50;

function eventTarget(event: Event): EventTarget | null {
  return event.composedPath()[0] ?? event.target;
}

/**
 * D5-2 analogue of "same ref": two descriptors name the same recorded target
 * only when tag, role and visible name all agree.
 */
function sameRecordedTarget(
  a: CaptureTargetDescriptor | null | undefined,
  b: CaptureTargetDescriptor | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.tag === b.tag && a.role === b.role && a.name === b.name;
}

function isOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  const root = document.documentElement;
  let node: Node | null = target;
  while (node && node !== root) {
    if (node instanceof Element && node.hasAttribute("data-bsk-overlay")) {
      return true;
    }
    const rootNode: Node | Document | ShadowRoot = node.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      const host: Element = rootNode.host;
      if (host.hasAttribute("data-bsk-overlay")) {
        return true;
      }
      node = host;
    } else {
      node = node.parentNode;
    }
  }
  return false;
}

function isTextFillable(el: Element): el is FillableElement {
  if (el instanceof HTMLElement && (el.isContentEditable || el.contentEditable === "true")) {
    return true;
  }
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  const type = el.type.toLowerCase();
  return type !== "checkbox" && type !== "radio" && type !== "file" && type !== "button";
}

function fillableFromTarget(target: EventTarget | null): FillableElement | null {
  if (!(target instanceof Element)) return null;
  if (isTextFillable(target)) return target;
  const el = target.closest('input,textarea,[contenteditable]:not([contenteditable="false"])');
  if (el && isTextFillable(el)) return el;
  return null;
}

const SEARCH_CHROME_SELECTOR =
  '[id*="chat-input"], [id*="search"], [class*="search"], form, [role="search"]';

/**
 * A control the user can name is its own step, so it must never be rewritten
 * into "focus the search box next to it".
 */
const SEARCH_CHROME_CONTROL_SELECTOR = [
  "a[href]",
  "button",
  "select",
  "textarea",
  "input",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
].join(", ");

/**
 * Search chrome is a small wrapper drawn around the input, so only a handful of
 * ancestors may claim a click. Without the bound, `closest` happily returns a
 * page-level node — MediaWiki Vector renders `<body class="…search-vue…">`, and
 * a site-wide `<form>` is just as common — and every click on the page would be
 * swallowed into a fill session on whatever search box the page happens to have.
 */
const SEARCH_CHROME_MAX_DEPTH = 4;

function isSearchChromeWrapper(container: Element, target: Element): boolean {
  if (container === document.body || container === document.documentElement) return false;
  let node: Element | null = target;
  for (let depth = 0; node && depth <= SEARCH_CHROME_MAX_DEPTH; depth += 1) {
    if (node === container) return true;
    node = node.parentElement;
  }
  return false;
}

/** Clicks on search chrome that only focus the nearby input should not become steps. */
function nearbyFillableFromSearchChrome(target: Element): FillableElement | null {
  if (target.closest(SEARCH_CHROME_CONTROL_SELECTOR)) return null;
  const container = target.closest(SEARCH_CHROME_SELECTOR);
  if (!container || !isSearchChromeWrapper(container, target)) return null;
  const fillable = container.querySelector(
    'textarea, input[type="search"], input[name="q"], #chat-textarea',
  );
  if (
    fillable instanceof HTMLElement &&
    isTextFillable(fillable) &&
    fillable !== target &&
    !fillable.contains(target)
  ) {
    return fillable;
  }
  return null;
}

const PICKER_TRIGGER_SELECTOR = [
  '[role="combobox"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[aria-haspopup="tree"]',
  '[aria-haspopup="grid"]',
  '[aria-haspopup="dialog"]',
].join(", ");

/** Bound the picker-ancestor walk so a page-level wrapper cannot claim every click. */
const PICKER_TRIGGER_MAX_DEPTH = 4;

function pickerTriggerAncestor(el: Element): Element | null {
  let node: Element | null = el;
  for (let depth = 0; node && depth <= PICKER_TRIGGER_MAX_DEPTH; depth += 1) {
    if (node.matches(PICKER_TRIGGER_SELECTOR)) return node;
    node = node.parentElement;
  }
  return null;
}

function isDisabledControl(el: FillableElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.disabled;
  return el.getAttribute("aria-disabled") === "true";
}

/** A read-only control accepts no typed text, so a click is its only signal. */
function isReadOnlyControl(el: FillableElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.readOnly;
  return false;
}

function pickerTriggerFor(fillable: FillableElement): Element | null {
  return pickerTriggerAncestor(fillable) ?? (isReadOnlyControl(fillable) ? fillable : null);
}

/** Describe the ARIA picker a click opens, merging its role with the inner input's name. */
function pickerTargetDescriptor(anchor: Element): CaptureTargetDescriptor | null {
  const container = anchor.closest(PICKER_TRIGGER_SELECTOR) ?? anchor;
  const containerDesc = describeTarget(container);
  // A wrapper div carries the role while the control inside it carries the
  // accessible name, and VOM reports the combination (`combobox "* Story"`).
  const inner =
    container === anchor
      ? container.querySelector<FillableElement>(
          'input,textarea,[contenteditable]:not([contenteditable="false"])',
        )
      : anchor;
  const innerDesc = inner ? describeTarget(inner) : null;
  const descriptor: CaptureTargetDescriptor = {
    ...containerDesc,
    ...(containerDesc.name || !innerDesc?.name ? {} : { name: innerDesc.name }),
    ...(containerDesc.placeholder || !innerDesc?.placeholder
      ? {}
      : { placeholder: innerDesc.placeholder }),
  };
  return isMeaningfulClickTarget(descriptor) ? descriptor : null;
}

function captureGeometry(el: Element): RecordStepPayload["geometry"] {
  const rect = el.getBoundingClientRect();
  return {
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    tag: el.tagName.toLowerCase(),
  };
}

function geometryForEventTarget(
  target: EventTarget | null,
): RecordStepPayload["geometry"] | undefined {
  if (!(target instanceof Element)) return undefined;
  const clickable = target.closest(
    'a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[contenteditable="true"]',
  );
  return captureGeometry(clickable ?? target);
}

function fillableValue(el: FillableElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  return el.textContent ?? "";
}

function hoverTriggerAttrs(el: Element): Record<string, string | undefined> {
  return {
    id: el.id || undefined,
    class: typeof el.className === "string" ? el.className || undefined : undefined,
    "data-testid": el.getAttribute("data-testid") ?? undefined,
    "data-test": el.getAttribute("data-test") ?? undefined,
    "data-cy": el.getAttribute("data-cy") ?? undefined,
    "aria-label": el.getAttribute("aria-label") ?? undefined,
    "aria-haspopup": el.getAttribute("aria-haspopup") ?? undefined,
    "aria-controls": el.getAttribute("aria-controls") ?? undefined,
    "aria-expanded": el.getAttribute("aria-expanded") ?? undefined,
    "aria-hidden": el.getAttribute("aria-hidden") ?? undefined,
    "aria-disabled": el.getAttribute("aria-disabled") ?? undefined,
    contenteditable: el.getAttribute("contenteditable") ?? undefined,
    disabled: el.hasAttribute("disabled") ? "" : undefined,
    hidden: el.hasAttribute("hidden") ? "" : undefined,
    inert: el.hasAttribute("inert") ? "" : undefined,
    onclick: el.getAttribute("onclick") ?? undefined,
    onmouseenter: el.getAttribute("onmouseenter") ?? undefined,
    onmouseover: el.getAttribute("onmouseover") ?? undefined,
    role: el.getAttribute("role") ?? undefined,
    tabindex: el.getAttribute("tabindex") ?? undefined,
    title: el.getAttribute("title") ?? undefined,
  };
}

function hoverTriggerRect(el: Element): HoverTriggerRect {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

function hoverTriggerStyle(el: Element): { cursor?: string; pointerEvents?: string } {
  if (!(el instanceof HTMLElement)) return {};
  const style = getComputedStyle(el);
  return { cursor: style.cursor, pointerEvents: style.pointerEvents };
}

function hasHoverGraphicDescendant(el: Element): boolean {
  return el.querySelector("img,svg,use,path,i") !== null;
}

function normalizeLabelText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateLabel(value: string, max = HOVER_TRIGGER_LABEL_MAX): string {
  const normalized = normalizeLabelText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function collectHoverTriggerLabelText(root: Element): string {
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += ` ${node.textContent ?? ""}`;
      return;
    }
    if (!(node instanceof Element)) return;
    if (node !== root && isHoverSurfaceCandidateElement(node)) {
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of root.childNodes) visit(child);
  return normalizeLabelText(text);
}

function compactHoverTargetName(
  el: Element,
  desc: CaptureTargetDescriptor,
): CaptureTargetDescriptor {
  if (!desc.name) return desc;
  const fullText = normalizeLabelText(el.textContent ?? "");
  const compactName = collectHoverTriggerLabelText(el);
  if (!compactName || compactName === desc.name) return desc;
  const compactComparable = compactName.replace(/\s+/g, "");
  const descComparable = desc.name.replace(/…$/, "").replace(/\s+/g, "");
  const fullTextComparable = fullText.replace(/\s+/g, "");
  if (
    descComparable.startsWith(compactComparable) &&
    fullTextComparable.startsWith(descComparable) &&
    compactName.length < desc.name.length
  ) {
    return { ...desc, name: truncateLabel(compactName) };
  }
  return desc;
}

function isWeakHoverTarget(target: CaptureTargetDescriptor): boolean {
  return !target.role && !target.name && target.tag === "div";
}

function looksLikeAvatarElement(el: Element): boolean {
  const className = typeof el.className === "string" ? el.className : "";
  return /\b(avatar|user-avatar)\b/i.test(className);
}

function normalizeHoverTarget(
  el: Element,
  desc: CaptureTargetDescriptor,
  decision: HoverTriggerDecision,
): CaptureTargetDescriptor {
  if (desc.role === "img" && !desc.name && looksLikeAvatarElement(el)) {
    return { ...desc, name: "image" };
  }
  if (
    isWeakHoverTarget(desc) &&
    (looksLikeAvatarElement(el) ||
      (hasHoverGraphicDescendant(el) && decision.reasons.includes("icon-only")))
  ) {
    return { tag: "img", role: "img", name: "image" };
  }
  return desc;
}

function hoverTriggerSignals(el: Element, desc: CaptureTargetDescriptor) {
  if (!(el instanceof HTMLElement)) return null;
  const style = hoverTriggerStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    role: desc.role,
    label: desc.name,
    attrs: hoverTriggerAttrs(el),
    rect: hoverTriggerRect(el),
    cursor: style.cursor,
    pointerEvents: style.pointerEvents,
    hasGraphicDescendant: hasHoverGraphicDescendant(el),
  };
}

function hoverCandidateFromEvent(target: EventTarget | null): HoverCandidate | null {
  if (!(target instanceof Element)) return null;
  const element = resolveHoverElement(target);
  if (!element) return null;
  const desc = describeTarget(element);
  const signals = hoverTriggerSignals(element, desc);
  if (!signals) return null;
  const decision = evaluateHoverTrigger(signals);
  const hasExpansionSignal = hasStrongHoverExpansionSignal(signals);
  const hasDirectSignal = hasDirectHoverInteractiveSignal(signals);
  if (!decision.eligible && !hasExpansionSignal && !hasDirectSignal) return null;
  if (!decision.eligible && !desc.name && !desc.role) return null;
  const normalizedTarget = normalizeHoverTarget(
    element,
    compactHoverTargetName(element, desc),
    decision,
  );
  const now = Date.now();
  return {
    element,
    target: normalizedTarget,
    recordedAt: now,
    score: decision.score,
    eligible: decision.eligible,
  };
}

function shouldReplaceHoverCandidate(
  current: HoverCandidate,
  next: HoverCandidate,
  now: number,
): boolean {
  if (next.element === current.element) return false;
  if (now - current.recordedAt > HOVER_BEFORE_CLICK_MAX_MS) return true;
  if (current.element.contains(next.element)) return false;
  if (next.element.contains(current.element)) return true;
  return next.score >= current.score + HOVER_REPLACE_SCORE_MARGIN;
}

/** Clicks that only pick an autocomplete/suggestion value — not a semantic submit action. */
function isInputCompletionClick(target: EventTarget | null, session: FillSession | null): boolean {
  if (!session || !(target instanceof Element)) return false;
  if (session.element.contains(target)) return false;

  const option = target.closest('[role="option"]');
  if (option?.closest('[role="listbox"]')) return true;

  const suggestionRoot = target.closest(
    [
      '[id*="Sug"]',
      '[id*="sug"]',
      '[class*="suggest"]',
      '[class*="autocomplete"]',
      '[class*="typeahead"]',
      "[data-autocomplete]",
    ].join(", "),
  );
  if (suggestionRoot && !suggestionRoot.contains(session.element)) return true;

  return false;
}

function scheduleInputCompletionCommit(
  sessionElement: FillableElement,
  syncFillSessionValue: (el: FillableElement) => void,
  commitFillSession: () => void,
  hasSessionFor: (el: FillableElement) => boolean,
): void {
  const syncAndCommit = () => {
    if (!hasSessionFor(sessionElement)) return;
    syncFillSessionValue(sessionElement);
    commitFillSession();
  };
  syncFillSessionValue(sessionElement);
  queueMicrotask(syncAndCommit);
  setTimeout(syncAndCommit, 0);
}

export function startRecordCapture(
  _requestId: string,
  sendStep: (step: RecordStepPayload) => void,
  options: { captureNavigation?: boolean } = {},
): RecordCaptureController {
  const emitStep = (step: RecordStepPayload) => {
    sendStep({ page_url: location.href, ...step });
  };
  const hoverSurfaceStateMap = (states: HoverSurfaceState[]): Map<Element, string> =>
    new Map(states.map((state) => [state.element, state.signature]));
  let fillSession: FillSession | null = null;
  let composing = false;
  let lastUrl = location.href;
  let keyboardActivation: { target: EventTarget | null; recordedAt: number } | undefined;
  let pendingHover: HoverCandidate | null = null;
  const recentHoverCandidates: HoverCandidate[] = [];
  const emittedHoverElements = new WeakSet<Element>();
  // Elements the user already clicked, keyed by the click time. Re-emitting a
  // hover that happened *before* that click would duplicate the click that
  // already swallowed it (D2); a hover recorded after the click is a new,
  // legitimate interaction (R1-3).
  const lastClickAt = new WeakMap<Element, number>();
  let hoverSurfaceStates = hoverSurfaceStateMap(collectHoverSurfaceStates());
  const hoverSurfaceNodes = new Map<Element, HoverSurfaceNode>();
  let generatedControlClick: Element | null = null;
  let navigationActionPending = false;
  let navigationActionVersion = 0;
  const committedValues = new WeakMap<FillableElement, string>();

  const markNavigationAction = () => {
    navigationActionPending = true;
    const version = ++navigationActionVersion;
    setTimeout(() => {
      if (navigationActionVersion === version) {
        navigationActionPending = false;
      }
    }, 0);
  };

  const emitFill = (session: FillSession) => {
    if (session.lastValue === session.baselineValue) return;
    const isPassword =
      session.element instanceof HTMLInputElement && session.element.type === "password";
    const value = isPassword ? "***" : session.lastValue;
    emitStep({
      op: "fill",
      target: session.target,
      geometry: captureGeometry(session.element),
      value,
      commit: session.pendingCommit ?? "blur",
      ...(isPassword ? { redacted: true } : {}),
    });
  };

  const commitFillSession = (commit: "enter" | "suggestion" | "blur" = "blur") => {
    if (!fillSession || composing) return;
    const session = fillSession;
    session.pendingCommit = commit;
    fillSession = null;
    emitFill(session);
    committedValues.set(session.element, session.lastValue);
  };

  const syncFillSessionValue = (el: FillableElement) => {
    if (!fillSession || fillSession.element !== el) return;
    fillSession.lastValue = fillableValue(el);
  };

  const ensureFillSession = (el: FillableElement) => {
    if (fillSession?.element === el) return;
    if (fillSession) commitFillSession();
    const currentValue = fillableValue(el);
    const baselineValue = committedValues.get(el) ?? currentValue;
    fillSession = {
      element: el,
      target: describeTarget(el),
      baselineValue,
      lastValue: currentValue,
    };
  };

  const emitNavigateIfChanged = (causedByAction?: boolean) => {
    if (location.href === lastUrl) return;
    commitFillSession();
    lastUrl = location.href;
    emitStep({
      op: "navigate",
      url: location.href,
      ...(causedByAction !== undefined ? { navigation_caused_by_action: causedByAction } : {}),
    });
  };

  const rememberHoverCandidate = (hover: HoverCandidate) => {
    const duplicate = recentHoverCandidates.findIndex(
      (candidate) => candidate.element === hover.element,
    );
    if (duplicate >= 0) recentHoverCandidates.splice(duplicate, 1);
    recentHoverCandidates.push(hover);
    if (recentHoverCandidates.length > HOVER_CANDIDATE_LIMIT) {
      recentHoverCandidates.splice(0, recentHoverCandidates.length - HOVER_CANDIDATE_LIMIT);
    }
  };

  const surfaceArea = (el: Element): number => {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  };

  const smallestContaining = <T>(
    target: Element,
    items: Iterable<T>,
    elementFor: (item: T) => Element,
  ): T | undefined => {
    let best: T | undefined;
    for (const item of items) {
      const element = elementFor(item);
      if (!element.contains(target)) continue;
      if (!best || surfaceArea(element) < surfaceArea(elementFor(best))) {
        best = item;
      }
    }
    return best;
  };

  const ownedSurfaceContaining = (target: Element): HoverSurfaceNode | undefined =>
    smallestContaining(target, hoverSurfaceNodes.values(), (node) => node.element);

  const surfaceStateContaining = (
    target: Element,
    states: HoverSurfaceState[],
  ): HoverSurfaceState | undefined => smallestContaining(target, states, (state) => state.element);

  const inferOwnerForSurface = (
    surface: Element,
    now: number,
    before?: HoverCandidate,
  ): HoverCandidate | undefined => {
    for (let index = recentHoverCandidates.length - 1; index >= 0; index -= 1) {
      const candidate = recentHoverCandidates[index];
      if (!candidate) continue;
      if (before && candidate.element === before.element) continue;
      if (before && candidate.recordedAt > before.recordedAt) continue;
      if (surface.contains(candidate.element)) continue;
      if (now - candidate.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) continue;
      if (isLikelyHoverSurfaceOwner(candidate.element, surface)) return candidate;
    }
    return undefined;
  };

  const nodeForUnownedSurface = (
    surfaceState: HoverSurfaceState,
    currentStates: HoverSurfaceState[],
    now: number,
  ): HoverSurfaceNode | undefined => {
    const owner = inferOwnerForSurface(surfaceState.element, now);
    if (!owner) return undefined;
    const parent = parentSurfaceNodeForOwner(owner, currentStates, now);
    const node: HoverSurfaceNode = {
      element: surfaceState.element,
      signature: surfaceState.signature,
      owner,
      ...(parent ? { parent } : {}),
    };
    hoverSurfaceNodes.set(surfaceState.element, node);
    return node;
  };

  const ownedSurfaceForAction = (
    target: Element,
    scanSurfaceStates: () => HoverSurfaceState[],
  ): HoverSurfaceNode | undefined => {
    const closestSurface = closestHoverSurfaceCandidate(target);
    if (closestSurface) {
      const owned = hoverSurfaceNodes.get(closestSurface);
      if (owned) return owned;
    }
    const ownedContaining = ownedSurfaceContaining(target);
    if (ownedContaining) return ownedContaining;
    // Without any hover candidate there is nothing that could own a surface, so
    // the full-DOM scan below is pure waste on the common click path (R1-6).
    if (recentHoverCandidates.length === 0 && hoverSurfaceNodes.size === 0) return undefined;
    const now = Date.now();
    const currentStates = scanSurfaceStates();
    pruneGoneHoverSurfaces(currentStates);
    const surfaceState = closestSurface
      ? currentStates.find((state) => state.element === closestSurface)
      : surfaceStateContaining(target, currentStates);
    hoverSurfaceStates = hoverSurfaceStateMap(currentStates);
    if (!surfaceState) return undefined;
    return nodeForUnownedSurface(surfaceState, currentStates, now);
  };

  const pruneGoneHoverSurfaces = (currentStates: HoverSurfaceState[]) => {
    const current = new Set(currentStates.map((state) => state.element));
    for (const element of hoverSurfaceNodes.keys()) {
      if (!current.has(element)) hoverSurfaceNodes.delete(element);
    }
  };

  const parentSurfaceNodeForOwner = (
    owner: HoverCandidate,
    currentStates: HoverSurfaceState[],
    now: number,
  ): HoverSurfaceNode | undefined => {
    const ownedParent = ownedSurfaceContaining(owner.element);
    if (ownedParent) return ownedParent;
    const parentState = surfaceStateContaining(owner.element, currentStates);
    if (!parentState) return undefined;
    const parentOwner = inferOwnerForSurface(parentState.element, now, owner);
    if (!parentOwner) return undefined;
    const parentNode: HoverSurfaceNode = {
      element: parentState.element,
      signature: parentState.signature,
      owner: parentOwner,
    };
    hoverSurfaceNodes.set(parentState.element, parentNode);
    return parentNode;
  };

  const createSurfaceNode = (
    state: HoverSurfaceState,
    owner: HoverCandidate,
    currentStates: HoverSurfaceState[],
    now: number,
  ): HoverSurfaceNode | undefined => {
    const parent = parentSurfaceNodeForOwner(owner, currentStates, now);
    if (parent?.element === state.element) return undefined;
    if (now - owner.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) return undefined;
    if (!isLikelyHoverSurfaceOwner(owner.element, state.element)) return undefined;
    const node: HoverSurfaceNode = {
      element: state.element,
      signature: state.signature,
      owner,
      ...(parent ? { parent } : {}),
    };
    hoverSurfaceNodes.set(state.element, node);
    return node;
  };

  const bindChangedHoverSurfaces = (
    previousStates: Map<Element, string>,
    currentStates: HoverSurfaceState[],
    now: number,
  ) => {
    for (const state of currentStates) {
      if (previousStates.get(state.element) === state.signature) continue;
      const owner = inferOwnerForSurface(state.element, now);
      if (!owner) continue;
      createSurfaceNode(state, owner, currentStates, now);
    }
  };

  const refreshHoverSurfaces = (previousStates = hoverSurfaceStates) => {
    const now = Date.now();
    const currentStates = collectHoverSurfaceStates();
    pruneGoneHoverSurfaces(currentStates);
    bindChangedHoverSurfaces(previousStates, currentStates, now);
    hoverSurfaceStates = hoverSurfaceStateMap(currentStates);
  };

  const scheduleHoverSurfaceRefresh = (previousStates: Map<Element, string>) => {
    setTimeout(() => refreshHoverSurfaces(previousStates), 0);
  };

  const emitHoverStep = (hover: HoverCandidate) => {
    if (emittedHoverElements.has(hover.element)) return;
    const clickedAt = lastClickAt.get(hover.element);
    // `<=` because the hover that immediately precedes a click on the same
    // element is the one that click already described, even when both land in
    // the same millisecond.
    if (clickedAt !== undefined && hover.recordedAt <= clickedAt) return;
    emitStep({
      op: "hover",
      target: hover.target,
      geometry: captureGeometry(hover.element),
    });
    emittedHoverElements.add(hover.element);
  };

  /**
   * M4: an opener candidate is only still usable when hover-trigger policy
   * accepted it (`eligible`) or when the surface it opened is currently visible
   * (hit by `collectHoverSurfaceStates`). Anything else is a stale pass-through
   * of the mouse path.
   */
  const ownsVisibleHoverSurface = (
    owner: HoverCandidate,
    visibleSurfaces: () => Set<Element>,
    surface?: Element,
  ): boolean => {
    if (surface && visibleSurfaces().has(surface)) return true;
    for (const [element, node] of hoverSurfaceNodes) {
      if (node.owner.element === owner.element && visibleSurfaces().has(element)) return true;
    }
    return false;
  };

  const isUsableHoverOwner = (
    owner: HoverCandidate,
    now: number,
    visibleSurfaces: () => Set<Element>,
    surface?: Element,
  ): boolean => {
    // Fast path: a policy-eligible candidate inside its window is usable
    // without touching the DOM at all (R1-6).
    if (owner.eligible && now - owner.recordedAt <= HOVER_CANDIDATE_MAX_MS) return true;
    // A still-open surface keeps its opener valid even past the candidate
    // window: the user is demonstrably still acting inside it.
    return ownsVisibleHoverSurface(owner, visibleSurfaces, surface);
  };

  const surfaceOwnerChain = (
    surface: HoverSurfaceNode,
    actionElement: Element,
    now: number,
    visibleSurfaces: () => Set<Element>,
  ): HoverCandidate[] => {
    const chain: HoverCandidate[] = [];
    const selected = new WeakSet<Element>();
    const surfaces: HoverSurfaceNode[] = [];
    let node: HoverSurfaceNode | undefined = surface;
    while (node && surfaces.length < 4) {
      surfaces.unshift(node);
      node = node.parent;
    }
    for (const owned of surfaces) {
      const owner = owned.owner;
      if (owner.element === actionElement || actionElement.contains(owner.element)) {
        continue;
      }
      if (selected.has(owner.element)) continue;
      if (emittedHoverElements.has(owner.element)) continue;
      if (!isUsableHoverOwner(owner, now, visibleSurfaces, owned.element)) continue;
      selected.add(owner.element);
      chain.push(owner);
    }
    return chain;
  };

  /**
   * D5-2: a candidate is the click target's own pre-action hover (not an
   * opener) when it was recorded by the pointer travelling to this very click
   * (same event batch) and it describes the same recorded target — "same ref /
   * same name", the D5 §2.4 fallback. The narrow rule is deliberate: a broader
   * `candidate.element.contains(actionElement)` exclusion drops the hover of a
   * wrapper that legitimately precedes a click on its inner child.
   */
  const isSelfActionHover = (
    candidate: HoverCandidate,
    pendingClick: PendingClickRecord | null | undefined,
    now: number,
  ): boolean =>
    !!pendingClick &&
    now - candidate.recordedAt <= SAME_ACTION_HOVER_MAX_MS &&
    (candidate.element === pendingClick.element ||
      sameRecordedTarget(candidate.target, pendingClick.target));

  const containedHoverOwnerForAction = (
    actionElement: Element,
    now: number,
    visibleSurfaces: () => Set<Element>,
    pendingClick?: PendingClickRecord | null,
  ): HoverCandidate | undefined => {
    for (let index = recentHoverCandidates.length - 1; index >= 0; index -= 1) {
      const candidate = recentHoverCandidates[index];
      if (!candidate) continue;
      if (candidate.element === actionElement) continue;
      if (!candidate.element.contains(actionElement)) continue;
      if (isSelfActionHover(candidate, pendingClick, now)) continue;
      if (!isUsableHoverOwner(candidate, now, visibleSurfaces)) continue;
      return candidate;
    }
    return undefined;
  };

  /**
   * The same-phase surface owners: the pointer reached this action through the
   * opener chain, so a candidate in the chain that *is* this very click's
   * target (same ref / same name, same batch) is the action's arrival, not a
   * separate hover.
   */
  const withoutSelfActionOwners = (
    chain: HoverCandidate[],
    pendingClick: PendingClickRecord | null | undefined,
    now: number,
  ): HoverCandidate[] =>
    pendingClick ? chain.filter((owner) => !isSelfActionHover(owner, pendingClick, now)) : chain;

  const markClickedElement = (node: EventTarget | null | undefined, clickedAt: number) => {
    if (!(node instanceof Element)) return;
    lastClickAt.set(node, clickedAt);
    const clickable = resolveClickableElement(node);
    if (clickable) lastClickAt.set(clickable, clickedAt);
  };

  /** The exact click this action is about to record, resolved before the hover replay. */
  const resolveClickRecord = (
    event: MouseEvent,
    options: { anchor?: Element } = {},
  ): PendingClickRecord | null => {
    const element = options.anchor ?? eventTarget(event);
    const target = options.anchor
      ? pickerTargetDescriptor(options.anchor)
      : describeEventTarget(eventTarget(event));
    if (!(element instanceof Element) || !target) return null;
    return { element, target };
  };

  /**
   * D5-2: write the suppression timestamp *now*, before the action's own hover
   * candidates are replayed. `markClickedElement` used to run inside
   * `emitClickStep`, i.e. after the replay, so an E3-style candidate produced by
   * the very same click could still be emitted as a separate step.
   */
  const claimClickRecord = (
    record: PendingClickRecord | null,
    actionTarget: EventTarget | null,
  ): PendingClickRecord | null => {
    const clickedAt = Date.now();
    // R2-17: the pointer event is the same action whether or not its target can
    // be described, so the event target itself is marked first. When
    // `describeEventTarget` / `pickerTargetDescriptor` yields null there is no
    // `record` to mark, and suppressing this action's own hover would otherwise
    // rest entirely on the 50ms batch window (R2-7 shows that window is not
    // reliable).
    markClickedElement(actionTarget, clickedAt);
    if (record) markClickedElement(record.element, clickedAt);
    return record;
  };

  const emitClickStep = (record: PendingClickRecord, expectsNavigation: boolean): void => {
    // Claiming a navigation makes the next URL change the effect of this click.
    // Opening a list is not a navigation, so it must not absorb a later one.
    if (expectsNavigation) markNavigationAction();
    emitStep({
      op: "click",
      target: record.target,
      geometry: geometryForEventTarget(record.element),
      expects_navigation: expectsNavigation,
    });
  };

  const emitClick = (
    event: MouseEvent,
    options: { expectsNavigation?: boolean; anchor?: Element } = {},
  ): void => {
    // Only record clicks an LLM can re-identify (named interactive controls).
    const record = claimClickRecord(resolveClickRecord(event, options), eventTarget(event));
    if (!record) return;
    emitClickStep(record, options.expectsNavigation ?? true);
  };

  const emitHoverCandidateBeforeAction = (
    actionTarget: EventTarget | null,
    pendingClick?: PendingClickRecord | null,
  ) => {
    if (!(actionTarget instanceof Element)) return;
    const actionElement = resolveClickableElement(actionTarget) ?? actionTarget;
    // One action may inspect the live surfaces at most once, and only when it
    // actually has to: an eligible owner still inside the candidate window is
    // accepted without touching the DOM (R1-6).
    let scannedStates: HoverSurfaceState[] | undefined;
    let scannedVisible: Set<Element> | undefined;
    const scanSurfaceStates = (): HoverSurfaceState[] =>
      (scannedStates ??= collectHoverSurfaceStates());
    // Measured at action time: a surface hidden since the last mouseover must
    // not keep its opener alive (M4).
    const visibleSurfaces = (): Set<Element> =>
      (scannedVisible ??= new Set(scanSurfaceStates().map((state) => state.element)));
    // R2-7: this clock measures the gap between the action event and this
    // check, so it must be read *before* the surface lookup below. That lookup
    // may run a full `document.querySelectorAll("*")` walk (`scanSurfaceStates`)
    // on a large document, and that cost belongs to this check, not to the
    // candidate's age: measuring after it inflates `now - recordedAt` past
    // SAME_ACTION_HOVER_MAX_MS and replays the action's own hover as a step.
    const now = Date.now();
    const surface = ownedSurfaceForAction(actionElement, scanSurfaceStates);
    const containedOwner = surface
      ? undefined
      : containedHoverOwnerForAction(actionElement, now, visibleSurfaces, pendingClick);
    const hoverChain = surface
      ? surfaceOwnerChain(surface, actionElement, now, visibleSurfaces)
      : containedOwner
        ? [containedOwner]
        : [];
    if (hoverChain.length === 0) {
      pendingHover = null;
      return;
    }
    for (const hover of withoutSelfActionOwners(hoverChain, pendingClick, now))
      emitHoverStep(hover);
    pendingHover = null;
  };

  const onMouseOver = (event: MouseEvent) => {
    const target = eventTarget(event);
    if (isOverlayTarget(target)) return;
    const now = Date.now();
    if (pendingHover && target instanceof Element && pendingHover.element.contains(target)) {
      if (now - pendingHover.recordedAt <= HOVER_BEFORE_CLICK_MAX_MS) return;
      pendingHover = null;
    }
    const candidate = hoverCandidateFromEvent(target);
    if (candidate) {
      const previousSurfaceStates = new Map(hoverSurfaceStates);
      rememberHoverCandidate(candidate);
      refreshHoverSurfaces(previousSurfaceStates);
      scheduleHoverSurfaceRefresh(previousSurfaceStates);
    }
    const hover = candidate?.eligible ? candidate : null;
    if (pendingHover && target instanceof Element) {
      const relation = decideHoverSurfaceRelation({ triggerElement: pendingHover.element }, target);
      if (relation.related && now - pendingHover.recordedAt <= HOVER_BEFORE_CLICK_MAX_MS) {
        return;
      }
    }
    if (!hover) return;
    if (pendingHover && !shouldReplaceHoverCandidate(pendingHover, hover, now)) {
      return;
    }
    pendingHover = hover;
  };

  const onClick = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = eventTarget(event);
    if (isOverlayTarget(target)) return;
    if (event.detail === 0 && generatedControlClick !== null && target === generatedControlClick) {
      generatedControlClick = null;
      return;
    }
    if (
      event.detail === 0 &&
      keyboardActivation?.target === target &&
      Date.now() - keyboardActivation.recordedAt < 500
    ) {
      keyboardActivation = undefined;
      return;
    }

    const label = target instanceof Element ? target.closest("label") : null;
    const nestedInteractive =
      target instanceof Element ? target.closest("a,button,input,select,textarea") : null;
    if (label instanceof HTMLLabelElement && !nestedInteractive) {
      commitFillSession();
      generatedControlClick = label.control;
      emitClick(event);
      return;
    }

    const fillable = fillableFromTarget(target);
    if (fillable) {
      // A disabled control cannot become a fill; recording the click would
      // describe an action the page refused.
      const pickerTrigger = isDisabledControl(fillable) ? null : pickerTriggerFor(fillable);
      // D5-2: the click target is resolved and its suppression timestamp is
      // written before the pre-action hover replay, so a candidate produced by
      // this very click cannot be replayed as a separate hover step.
      const record = pickerTrigger
        ? claimClickRecord(resolveClickRecord(event, { anchor: pickerTrigger }), eventTarget(event))
        : null;
      emitHoverCandidateBeforeAction(fillable, record);
      ensureFillSession(fillable);
      if (record) emitClickStep(record, false);
      return;
    }

    if (target instanceof Element) {
      const nearbyFillable = nearbyFillableFromSearchChrome(target);
      if (nearbyFillable) {
        emitHoverCandidateBeforeAction(nearbyFillable);
        ensureFillSession(nearbyFillable);
        return;
      }
    }

    if (isInputCompletionClick(target, fillSession)) {
      markNavigationAction();
      const sessionElement = fillSession!.element;
      scheduleInputCompletionCommit(
        sessionElement,
        syncFillSessionValue,
        () => commitFillSession("suggestion"),
        (el) => fillSession?.element === el,
      );
      return;
    }

    commitFillSession();
    if (target instanceof Element && target.closest("select")) return;
    const record = claimClickRecord(resolveClickRecord(event), eventTarget(event));
    emitHoverCandidateBeforeAction(target, record);
    if (record) emitClickStep(record, true);
  };

  const onFocusIn = (event: FocusEvent) => {
    const target = fillableFromTarget(eventTarget(event));
    if (target) ensureFillSession(target);
  };

  const onFocusOut = (event: FocusEvent) => {
    const target = fillableFromTarget(eventTarget(event));
    if (!target) return;
    if (!fillSession || fillSession.element !== target) return;
    syncFillSessionValue(target);
    commitFillSession();
  };

  const onInput = (event: Event) => {
    const target = fillableFromTarget(eventTarget(event));
    if (!target) return;
    if (composing) return;
    ensureFillSession(target);
    syncFillSessionValue(target);
  };

  const onCompositionStart = () => {
    composing = true;
  };

  const onCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    const target = fillableFromTarget(eventTarget(event));
    if (target) {
      ensureFillSession(target);
      syncFillSessionValue(target);
    }
  };

  const onChange = (event: Event) => {
    commitFillSession();
    const target = eventTarget(event);
    if (target instanceof HTMLSelectElement) {
      emitHoverCandidateBeforeAction(target);
      const values = Array.from(target.selectedOptions).map((opt) => opt.value);
      const labels = Array.from(target.selectedOptions).map((opt) =>
        (opt.label || opt.textContent || opt.value).trim(),
      );
      const desc = describeTarget(target);
      markNavigationAction();
      emitStep({
        op: "select",
        target: desc,
        geometry: captureGeometry(target),
        values,
        labels,
        expects_navigation: true,
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (isOverlayTarget(eventTarget(event))) return;
    const target = eventTarget(event);
    const fillable = fillableFromTarget(target);
    if (fillable) {
      ensureFillSession(fillable);
      syncFillSessionValue(fillable);
    }
    const modifiers = [
      ...(event.altKey ? (["alt"] as const) : []),
      ...(event.ctrlKey ? (["ctrl"] as const) : []),
      ...(event.metaKey ? (["meta"] as const) : []),
      ...(event.shiftKey ? (["shift"] as const) : []),
    ];
    if (!shouldRecordPress(event.key, modifiers)) {
      return;
    }
    markNavigationAction();
    if (event.key === "Enter" || event.key === " ") {
      const submitTarget =
        event.key === "Enter" && fillable
          ? fillable
              .closest("form")
              ?.querySelector(
                'button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]',
              )
          : null;
      keyboardActivation = {
        target: submitTarget ?? target,
        recordedAt: Date.now(),
      };
    }
    if (fillable) {
      commitFillSession(event.key === "Enter" ? "enter" : "blur");
    }
    const desc = describeEventTarget(target);
    if (!desc && !event.key) return;
    emitHoverCandidateBeforeAction(target);
    emitStep({
      op: "press",
      key: event.key,
      ...(desc ? { target: desc, geometry: geometryForEventTarget(target) } : {}),
      ...(modifiers.length ? { modifiers } : {}),
      expects_navigation: event.key === "Enter",
    });
  };

  document.addEventListener("click", onClick, true);
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("keydown", onKeyDown, true);

  const captureNavigation = options.captureNavigation ?? true;
  const urlObserver = captureNavigation
    ? new MutationObserver(() => emitNavigateIfChanged())
    : null;
  urlObserver?.observe(document, { subtree: true, childList: true });
  const onUrlEvent = () => emitNavigateIfChanged();
  // Wrap: passing commitFillSession directly would forward the DOM event as
  // the `commit` argument and stamp it onto the recorded fill step.
  const onPageHide = () => commitFillSession();
  if (captureNavigation) {
    window.addEventListener("hashchange", onUrlEvent);
    window.addEventListener("popstate", onUrlEvent);
  }
  window.addEventListener("pagehide", onPageHide);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  if (captureNavigation) {
    history.pushState = function (...args: Parameters<History["pushState"]>) {
      originalPushState.apply(this, args);
      emitNavigateIfChanged(navigationActionPending ? true : undefined);
    };
    history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      originalReplaceState.apply(this, args);
      emitNavigateIfChanged(navigationActionPending ? true : undefined);
    };
  }

  return {
    dispose() {
      commitFillSession();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mouseover", onMouseOver, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("compositionstart", onCompositionStart, true);
      document.removeEventListener("compositionend", onCompositionEnd, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("keydown", onKeyDown, true);
      urlObserver?.disconnect();
      if (captureNavigation) {
        window.removeEventListener("hashchange", onUrlEvent);
        window.removeEventListener("popstate", onUrlEvent);
      }
      window.removeEventListener("pagehide", onPageHide);
      if (captureNavigation) {
        history.pushState = originalPushState;
        history.replaceState = originalReplaceState;
      }
    },
  };
}
