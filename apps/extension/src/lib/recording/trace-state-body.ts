import type { StepAnnotation } from "./types";

/**
 * Build stamp of the extension bundle that produced this body, injected at build
 * time via Vite's `define` (see `wxt.config.ts`; `vitest.config.ts` mirrors it with
 * `"test"`). It is re-emitted into every state body's front matter so an exported
 * `states/*.txt` can be checked offline against a specific build — the extension
 * id and `manifest.version` are identical across rebuilds, so they cannot show
 * which bundle a browser actually loaded (H2-metrics: a stale bundle reproduced a
 * pre-fix trace byte-for-byte at the same version).
 *
 * The `typeof` guard mirrors `src/transport/handshake.ts`: if this module is ever
 * evaluated without the define in place, a parseable line is still written instead
 * of throwing a `ReferenceError`.
 */
const BUILD_STAMP: string = typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : "unknown";

/** Front matter of a state body, as written by `formatTraceStateBody`. */
export interface TraceStateFrontMatter {
  state?: string;
  url?: string;
  title?: string;
  /** `<short-sha>[-dirty].<yyyyMMdd-HHmm>`, or `nogit`/`unknown` when unavailable. */
  extension_build?: string;
  /**
   * `steps_here` / `state_unbound_steps` / `state_backfilled_steps` /
   * `post_state_fallback_steps`, always parsed as numeric arrays.
   */
  [key: string]: string | number[] | undefined;
}

/**
 * Parse the `# bsk-observation 1` front matter of a state body.
 *
 * Every key with a `_steps` suffix is parsed into a number array — exactly like
 * `steps_here` — instead of being left as the raw `"[2]"` string. A consumer
 * that treats the writer's own line as a list must not get `undefined.length`
 * for `state_unbound_steps` (R1-10), `state_backfilled_steps` or
 * `post_state_fallback_steps` (R2-8 / R2-12). Unknown keys stay as trimmed
 * strings.
 */
export function parseTraceStateFrontMatter(body: string): TraceStateFrontMatter {
  const out: TraceStateFrontMatter = {};
  const lines = body.split(/\r?\n/);
  if (!lines[0]?.startsWith("#")) return out;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "---") break;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] =
      key === "steps_here" || key.endsWith("_steps")
        ? [...value.matchAll(/\d+/g)].map((match) => Number(match[0]))
        : value;
  }
  return out;
}

function annotationText(annotation: StepAnnotation, stepId: number): string {
  return ` ⟵ step ${stepId}: ${annotation.op}${annotation.detail ? `: ${annotation.detail}` : ""}`;
}

export function formatTraceStateBody(input: {
  stateId: string;
  url: string;
  title?: string;
  stepIds: number[];
  /** Steps that reference this state only because their pre-state was missing. */
  unboundStepIds?: number[];
  /**
   * Steps whose result state is this state only because a trailing observation
   * backfilled it (E9 / R2-8): the observation is real, but it may also cover
   * the effect of later actions, so `result.state === state` here must not be
   * read as "this action's own settle landed there".
   */
  backfilledStepIds?: number[];
  /**
   * Steps whose result state is this state only because no observation was ever
   * available and an adjacent draft's state was reused (R2-12). Disjoint from
   * `backfilledStepIds`: these steps were never observed at all.
   */
  fallbackStepIds?: number[];
  vomText: string;
  annotations: StepAnnotation[];
  stepIdByDraftId: Map<number, number>;
}): string {
  const lines = ["# bsk-observation 1", `state: ${JSON.stringify(input.stateId)}`];
  lines.push(`url: ${JSON.stringify(input.url)}`);
  if (input.title) lines.push(`title: ${JSON.stringify(input.title)}`);
  if (input.stepIds.length > 0) lines.push(`steps_here: [${input.stepIds.join(", ")}]`);
  // Unlike a step-level marker, the body is a passthrough string: the CLI
  // copies it verbatim into `states/<id>.txt` and the wire trace `body`, so this
  // survives the protocol boundary and reaches whatever reads the trace.
  if (input.unboundStepIds?.length) {
    lines.push(`state_unbound_steps: [${input.unboundStepIds.join(", ")}]`);
  }
  // R2-8: `steps_here` alone cannot separate a normal bind from a backfill, and
  // `postStateBackfilled` is internal bookkeeping that never reaches the wire
  // trace. Both facts have to be visible in the body, like `state_unbound_steps`.
  if (input.backfilledStepIds?.length) {
    lines.push(`state_backfilled_steps: [${input.backfilledStepIds.join(", ")}]`);
  }
  // R2-12: a fabricated post-state is the mirror image of a missing pre-state,
  // so it gets its own line rather than sharing the backfill one — "coarser
  // observation" and "no observation" must stay distinguishable.
  if (input.fallbackStepIds?.length) {
    lines.push(`post_state_fallback_steps: [${input.fallbackStepIds.join(", ")}]`);
  }
  // Always emitted, and always the last front-matter line: `steps_here` is absent
  // when a state has no bound steps, so the stamp cannot be keyed off it. Written
  // unquoted (a stamp never contains spaces) so a plain `grep extension_build`
  // works on `states/<id>.txt` as well as through `parseTraceStateFrontMatter`.
  lines.push(`extension_build: ${BUILD_STAMP}`);
  lines.push("---");

  const byLine = new Map<number, Array<{ annotation: StepAnnotation; stepId: number }>>();
  for (const annotation of input.annotations) {
    const stepId = input.stepIdByDraftId.get(annotation.draftId);
    if (stepId === undefined) continue;
    const bucket = byLine.get(annotation.line) ?? [];
    bucket.push({ annotation, stepId });
    byLine.set(annotation.line, bucket);
  }

  input.vomText.split("\n").forEach((bodyLine, lineIndex) => {
    let line = bodyLine;
    for (const item of byLine.get(lineIndex) ?? []) {
      line += annotationText(item.annotation, item.stepId);
    }
    lines.push(line);
  });
  return `${lines.join("\n")}\n`;
}
