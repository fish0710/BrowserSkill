import type { StepV3, TargetDescriptorV3, TraceStateV3, TraceV3 } from "@/transport/types";
import type { RecordingDraftStep } from "./types";

/**
 * D3-1: `redactValues` only masks the `value` field of a fill step. The same
 * secret reaches the finished trace through replayed URLs, page titles and VOM
 * text, so the trace is scrubbed once on the way out of `buildTraceV3`.
 *
 * R2-1: the threshold is 4, not 3. Three-character fragments such as `one`,
 * `two` or `the` are ordinary words (`"Money in your phone"` contains `one`),
 * so a three-character fill value must never enter the scrub set. Four is the
 * shortest length that is worth the boundary scan below.
 */
export const MIN_SCRUB_LEN = 4;

/** Mask substituted for every secret variant. */
export const REDACTION_MASK = "***";

/**
 * The secrets a run must never write out: the fill values that the reducer
 * masks (`redactValues` masks every fill, `redacted` masks the marked ones).
 * Non-fill drafts carry no user-typed plaintext.
 */
export function collectTraceSecrets(
  drafts: readonly RecordingDraftStep[],
  redactValues: boolean,
): string[] {
  const secrets = new Set<string>();
  for (const draft of drafts) {
    if (draft.op !== "fill") continue;
    if (!redactValues && draft.redacted !== true) continue;
    const value = draft.value;
    if (typeof value !== "string" || value.length < MIN_SCRUB_LEN) continue;
    secrets.add(value);
  }
  return [...secrets];
}

/**
 * A secret survives a round trip through URLs and front matter in several
 * shapes: as typed, JSON-escaped (`url: "..."` lines), percent-encoded
 * (`encodeURIComponent` for a query value, `encodeURI` for a whole URL),
 * form-encoded (`URLSearchParams`, `+` for a space) and double-encoded.
 *
 * R2-2: `URLSearchParams` is not the same encoder as `encodeURIComponent` — it
 * additionally escapes `! ' ( ) *` — so the form shape has to be enumerated on
 * its own. Its percent escapes also survive in either casing (`%2F` vs `%2f`),
 * so both casings are added.
 */
function secretVariants(secret: string): string[] {
  const variants = new Set<string>();
  addVariant(variants, secret);
  addVariant(variants, JSON.stringify(secret).slice(1, -1));
  addVariant(variants, tryEncode(encodeURIComponent, secret));
  addVariant(
    variants,
    tryEncode((value) => encodeURIComponent(encodeURIComponent(value)), secret),
  );
  addVariant(variants, tryEncode(encodeURI, secret));
  addVariant(variants, secret.replace(/ /g, "+"));
  const form = tryEncode((value) => new URLSearchParams({ v: value }).toString().slice(2), secret);
  addVariant(variants, form);
  addVariant(variants, recasePercentEscapes(form, true));
  addVariant(variants, recasePercentEscapes(form, false));
  return [...variants];
}

function tryEncode(encode: (value: string) => string, value: string): string {
  try {
    return encode(value);
  } catch {
    // A lone surrogate makes a percent encoder throw; the raw form still covers it.
    return "";
  }
}

function recasePercentEscapes(value: string, upper: boolean): string {
  return value.replace(/%[0-9A-Fa-f]{2}/g, (match) =>
    upper ? match.toUpperCase() : match.toLowerCase(),
  );
}

/**
 * A body line is an addressable unit (`steps_here` and annotations refer to line
 * indices), so a variant that contains a line break is split into its own lines
 * instead of being replaced across them.
 */
function addVariant(variants: Set<string>, value: string): void {
  if (value.length < MIN_SCRUB_LEN) return;
  if (!value.includes("\n") && !value.includes("\r")) {
    variants.add(value);
    return;
  }
  for (const line of value.split(/\r?\n/)) {
    if (line.length >= MIN_SCRUB_LEN) variants.add(line);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * R2-18: one pre-compiled matcher per run (variant-deduped, longest alternative
 * first so no short variant can clip the prefix of a longer one), so each field
 * costs a single traversal instead of one `split().join()` per variant.
 *
 * R2-1: a secret is replaced only where it is a whole value, never as a bare
 * substring. Two shapes are accepted in the same pass:
 *
 * - query/form field value — the `?`/`&`/`=` before and the `&`/`#`/end after
 *   are the boundary, so no letter/digit lookaround is needed there (the value
 *   may run right up to `&` or the end of the string);
 * - standalone token in free text (`body`, `title`) — neither neighbour may be
 *   a letter or digit, and a `%XX` escape counts as a boundary because it is
 *   the encoded form of a separator (`Form%20value%20<secret>`).
 */
function compileScrubber(secrets: readonly string[]): RegExp | null {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SCRUB_LEN) continue;
    for (const variant of secretVariants(secret)) variants.add(variant);
  }
  if (variants.size === 0) return null;

  const alternation = [...variants]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const boundaryBefore = "(?:(?<![A-Za-z0-9])|(?<=%[0-9A-Fa-f]{2}))";
  const boundaryAfter = "(?![A-Za-z0-9])";
  return new RegExp(
    `(?:(?<=[?&=])(?:${alternation})(?=[&#]|$))` +
      `|(?:${boundaryBefore}(?:${alternation})${boundaryAfter})`,
    "g",
  );
}

interface ScrubbableStep {
  to?: string;
  url?: string;
  target?: TargetDescriptorV3;
}

/**
 * Replace every secret variant in the fields a secret can reach. Pure: the
 * input trace is never mutated, an empty secret set returns the very same
 * object, and a field that does not match keeps its identity (R2-18) so a run
 * without `--redact-values` is byte-for-byte unchanged.
 *
 * Deliberately not scrubbed: the state registry dedup key (`url\0vomText`), so
 * state reuse keeps its pre-scrub identity.
 */
export function scrubTraceSecrets<T extends TraceV3>(trace: T, secrets: readonly string[]): T {
  const scrubber = compileScrubber(secrets);
  if (!scrubber) return trace;

  const scrub = (value: string): string => value.replace(scrubber, REDACTION_MASK);

  const startUrl = scrub(trace.entry.start_url);
  const entry =
    startUrl === trace.entry.start_url ? trace.entry : { ...trace.entry, start_url: startUrl };

  const states = trace.states.map((state): TraceStateV3 => {
    const url = scrub(state.url);
    const title = typeof state.title === "string" ? scrub(state.title) : state.title;
    const body = typeof state.body === "string" ? scrub(state.body) : state.body;
    if (url === state.url && title === state.title && body === state.body) return state;
    return {
      ...state,
      url,
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
    };
  });

  const steps = trace.steps.map((step): StepV3 => {
    const mutable = step as ScrubbableStep;
    const patch: Record<string, unknown> = {};
    if (typeof mutable.to === "string") {
      const to = scrub(mutable.to);
      if (to !== mutable.to) patch.to = to;
    }
    if (typeof mutable.url === "string") {
      const url = scrub(mutable.url);
      if (url !== mutable.url) patch.url = url;
    }
    const target = mutable.target;
    if (target) {
      const name = typeof target.name === "string" ? scrub(target.name) : target.name;
      const ctx = typeof target.ctx === "string" ? scrub(target.ctx) : target.ctx;
      if (name !== target.name || ctx !== target.ctx) {
        patch.target = {
          ...target,
          ...(name === undefined ? {} : { name }),
          ...(ctx === undefined ? {} : { ctx }),
        };
      }
    }
    if (Object.keys(patch).length === 0) return step;
    return { ...step, ...patch } as StepV3;
  });

  const untouched =
    entry === trace.entry &&
    states.every((state, index) => state === trace.states[index]) &&
    steps.every((step, index) => step === trace.steps[index]);
  if (untouched) return trace;

  return { ...trace, entry, states, steps } as T;
}
