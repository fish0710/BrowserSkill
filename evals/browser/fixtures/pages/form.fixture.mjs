import { escapeHtml, page } from "../../lib/fixtures.mjs";

export default {
  id: "form",
  routes: ["/form", "/result"],
  render({ pathname, runId, query, record }) {
    if (pathname === "/form") {
      // `?picker=1` appends an ARIA combobox/listbox trigger (collapsed options).
      // Recording it exercises the picker-expansion click path; without the query
      // parameter the page is byte-for-byte what every existing case expects.
      const picker = query.get("picker") === "1" ? `<div id="story-picker" role="combobox" aria-haspopup="listbox" aria-expanded="false"><span id="story-label">Story</span><input id="story" name="story" aria-labelledby="story-label" placeholder="Type to search" autocomplete="off"></div><ul id="story-options" hidden><li>Option A</li><li>Option B</li></ul>` : "";
      const pickerScript =
        picker === ""
          ? ""
          : `const pickerInput = document.querySelector("#story"); pickerInput.addEventListener("click", () => { document.querySelector("#story-picker").setAttribute("aria-expanded", "true"); document.querySelector("#story-options").hidden = false; browserEval.send("form.picker_expanded"); });`;
      // `?finishAfterMs=N` presses the extension's own RecordOverlay [结束] button from
      // inside the page after N ms — the same DOM control a human clicks. This is the
      // only way to exercise the browser-initiated (`user_finish`) stop while a
      // non-detached `record start` holds the session busy lock.
      const finishAfter = Number(query.get("finishAfterMs") ?? 0);
      const finishScript =
        Number.isFinite(finishAfter) && finishAfter > 0
          ? `let finishTicks = 0; const tryFinish = () => { const hosts = [...document.querySelectorAll("[data-bsk-overlay]")]; for (const host of hosts) { const btn = host.shadowRoot && host.shadowRoot.querySelector("[data-slot='record-overlay-finish']"); if (btn) { btn.click(); browserEval.send("form.finish_clicked"); return; } } if (finishTicks++ < 200) setTimeout(tryFinish, 100); }; setTimeout(tryFinish, ${Math.round(finishAfter)});`
          : "";
      return page({
        title: "Browser Eval Form",
        body: `<section class="card"><h1>Web form</h1><form action="/result" method="get"><input type="hidden" name="run" value="${escapeHtml(runId)}"><label>Text input<input id="text-input" name="text" autocomplete="off"></label><label>Textarea<textarea id="notes" name="notes"></textarea></label><label>Dropdown<select id="choice" name="choice"><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select></label>${picker}<button id="submit" type="submit">Submit</button></form></section>`,
        script: `document.querySelector("#submit").addEventListener("keydown", (event) => { if (event.key === "Enter") browserEval.send("form.enter_pressed"); }); ${pickerScript} ${finishScript}`,
      });
    }
    const values = {
      text: query.get("text") ?? "",
      notes: query.get("notes") ?? "",
      choice: query.get("choice") ?? "",
    };
    record("form.submitted", values, { path: pathname });
    return page({
      title: "Form Result",
      body: `<section class="card"><h1>Received!</h1><p id="submitted-values" class="marker">${escapeHtml(values.text)} | ${escapeHtml(values.notes)} | ${escapeHtml(values.choice)}</p></section>`,
    });
  },
};
