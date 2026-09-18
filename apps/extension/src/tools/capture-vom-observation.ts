import { captureVomObservation as captureVomObservationRaw } from "./observation";

/**
 * Recording-facing facade for one VOM observation. It adds exactly one thing to
 * `./observation`'s `captureVomObservation`: the `keepRedundantRefChildren` opt-in.
 *
 * This module is imported by `lib/recording/observation-capture.ts` and by nothing
 * else in production code — `tool.snapshot` / `tool.observe` (and every other caller)
 * import `captureVomObservation` from `./observation` directly, so they keep HEAD's
 * terse rendering and the option stays at `renderVom`'s own `false` default.
 *
 * Recording observation is the only caller that indexes refs by geometry, so it opts
 * in here by default: a control nested inside a named ref node (e.g. the input behind
 * a named combobox) must still get its own `@eN`, otherwise the ref index cannot
 * resolve a geometry hit on that child and `target-matcher` reports `unmatched`.
 * See D2-rootcause.md §3.3 A.
 *
 * An explicit `keepRedundantRefChildren` still wins, so tests can pin both directions
 * through this entry point.
 */
export async function captureVomObservation(
  ...args: Parameters<typeof captureVomObservationRaw>
): ReturnType<typeof captureVomObservationRaw> {
  const [cdp, tabId, url, options = {}] = args;
  return captureVomObservationRaw(cdp, tabId, url, {
    ...options,
    keepRedundantRefChildren: options.keepRedundantRefChildren ?? true,
  });
}

export { type CaptureVomObservationOptions } from "./observation";
export {
  type CaptureVomFrame,
  type CaptureVomMatchNode,
  type CaptureVomObservationResult,
} from "./vom/record-safe-observation";
