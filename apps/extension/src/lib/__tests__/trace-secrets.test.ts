import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TraceV3 } from "@/transport/types";
import { RecordingStateRegistry } from "../recording/state-registry";
import { buildTraceV3 } from "../recording/trace-builder-v3";
import { collectTraceSecrets, MIN_SCRUB_LEN, scrubTraceSecrets } from "../recording/trace-secrets";
import type { RecordingDraftStep } from "../recording/types";

const SECRET = "ALPHA-secret-123";

function buildTrace(input: {
  drafts: RecordingDraftStep[];
  url: string;
  title?: string;
  vomText: string;
  redactValues?: boolean;
  startUrl?: string;
}): TraceV3 {
  const registry = new RecordingStateRegistry();
  const state = registry.register({
    url: input.url,
    title: input.title,
    vomText: input.vomText,
  });
  return buildTraceV3({
    registry,
    drafts: input.drafts.map((draft) => ({
      ...draft,
      preStateId: state.id,
      postStateId: state.id,
    })) as RecordingDraftStep[],
    startedAt: "2026-09-17T00:00:00.000Z",
    startUrl: input.startUrl,
    stoppedBy: "user_finish",
    bskVersion: "test",
    redactValues: input.redactValues,
  });
}

type FillDraft = Extract<RecordingDraftStep, { op: "fill" }>;

function fillDraft(value: string, extra: Partial<FillDraft> = {}): FillDraft {
  return { op: "fill", value, ...extra };
}

describe("collectTraceSecrets", () => {
  it("takes every fill value under redactValues and only marked values otherwise", () => {
    const drafts: RecordingDraftStep[] = [
      fillDraft("plain-value"),
      fillDraft("marked-value", { redacted: true }),
      { op: "click" } as RecordingDraftStep,
    ];
    expect(collectTraceSecrets(drafts, true)).toEqual(["plain-value", "marked-value"]);
    expect(collectTraceSecrets(drafts, false)).toEqual(["marked-value"]);
  });

  it("ignores select, navigate and click drafts", () => {
    // `two` reaches the r3-redact1 trace through the `select` step
    // (`b-run.mjs` select1), not through a fill, so it is not a secret at all.
    const drafts: RecordingDraftStep[] = [
      { op: "select", values: ["two"], labels: ["Two"] } as RecordingDraftStep,
      { op: "navigate", url: "https://example.com/?q=two" } as RecordingDraftStep,
      { op: "click" } as RecordingDraftStep,
      fillDraft("kept-value"),
    ];
    expect(collectTraceSecrets(drafts, true)).toEqual(["kept-value"]);
  });

  it("drops values shorter than the threshold and empty values", () => {
    // R2-1: three-character words (`one`, `two`) are ordinary prose, so they must
    // never enter the scrub set; four characters is the first length kept.
    const drafts: RecordingDraftStep[] = [
      fillDraft(""),
      fillDraft("a"),
      fillDraft("hi"),
      fillDraft("two"),
      fillDraft("four"),
    ];
    expect(MIN_SCRUB_LEN).toBe(4);
    expect(collectTraceSecrets(drafts, true)).toEqual(["four"]);
  });
});

describe("scrubTraceSecrets", () => {
  it("returns the same object when there is nothing to scrub", () => {
    const trace = {
      version: 3,
      recorded_at: "x",
      stopped_by: "user_finish",
      entry: { start_url: "https://example.com/?text=ALPHA-secret-123" },
      recorder: { bsk: "test", vom: 1 },
      states: [{ id: "s1", url: "https://example.com/", body: "ALPHA-secret-123" }],
      steps: [],
    } as unknown as TraceV3;
    expect(scrubTraceSecrets(trace, [])).toBe(trace);
  });

  it("does not mutate the trace it was given", () => {
    const trace = {
      version: 3,
      recorded_at: "x",
      stopped_by: "user_finish",
      entry: { start_url: `https://example.com/?text=${SECRET}` },
      recorder: { bsk: "test", vom: 1 },
      states: [{ id: "s1", url: "https://example.com/", body: `Received! ${SECRET}` }],
      steps: [
        {
          op: "navigate",
          id: 1,
          state: "s1",
          result: { state: "s1" },
          to: `https://x/?q=${SECRET}`,
        },
      ],
    } as unknown as TraceV3;
    const scrubbed = scrubTraceSecrets(trace, [SECRET]);
    expect(scrubbed).not.toBe(trace);
    expect(trace.entry.start_url).toContain(SECRET);
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
  });
});

describe("buildTraceV3 secret scrubbing", () => {
  it("scrubs a secret echoed into a URL query string, every encoding shape", () => {
    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft(SECRET)],
      url: `https://example.com/result?text=${SECRET}&encoded=${encodeURIComponent(SECRET)}`,
      title: `Result for ${SECRET}`,
      vomText: [
        "@vom 1",
        `RootWebArea name="Result for ${SECRET}"`,
        `  paragraph StaticText name="Received! ${SECRET}"`,
        `  paragraph StaticText name="Form%20value%20${SECRET}"`,
        '  paragraph StaticText name="Received! ALPHA-secret-123"',
      ].join("\n"),
      startUrl: `https://example.com/?q=${SECRET}`,
    });

    const dumped = JSON.stringify(trace);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain(encodeURIComponent(SECRET));
    expect(trace.states[0]!.url).toContain("text=***");
    expect(trace.states[0]!.url).toContain("encoded=***");
    expect(trace.states[0]!.title).toBe("Result for ***");
    expect(trace.states[0]!.body).toContain('StaticText name="Received! ***"');
    expect(trace.entry.start_url).toBe("https://example.com/?q=***");
    expect(dumped).toContain("***");
    // The masked fill step is untouched and still marked redacted.
    expect(trace.steps[0]).toMatchObject({ op: "fill", value: "***", redacted: true });
  });

  it("keeps the body line structure intact while scrubbing", () => {
    const body = [
      "# bsk-observation 1",
      'state: "s1"',
      `url: "https://example.com/result?text=${SECRET}"`,
      "steps_here: [1]",
      "---",
      "@vom 1",
      `RootWebArea name="${SECRET}"`,
      "  button Save",
    ].join("\n");
    const trace = {
      version: 3,
      recorded_at: "x",
      stopped_by: "user_finish",
      entry: { start_url: `https://example.com/?q=${SECRET}` },
      recorder: { bsk: "test", vom: 1 },
      states: [{ id: "s1", url: `https://example.com/result?text=${SECRET}`, body }],
      steps: [],
    } as unknown as TraceV3;

    const scrubbed = scrubTraceSecrets(trace, [SECRET]);
    const lines = scrubbed.states[0]!.body.split("\n");
    expect(lines.length).toBe(body.split("\n").length);
    expect(lines[3]).toBe("steps_here: [1]");
    expect(lines[4]).toBe("---");
    expect(lines[5]).toBe("@vom 1");
    expect(lines[7]).toBe("  button Save");
    expect(lines.every((line) => !line.includes(SECRET))).toBe(true);
  });

  it("scrubs fill values that travel through step targets and navigation", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: "https://example.com/",
      vomText: "@vom 1\nRootWebArea",
    });
    const trace = buildTraceV3({
      registry,
      drafts: [
        {
          op: "fill",
          value: SECRET,
          redacted: true,
          captureTarget: { tag: "input", role: "textbox", name: `Search ${SECRET}` },
          preStateId: state.id,
          postStateId: state.id,
        } as RecordingDraftStep,
      ],
      startedAt: "2026-09-17T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.steps[0]).toMatchObject({
      op: "fill",
      value: "***",
      target: { name: "Search ***" },
    });
  });

  it("is a no-op without --redact-values and without any marked value", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: `https://example.com/result?text=${"plain-text-value"}`,
      title: "plain-text-value",
      vomText: '@vom 1\nRootWebArea name="plain-text-value"',
    });
    const drafts: RecordingDraftStep[] = [
      { op: "fill", value: "plain-text-value", preStateId: state.id, postStateId: state.id },
    ];
    const trace = buildTraceV3({
      registry,
      drafts,
      startedAt: "2026-09-17T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.states[0]!.url).toContain("plain-text-value");
    expect(trace.states[0]!.title).toBe("plain-text-value");
    expect(trace.states[0]!.body).toContain("plain-text-value");
    expect(trace.steps[0]).toMatchObject({ op: "fill", value: "plain-text-value" });
    expect(trace.steps[0]).not.toHaveProperty("redacted");
  });

  it("scrubs the r3-redact1 golden trace down to zero plaintext hits", () => {
    // D3 evidence: `--redact-values` masked every fill step, yet the replayed
    // secret survived in `states[3].url` and in `states/s3.txt`.
    const fixtureDir = path.resolve(
      process.cwd(),
      "../../recordings/eval-20260917/B-runs/r3-redact1",
    );
    const trace = JSON.parse(readFileSync(path.join(fixtureDir, "trace.json"), "utf8")) as TraceV3;
    const body = readFileSync(path.join(fixtureDir, "states/s3.txt"), "utf8");
    const target = trace.states.find((state) => state.id === "s3")!;
    target.body = body;

    // R2-3: the secret set comes from the same `collectTraceSecrets` the
    // production builder uses, not from a hand-picked list. The run's real
    // fills are the three long values plus the 3-character `two`; the latter
    // must not be collected, otherwise the prose line would be shredded.
    const drafts: RecordingDraftStep[] = [
      fillDraft("ALPHA-secret-123"),
      fillDraft("NOTES-secret-456"),
      fillDraft("PICKER-secret-789"),
      fillDraft("two"),
    ];
    const secrets = collectTraceSecrets(drafts, true);
    expect(secrets).toEqual(["ALPHA-secret-123", "NOTES-secret-456", "PICKER-secret-789"]);

    const scrubbed = scrubTraceSecrets(trace, secrets);
    const scrubbedBody = scrubbed.states.find((state) => state.id === "s3")!.body;

    for (const secret of secrets) {
      expect(JSON.stringify(scrubbed)).not.toContain(secret);
      expect(scrubbedBody).not.toContain(secret);
    }
    expect(scrubbedBody.split("\n").length).toBe(body.split("\n").length);
    // The three long fills are gone; `two` was never a secret, so it survives.
    expect(scrubbedBody).toContain('paragraph "*** | *** | two"');
    // The step ids/`steps_here` line the golden fixture relies on stay put.
    expect(scrubbedBody).toContain("steps_here: [7]");
  });

  it("still scrubs without --redact-values when the draft is marked redacted", () => {
    const trace = buildTrace({
      redactValues: false,
      drafts: [fillDraft(SECRET, { redacted: true })],
      url: `https://example.com/result?text=${SECRET}`,
      vomText: `@vom 1\nRootWebArea name="${SECRET}"`,
    });

    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(trace.states[0]!.url).toBe("https://example.com/result?text=***");
  });

  it("leaves short values alone rather than shredding the body", () => {
    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft("a"), fillDraft("of")],
      url: "https://example.com/result?text=a",
      title: "a lot of noise",
      vomText: ["@vom 1", 'RootWebArea name="a lot of noise"'].join("\n"),
    });

    expect(trace.states[0]!.url).toBe("https://example.com/result?text=a");
    expect(trace.states[0]!.title).toBe("a lot of noise");
    expect(trace.states[0]!.body).toContain('RootWebArea name="a lot of noise"');
  });

  it("does not rewrite prose that merely contains a 3-character fill value (R2-1)", () => {
    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft("one"), fillDraft(SECRET)],
      url: `https://example.com/result?text=${SECRET}`,
      title: "Money in your phone",
      vomText: ["@vom 1", 'RootWebArea name="Money in your phone"'].join("\n"),
    });

    // `one` is dropped by the threshold, so the surrounding words survive…
    expect(trace.states[0]!.title).toBe("Money in your phone");
    expect(trace.states[0]!.body).toContain('RootWebArea name="Money in your phone"');
    // …while the long value in the same run is still scrubbed.
    expect(trace.states[0]!.url).toBe("https://example.com/result?text=***");
    expect(JSON.stringify(trace)).not.toContain(SECRET);
  });

  it("keeps `two` in the body while a long fill value is still scrubbed (R2-1/R2-3)", () => {
    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft(SECRET), fillDraft("two")],
      url: `https://example.com/result?text=${SECRET}&choice=two`,
      title: `Received! ${SECRET}`,
      vomText: [
        "@vom 1",
        `RootWebArea "Received! ${SECRET} | two"`,
        `  paragraph "${SECRET} | two"`,
      ].join("\n"),
    });

    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(trace.states[0]!.url).toBe("https://example.com/result?text=***&choice=two");
    expect(trace.states[0]!.title).toBe("Received! ***");
    expect(trace.states[0]!.body).toContain('paragraph "*** | two"');
  });

  it("only replaces a secret as a whole token, not as a fragment (R2-1 boundaries)", () => {
    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft(SECRET)],
      url: "https://example.com/result",
      title: `x${SECRET}x`,
      vomText: ["@vom 1", `RootWebArea name="x${SECRET}x"`].join("\n"),
    });

    expect(trace.states[0]!.title).toBe(`x${SECRET}x`);
    expect(trace.states[0]!.body).toContain(`x${SECRET}x`);
  });

  it("scrubs the bare and percent-encoded forms sitting in one URL (R2-1 query values)", () => {
    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft(SECRET)],
      url: `https://example.com/result?text=${SECRET}&encoded=${encodeURIComponent(SECRET)}`,
      vomText: "@vom 1\nRootWebArea",
    });

    expect(trace.states[0]!.url).toBe("https://example.com/result?text=***&encoded=***");
  });

  it("scrubs the URLSearchParams form and its lower-percent shape (R2-2)", () => {
    // `URLSearchParams` escapes `!`, which `encodeURIComponent` does not:
    // `"hello!world/ok"` -> `hello%21world%2Fok`. The lowercase `%2f` spelling
    // of the same escape must be covered too.
    const secret = "hello!world/ok";
    const form = new URLSearchParams({ v: secret }).toString().slice(2);
    expect(form).toBe("hello%21world%2Fok");
    const lowerPercent = form.replace(/%[0-9A-Fa-f]{2}/g, (match) => match.toLowerCase());
    expect(lowerPercent).toBe("hello%21world%2fok");

    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft(secret)],
      url: `https://example.com/result?q=${form}&lower=${lowerPercent}`,
      vomText: "@vom 1\nRootWebArea",
    });

    expect(trace.states[0]!.url).toBe("https://example.com/result?q=***&lower=***");
    expect(JSON.stringify(trace)).not.toContain(form);
    expect(JSON.stringify(trace)).not.toContain(lowerPercent);
  });

  it("keeps untouched states and steps by identity instead of deep-copying (R2-18)", () => {
    const trace = {
      version: 3,
      recorded_at: "x",
      stopped_by: "user_finish",
      entry: { start_url: "https://example.com/" },
      recorder: { bsk: "test", vom: 1 },
      states: [
        { id: "s1", url: `https://example.com/?q=${SECRET}`, body: SECRET },
        { id: "s2", url: "https://example.com/clean", body: "nothing here" },
      ],
      steps: [
        { op: "click", id: 1, state: "s2", result: { state: "s2" }, target: { tag: "button" } },
      ],
    } as unknown as TraceV3;

    const scrubbed = scrubTraceSecrets(trace, [SECRET]);
    expect(scrubbed.states[1]).toBe(trace.states[1]);
    expect(scrubbed.steps[0]).toBe(trace.steps[0]);
    expect(scrubbed.states[0]).not.toBe(trace.states[0]);
    expect(scrubbed.states[0]!.url).toBe("https://example.com/?q=***");
    expect(scrubbed.states[0]!.body).toBe("***");
    // A secret set that matches nothing returns the very same trace object.
    expect(scrubTraceSecrets(trace, ["absent-secret"])).toBe(trace);
  });

  it("masks the longest variant first so no prefix of a secret survives", () => {
    const trace = buildTrace({
      redactValues: true,
      drafts: [fillDraft("abcd"), fillDraft("abcdefgh")],
      url: "https://example.com/result?text=abcdefgh",
      vomText: "@vom 1\nRootWebArea",
    });

    expect(trace.states[0]!.url).toBe("https://example.com/result?text=***");
    expect(JSON.stringify(trace)).not.toContain("abcd");
  });

  it("scrubs the JSON-escaped form written into the body front matter", () => {
    const secret = 'pa"ss\\word';
    const registry = new RecordingStateRegistry();
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    const state = registry.register({
      url: `https://example.com/?q=${jsonEscaped}`,
      vomText: "@vom 1\nRootWebArea",
    });
    const trace = buildTraceV3({
      registry,
      drafts: [
        { op: "fill", value: secret, redacted: true, preStateId: state.id, postStateId: state.id },
      ],
      startedAt: "2026-09-17T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(JSON.stringify(trace)).not.toContain(jsonEscaped);
    expect(trace.states[0]!.url).toBe("https://example.com/?q=***");
  });

  it("scrubs the space-as-plus form", () => {
    const secret = "two words here";
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: "https://example.com/?q=two+words+here",
      vomText: "@vom 1\nRootWebArea",
    });
    const trace = buildTraceV3({
      registry,
      drafts: [
        { op: "fill", value: secret, redacted: true, preStateId: state.id, postStateId: state.id },
      ],
      startedAt: "2026-09-17T00:00:00.000Z",
      stoppedBy: "user_finish",
      bskVersion: "test",
    });

    expect(trace.states[0]!.url).toBe("https://example.com/?q=***");
  });
});
