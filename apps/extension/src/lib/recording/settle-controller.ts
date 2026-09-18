import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import { type DocumentSettleScope, waitForDocumentSettled } from "./document-settle";
import type { RegisteredObservation } from "./observation-capture";
import { RecordingObservationSession } from "./observation-session";
import type { RecordingDraftStep } from "./types";

interface PendingSettle {
  abort: AbortController;
  scope: DocumentSettleScope;
}

interface PendingRedirect {
  url: string;
  abort: AbortController;
}

const CAPTURE_RETRY_DELAY_MS = 250;

/**
 * Upper bound on how long the next action's pre-state binding waits for a DOM
 * read that is already in flight (E19).
 *
 * The wait runs inside the action queue, so it must stay well below the pace of
 * a human burst while still covering a real capture on a large page; past the
 * bound the sample is abandoned and the pre-E19 abort-and-backfill path takes
 * over.
 */
const IN_FLIGHT_BIND_TIMEOUT_MS = 1_500;

/** What an in-flight DOM read eventually produced. Never a rejection: both the
 * owning settle task and every waiter share the same promise, and an unhandled
 * rejection on the waiter side would be fatal. */
type SampleOutcome =
  | { ok: true; observation: RegisteredObservation }
  | { ok: false; error: unknown };

/**
 * A settle task that has finished waiting for the document to be quiet and is
 * now reading the DOM (E19).
 *
 * The distinction that matters is *where* a settle is when a later action
 * supersedes it:
 *
 * - still inside `waitForDocumentSettled` — nothing has been read yet, so the
 *   action aborts it as before and the draft is backfilled from a later
 *   observation (E9);
 * - inside `capture` — the DOM read has already begun on the document the
 *   previous action produced. Aborting it throws away the only observation that
 *   *is* the previous action's result and *is* the next action's pre-state
 *   (pace 500ms: hover opens a menu, the sample reads the open menu, the click
 *   on a menu item arrives). Keeping it serves both ends.
 */
interface InFlightSample {
  /** Draft whose settle started this read. */
  draftIndex: number;
  /**
   * Wall clock just before `session.capture()` was entered, i.e. at or just
   * before the observation's own `capturedAt` (E11). Used only for diagnostics:
   * whether this sample is a legal pre-state is decided by `bindDraft`'s
   * `capturedAt <= arrivedAt` guard, not here.
   */
  startedAt: number;
  outcome: Promise<SampleOutcome>;
}

/**
 * Resolve with the promise's value, or `null` if it has not settled in time.
 * The timer is cleared as soon as the promise wins so a bounded wait never
 * leaves a stray timer (or, with real timers, a live event-loop handle) behind.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const finish = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    void promise.then(
      (value) => finish(value),
      () => finish(null),
    );
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

export function inferMissingPostStates(drafts: RecordingDraftStep[]): void {
  for (let index = 0; index < drafts.length - 1; index += 1) {
    const draft = drafts[index];
    const next = drafts[index + 1];
    if (draft && next && !draft.postStateId && next.preStateId) {
      // R2-12: this is the same fabrication as `#fallbackMissingPostStates`
      // (an adjacent state standing in for an observation), so it carries the
      // same marker rather than slipping through unlabelled.
      draft.postStateId = next.preStateId;
      draft.postStateFallback = true;
      delete draft.postStatePending;
    }
  }
}

export class SettleController {
  readonly #session: RecordingObservationSession;
  readonly #cdp: CdpRunner;
  readonly #tabsApi: ChromeTabsApi;
  readonly #tabId: number;
  readonly #rootScope: DocumentSettleScope;
  readonly #pending = new Map<number, PendingSettle>();
  /**
   * Draft indices whose settle was aborted by a later action before it could
   * sample a result (E9). They are backfilled by the next observation that is
   * genuinely sampled after the draft arrived, instead of being stamped with
   * the next action's pre-state.
   */
  readonly #superseded = new Set<number>();
  /** Counts backfills for the DEV diagnostics channel (E9). */
  #backfillCount = 0;
  /**
   * The sample currently being read from the DOM, if any (E19). At most one
   * settle can be in this state at a time: settles are queued serially on
   * `#queue`.
   */
  #inFlight: InFlightSample | null = null;
  #queue = Promise.resolve();
  #pendingRedirect: PendingRedirect | null = null;
  #redirectQueue = Promise.resolve();

  constructor(input: {
    session: RecordingObservationSession;
    cdp: CdpRunner;
    tabsApi: ChromeTabsApi;
    tabId: number;
  }) {
    this.#session = input.session;
    this.#cdp = input.cdp;
    this.#tabsApi = input.tabsApi;
    this.#tabId = input.tabId;
    this.#rootScope = { target: { tabId: input.tabId } };
  }

  get hasPending(): boolean {
    return this.#pending.size > 0 || this.#pendingRedirect !== null;
  }

  async #captureWithRetry(signal?: AbortSignal) {
    try {
      return await this.#session.capture(this.#cdp, this.#tabsApi, this.#tabId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      await delay(CAPTURE_RETRY_DELAY_MS, signal);
      return this.#session.capture(this.#cdp, this.#tabsApi, this.#tabId, signal);
    }
  }

  /** The sample being read from the DOM right now, if any (E19, read-only). */
  get hasInFlightSample(): boolean {
    return this.#inFlight !== null;
  }

  /**
   * Wait, bounded, for a DOM read that is already in flight (E19).
   *
   * Called by the action path *before* `bindDraft`: `session.capture()` has
   * already published the sample as `cursor.lastSettled` by the time this
   * resolves, so the arriving action binds it through the ordinary E11 guard
   * (`capturedAt <= arrivedAt`) instead of falling back to the snapshot from
   * before the previous action. The owning settle task binds the very same
   * observation as its own result, so the sample is shared rather than
   * duplicated — and because that is a real observation of both actions, its
   * draft is never marked `postStateBackfilled`.
   *
   * Only a read that *started no later than `arrivedAt`* is worth waiting for:
   * that is exactly the E11 condition for the sample to be a legal pre-state.
   * A read that began after the action arrived (`startedAt > arrivedAt`) would
   * be rejected as `late` no matter when it lands, so waiting for it would only
   * delay the burst and stall the serial settle queue — those return `null` at
   * once and leave the E9 abort-and-backfill path in charge.
   *
   * Returns `null` when there was nothing in flight, when the read began after
   * `arrivedAt`, when it failed, or when `timeoutMs` elapsed. In the last case
   * the sample is abandoned and aborted so the settle queue can drain: the
   * caller then follows the E9 path (a later observation backfills the draft).
   */
  async awaitInFlightSample(
    arrivedAt: number,
    timeoutMs: number = IN_FLIGHT_BIND_TIMEOUT_MS,
  ): Promise<RegisteredObservation | null> {
    const inFlight = this.#inFlight;
    if (!inFlight) return null;
    if (inFlight.startedAt > arrivedAt) return null;
    const outcome = await withTimeout(inFlight.outcome, timeoutMs);
    if (!outcome) {
      // Bounded wait exceeded: stop treating this read as shareable and fall
      // back to the pre-E19 behaviour. The abort is what makes the settle task
      // stop waiting on it; a sample that lands anyway can still backfill the
      // draft through `#bindTrailing`.
      if (this.#inFlight === inFlight) this.#inFlight = null;
      this.#pending.get(inFlight.draftIndex)?.abort.abort();
      if (import.meta.env.DEV) {
        console.debug("[bsk record] in-flight observation did not land in time", {
          stepId: inFlight.draftIndex + 1,
          startedAt: inFlight.startedAt,
          arrivedAt,
          timeoutMs,
        });
      }
      return null;
    }
    return outcome.ok ? outcome.observation : null;
  }

  /**
   * Backfill post-states for superseded drafts from `observation`.
   *
   * Only drafts that (a) still have no `postStateId`, (b) did not arrive after
   * the observation's sample began, and (c) were superseded by a later action —
   * either while their own settle was pending, or because their settle failed
   * and left them without a result — are eligible. The sampling clock is what
   * keeps a stale snapshot from becoming a result state: a sample that *began*
   * before the action cannot describe the document after it. This is the same
   * monotonicity rule `RecordingObservationSession.bindDraft` applies to
   * pre-states, and it uses the same clock (`capturedAt`, E11): a sample that
   * started before an action but settled after it is still a legal result for
   * that action, because the sample's own read may well cover its effect.
   */
  #bindTrailing(
    drafts: RecordingDraftStep[],
    observation: RegisteredObservation,
    sampledAt: number,
    belowIndex: number,
  ): void {
    this.#noteSuperseded(drafts, belowIndex);
    const backfilled: number[] = [];
    for (const index of this.#superseded) {
      const draft = drafts[index];
      if (!draft || draft.postStateId) {
        this.#superseded.delete(index);
        continue;
      }
      const arrivedAt = draft.arrivedAt;
      if (arrivedAt !== undefined && arrivedAt > sampledAt) continue;
      draft.postStateId = observation.stateId;
      draft.postStateBackfilled = true;
      delete draft.postStateFallback;
      delete draft.postStatePending;
      this.#superseded.delete(index);
      this.#session.registry.markStep(observation.stateId, index + 1);
      backfilled.push(index + 1);
    }
    if (backfilled.length === 0) return;
    this.#backfillCount += backfilled.length;
    // The backfill is a deliberate semantic downgrade (a superseded action can
    // receive a coarser observation that includes the effect of later actions).
    // It must be visible rather than a silent inference: the durable channel is
    // the bound state's `steps_here` line (via `markStep`), and DEV runs also
    // get this counter.
    if (import.meta.env.DEV) {
      console.debug("[bsk record] post-state backfilled from a trailing observation", {
        stepIds: backfilled,
        stateId: observation.stateId,
        sampledAt,
        settledAt: observation.settledAt,
        backfillCount: this.#backfillCount,
      });
    }
  }

  /**
   * Remember every draft below `limit` that is still waiting for a result.
   *
   * Called both when an action supersedes a pending settle and after a settle
   * failed: in the latter case the draft is no longer in `#pending`, but it is
   * still exactly the draft a later observation should describe. Without this
   * second call a failed capture left the draft permanently "result equals
   * state", which is the defect this job removes.
   */
  #noteSuperseded(drafts: RecordingDraftStep[], limit: number): void {
    const end = Math.min(limit, drafts.length);
    for (let index = 0; index < end; index += 1) {
      const draft = drafts[index];
      if (draft && !draft.postStateId) {
        draft.postStatePending = true;
        this.#superseded.add(index);
      }
    }
  }

  schedule(
    drafts: RecordingDraftStep[],
    draftIndex: number,
    scope: DocumentSettleScope = this.#rootScope,
  ): void {
    if (scope.target.tabId !== this.#tabId) {
      throw new Error(
        `settle scope tab ${scope.target.tabId} does not belong to tab ${this.#tabId}`,
      );
    }
    for (const [index, pending] of this.#pending) {
      if (index >= draftIndex) continue;
      // E19: a settle that is already reading the DOM is not superseded. Its
      // sample is the previous action's result *and* this action's pre-state, so
      // aborting it destroyed the only observation that could bind either end.
      // The sampling task owns deciding what to do with it from here; this
      // action gets it through `awaitInFlightSample` (bounded).
      if (this.#inFlight?.draftIndex === index) continue;
      pending.abort.abort();
      this.#pending.delete(index);
    }
    // Do NOT write `drafts[draftIndex].preStateId` into earlier drafts here.
    // During a burst all pending drafts share the snapshot taken before the
    // burst (a `cursor.lastSettled` reuse), so that value is a stale
    // *pre*-state, not an earlier action's result; writing it pinned
    // `result.state` to the state from before the whole burst. Mark the drafts
    // instead and let the next observation sampled after they arrived backfill
    // them (`#bindTrailing`).
    this.#noteSuperseded(drafts, draftIndex);

    this.#pending.get(draftIndex)?.abort.abort();
    const pending = { abort: new AbortController(), scope };
    this.#pending.set(draftIndex, pending);
    const task = async () => {
      if (pending.abort.signal.aborted) return;
      try {
        const settleOutcome = await waitForDocumentSettled(this.#cdp, pending.scope, {
          signal: pending.abort.signal,
        });
        if (settleOutcome === "cancelled") return;
        // E19: publish the read as an in-flight sample *before* awaiting it, so
        // a later action that arrives while the DOM is being read can wait for
        // this exact observation instead of aborting it. The wrapped promise
        // never rejects, because the owning task and every waiter share it.
        const inFlight: InFlightSample = {
          draftIndex,
          startedAt: Date.now(),
          outcome: this.#captureWithRetry(pending.abort.signal).then(
            (observation) => ({ ok: true as const, observation }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        };
        this.#inFlight = inFlight;
        const sample = await inFlight.outcome;
        if (!sample.ok) throw sample.error;
        const observation = sample.observation;
        const sampledAt = observation.capturedAt ?? observation.settledAt ?? Date.now();
        // Bind this draft's own result *before* the trailing scan. The sample
        // may be shared with a later action that waited for it (E19); that makes
        // it a plain observation for both ends, not a backfill, so the scan must
        // not claim it as one.
        const own = drafts[draftIndex];
        if (own && !own.postStateId) {
          own.postStateId = observation.stateId;
          // The draft was marked pending by the supersede scan; now that its own
          // settle landed, the bookkeeping must not keep claiming it is
          // unresolved (the trace reads the flag set, not this one). Binding it
          // here, before the trailing scan, is also what keeps a sample that is
          // *shared* with a later action (E19) from being reported as a
          // backfill: it is the plain observation of this action.
          delete own.postStatePending;
          this.#superseded.delete(draftIndex);
        }
        this.#bindTrailing(drafts, observation, sampledAt, draftIndex);
        if (this.#inFlight === inFlight) {
          this.#inFlight = null;
        }
      } catch (error) {
        if (!isAbortError(error)) {
          console.warn(
            `[bsk record] post-action observation failed for step ${draftIndex + 1}`,
            error,
          );
          // The draft keeps no result; a later observation must be able to
          // adopt it, otherwise it stays "result equals state" forever.
          this.#noteSuperseded(drafts, draftIndex + 1);
        }
      } finally {
        // A failed or aborted read must not stay advertised as shareable, or the
        // next action would wait the full bound for an observation that will
        // never arrive.
        if (this.#inFlight?.draftIndex === draftIndex) this.#inFlight = null;
        if (this.#pending.get(draftIndex) === pending) this.#pending.delete(draftIndex);
      }
    };
    this.#queue = this.#queue.then(task, task).catch(() => {});
  }

  cancel(): void {
    for (const pending of this.#pending.values()) pending.abort.abort();
    this.#pending.clear();
    this.#superseded.clear();
    this.#inFlight = null;
    this.clearRedirect();
  }

  async flush(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const current = this.#queue;
      await current;
      if (current === this.#queue) return;
    }
    console.warn("[bsk record] settle queue kept growing; using completed observations");
  }

  /**
   * Final backfill at stop. Every draft still missing a post-state is filled
   * from one last observation reached after those drafts arrived; the legacy
   * "copy the next draft's pre-state" path (`inferMissingPostStates`) stays only
   * as the last resort when nothing was ever observed, because the reducer drops
   * a step whose pre- and post-states are both missing (`trace-reducer-v3.ts`),
   * turning misalignment into a lost step.
   */
  async settleTrailing(drafts: RecordingDraftStep[]): Promise<void> {
    const trailing: RecordingDraftStep[] = [];
    const indexes: number[] = [];
    // The whole list is scanned, not just a suffix: a superseded draft in the
    // middle stays unbound while a later draft already has a result, and a
    // suffix-only scan would stop at it and never backfill.
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (!draft || draft.postStateId) continue;
      trailing.push(draft);
      indexes.push(index);
    }
    if (trailing.length === 0) {
      this.#fallbackMissingPostStates(drafts);
      return;
    }
    try {
      const observation = await this.#captureWithRetry();
      const sampledAt = observation.capturedAt ?? observation.settledAt ?? Date.now();
      const backfilled: number[] = [];
      trailing.forEach((draft, position) => {
        const arrivedAt = draft.arrivedAt;
        if (arrivedAt !== undefined && arrivedAt > sampledAt) return;
        draft.postStateId = observation.stateId;
        draft.postStateBackfilled = true;
        delete draft.postStateFallback;
        delete draft.postStatePending;
        const index = indexes[position]!;
        this.#superseded.delete(index);
        this.#session.registry.markStep(observation.stateId, index + 1);
        backfilled.push(index + 1);
      });
      if (backfilled.length > 0 && import.meta.env.DEV) {
        console.debug("[bsk record] final observation backfilled pending post-states", {
          stepIds: backfilled,
          stateId: observation.stateId,
          sampledAt,
          settledAt: observation.settledAt,
        });
      }
    } catch (error) {
      console.warn("[bsk record] final observation at stop failed", error);
    }
    this.#fallbackMissingPostStates(drafts);
  }

  /**
   * Last resort: reuse an adjacent known state so no step loses both its
   * pre-state and its post-state. This keeps `trace-reducer-v3` from dropping
   * the step entirely.
   *
   * R2-12: silently reusing a neighbour made the post side *less* honest than
   * the pre side, which has carried an explicit marker since R1-5. Every draft
   * filled here is therefore flagged `postStateFallback`, which
   * `trace-builder-v3` mirrors into the landing state's
   * `post_state_fallback_steps` front-matter line (kept apart from
   * `state_backfilled_steps`, because "never observed" is not the same defect
   * as "covered by a coarser observation"). The landing still comes from an
   * adjacent draft, so it is an inference, not an observation.
   */
  #fallbackMissingPostStates(drafts: RecordingDraftStep[]): void {
    const fabricated: number[] = [];
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      if (!draft || draft.postStateId) continue;
      const next = drafts[index + 1];
      const landing = drafts[index - 1]?.postStateId ?? next?.preStateId ?? next?.postStateId;
      if (!landing) continue;
      draft.postStateId = landing;
      draft.postStateFallback = true;
      delete draft.postStatePending;
      fabricated.push(index + 1);
    }
    if (fabricated.length > 0 && import.meta.env.DEV) {
      console.debug("[bsk record] no observation available; post-state reused an adjacent state", {
        stepIds: fabricated,
      });
    }
    inferMissingPostStates(drafts);
  }

  clearRedirect(): void {
    this.#pendingRedirect?.abort.abort();
    this.#pendingRedirect = null;
  }

  scheduleRedirect(drafts: RecordingDraftStep[], url: string): void {
    this.#pendingRedirect?.abort.abort();
    const pending: PendingRedirect = { url, abort: new AbortController() };
    this.#pendingRedirect = pending;
    const task = () => this.#settleRedirect(drafts, pending);
    this.#redirectQueue = this.#redirectQueue.then(task, task).catch(() => {});
  }

  async #settleRedirect(drafts: RecordingDraftStep[], pending: PendingRedirect): Promise<void> {
    const outcome = await waitForDocumentSettled(this.#cdp, this.#rootScope, {
      signal: pending.abort.signal,
    });
    if (outcome === "cancelled" || this.#pendingRedirect !== pending) return;

    let finalUrl = pending.url;
    try {
      finalUrl = (await this.#tabsApi.get(this.#tabId)).url || finalUrl;
    } catch {
      // The navigation event URL remains the best available destination.
    }
    if (this.#pendingRedirect !== pending) return;
    this.#pendingRedirect = null;
    if (
      !finalUrl ||
      finalUrl === "about:blank" ||
      this.#session.cursor.lastSettled?.url === finalUrl
    ) {
      return;
    }

    const last = drafts[drafts.length - 1];
    if (last?.op === "navigate" && last.url === finalUrl) {
      if (!last.postStateId) this.schedule(drafts, drafts.length - 1);
      await this.flush();
      return;
    }

    const draft: RecordingDraftStep = {
      op: "navigate",
      url: finalUrl,
      pageUrl: finalUrl,
      cause: "browser",
      transitionQualifiers: ["server_redirect"],
      preStateId: this.#session.cursor.lastSettled?.stateId,
    };
    drafts.push(draft);
    const draftIndex = drafts.length - 1;
    if (draft.preStateId) this.#session.registry.markStep(draft.preStateId, draftIndex + 1);
    this.schedule(drafts, draftIndex);
    await this.flush();
  }

  async flushRedirects(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const current = this.#redirectQueue;
      await current;
      if (current === this.#redirectQueue) return;
    }
    console.warn("[bsk record] redirect queue kept growing; using the final completed landing");
  }
}
