// @vitest-environment node
// Real-browser regression for the reported chain:
//   hover a menu trigger -> passive observe/read -> click the revealed menuitem.
//
// The load-bearing fixture is `bottomEdgePortalMenuFixture`: a hover menu opened
// through JS, rendered into a portal, dismissed by the page on any scroll, and
// positioned so its first item is partially clipped by the viewport. That is the
// shape the report describes (1470x652 viewport, menu near the fold), and it is
// where the destructive geometry scroll used to close the menu and leave the
// click failing with "target element has no visible geometry".
//
// Opt in with BSK_HOVER_CHROME=/path/to/chrome, mirroring the other
// *.browser.test.ts suites. Only the page is a fixture; the production
// hover/click handlers run unchanged.
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { InteractionDeps } from "../interaction";
import { handleClick, handleHover } from "../interaction";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

const TRIGGER_STYLE =
  "#trigger { position: absolute; left: 40px; top: 40px; width: 120px; height: 32px; }";
const ITEM_STYLE = ".item { display: block; width: 100%; height: 28px; }";

/**
 * Shared menu plumbing: a portal panel plus the events it records.
 *
 * The panel is appended to a wrapper that also contains the trigger, and the
 * pair is dismissed on the *wrapper's* `mouseleave`. That is how real dropdowns
 * behave (AntD/React portals keep the trigger and the floating panel in one
 * hover group), and it is why moving the pointer onto a menu item is safe while
 * leaving the group closes it.
 */
const MENU_SCRIPT = `
  window.__events = [];
  window.__clicked = null;
  const log = (event) => window.__events.push(event);
  const trigger = document.getElementById('trigger');
  const hoverGroup = document.createElement('div');
  hoverGroup.id = 'hover-group';
  // A plain wrapper that keeps the trigger and the portal in one hover scope.
  trigger.parentNode.insertBefore(hoverGroup, trigger);
  hoverGroup.append(trigger);
  let portal = null;
  let open = false;
  function closeMenu(reason) {
    if (!open) return;
    open = false;
    log('close:' + reason);
    portal?.remove();
    portal = null;
  }
  function openMenuAt(top, closeOnScroll) {
    if (open) return;
    open = true;
    log('open');
    portal = document.createElement('div');
    portal.setAttribute('role', 'menu');
    Object.assign(portal.style, {
      position: 'absolute', left: '40px', top: top + 'px', width: '200px',
      background: '#fff', border: '1px solid #999',
    });
    for (const label of ['任务', '故事']) {
      const item = document.createElement('button');
      item.className = 'item';
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.addEventListener('click', () => { window.__clicked = label; log('click:' + label); });
      portal.append(item);
    }
    // The panel lives inside the hover group, so pointing at an item does not
    // read as "leaving the trigger".
    hoverGroup.append(portal);
    if (closeOnScroll) window.addEventListener('scroll', () => closeMenu('scroll'), true);
  }
  hoverGroup.addEventListener('mouseenter', () => openMenuAt(window.__menuTop, window.__closeOnScroll));
  hoverGroup.addEventListener('mouseleave', () => closeMenu('hover-group-leave'));
  window.__state = () => ({
    events: window.__events.slice(-10),
    open: !!document.querySelector("[role='menuitem']"),
    scrollY: Math.round(window.scrollY),
    clicked: window.__clicked,
  });
`;

/** A menu revealed purely by CSS `:hover`, nested under the trigger. */
function cssMenuFixture(): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; font: 14px sans-serif; min-height: 2400px; }
    ${TRIGGER_STYLE}
    #menu { display: none; position: absolute; left: 0; top: 100%; width: 200px; background: #fff; border: 1px solid #999; }
    #trigger:hover #menu { display: block; }
    ${ITEM_STYLE}
  </style></head><body>
    <div id="trigger"><button id="trigger-button">新建</button>
      <div id="menu" role="menu">
        <button class="item" role="menuitem" id="item-task">任务</button>
        <button class="item" role="menuitem" id="item-story">故事</button>
      </div>
    </div>
  </body></html>`;
}

/**
 * A React-shaped menu: JS hover handlers open it and the panel is appended to
 * `<body>` (a portal), so it is *not* a DOM descendant of the trigger. Leaving
 * the trigger closes it, which is what makes the pointer path matter.
 */
function jsPortalMenuFixture(): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; font: 14px sans-serif; min-height: 2400px; }
    ${TRIGGER_STYLE}
    ${ITEM_STYLE}
  </style></head><body>
    <button id="trigger">新建</button>
    <script>
      window.__menuTop = 76;
      window.__closeOnScroll = false;
      ${MENU_SCRIPT}
    </script>
  </body></html>`;
}

/**
 * The reported shape: the portal menu sits at the bottom edge of a short
 * viewport, so its first item is *partially* clipped, and the page dismisses the
 * menu on any scroll.
 *
 * A partial clip matters: it is exactly the case where "scroll it into view
 * first" both looks justified and is destructive. Measuring in place works here,
 * so the click must not scroll.
 */
function bottomEdgePortalMenuFixture(): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; font: 14px sans-serif; min-height: 3000px; }
    ${TRIGGER_STYLE}
    ${ITEM_STYLE}
  </style></head><body>
    <button id="trigger">新建</button>
    <script>
      // 630px down a 652px viewport: the item spans 631..659, so it crosses the
      // bottom edge while still being hit-testable.
      window.__menuTop = 630;
      window.__closeOnScroll = true;
      ${MENU_SCRIPT}
    </script>
  </body></html>`;
}

async function withHoverBrowser(
  run: (h: {
    evaluate: <T>(expression: string) => Promise<T>;
    setContent: (html: string) => Promise<void>;
    backendId: (selector: string) => Promise<number | null>;
    writeRef: (name: string, backendNodeId: number | null) => void;
    hover: (ref: string, options?: { settleMs?: number; signal?: AbortSignal }) => Promise<unknown>;
    click: (
      ref: string,
      options?: { signal?: AbortSignal; preserveHover?: boolean },
    ) => Promise<unknown>;
    deps: InteractionDeps;
  }) => Promise<void>,
) {
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  await withChrome(
    { executable: process.env.BSK_HOVER_CHROME, deviceScale: 1, zoom: 1 },
    async (send: Send) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await send("Page.bringToFront", {}, sessionId);
      const local: Send = (method, params) => send(method, params, sessionId);
      await local("Page.enable");
      await local("DOM.enable");
      await local("Runtime.enable");
      // Pin the viewport the report came from so the fixture geometry is stable.
      await local("Emulation.setDeviceMetricsOverride", {
        width: 1470,
        height: 652,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const { frameTree } = await local<{ frameTree: { frame: { id: string } } }>(
        "Page.getFrameTree",
      );

      const evaluate = async <T>(expression: string): Promise<T> => {
        const reply = await local<{ result: { value: T }; exceptionDetails?: { text?: string } }>(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
        );
        expect(reply.exceptionDetails).toBeUndefined();
        return reply.result.value;
      };
      const setContent = async (html: string) => {
        await local("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
        await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      };

      const manager = new SessionManager({
        agentWindow: {
          create: async () => 100,
          remove: async () => {},
          ensureActiveTab: async () => 4,
        },
      });
      const ctx = await manager.start("aa11");
      const cdp: CdpRunner = {
        send: (_tabId, method, params) => local(method, params),
        trackSessionTab: () => {},
        getAttachmentId: () => "hover-observation-browser-test",
      };
      const tabsApi = {
        get: async (id: number) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab,
        query: async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab],
      };
      const deps: InteractionDeps = { cdp, tabsApi };

      const backendId = async (selector: string): Promise<number | null> => {
        const doc = await local<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
        const found = await local<{ nodeId?: number }>("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector,
        });
        if (!found.nodeId) return null;
        const { node } = await local<{ node: { backendNodeId: number } }>("DOM.describeNode", {
          nodeId: found.nodeId,
        });
        return node.backendNodeId;
      };

      await run({
        evaluate,
        setContent,
        deps,
        backendId,
        writeRef: (name, backendNodeId) => {
          if (backendNodeId !== null) ctx.refStore.set(name, backendNodeId, { tabId: 4 });
        },
        hover: (ref, options = {}) =>
          handleHover(
            manager,
            {
              session_id: "aa11",
              ref,
              ...(options.settleMs !== undefined ? { settle_ms: options.settleMs } : {}),
            },
            { ...deps, ...(options.signal ? { signal: options.signal } : {}) },
          ),
        click: (ref, options = {}) =>
          handleClick(
            manager,
            { session_id: "aa11", ref },
            {
              ...deps,
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.preserveHover ? { preserveHover: true } : {}),
            },
          ),
      });
    },
  );
}

function failed(res: unknown): string | null {
  return res && typeof res === "object" && typeof (res as { code?: unknown }).code === "string"
    ? ((res as { code: string }).code ?? null)
    : null;
}

interface MenuState {
  events: string[];
  open: boolean;
  scrollY: number;
  clicked: string | null;
}

describe.skipIf(!process.env.BSK_HOVER_CHROME)(
  "hover-revealed menu click",
  { timeout: 30_000 },
  () => {
    it("clicks a CSS :hover menu item that a passive read left open", async () => {
      await withHoverBrowser(async (h) => {
        await h.setContent(cssMenuFixture());
        h.writeRef("e1", await h.backendId("#trigger-button"));

        const hoverRes = await h.hover("@e1", { settleMs: 0 });
        expect(failed(hoverRes)).toBeNull();
        expect(await h.evaluate("getComputedStyle(document.getElementById('menu')).display")).toBe(
          "block",
        );

        // A passive read between hover and click (the observe in the report):
        // the menu must still be open afterwards.
        await h.evaluate("document.getElementById('menu').getBoundingClientRect()");
        expect(await h.evaluate("getComputedStyle(document.getElementById('menu')).display")).toBe(
          "block",
        );

        h.writeRef("e2", await h.backendId("#item-task"));
        const clickRes = await h.click("@e2", { preserveHover: true });
        expect(failed(clickRes)).toBeNull();
      });
    });

    it("clicks a JS portal menu item that a passive read left open", async () => {
      await withHoverBrowser(async (h) => {
        await h.setContent(jsPortalMenuFixture());
        h.writeRef("e1", await h.backendId("#trigger"));

        const hoverRes = await h.hover("@e1", { settleMs: 0 });
        expect(failed(hoverRes)).toBeNull();
        expect(await h.evaluate("window.__state().open")).toBe(true);

        await h.evaluate("document.querySelector(\"[role='menu']\").getBoundingClientRect()");
        expect(await h.evaluate("window.__state().open")).toBe(true);

        h.writeRef("e2", await h.backendId("[role='menuitem']"));
        const clickRes = await h.click("@e2", { preserveHover: true });
        expect(failed(clickRes)).toBeNull();
        expect((await h.evaluate<MenuState>("window.__state()")).clicked).toBe("任务");
      });
    });

    it("clicks a partially clipped portal menu item without scrolling the menu away", async () => {
      await withHoverBrowser(async (h) => {
        await h.setContent(bottomEdgePortalMenuFixture());
        h.writeRef("e1", await h.backendId("#trigger"));

        const hoverRes = await h.hover("@e1", { settleMs: 0 });
        expect(failed(hoverRes)).toBeNull();
        const opened = await h.evaluate<MenuState>("window.__state()");
        expect(opened.open).toBe(true);

        // The item really is clipped: it crosses the bottom edge of the viewport.
        const item = await h.evaluate<{ top: number; bottom: number; viewportHeight: number }>(
          `(() => { const r = document.querySelector("[role='menuitem']").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, viewportHeight: window.innerHeight }; })()`,
        );
        expect(item.bottom).toBeGreaterThan(item.viewportHeight);

        h.writeRef("e2", await h.backendId("[role='menuitem']"));
        // Under a held hover the geometry is measured where the element sits, so
        // no scroll runs and the page cannot dismiss the menu.
        const clickRes = await h.click("@e2", { preserveHover: true });
        expect(failed(clickRes)).toBeNull();

        const after = await h.evaluate<MenuState>("window.__state()");
        expect(after.scrollY).toBe(0);
        expect(after.events).not.toContain("close:scroll");
        expect(after.clicked).toBe("任务");
      });
    });

    it("still brings a genuinely off-screen target into view", async () => {
      await withHoverBrowser(async (h) => {
        await h.setContent(bottomEdgePortalMenuFixture());
        // Push the trigger far down the document so it starts out of view.
        await h.evaluate("document.getElementById('trigger').style.top = '2000px'");
        h.writeRef("e1", await h.backendId("#trigger"));

        const hoverRes = await h.hover("@e1", { settleMs: 0 });
        expect(failed(hoverRes)).toBeNull();
        // Hovering it at all required scrolling it into view.
        expect((hoverRes as { y: number }).y).toBeLessThan(652);
      });
    });
  },
);
