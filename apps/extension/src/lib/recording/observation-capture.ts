import type { RenderedRef } from "@browser-skill/vom";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import {
  type CaptureVomMatchNode,
  type CaptureVomObservationResult,
  captureVomObservation,
} from "@/tools/capture-vom-observation";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";

export interface IndexedObservationNode {
  frameId: string;
  geometry: CaptureVomMatchNode;
  ref?: RenderedRef;
}

/**
 * Debug-only counters for one recording observation (M5 attribution for D1).
 *
 * These numbers exist to answer "which layer dropped the missing panel?" and
 * are deliberately *not* part of the recording trace protocol: callers spread
 * individual fields out of `CapturedRecordingObservation`, so nothing here can
 * reach `trace.json` unless a caller opts in explicitly.
 */
export interface RecordingObservationDebug {
  /** Nodes handed to the semantic/render pipeline (per-frame DOM nodes). */
  preRenderNodes: number;
  /**
   * Derived count of nodes whose post-normalization geometry cannot paint
   * (missing rect, or non-positive width/height). This approximates the
   * `rendered=false` filter in `tools/vom/normalize.ts` without changing it.
   */
  renderedFalseNodes: number;
  /** Nodes dropped by the double-layer renderer (`hiddenCount` in render.ts). */
  hiddenCount: number;
  /** Whether the renderer chose a double-layer (L1/L2) output. */
  doubleLayer: boolean;
  /** Refs actually emitted into the rendered text. */
  renderedRefs: number;
}

export interface CapturedRecordingObservation {
  rootFrameId: string;
  index: ObservationNodeIndex;
  url: string;
  title?: string;
  vomText: string;
  truncated: boolean;
  /** Trace-external observability; see `RecordingObservationDebug`. */
  debug?: RecordingObservationDebug;
}

/**
 * `renderVom` does not return stats, so `hiddenCount` is recovered from the
 * occlusion line it writes (`L2 page … occluded by L1 (~N nodes…)`). Reading it
 * back is exact and leaves render semantics untouched.
 */
const OCCLUDED_NODES_PATTERN = /occluded by L1 \(~(\d+) nodes, not actionable\)/;

function measureRecordingObservation(
  captured: CaptureVomObservationResult,
): RecordingObservationDebug {
  let renderedFalseNodes = 0;
  for (const node of captured.matchNodes) {
    const rect = node.rect;
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) renderedFalseNodes += 1;
  }
  const occluded = OCCLUDED_NODES_PATTERN.exec(captured.text);
  return {
    preRenderNodes: captured.matchNodes.length,
    renderedFalseNodes,
    hiddenCount: occluded ? Number.parseInt(occluded[1] ?? "0", 10) : 0,
    doubleLayer: occluded !== null,
    renderedRefs: captured.refs.length,
  };
}

export interface RegisteredObservation {
  stateId: string;
  rootFrameId: string;
  index: ObservationNodeIndex;
  url: string;
  /**
   * `Date.now()` at the moment the *sample was started* (E11), i.e. the instant
   * `RecordingObservationSession.capture` entered, which is the closest clock
   * the extension can take to the CDP DOM read.
   *
   * This — not `settledAt` — is the clock both monotonicity guards use: a
   * snapshot whose sampling began before an action arrived describes what the
   * page looked like when that action started, even when the read finished
   * after it (hover opens a menu, the click arrives 500ms later, the hover's
   * sample only settles then). `settledAt` merely says when the observation
   * became available.
   *
   * Optional because callers that inject observations (tests, transitional
   * code) have no capture clock; an absent value falls back to `settledAt` and
   * then to "usable".
   */
  capturedAt?: number;
  /**
   * `Date.now()` at the moment the observation was registered (E9). Retained
   * for diagnostics/DEV logs and as the fallback clock when `capturedAt` is
   * absent; the backfill/pre-state guards prefer `capturedAt`.
   */
  settledAt?: number;
}

export interface RecordingDocumentScope {
  frameId: string;
  target: CdpTarget;
}

function nodeKey(frameId: string, backendNodeId: number): string {
  return `${frameId}:${backendNodeId}`;
}

function frameTagKey(frameId: string, tag: string): string {
  return `${frameId}:${tag.toLowerCase()}`;
}

export class ObservationNodeIndex {
  readonly #nodesByFrameTag = new Map<string, IndexedObservationNode[]>();
  readonly #refById = new Map<string, RenderedRef>();
  readonly #refsByFrame = new Map<string, RenderedRef[]>();
  readonly #scopeByProducer = new Map<string, RecordingDocumentScope | null>();

  constructor(
    input: Pick<CaptureVomObservationResult, "rootFrameId" | "matchNodes" | "refs"> &
      Partial<Pick<CaptureVomObservationResult, "frames">>,
  ) {
    const refByNode = new Map<string, RenderedRef>();
    for (const ref of input.refs) {
      const frameId = ref.frameId ?? input.rootFrameId;
      refByNode.set(nodeKey(frameId, ref.backendNodeId), ref);
      this.#refById.set(ref.ref, ref);
      const frameRefs = this.#refsByFrame.get(frameId) ?? [];
      frameRefs.push(ref);
      this.#refsByFrame.set(frameId, frameRefs);
    }
    for (const frame of input.frames ?? []) {
      const documentId = frame.recordingDocumentId;
      if (!documentId) continue;
      this.#scopeByProducer.set(
        documentId,
        this.#scopeByProducer.has(documentId)
          ? null
          : { frameId: frame.frameId, target: frame.target },
      );
    }
    for (const geometry of input.matchNodes) {
      const { frameId } = geometry;
      const entry = {
        frameId,
        geometry,
        ref: refByNode.get(nodeKey(frameId, geometry.backendNodeId)),
      };
      const key = frameTagKey(frameId, geometry.tag);
      const bucket = this.#nodesByFrameTag.get(key) ?? [];
      bucket.push(entry);
      this.#nodesByFrameTag.set(key, bucket);
    }
  }

  candidates(frameId: string, tag: string): readonly IndexedObservationNode[] {
    return this.#nodesByFrameTag.get(frameTagKey(frameId, tag)) ?? [];
  }

  ref(refId: string): RenderedRef | undefined {
    return this.#refById.get(refId);
  }

  refs(frameId: string): readonly RenderedRef[] {
    return this.#refsByFrame.get(frameId) ?? [];
  }

  documentScope(producerId: string): RecordingDocumentScope | undefined {
    return this.#scopeByProducer.get(producerId) ?? undefined;
  }
}

async function readTabMeta(
  tabsApi: ChromeTabsApi,
  tabId: number,
): Promise<{ url: string; title?: string }> {
  try {
    const tab = await tabsApi.get(tabId);
    return { url: tab.url ?? "about:blank", title: tab.title };
  } catch {
    return { url: "about:blank" };
  }
}

export async function captureRecordingObservation(input: {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  tabId: number;
  maxTokens: number;
  redactValues: boolean;
  signal?: AbortSignal;
}): Promise<CapturedRecordingObservation> {
  const { url, title } = await readTabMeta(input.tabsApi, input.tabId);
  const captured = await captureVomObservation(input.cdp, input.tabId, url, {
    maxTokens: input.maxTokens,
    redactValues: input.redactValues,
    conditionalSurfaceProbe: false,
    signal: input.signal,
  });
  const debug = measureRecordingObservation(captured);
  // Trace-external channel: the field above is for callers/tests, this line is
  // for live attribution runs against real pages. Guarded so the production
  // bundle carries no per-observation console call (R1-9).
  if (import.meta.env.DEV) console.debug("[record-observe]", debug);
  return {
    rootFrameId: captured.rootFrameId,
    index: new ObservationNodeIndex(captured),
    url,
    title,
    vomText: captured.text,
    truncated: captured.truncated,
    debug,
  };
}
