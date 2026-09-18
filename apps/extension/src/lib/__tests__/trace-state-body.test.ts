import { describe, expect, it } from "vitest";
import { formatTraceStateBody, parseTraceStateFrontMatter } from "../recording/trace-state-body";

describe("trace state body front matter", () => {
  it("parses every *_steps line as a numeric array, not a raw string", () => {
    // R1-10: `state_unbound_steps` is written exactly like `steps_here`, so a
    // consumer must get `[2]` (and a usable `.length`) for both.
    const body = formatTraceStateBody({
      stateId: "s1",
      url: "https://example.com/",
      stepIds: [1, 3],
      unboundStepIds: [2],
      vomText: "@vom 1\nRootWebArea",
      annotations: [],
      stepIdByDraftId: new Map(),
    });

    const frontMatter = parseTraceStateFrontMatter(body);
    expect(frontMatter.steps_here).toEqual([1, 3]);
    expect(frontMatter.state_unbound_steps).toEqual([2]);
    expect(frontMatter.state).toBe("s1");
    expect(frontMatter.url).toBe("https://example.com/");
    // Absent keys stay absent rather than becoming `[]`, so a consumer can tell
    // "this state has no backfilled steps" from "this body predates the key".
    expect(frontMatter.state_backfilled_steps).toBeUndefined();
    expect(frontMatter.post_state_fallback_steps).toBeUndefined();
  });

  it("writes backfilled and fabricated post-state steps as their own lines (R2-8 / R2-12)", () => {
    // R2-8: `steps_here` mixes normal binds with backfills, so a replay cannot
    // tell "the action's own settle landed here" from "a later, coarser
    // observation was backfilled onto it". R2-12: a fabricated landing (no
    // observation at all) is a third category again. Each gets a durable line,
    // and both are parsed as numeric lists by the same `*_steps` rule.
    const body = formatTraceStateBody({
      stateId: "s3",
      url: "https://example.com/next",
      stepIds: [1, 2, 3],
      unboundStepIds: [4],
      backfilledStepIds: [1, 2],
      fallbackStepIds: [3],
      vomText: "@vom 1\nRootWebArea",
      annotations: [],
      stepIdByDraftId: new Map(),
    });

    expect(body).toContain("state_backfilled_steps: [1, 2]");
    expect(body).toContain("post_state_fallback_steps: [3]");
    const frontMatter = parseTraceStateFrontMatter(body);
    expect(frontMatter.steps_here).toEqual([1, 2, 3]);
    expect(frontMatter.state_unbound_steps).toEqual([4]);
    expect(frontMatter.state_backfilled_steps).toEqual([1, 2]);
    expect(frontMatter.post_state_fallback_steps).toEqual([3]);
  });

  it("omits both post-state provenance lines when every result was observed", () => {
    const body = formatTraceStateBody({
      stateId: "s1",
      url: "https://example.com/",
      stepIds: [1],
      vomText: "@vom 1\nRootWebArea",
      annotations: [],
      stepIdByDraftId: new Map(),
    });

    expect(body).not.toContain("state_backfilled_steps");
    expect(body).not.toContain("post_state_fallback_steps");
  });

  it("writes the injected build stamp on the last front-matter line and reads it back", () => {
    // The build stamp is the only way to tell two same-version bundles apart
    // after export, so it must be written on every body and survive parsing.
    const body = formatTraceStateBody({
      stateId: "s1",
      url: "https://example.com/",
      stepIds: [1],
      unboundStepIds: [2],
      vomText: "@vom 1\nRootWebArea",
      annotations: [],
      stepIdByDraftId: new Map(),
    });

    expect(body).toContain("extension_build: test");
    expect(parseTraceStateFrontMatter(body).extension_build).toBe("test");
  });

  it("keeps extension_build inside the front matter, after steps_here", () => {
    const body = formatTraceStateBody({
      stateId: "s1",
      url: "https://example.com/",
      stepIds: [1, 3],
      vomText: "@vom 1\nRootWebArea",
      annotations: [],
      stepIdByDraftId: new Map(),
    });
    const lines = body.split("\n");
    const terminator = lines.indexOf("---");

    expect(terminator).toBeGreaterThan(0);
    expect(lines.indexOf("extension_build: test")).toBe(terminator - 1);
    expect(lines.indexOf("steps_here: [1, 3]")).toBeLessThan(terminator);
    // The body itself must not gain a stray copy of the marker.
    expect(body.endsWith("RootWebArea\n")).toBe(true);
  });

  it("parses a production-shaped stamp as a string, not as a step list", () => {
    // The real stamp is `<sha>[-dirty].<yyyyMMdd-HHmm>`, so it is full of digits.
    // A consumer must read it back verbatim; treating it as a `*_steps` list would
    // collapse it to `[2974, 20260917, 1547]` (or similar) and destroy the id.
    const stamp = "2974ac2-dirty.20260917-1547";
    const body = [
      "# bsk-observation 1",
      'state: "s1"',
      "steps_here: [1]",
      `extension_build: ${stamp}`,
      "---",
      "@vom 1",
      "RootWebArea",
      "",
    ].join("\n");
    const frontMatter = parseTraceStateFrontMatter(body);

    expect(frontMatter.extension_build).toBe(stamp);
    expect(frontMatter.steps_here).toEqual([1]);
    // `nogit` (git unavailable) must stay printable too.
    expect(parseTraceStateFrontMatter(body.replace(stamp, "nogit")).extension_build).toBe("nogit");
  });

  it("returns no array for a state that was never written by the formatter", () => {
    expect(parseTraceStateFrontMatter("@vom 1\nRootWebArea")).toEqual({});
  });

  it("keeps quoted values unquoted and stops at the front matter terminator", () => {
    const frontMatter = parseTraceStateFrontMatter(
      ["# bsk-observation 1", 'state: "s4"', 'title: "a, b"', "---", "steps_here: [9]"].join("\n"),
    );

    expect(frontMatter).toEqual({ state: "s4", title: "a, b" });
  });
});
