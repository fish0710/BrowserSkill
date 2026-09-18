import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordStepPayload } from "@/lib/record-bridge";
import { startRecordCapture } from "../record-capture";

vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: vi.fn((message: { sequence?: number }) =>
      Promise.resolve({ ok: true, sequence: message.sequence }),
    ),
  },
});

// R1-6: `collectHoverSurfaceStates()` is a full `document.querySelectorAll("*")`
// walk, so counting its invocations is the direct evidence that the action path
// only scans when it truly has to.
const hoverSurfaceScanCounter = vi.hoisted(() => ({
  count: 0,
  // Lets a test model a scan that is itself slow (R2-7): the hook runs where
  // the real `document.querySelectorAll("*")` walk would spend its time.
  onScan: undefined as (() => void) | undefined,
}));
vi.mock("../record-hover-surface", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../record-hover-surface")>();
  return {
    ...actual,
    collectHoverSurfaceStates: () => {
      hoverSurfaceScanCounter.count += 1;
      hoverSurfaceScanCounter.onScan?.();
      return actual.collectHoverSurfaceStates();
    },
  };
});

function mockRect(
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: rect.left,
    y: rect.top,
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  });
}

function mockHoverStyle(pointerElements: Element[], positionedElements: Element[] = []): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const style = {
      cursor: pointerElements.includes(el) ? "pointer" : "",
      display: "block",
      pointerEvents: "auto",
      position: positionedElements.includes(el) ? "absolute" : "static",
      visibility: "visible",
    } as CSSStyleDeclaration;
    return style;
  });
}

function mouseOver(el: Element): void {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
}

describe("record-capture semantic", () => {
  let steps: RecordStepPayload[];

  beforeEach(() => {
    steps = [];
    hoverSurfaceScanCounter.count = 0;
    hoverSurfaceScanCounter.onScan = undefined;
    document.body.innerHTML = `
      <label for="q">查询</label>
      <input id="q" name="q" />
      <button type="button" aria-label="搜索">搜索</button>
      <div role="listbox" id="sug">
        <div role="option">建议项</div>
      </div>
    `;
  });

  it("commits final fill value and records semantic click", () => {
    const capture = startRecordCapture("rec-1", (step) => steps.push(step));
    const input = document.querySelector("input")!;
    const button = document.querySelector("button")!;

    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));

    capture.dispose();

    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "fill",
          value: "hello",
          target: expect.objectContaining({ name: "查询", tag: "input" }),
        }),
        expect.objectContaining({
          op: "click",
          target: expect.objectContaining({ name: "搜索", role: "button" }),
        }),
      ]),
    );
    expect(JSON.stringify(steps)).not.toMatch(/@e\d+/);
    expect(steps.some((s) => "selector" in s)).toBe(false);
  });

  it("ignores autocomplete suggestion clicks while a fill session is open", () => {
    const capture = startRecordCapture("rec-2", (step) => steps.push(step));
    const input = document.querySelector("input")!;
    const option = document.querySelector('[role="option"]')!;

    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "hel";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    option.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    capture.dispose();

    expect(steps.filter((s) => s.op === "click")).toHaveLength(0);
    expect(steps.some((s) => s.op === "fill" && s.value === "hello")).toBe(true);
  });

  it("records the click that opens an ARIA picker", () => {
    document.body.innerHTML = `
      <label id="story-label">* Story</label>
      <div role="combobox" aria-haspopup="listbox" aria-expanded="false">
        <input id="story" aria-labelledby="story-label" placeholder="Type to search" />
      </div>
    `;
    const capture = startRecordCapture("rec-picker", (step) => steps.push(step));
    const input = document.querySelector("#story")!;

    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.filter((s) => s.op === "click")).toEqual([
      expect.objectContaining({
        op: "click",
        target: expect.objectContaining({ name: "* Story", role: "combobox" }),
        expects_navigation: false,
      }),
    ]);
  });

  it("does not attribute a later navigation to the picker click", () => {
    document.body.innerHTML = `
      <label id="story-label">* Story</label>
      <div role="combobox" aria-haspopup="listbox">
        <input id="story" aria-labelledby="story-label" />
      </div>
      <button type="button">Submit</button>
    `;
    const capture = startRecordCapture("rec-picker-nav", (step) => steps.push(step));
    const input = document.querySelector("#story")!;
    const button = document.querySelector("button")!;

    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    const clicks = steps.filter((s) => s.op === "click");
    expect(clicks.map((s) => s.expects_navigation)).toEqual([false, true]);
  });

  it("keeps a plain text field click out of the trace", () => {
    document.body.innerHTML = `
      <label for="title">Title</label>
      <input id="title" name="title" />
    `;
    const capture = startRecordCapture("rec-plain-fill", (step) => steps.push(step));
    const input = document.querySelector<HTMLInputElement>("#title")!;

    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "sample text";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    capture.dispose();

    expect(steps.filter((s) => s.op === "click")).toHaveLength(0);
    expect(steps.filter((s) => s.op === "fill")).toHaveLength(1);
  });

  it("records a click on a read-only picker input", () => {
    document.body.innerHTML = `
      <label for="owner">Owner</label>
      <input id="owner" name="owner" readonly />
    `;
    const capture = startRecordCapture("rec-readonly-picker", (step) => steps.push(step));
    const input = document.querySelector("#owner")!;

    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    capture.dispose();

    expect(steps.filter((s) => s.op === "click")).toHaveLength(1);
  });

  it("ignores a click on a disabled picker input", () => {
    document.body.innerHTML = `
      <label id="state-label">State</label>
      <div role="combobox" aria-haspopup="listbox">
        <input id="state" aria-labelledby="state-label" disabled />
      </div>
    `;
    const capture = startRecordCapture("rec-disabled-picker", (step) => steps.push(step));
    const input = document.querySelector("#state")!;

    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps).toEqual([]);
  });

  it("does not treat a distant picker wrapper as the clicked control", () => {
    document.body.innerHTML = `
      <div role="combobox" aria-haspopup="listbox">
        <div><div><div><div><div>
          <label for="note">Note</label>
          <input id="note" name="note" />
        </div></div></div></div></div>
      </div>
    `;
    const capture = startRecordCapture("rec-far-picker", (step) => steps.push(step));
    const input = document.querySelector("#note")!;

    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.filter((s) => s.op === "click")).toHaveLength(0);
  });

  it("records Enter press but not bare typing keys", () => {
    const capture = startRecordCapture("rec-press", (step) => steps.push(step));
    const input = document.querySelector("input")!;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    capture.dispose();
    expect(steps.filter((s) => s.op === "press")).toEqual([
      expect.objectContaining({ op: "press", key: "Enter" }),
    ]);
  });

  it("does not emit page navigation from a child Document capture", () => {
    const originalUrl = location.href;
    const capture = startRecordCapture("rec-child", (step) => steps.push(step), {
      captureNavigation: false,
    });

    history.pushState({}, "", "#inside-frame");
    expect(steps).toEqual([]);

    capture.dispose();
    history.replaceState({}, "", originalUrl);
  });

  it("does not record clicks on anonymous layout divs", () => {
    document.body.innerHTML = `
      <div id="chrome">page chrome</div>
      <button type="button" aria-label="下一步">下一步</button>
    `;
    const capture = startRecordCapture("rec-3", (step) => steps.push(step));
    document
      .querySelector("#chrome")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    document
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      op: "click",
      target: { name: "下一步", role: "button" },
    });
  });

  it("records a hover trigger before clicking its revealed menu item", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-menu", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
      geometry: { tag: "button", rect: { x: 900, y: 8, w: 32, h: 32 } },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "link", name: "My profile" },
    });
  });

  it("records hover for compact topbar image buttons before menu item clicks", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="image" style="position: absolute; top: 8px; left: 900px; width: 32px; height: 32px;">
        <img alt="image" />
      </button>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-topbar", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "image" },
    });
  });

  it("records hover when the revealed menu item is inside the hover root", () => {
    document.body.innerHTML = `
      <div class="user dropdown" role="button" aria-label="image">
        <img alt="image" />
        <ul>
          <li><a href="/u/me">My profile</a></li>
        </ul>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-contained-menu", (step) => steps.push(step));
    const trigger = document.querySelector('[role="button"]')!;
    const menu = document.querySelector("ul")!;
    const item = document.querySelector("a")!;
    mockRect(trigger, { left: 900, top: 8, width: 32, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "image" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "link", name: "My profile" },
    });
  });

  it("does not let a revealed topbar menu link replace the pending hover trigger", () => {
    document.body.innerHTML = `
      <a href="/u/me" aria-label="image" style="position: absolute; top: 8px; left: 900px; width: 32px; height: 32px;">
        <img alt="image" />
      </a>
      <ul class="user-menu dropdown-menu">
        <li><a class="dropdown-item profile-link" href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-topbar-link", (step) => steps.push(step));
    const trigger = document.querySelector('a[aria-label="image"]')!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("ul a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 72,
      top: 72,
      left: 820,
      right: 916,
      bottom: 104,
      width: 96,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: el === item ? "pointer" : "",
        pointerEvents: "auto",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "link", name: "image" },
    });
  });

  it("keeps the first hover trigger over a later lower-score accepted hover", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu" aria-haspopup="menu" aria-expanded="false">
        <img alt="image" />
      </button>
      <a class="account-menu" role="button" href="/u/me">My profile</a>
    `;
    const capture = startRecordCapture("rec-hover-latch", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const laterHover = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(laterHover, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 72,
      top: 72,
      left: 820,
      right: 916,
      bottom: 104,
      width: 96,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: el === laterHover ? "pointer" : "",
        pointerEvents: "auto",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    laterHover.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    laterHover.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "button", name: "My profile" },
    });
  });

  it("keeps the menu opener hover when moving over an accepted menu item", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <ul class="create-menu dropdown-menu">
        <li class="dropdown-item" tabindex="0">文档C+D</li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-menu-opener", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector("li")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([item]);

    mouseOver(trigger);
    mouseOver(item);
    click(item);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "li", name: "文档C+D" },
    });
  });

  it("does not latch a plain div action item inside a hover surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <div class="create-menu dropdown-menu">
        <div class="tg-menu-item" tabindex="0">文档C+D</div>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-menu-div-action", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector(".tg-menu-item")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([item]);

    mouseOver(trigger);
    mouseOver(item);
    click(item);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "文档C+D" },
    });
  });

  it("keeps the opener hover when a surface action is clicked after the short latch window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T03:43:36.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
        <div class="create-menu dropdown-menu">
          <div class="tg-menu-item" tabindex="0">文档C+D</div>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-menu-div-action-slow", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const item = document.querySelector(".tg-menu-item")!;
      mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
      mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
      mockHoverStyle([item]);

      mouseOver(trigger);
      vi.setSystemTime(new Date("2026-08-07T03:43:47.000Z"));
      mouseOver(item);
      click(item);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "click",
        target: { tag: "div", name: "文档C+D" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("infers a non-policy opener hover from the later surface action", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <div class="tg-menu-item" tabindex="0">文档C+D</div>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-infer-opener", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector(".tg-menu-item")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([trigger, item]);

    mouseOver(trigger);
    mouseOver(item);
    click(item);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "文档C+D" },
    });
  });

  it("does not record a strong-looking surface item when clicking that item itself", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-expanded="false"><div>文档C+D</div></li>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-false-submenu", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector("li")!;
    const itemInner = document.querySelector("li div")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([item, itemInner]);

    mouseOver(trigger);
    mouseOver(item);
    click(itemInner);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "文档C+D" },
    });
  });

  it("records cascaded hover triggers before clicking inside the final surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <ul class="create-menu dropdown-menu">
        <li class="dropdown-item" tabindex="0" aria-haspopup="menu">更多模板</li>
      </ul>
      <div role="menu" class="template-submenu">
        <button type="button">Blank doc</button>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-cascade", (step) => steps.push(step));
    const trigger = document.querySelector("button[aria-label]")!;
    const menu = document.querySelector(".create-menu")!;
    const submenu = document.querySelector(".template-submenu")!;
    const nestedTrigger = document.querySelector("li")!;
    const finalAction = document.querySelector(".template-submenu button")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(nestedTrigger, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([nestedTrigger, finalAction]);

    mouseOver(trigger);
    mockRect(submenu, { left: 984, top: 48, width: 160, height: 80 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mouseOver(nestedTrigger);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "hover",
      target: { tag: "li", name: "更多模板" },
    });
    expect(steps[2]).toMatchObject({
      op: "click",
      target: { role: "button", name: "Blank doc" },
    });
  });

  it("infers the full hover opener chain for nested menu actions", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-expanded="false">文档C+D</li>
      </div>
      <div role="menu" class="format-submenu">
        <span tabindex="0">Markdown</span>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-nested-infer", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const submenu = document.querySelector(".format-submenu")!;
    const nestedTrigger = document.querySelector("li")!;
    const finalAction = document.querySelector("span")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(nestedTrigger, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([trigger, nestedTrigger, finalAction]);

    mouseOver(trigger);
    mockRect(submenu, { left: 984, top: 48, width: 160, height: 80 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mouseOver(nestedTrigger);
    mouseOver(finalAction);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "hover",
      target: { tag: "li", name: "文档C+D" },
    });
    expect(steps[2]).toMatchObject({
      op: "click",
      target: { tag: "span", name: "Markdown" },
    });
  });

  it("uses the nested hover trigger label without descendant submenu text", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-haspopup="menu">
          <span>多维表格</span>
          <div>
            <span tabindex="0">表格视图</span>
            <div tabindex="0">看板视图</div>
            <span>甘特视图</span>
            <span>日历视图</span>
            <span>相册视图</span>
            <span>架构视图</span>
            <span>神奇表单</span>
          </div>
        </li>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-nested-compact-label", (step) =>
      steps.push(step),
    );
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const nestedTrigger = document.querySelector("li")!;
    const submenu = document.querySelector("li > div")!;
    const finalAction = document.querySelector("li > div div")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(nestedTrigger, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([trigger, nestedTrigger, finalAction], [submenu]);

    mouseOver(trigger);
    mockRect(submenu, { left: 984, top: 48, width: 180, height: 220 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mouseOver(nestedTrigger);
    mouseOver(finalAction);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "hover",
      target: { tag: "li", name: "多维表格" },
    });
    expect(JSON.stringify(steps[1]?.target)).not.toContain("看板视图");
    expect(steps[2]).toMatchObject({
      op: "click",
      target: { tag: "div", name: "看板视图" },
    });
  });

  it("does not let a stale pass-through shortcut hover claim a later submenu", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T06:39:40.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">
            <span class="menu-item-label">文档</span>
            <span class="text-font-tips">C+D</span>
          </li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content">
              <span class="menu-item-label">多维表格</span>
            </div>
            <div class="t-dropdown__submenu-wrapper">
              <span tabindex="0">看板视图</span>
            </div>
          </li>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-stale-shortcut", (step) => steps.push(step));
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const shortcut = document.querySelector(".text-font-tips")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 160 });
      mockRect(shortcut, { left: 950, top: 56, width: 29, height: 22 });
      mockRect(nestedTrigger, { left: 820, top: 92, width: 160, height: 32 });
      mockHoverStyle([trigger, shortcut, nestedTrigger, finalAction], [submenu]);

      mouseOver(trigger);
      mouseOver(shortcut);
      mockRect(submenu, { left: 984, top: 92, width: 160, height: 80 });
      mockRect(finalAction, { left: 984, top: 92, width: 136, height: 32 });
      mouseOver(nestedTrigger);
      vi.runOnlyPendingTimers();
      mouseOver(finalAction);
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("C+D");
      expect(steps[2]).toMatchObject({
        op: "click",
        target: { tag: "span", name: "看板视图" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an item inside a newly opened menu claim the parent surface", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T07:12:08.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">文档C+D</li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <span>多维表格</span>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <span tabindex="0">看板视图</span>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-parent-surface-owner", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockHoverStyle([trigger, passThrough, nestedTrigger, finalAction]);

      mouseOver(trigger);
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mouseOver(passThrough);
      vi.runOnlyPendingTimers();
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(nestedTrigger);
      vi.runOnlyPendingTimers();
      mouseOver(finalAction);
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
    } finally {
      vi.useRealTimers();
    }
  });

  it("infers an unowned existing parent surface when a nested submenu is opened", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T07:28:10.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">文档C+D</li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content">
              <span class="menu-item-label">多维表格</span>
            </div>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <span tabindex="0">看板视图</span>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-existing-parent-surface", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockHoverStyle([trigger, passThrough, nestedTrigger, finalAction]);

      mouseOver(passThrough);
      mouseOver(trigger);
      vi.runOnlyPendingTimers();
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(nestedTrigger);
      vi.runOnlyPendingTimers();
      mouseOver(finalAction);
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns a side submenu to the vertically aligned hover trigger", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T06:55:38.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">
            <span class="menu-item-label">文档</span>
            <span class="text-font-tips">C+D</span>
          </li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content">
              <span class="menu-item-label">多维表格</span>
            </div>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <li class="create-submenu-item-vika-kanban" tabindex="0">
            <span>看板视图</span>
          </li>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-side-submenu-alignment", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalAction = document.querySelector(".t-dropdown__submenu-wrapper span")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockHoverStyle([trigger, passThrough, nestedTrigger, finalAction]);

      mouseOver(trigger);
      mouseOver(passThrough);
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(nestedTrigger);
      mouseOver(finalAction);
      vi.runOnlyPendingTimers();
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { tag: "li", name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
      expect(steps[2]).toMatchObject({
        op: "click",
        target: { tag: "span", name: "看板视图" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("outputs only one parent path for noisy nested menu hover movement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T07:02:36.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button">新建</button>
        <div class="create-menu dropdown-menu">
          <li class="create-menu-item-doc" tabindex="0">
            <span class="menu-item-label">文档</span>
            <span class="text-font-tips">C+D</span>
          </li>
          <li class="create-menu-item-vika" tabindex="0" aria-haspopup="menu">
            <div class="t-dropdown__item-content" tabindex="0">
              <span class="menu-item-label">多维表格</span>
            </div>
          </li>
        </div>
        <div class="t-dropdown__submenu-wrapper">
          <div class="create-submenu-item-vika-kanban" tabindex="0">
            <div class="create-submenu-item-label" tabindex="0">
              <span>表格视图</span>
            </div>
          </div>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-noisy-nested-path", (step) => steps.push(step));
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const passThrough = document.querySelector(".create-menu-item-doc")!;
      const nestedTrigger = document.querySelector(".create-menu-item-vika")!;
      const nestedInner = document.querySelector(".t-dropdown__item-content")!;
      const submenu = document.querySelector(".t-dropdown__submenu-wrapper")!;
      const finalItem = document.querySelector(".create-submenu-item-vika-kanban")!;
      const finalHoverItem = document.querySelector(".create-submenu-item-label")!;
      const finalAction = document.querySelector(".create-submenu-item-vika-kanban")!;
      mockRect(trigger, { left: 42, top: 72, width: 60, height: 32 });
      mockRect(menu, { left: 8, top: 104, width: 201, height: 439 });
      mockRect(passThrough, { left: 17, top: 113, width: 184, height: 34 });
      mockRect(nestedTrigger, { left: 17, top: 228, width: 184, height: 34 });
      mockRect(nestedInner, { left: 25, top: 234, width: 168, height: 22 });
      mockHoverStyle([
        trigger,
        passThrough,
        nestedTrigger,
        nestedInner,
        finalItem,
        finalHoverItem,
        finalAction,
      ]);

      mouseOver(trigger);
      mouseOver(nestedTrigger);
      mouseOver(nestedInner);
      mockRect(submenu, { left: 201, top: 213, width: 114, height: 267 });
      mockRect(finalItem, { left: 209, top: 257, width: 97, height: 34 });
      mockRect(finalHoverItem, { left: 209, top: 257, width: 97, height: 34 });
      mockRect(finalAction, { left: 209, top: 257, width: 97, height: 34 });
      mouseOver(passThrough);
      mouseOver(nestedInner);
      mouseOver(finalHoverItem);
      vi.runOnlyPendingTimers();
      click(finalAction);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { name: "多维表格" },
      });
      expect(JSON.stringify(steps)).not.toContain("文档C+D");
      expect(JSON.stringify(steps)).not.toContain('"表格视图","tag":"div"');
      expect(steps.filter((step) => step.op === "hover")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not infer sibling items in the same surface as hover openers", () => {
    document.body.innerHTML = `
      <button type="button">新建</button>
      <div class="create-menu dropdown-menu">
        <li tabindex="0" aria-expanded="false">文档C+D</li>
        <span tabindex="0">Markdown</span>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-same-surface-action", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const category = document.querySelector("li")!;
    const finalAction = document.querySelector("span")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 320, height: 80 });
    mockRect(category, { left: 820, top: 48, width: 160, height: 32 });
    mockRect(finalAction, { left: 984, top: 48, width: 136, height: 32 });
    mockHoverStyle([trigger, category, finalAction]);

    mouseOver(trigger);
    mouseOver(category);
    mouseOver(finalAction);
    click(finalAction);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "新建" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { tag: "span", name: "Markdown" },
    });
  });

  it("records avatar div hover with a semantic image target", () => {
    document.body.innerHTML = `
      <div class="tg-avatar tg-avatar--img tg-avatar--shape-hexagon">
        <img class="tg-avatar__image" />
      </div>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-hover-avatar-div", (step) => steps.push(step));
    const trigger = document.querySelector(".tg-avatar")!;
    const image = document.querySelector("img")!;
    const menu = document.querySelector(".user-menu")!;
    const item = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      cursor: "pointer",
      pointerEvents: "auto",
    } as CSSStyleDeclaration);

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    image.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { tag: "img", role: "img", name: "image" },
    });
    expect(steps[1]).toMatchObject({
      op: "click",
      target: { role: "link", name: "My profile" },
    });
  });

  it("does not let unrelated topbar hovers or menu pass-through items own an avatar menu", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T08:08:45.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="Star">Star</button>
        <div class="tg-avatar tg-avatar--img tg-avatar--shape-hexagon">
          <img class="tg-avatar__image" />
        </div>
        <ul class="user-menu dropdown-menu">
          <li><a href="/u/me">My profile</a></li>
          <li><a href="/dashboard/groups">My groups</a></li>
        </ul>
      `;
      const star = document.querySelector("button")!;
      const avatar = document.querySelector(".tg-avatar")!;
      const image = document.querySelector("img")!;
      const menu = document.querySelector(".user-menu")!;
      const profile = document.querySelector('a[href="/u/me"]')!;
      const groups = document.querySelector('a[href="/dashboard/groups"]')!;
      let menuRect = { left: 0, top: 0, width: 0, height: 0 };
      let profileRect = { left: 0, top: 0, width: 0, height: 0 };
      let groupsRect = { left: 0, top: 0, width: 0, height: 0 };
      mockRect(star, { left: 760, top: 8, width: 60, height: 32 });
      mockRect(avatar, { left: 900, top: 8, width: 32, height: 32 });
      mockRect(image, { left: 900, top: 8, width: 32, height: 32 });
      vi.spyOn(menu, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: menuRect.left,
            y: menuRect.top,
            top: menuRect.top,
            left: menuRect.left,
            right: menuRect.left + menuRect.width,
            bottom: menuRect.top + menuRect.height,
            width: menuRect.width,
            height: menuRect.height,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      vi.spyOn(profile, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: profileRect.left,
            y: profileRect.top,
            top: profileRect.top,
            left: profileRect.left,
            right: profileRect.left + profileRect.width,
            bottom: profileRect.top + profileRect.height,
            width: profileRect.width,
            height: profileRect.height,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      vi.spyOn(groups, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: groupsRect.left,
            y: groupsRect.top,
            top: groupsRect.top,
            left: groupsRect.left,
            right: groupsRect.left + groupsRect.width,
            bottom: groupsRect.top + groupsRect.height,
            width: groupsRect.width,
            height: groupsRect.height,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      mockHoverStyle([star, avatar, image, profile, groups]);
      const capture = startRecordCapture("rec-hover-avatar-menu-pass-through", (step) =>
        steps.push(step),
      );

      mouseOver(star);
      mouseOver(avatar);
      mouseOver(image);
      menuRect = { left: 820, top: 48, width: 160, height: 96 };
      profileRect = { left: 830, top: 56, width: 120, height: 28 };
      groupsRect = { left: 830, top: 88, width: 120, height: 28 };
      vi.runOnlyPendingTimers();
      mouseOver(profile);
      mouseOver(groups);
      click(groups);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { tag: "img", role: "img", name: "image" },
      });
      expect(steps[1]).toMatchObject({
        op: "click",
        target: { role: "link", name: "My groups" },
      });
      expect(JSON.stringify(steps)).not.toContain("Star");
      expect(JSON.stringify(steps)).not.toContain("My profile");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record hover before an unrelated page click", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <main>
        <a href="/projects">Projects</a>
      </main>
    `;
    const capture = startRecordCapture("rec-hover-unrelated-click", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const link = document.querySelector("main a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
    expect(steps[0]).toMatchObject({
      op: "click",
      target: { role: "link", name: "Projects" },
    });
  });

  it("records hover before filling a field inside the hover surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div class="user-menu dropdown-menu">
        <label for="nickname">Nickname</label>
        <input id="nickname" />
      </div>
    `;
    const capture = startRecordCapture("rec-hover-fill-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const input = document.querySelector("input")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 96 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.value = "Ada";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "fill"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
    expect(steps[1]).toMatchObject({
      op: "fill",
      target: { tag: "input" },
      value: "Ada",
    });
  });

  it("records hover before selecting inside the hover surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div class="user-menu dropdown-menu">
        <select aria-label="Status">
          <option value="online">Online</option>
          <option value="away">Away</option>
        </select>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-select-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".user-menu")!;
    const select = document.querySelector("select")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 96 });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    select.value = "away";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "select"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
    expect(steps[1]).toMatchObject({
      op: "select",
      target: { role: "combobox", name: "Status" },
      values: ["away"],
      labels: ["Away"],
    });
  });

  it("records hover before clicking an unlabelled positioned floating surface", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div style="position: absolute; top: 48px; left: 820px; width: 160px; height: 80px;">
        <a href="/u/me">My profile</a>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-plain-floating-surface", (step) =>
      steps.push(step),
    );
    const trigger = document.querySelector("button")!;
    const surface = document.querySelector("div")!;
    const link = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 48,
      top: 48,
      left: 820,
      right: 980,
      bottom: 128,
      width: 160,
      height: 80,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: "",
        display: "block",
        pointerEvents: "auto",
        position: el === surface ? "absolute" : "static",
        visibility: "visible",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({
      op: "hover",
      target: { role: "button", name: "Open user navigation menu" },
    });
  });

  it("does not treat ordinary document-flow divs as hover surfaces", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div>
        <a href="/u/me">My profile</a>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-plain-flow-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const link = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      cursor: "",
      display: "block",
      pointerEvents: "auto",
      position: "static",
      visibility: "visible",
    } as CSSStyleDeclaration);

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("does not treat unlabelled sticky containers as hover surfaces", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
      <div style="position: sticky; top: 48px; left: 820px; width: 160px; height: 80px;">
        <a href="/u/me">My profile</a>
      </div>
    `;
    const capture = startRecordCapture("rec-hover-sticky-surface", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const surface = document.querySelector("div")!;
    const link = document.querySelector("a")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 820,
      y: 48,
      top: 48,
      left: 820,
      right: 980,
      bottom: 128,
      width: 160,
      height: 80,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const style = {
        cursor: "",
        display: "block",
        pointerEvents: "auto",
        position: el === surface ? "sticky" : "static",
        visibility: "visible",
      } as CSSStyleDeclaration;
      return style;
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("does not record hover before clicking the same trigger", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="Open user navigation menu">avatar</button>
    `;
    const capture = startRecordCapture("rec-hover-same-trigger", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 8,
      top: 8,
      left: 900,
      right: 932,
      bottom: 40,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("does not record hover for ordinary controls without popup signals", () => {
    const capture = startRecordCapture("rec-hover-noise", (step) => steps.push(step));
    const button = document.querySelector("button")!;

    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });
  it("records a click on a control whose page happens to contain a search box", () => {
    // MediaWiki Vector ships `<body class="…skin-vector-search-vue…">`, which
    // `closest('[class*="search"]')` used to match for every click on the page.
    document.body.className = "skin-vector skin-vector-search-vue";
    document.body.innerHTML = `
      <form id="searchform"><input type="search" name="search" /></form>
      <nav><button type="button" aria-label="\u9690\u85cf\u76ee\u5f55"><span>x</span></button></nav>
    `;
    const capture = startRecordCapture("rec-search-body", (step) => steps.push(step));
    click(document.querySelector("span")!);
    capture.dispose();
    document.body.className = "";

    expect(steps).toEqual([
      expect.objectContaining({
        op: "click",
        target: expect.objectContaining({ name: "\u9690\u85cf\u76ee\u5f55" }),
      }),
    ]);
  });

  it("records a link click inside a form that also holds a search box", () => {
    document.body.innerHTML = `
      <form>
        <input type="search" name="q" />
        <a href="/help">Help</a>
      </form>
    `;
    const capture = startRecordCapture("rec-search-form", (step) => steps.push(step));
    click(document.querySelector("a")!);
    capture.dispose();

    expect(steps).toEqual([
      expect.objectContaining({ op: "click", target: expect.objectContaining({ name: "Help" }) }),
    ]);
  });

  it("still redirects a click on bare search chrome into a fill session", () => {
    document.body.innerHTML = `
      <div class="search-box">
        <span class="icon"></span>
        <input type="search" name="q" />
      </div>
    `;
    const capture = startRecordCapture("rec-search-chrome", (step) => steps.push(step));
    const icon = document.querySelector(".icon")!;
    click(icon);
    const input = document.querySelector("input")!;
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["fill"]);
  });

  it("does not re-emit a hover for an element that was already clicked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T10:10:00.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
        <div class="create-menu dropdown-menu">
          <div class="tg-menu-item" tabindex="0">文档C+D</div>
        </div>
      `;
      const capture = startRecordCapture("rec-click-then-hover", (step) => steps.push(step));
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const item = document.querySelector(".tg-menu-item")!;
      mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
      mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
      mockHoverStyle([item]);

      // The trigger is clicked, then the revealed menu item is clicked 5s later
      // while the mouse stays on the trigger. The hover that preceded the click
      // is already described by that click, so it must not be replayed as a new
      // step for the item action (R1-3).
      mouseOver(trigger);
      click(trigger);
      vi.setSystemTime(new Date("2026-08-07T10:10:05.000Z"));
      click(item);
      capture.dispose();

      expect(steps.filter((s) => s.op === "hover")).toHaveLength(0);
      expect(steps.map((s) => s.op)).toEqual(["click", "click"]);
      expect(steps[0]).toMatchObject({ op: "click", target: { name: "新建" } });
      expect(steps[1]).toMatchObject({ op: "click", target: { name: "文档C+D" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a new hover for an element that was clicked in an earlier cycle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T10:00:00.000Z"));
    try {
      document.body.innerHTML = `
        <div class="user dropdown" role="button" aria-label="image">
          <img alt="image" />
          <ul>
            <li><a href="/u/me">My profile</a></li>
          </ul>
        </div>
      `;
      const capture = startRecordCapture("rec-hover-after-click", (step) => steps.push(step));
      const trigger = document.querySelector('[role="button"]')!;
      const menu = document.querySelector("ul")!;
      const item = document.querySelector("a")!;
      mockRect(trigger, { left: 900, top: 8, width: 32, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

      // Cycle 1: hovering the trigger and clicking it is one action, so the
      // click already describes it and no hover step is due.
      mouseOver(trigger);
      click(trigger);
      expect(steps.map((s) => s.op)).toEqual(["click"]);

      // Cycle 2: the user reopens the same menu 5s later and picks an item. This
      // is a genuinely new hover and must not be swallowed by the earlier click
      // on the same element (R1-3).
      vi.setSystemTime(new Date("2026-08-07T10:00:05.000Z"));
      mouseOver(trigger);
      click(item);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["click", "hover", "click"]);
      expect(steps[1]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "image" },
      });
      expect(steps[2]).toMatchObject({
        op: "click",
        target: { role: "link", name: "My profile" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a contained opener older than the hover surface window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T09:00:00.000Z"));
    try {
      document.body.innerHTML = `
        <div class="create-menu dropdown-menu" tabindex="0">
          <button type="button">文档C+D</button>
        </div>
      `;
      const capture = startRecordCapture("rec-stale-contained-opener", (step) => steps.push(step));
      const menu = document.querySelector(".create-menu")!;
      const item = document.querySelector("button")!;
      mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
      mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
      mockHoverStyle([menu]);

      // The menu is a policy-eligible candidate while visible, then it closes
      // (`display: none`) before the contained item is ever acted on.
      mouseOver(menu);
      vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
        const hidden = el === menu || el === item;
        const style = {
          cursor: el === menu ? "pointer" : "",
          display: hidden ? "none" : "block",
          pointerEvents: hidden ? "none" : "auto",
          position: "static",
          visibility: hidden ? "hidden" : "visible",
        } as CSSStyleDeclaration;
        return style;
      });

      // 30s later the closed menu must not resurface as a hover step.
      vi.setSystemTime(new Date("2026-08-07T09:00:30.000Z"));
      click(item);
      capture.dispose();

      expect(steps.filter((s) => s.op === "hover")).toHaveLength(0);
      expect(steps.map((s) => s.op)).toEqual(["click"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an ineligible contained opener whose surface is not visible", () => {
    document.body.innerHTML = `
      <div class="create-menu dropdown-menu" tabindex="0">
        <button type="button">文档C+D</button>
      </div>
    `;
    const capture = startRecordCapture("rec-ineligible-contained-opener", (step) =>
      steps.push(step),
    );
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector("button")!;
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const hidden = el === menu || el === item;
      const style = {
        cursor: "pointer",
        display: hidden ? "none" : "block",
        pointerEvents: hidden ? "none" : "auto",
        position: "static",
        visibility: hidden ? "hidden" : "visible",
        fontSize: "14px",
      } as CSSStyleDeclaration;
      return style;
    });

    // Never-visible surface: the mouseover only produced an ineligible
    // candidate, so acting inside it must not invent a hover step.
    mouseOver(menu);
    click(item);
    capture.dispose();

    expect(steps.filter((s) => s.op === "hover")).toHaveLength(0);
    expect(steps.map((s) => s.op)).toEqual(["click"]);
  });

  it("keeps the opener hover when the menu stays open until its item is clicked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T09:30:00.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
        <div class="create-menu dropdown-menu">
          <div class="tg-menu-item" tabindex="0">文档C+D</div>
        </div>
      `;
      const capture = startRecordCapture("rec-opener-hover-menu-item", (step) => steps.push(step));
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu")!;
      const item = document.querySelector(".tg-menu-item")!;
      mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
      mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
      mockHoverStyle([item]);

      mouseOver(trigger);
      // Human-paced pause: the menu is still visible, so the opener hover stays
      // legitimate even though the 10s candidate window has passed.
      vi.setSystemTime(new Date("2026-08-07T09:30:30.000Z"));
      mouseOver(menu);
      click(item);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({ op: "click", target: { name: "文档C+D" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds a surface whose opener was hovered 15s earlier", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T11:00:00.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
        <div class="create-menu dropdown-menu" style="display: none">
          <div class="tg-menu-item" tabindex="0">文档C+D</div>
        </div>
      `;
      const capture = startRecordCapture("rec-slow-surface-binding", (step) => steps.push(step));
      const trigger = document.querySelector("button")!;
      const menu = document.querySelector(".create-menu") as HTMLElement;
      const item = document.querySelector(".tg-menu-item")!;
      mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
      mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
      vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
        const hidden = (el as HTMLElement).style?.display === "none";
        const style = {
          cursor: el === item ? "pointer" : "",
          display: hidden ? "none" : "block",
          pointerEvents: hidden ? "none" : "auto",
          position: "static",
          visibility: hidden ? "hidden" : "visible",
        } as CSSStyleDeclaration;
        return style;
      });

      // Lazy menu: the opener is hovered while nothing is visible yet, and the
      // menu only appears 15s later - past the 10s candidate window but inside
      // the 30s surface-binding window. The freshly visible surface must still
      // bind to that opener, otherwise the item click loses its causal hover
      // (R1-7). Measured against the old shared 10s window this test yields
      // `["click"]`.
      mouseOver(trigger);
      vi.setSystemTime(new Date("2026-08-07T11:00:15.000Z"));
      menu.style.display = "block";
      const scansBeforeAction = hoverSurfaceScanCounter.count;
      click(item);
      capture.dispose();

      // The binding is checked against the live DOM, so the fallback path does
      // run a scan - the lazy fast path is only a shortcut, not a removal. It
      // must run exactly once though: the surface lookup and the visibility
      // check share one snapshot instead of scanning twice (R1-6).
      expect(hoverSurfaceScanCounter.count).toBe(scansBeforeAction + 1);
      expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
      expect(steps[0]).toMatchObject({
        op: "hover",
        target: { role: "button", name: "新建" },
      });
      expect(steps[1]).toMatchObject({ op: "click", target: { tag: "div", name: "文档C+D" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the full-DOM hover surface scan when the opener is eligible", () => {
    document.body.innerHTML = `
      <button type="button" aria-label="新建" aria-haspopup="menu">新建</button>
      <div class="create-menu dropdown-menu">
        <div class="tg-menu-item" tabindex="0">文档C+D</div>
      </div>
    `;
    const capture = startRecordCapture("rec-lazy-surface-scan", (step) => steps.push(step));
    const trigger = document.querySelector("button")!;
    const menu = document.querySelector(".create-menu")!;
    const item = document.querySelector(".tg-menu-item")!;
    mockRect(trigger, { left: 900, top: 8, width: 60, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
    mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
    mockHoverStyle([item]);

    // The candidate passes hover-trigger policy, so the opener is accepted from
    // the in-memory candidate window alone. The action path must not pay for a
    // `document.querySelectorAll("*")` walk to confirm it (R1-6).
    mouseOver(trigger);
    const scansBeforeAction = hoverSurfaceScanCounter.count;
    click(item);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(hoverSurfaceScanCounter.count).toBe(scansBeforeAction);
  });

  it("never scans for hover surfaces when an action has no candidate at all", () => {
    document.body.innerHTML = `<a href="/help">Help</a>`;
    const capture = startRecordCapture("rec-no-candidate-scan", (step) => steps.push(step));
    const link = document.querySelector("a")!;
    mockRect(link, { left: 10, top: 10, width: 80, height: 24 });

    // No mouseover ever produced a candidate and no surface is owned, so a
    // surface lookup cannot match anything. The action path must short-circuit
    // instead of walking the whole document for nothing (R1-6).
    const scansBeforeAction = hoverSurfaceScanCounter.count;
    click(link);
    capture.dispose();

    expect(steps).toEqual([
      expect.objectContaining({ op: "click", target: expect.objectContaining({ name: "Help" }) }),
    ]);
    expect(hoverSurfaceScanCounter.count).toBe(scansBeforeAction);
  });

  it("does not emit a same-action hover step when clicking a has-submenu combobox", () => {
    // D5-2: the pointer moving to `#story` produces a mouseover whose resolved
    // hover element is the wrapping `<div role="combobox" aria-haspopup>`.
    // That wrapper both contains the input and describes the very target the
    // click records, so replaying it would add a spurious hover step in front of
    // the click (the 7/8 regression).
    document.body.innerHTML = `
      <label id="story-label">* Story</label>
      <div id="story-picker" role="combobox" aria-haspopup="listbox" aria-expanded="false">
        <input id="story" aria-labelledby="story-label" placeholder="Type to search" />
      </div>
    `;
    const capture = startRecordCapture("rec-same-action-hover", (step) => steps.push(step));
    const wrapper = document.querySelector("#story-picker")!;
    const input = document.querySelector("#story")!;
    mockRect(wrapper, { left: 300, top: 200, width: 220, height: 36 });

    // Real pointer path: `moveRealPointer` fires mouseover on the wrapper on its
    // way to the input, then the click lands on the input.
    mouseOver(wrapper);
    click(input);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
    expect(steps[0]).toMatchObject({
      op: "click",
      target: { role: "combobox", name: "* Story" },
      expects_navigation: false,
    });
  });

  it("keeps an explicit hover step when a menu is opened by hovering and its item is clicked later", () => {
    // The legitimate counterpart (12→13): an explicit `bsk hover` on the opener
    // is a real, earlier action of its own. The click on the revealed item must
    // keep both steps even though the opener wrapper contains the click target.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T09:00:00.000Z"));
    try {
      document.body.innerHTML = `
        <button type="button" aria-label="Account" aria-haspopup="menu" aria-expanded="false">Account</button>
        <div id="hover-panel" class="account-menu dropdown-menu">
          <a href="/profile">Profile beta</a>
        </div>
      `;
      const capture = startRecordCapture("rec-explicit-hover-opener", (step) => steps.push(step));
      const opener = document.querySelector("button")!;
      const menu = document.querySelector("#hover-panel")!;
      const item = document.querySelector("a")!;
      mockRect(opener, { left: 900, top: 8, width: 72, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 200, height: 80 });

      mouseOver(opener);
      vi.setSystemTime(new Date("2026-09-17T09:00:00.500Z"));
      mouseOver(menu);
      click(item);
      capture.dispose();

      expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
      expect(steps[0]).toMatchObject({ op: "hover", target: { name: "Account" } });
      expect(steps[1]).toMatchObject({
        op: "click",
        target: { role: "link", name: "Profile beta" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit a same-name wrapper hover when the interactive child is clicked", () => {
    // Pins the D5 §2.4 half of the fix on its own: the wrapper is never written
    // to `lastClickAt` (only the inner child is), so the timestamp suppression
    // cannot catch it. Only "candidate describes the same recorded target as
    // this click, in the same batch" does.
    document.body.innerHTML = `
      <div role="button" aria-label="Account" aria-haspopup="menu">
        <div role="button" aria-haspopup="menu">Account</div>
      </div>
    `;
    const capture = startRecordCapture("rec-same-name-wrapper", (step) => steps.push(step));
    const wrapper = document.querySelector('[aria-label="Account"]')!;
    const inner = wrapper.querySelector("div")!;
    mockRect(wrapper, { left: 900, top: 8, width: 96, height: 32 });

    mouseOver(wrapper);
    click(inner);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["click"]);
    expect(steps[0]).toMatchObject({ op: "click", target: { role: "button", name: "Account" } });
  });

  it("samples the same-action hover window before the action-time surface scan (R2-7)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T09:00:00.000Z"));
    try {
      document.body.innerHTML = `
        <div role="button" aria-label="Account" aria-haspopup="menu">
          <div role="button" aria-haspopup="menu">Account</div>
        </div>
      `;
      const capture = startRecordCapture("rec-action-clock-before-scan", (step) =>
        steps.push(step),
      );
      const wrapper = document.querySelector('[aria-label="Account"]')!;
      const inner = wrapper.querySelector("div")!;
      mockRect(wrapper, { left: 900, top: 8, width: 96, height: 32 });

      // The pointer travelled from the wrapper to the inner control: one action.
      mouseOver(wrapper);

      // A big document / slow machine: the full-DOM surface scan triggered by
      // this very action costs 60ms, i.e. more than the whole 50ms same-action
      // window it is consulted inside. The window measures the pointer's travel,
      // so the scan's cost must not be charged to it (R2-7).
      hoverSurfaceScanCounter.onScan = () => {
        hoverSurfaceScanCounter.onScan = undefined;
        vi.setSystemTime(new Date(Date.now() + 60));
      };
      const scansBeforeAction = hoverSurfaceScanCounter.count;
      click(inner);
      capture.dispose();

      // The scan really ran, and the candidate is still this click's own arrival.
      expect(hoverSurfaceScanCounter.count).toBeGreaterThan(scansBeforeAction);
      expect(steps.map((s) => s.op)).toEqual(["click"]);
      expect(steps[0]).toMatchObject({ op: "click", target: { role: "button", name: "Account" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a click whose target has no recordable descriptor (R2-17)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T10:00:00.000Z"));
    try {
      document.body.innerHTML = `
        <div id="bell" role="switch" tabindex="0" aria-haspopup="menu" aria-expanded="false"></div>
        <div class="create-menu dropdown-menu">
          <div class="tg-menu-item" tabindex="0">文档C+D</div>
        </div>
      `;
      const capture = startRecordCapture("rec-undescribable-click-mark", (step) =>
        steps.push(step),
      );
      const trigger = document.querySelector("#bell")!;
      const menu = document.querySelector(".create-menu")!;
      const item = document.querySelector(".tg-menu-item")!;
      mockRect(trigger, { left: 900, top: 8, width: 32, height: 32 });
      mockRect(menu, { left: 820, top: 48, width: 180, height: 80 });
      mockRect(item, { left: 820, top: 48, width: 160, height: 32 });
      mockHoverStyle([item]);

      // `#bell` carries no accessible name, so `describeEventTarget` returns null
      // and the click itself is not recorded — no record, hence previously no
      // suppression timestamp either. The click is still the action that
      // describes the hover immediately before it, so it must be marked from the
      // event target itself and not left to the 50ms window (R2-17).
      mouseOver(trigger);
      click(trigger);
      vi.setSystemTime(new Date("2026-09-17T10:00:05.000Z"));
      click(item);
      capture.dispose();

      expect(steps.filter((s) => s.op === "hover")).toHaveLength(0);
      expect(steps.map((s) => s.op)).toEqual(["click"]);
      expect(steps[0]).toMatchObject({ op: "click", target: { name: "文档C+D" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a wrapper hover when a different inner child is clicked", () => {
    // The narrowed D5-2 rule must not swallow a legitimate wrapper hover: the
    // wrapper declares a different recorded target than the child that is
    // clicked, so both steps stay.
    document.body.innerHTML = `
      <div role="button" aria-label="user avatar" aria-haspopup="menu">
        <img alt="avatar" />
        <span role="button" aria-label="Settings">Settings</span>
      </div>
      <ul class="user-menu dropdown-menu">
        <li><a href="/u/me">My profile</a></li>
      </ul>
    `;
    const capture = startRecordCapture("rec-wrapper-hover-child-click", (step) => steps.push(step));
    const wrapper = document.querySelector('[aria-label="user avatar"]')!;
    const child = document.querySelector("span")!;
    const menu = document.querySelector("ul")!;
    mockRect(wrapper, { left: 900, top: 8, width: 32, height: 32 });
    mockRect(menu, { left: 820, top: 48, width: 160, height: 80 });

    mouseOver(wrapper);
    click(child);
    capture.dispose();

    expect(steps.map((s) => s.op)).toEqual(["hover", "click"]);
    expect(steps[0]).toMatchObject({ op: "hover", target: { name: "user avatar" } });
    expect(steps[1]).toMatchObject({ op: "click", target: { name: "Settings" } });
  });
});
