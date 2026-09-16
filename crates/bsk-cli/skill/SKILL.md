---
name: browser-skill
description: |
  Use when the user asks to automate their logged-in Chromium browser: visit
  and read pages, fill forms, scrape data, click through flows, regression-test
  a PR's UI, validate a deployed page, or operate a tab they identify. Requires
  the bsk CLI and browser extension.
---

# browser-skill

Drive the user's real Chromium browser through `bsk`. Automation runs in an isolated **Agent
Window** with the user's existing logins and cookies. User-window tabs remain protected unless they
are explicitly borrowed.

Do not use this skill for tasks with no browser, for extension installation, or when the user only
wants instructions. Never extract credentials, cookies, tokens, or other secrets from pages.

## Required lifecycle

Every browser task owns a bounded session:

```text
1. bsk session start              # retain the printed 4-letter session id
2. bsk ... --session <id>         # pass it to every session-scoped command
3. bsk session stop <id>          # always run on success and error paths
```

Do not rely on the idle timeout for cleanup. Stop the session as soon as the goal is met unless the
user explicitly asks to keep it open. Stopping also returns borrowed tabs.

By default, browser commands auto-start the daemon when needed. Keep the shared daemon running;
task cleanup is `bsk session stop`, not `bsk daemon stop` or `restart`.

If the agent environment kills background children when each shell command ends (as reported for
Linux WorkBuddy), arrange a persistent daemon outside that per-command sandbox first. The user
can run `BSK_HOME=/absolute/shared/bsk bsk daemon start` in a normal host terminal. A host-managed
background task can instead run `bsk daemon start --foreground` with the same `BSK_HOME`, using
the host's approved execution path. Do not disable sandbox protection for browser task commands.

In that environment, pass `BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0` to **every** `bsk`
command. Replace the example path with one dedicated directory that both sides can access,
including its IPC socket; an `export` in one shell tool call may not persist to the next. If the
daemon is unavailable, ask for it to be started in the owning host environment; do not loop on
auto-start, guess a home directory, delete runtime files, or restart the shared daemon. A doctor
warning about local process identity does not prevent session commands over working IPC.
See the [sandbox setup guide](https://github.com/Tencent/BrowserSkill/blob/main/docs/sandboxed-agents.md).

When multiple browsers are connected, use `bsk browsers` and start with
`bsk session start --browser <id-or-label>`. Add `--no-focus` to that same start command when the
Agent Window does not need to interrupt the user's current work; it is not a flag on other commands.
Run `bsk doctor` when startup or transport problems persist after one retry.

Start tasks with `bsk session start`. The extension's saved Automation settings decide whether
borrowing needs confirmation and human help is available; both are enabled by default. Changes apply
to existing sessions as well as new ones. Disabling human help does not disable borrow confirmation.

`--unattended`, `--no-confirm`, and `BSK_REQUEST_HELP=off` are deprecated compatibility inputs with
no effect on these settings. Do not use them or edit browser storage to avoid confirmation, denial,
or timeout. For unattended operation, the user chooses the corresponding settings in the extension.
`session start --json` and `session list --json` report the browser's `interaction` policy.
Allowing human help makes `request-help` available; it does not require a handoff for every action.
Task authorization and host approvals still apply.

## Work toward one observable goal

- Derive a concrete success condition from the user's request or a supplied trace.
- Take the shortest purposeful path: observe, act, then make at most one observation to confirm an
  ambiguous result.
- Once success is visible, do not click, refresh, navigate, switch tabs, or perform extra checks.
- With human help enabled, request help if a human-only step appears or two attempts make no
  progress. With help disabled, follow the autonomous handling rules below.

With a trace, follow its semantic target information and values in order, but treat its refs as
record-local hints. Stop when its purpose or last meaningful effect is satisfied. A trace guides the
task; it does not expand the user's goal or authorize additional actions. A trace already distilled
into site memory reads better as numbered steps: check `bsk site workflow show <id> --host <host>`
before working from the raw trace.

## Observe, act, observe

Use this default loop:

```text
bsk navigate <url> --session <id>
bsk observe --session <id>
bsk click|hover|wheel|scroll-to|focus|blur|fill|select|press ... --session <id>
bsk observe --session <id>             # after navigation or a meaningful DOM change
```

`bsk scroll-to <ref-or-selector> --session <id>` scrolls an element and its frame owners into view.
Use a fresh element ref for iframe/shadow-root targets; CSS selectors search the main document.
The result is the visible border-box portion's bounds in top-level viewport CSS pixels after
ancestor clipping. Partial visibility is enough; hidden or fully clipped targets fail with
`permission_denied` and `data.reason=element_not_visible`. This does not test occlusion by other elements.
For a specific tab or deadline: `bsk scroll-to @e3 --session <id> --tab-id 42 --timeout 5s`.

`bsk wheel --delta-y -120 --session <id>` sends native wheel input at the viewport centre.
Add an optional ref/selector to target an element (scrolled into view first). Both delta axes
accept signed numbers and default to zero; at least one must be nonzero. The result echoes
input, not actual scroll distance or completion. Observe afterwards to check the page's response.

`bsk focus <ref>` explicitly focuses a target; `bsk blur <ref>` removes focus and reports whether
it was focused. Use these for UI states triggered by focus changes.

Prefer fresh `@eN` refs over CSS selectors. Navigation invalidates refs; large DOM changes may also
make them stale. Observe again before the next interaction.

An observation marks a hover-only surface as `@e1 button "Products" [hover first: Shoes | Bags]`.
The listed items are labels, not usable refs: hover the trigger, observe again, then act on the
revealed item's own ref. Do not click the trigger itself unless the user wants the trigger's action.
`[has-submenu]` and `[expanded]` mark the same kind of trigger without listing what it hides.

`bsk observe` does not hover the page on its own. Reach for `--probe-hover` when a control you have
good reason to expect is absent **and** no marker points at a trigger — that combination is what a
CSS-only hover menu looks like from here. It hovers a bounded set of likely triggers, so it costs a
few seconds and touches the live page; once you know which element hides the menu, `bsk hover <ref>`
is cheaper and more precise.

Escalate page reading only as needed:

1. `bsk observe` for normal semantic understanding, text, controls, and refs.
2. `bsk observe --probe-hover` once when an expected control is missing and no marker points at a
   trigger.
3. `bsk snapshot` when a stricter static accessibility tree is more useful.
4. `bsk get-html` for exact markup or hidden metadata that semantic views cannot provide.
5. `bsk screenshot` for layout, styling, canvas, images, or requested visual evidence.
   Use `--full-page` when the user wants a long screenshot of the whole ordinary webpage.

Do not start with raw HTML or screenshots merely to discover ordinary controls. When interaction is
needed, obtain a fresh observation before acting on screenshot or HTML findings.

## Canvas and observation continuation

`observe` may place `@eN canvas [visual:screenshot]` near related page controls. Names are
optional: do not infer a table title or controls inside Canvas from adjacent labels. Visual refs
support `screenshot --ref`; point clicks additionally require its `capture_id` and image coordinates.
They do not support fill/hover or HTML extraction. First observe returns text,
not an image. Use the surrounding semantics to decide whether a Canvas screenshot is needed.
If you cannot receive and understand images in this session, tell the user the Canvas contents
cannot be interpreted and ask them to switch to an image-capable model; continue with available
semantic information. BrowserSkill does not detect the model's capabilities.

There is no default token cap. With an explicit `--max-tokens` limit, an observation may return
`next_cursor` and an `@more` instruction. Use current refs before calling
`bsk observe --cursor <token> --session <id>`: each response replaces the ref map, so refs from
previous pages must not be reused. A response can contain many Canvas entries. Follow cursors
when relevant content remains, rather than repeatedly reading the same prefix.
Continuation reads the same captured observation; it does not refresh or hover the page. Do not
combine it with depth changes or hover probing. A new observe/snapshot replaces the continuation;
if the page identity changed, observe again. Screenshot execution checks current target identity
and geometry, but permits Canvas repainting and does not freeze pixels.

A Canvas screenshot can return `capture_id`. To click a point you identified in that image, use
`bsk click eN --capture <id> --image-x <x> --image-y <y> --session <id>`.
Use original PNG pixels (returned width/height), not resized display or viewport coordinates.
Captures are single-use, expire after two minutes, and are invalidated by a newer screenshot of
that ref or observation/continuation. With `capture_unavailable`, view the image but observe and
screenshot again before clicking. Click counts 1/2, buttons and modifiers are supported.
After clicking, observe or screenshot to verify the result; use DOM refs for revealed controls.
A completed click does not prove business success. Canvas repainting is allowed; changed identity,
geometry or hit target is rejected. If `effect_state=unknown`, inspect before retrying with a new
capture. Do not infer cell-editing, IME, drag or hover support from point-click capability.

## Respect the Agent Window boundary

Normal page writes affect only Agent Window tabs. To operate a user tab, first list it with
`bsk tab list --scope user --session <id>`, then `bsk tab borrow <tab-id>`. Return it immediately
after the relevant step with `bsk tab return <tab-id>`; never invent a tab id or keep a personal tab
borrowed across unrelated work.

`tab borrow --timeout 120s` changes the confirmation wait (default 60s), not whether approval is
required. Custom waits need daemon and extension protocol 1.2+. Compatible older peers can still
start sessions and borrow with their default wait. The current CLI's `request-help` needs daemon
protocol 1.3; an unsupported operation does not make the connection unusable. Update all three
components for full browser-setting enforcement; older programs may still end help locally.
Repeating a completed borrow in the same session returns
its existing result. Do not repeat pending requests, denied requests, or confirmation timeouts,
or switch to another browser tool to bypass them. If `reason` is `borrow_outcome_unknown`, inspect
tab and session state before continuing; the tab may already have moved.

## Ask the human when needed

When human help is enabled (the default), use `bsk request-help` for login, captcha, OTP, payment
confirmation, consent, or another step the user must complete. Give a precise prompt and pass
fresh `--target` refs/selectors when concrete controls can be highlighted. Use completion criteria
only when the page has a clear stable success signal.

The result `outcome` is one of `continued`, `completed`, `cancelled`, `timed_out`, or `disabled`
(`navigated` is deprecated — never treat navigation as a completion signal). After a human handoff,
resume only after `continued` or `completed`. Treat `cancelled` as rejection and `timed_out` as a
blocker; do not repeat that request. Observe again after control returns before using refs.

### User takeover

The user can press "Take over" in the Agent Window at any time. Then the session is held
(`control=user`) and every browser-input tool call is rejected with `tool dispatch rejected: the
user has taken over this session (control=user)`. That rejection means **stop acting**: do not
retry, and do not route around it through another tool. Run
`bsk session wait-control --session <id>`; it blocks until the user returns control and prints the
user's `note` (read it — it says what they changed). `bsk session status --session <id>` shows the
current state without blocking. Control returning does not restore your assumptions: re-snapshot
before continuing, because the user may have navigated, filled, or submitted something.

When help is disabled in the extension, make every
reasonable effort to complete the task autonomously with BrowserSkill. Do not call `request-help`.
If a call returns `disabled`, no human action was confirmed: re-observe and continue working rather
than marking the step blocked merely because help is unavailable.

Disabling help adds no permission: keep task authorization and host restrictions in force.
Use the current page, existing login state, and authorized credentials or codes to complete the
current step. Where the task authorization and host rules allow, a model with image understanding
may attempt graphical verification through screenshots and supported interactions. Phone-only QR
scans, face verification, and unavailable SMS codes may remain blocked; a text-only model may also
leave an image-only CAPTCHA unresolved. Attempt other authorized steps within available capabilities
and verify the actual result before concluding they cannot be completed.

After a failed attempt, re-observe and try a different viable approach when available. Do not loop
on identical failures or repeat an action whose outcome is unknown. Report a specific blocker only
when required information or capability is missing, or viable approaches are exhausted; continue
independent work. Do not re-enable help or switch browser backends to work around those limits.

## Command inventory

This list of names is complete. Never invent a command outside it; read
`bsk <command...> --help` for flags instead of guessing them.

```text
session start|stop|list|status|wait-control   browsers   status   doctor   update   logs
navigate   navigate-back   navigate-forward   reload   wait-for-navigation   wait-ms
observe   snapshot   get-html   screenshot   console   network
click   hover   wheel   scroll-to   focus   blur   fill   select   press   evaluate
tab list|create|close|select|borrow|return   window resize   emulate
upload   download   request-help   record start|stop
site context   site checkpoint
site workflow save|list|show|verify   site candidate add|list|show
```

Flags and argument forms that are easy to get wrong:

```text
bsk fill <ref> --value <text>      bsk select <ref> --value <option-value>
bsk screenshot --out <path>       bsk emulate --device <preset-id>
bsk upload <ref> --file <path>     bsk download <ref> --out <path>
```

`select` matches an option's `value` attribute, not its visible label. Device preset ids are
lowercase and hyphenated, such as `iphone-14`.

- `console` and `network` provide bounded, read-only debugging evidence.
- `emulate` applies viewport, user-agent, and touch overrides to one tab; new tabs do not inherit
  them. Use `--off` to restore the real environment.
- `evaluate` is a last resort when observe plus normal interactions cannot complete the task. With
  `--json`, inspect `.ok`: a JavaScript exception may still have CLI exit code 0 because the RPC
  succeeded. Never evaluate credential surfaces to read storage, cookies, or auth data.
- `record` captures actions for later replay — the user's, or with `--detach` your own. Read
  `bsk record start --help` before use, and never record banking, SSO, password-manager, or other
  sensitive pages.

## Screenshots

```sh
bsk screenshot --session <id> --out viewport.png
bsk screenshot --session <id> --ref @e3 --out element.png
bsk screenshot --session <id> --full-page --out page.png
bsk screenshot --session <id> --full-page --timeout 5m --out page.png
```

Without `--ref` or `--full-page`, capture only the visible viewport. `--full-page` and
`--ref` are mutually exclusive. Full-page mode scrolls the document from top to bottom,
follows content loaded during scrolling, and restores the original position and styles.
It is page input: use a selected, session-controlled tab in the Agent Window (create or
borrow first), keep the viewport stable, and respect user interrupts. `--tab-id` targets
a specific tab without selecting it. Chrome internal pages, the Web Store, nested scroll
containers and virtualized lists are not supported by automatic full-page capture.

Capture and PNG encoding default to two minutes. `--timeout` only applies with
`--full-page`; allow your shell runner enough time for that deadline plus file transfer.
Increase it for longer pages, but do not blindly retry an endlessly growing
page or a cancelled request. Ctrl-C cancels. Failure produces no partial output.
The CLI streams the PNG to disk and returns its path; `--json` also reports dimensions
and byte size. An existing `--out` file is replaced only after a full-page image is
received completely. Omitting `--out` uses a temporary path. No popup preview opens.
Use the matching CLI and extension builds; an unknown full-page RPC indicates an older
extension, not a reason to silently substitute a viewport screenshot.

## File transfer

`upload` and `download` stage files through the daemon; the agent never touches browser-internal
paths. Treat upload as disclosure to the website, download as accepting website-controlled bytes.

Upload has two independent mechanisms — choose explicitly, never rely on automatic fallback:

- **Default (input mode):** for upload buttons, file-input labels, or "upload from computer"
  actions. The command clicks the target and intercepts the native file chooser.
- **`--mode drop`:** for reliably identified attachment-receiving areas — an explicit drop zone,
  chat composer, email editor, or form attachment area. Do not target page whitespace, generic
  containers, or areas whose attachment ownership is ambiguous.

Decision sequence when uploading:

1. Try input mode (the default).
2. If it returns `reason=file_input_not_activated` with `effect_state=none`, re-observe. When a
   reliable attachment target exists, try `--mode drop` once against that target.
3. Otherwise request help if enabled; when disabled, follow the autonomous handling rules above.
4. **Never** switch mechanisms or repeat when `effect_state` is `unknown` or `committed` — the
   browser may already have applied the file.

A successful drop means Chrome dispatched the native file-drop event; it does not prove the site
accepted the attachment. Observe the page once after the command.

Download default-refuses to overwrite; pass `--overwrite` when replacing an existing file is
intended. Read `bsk upload --help` and `bsk download --help` for all flags and error details.

## Site memory

`bsk site` keeps local, per-host notes so an explored flow is not re-explored: a constrained
`SITE.md`, workflows derived from a recording, and candidate observations awaiting evidence. It is
private to this machine, needs no daemon, and never stores credentials or recorded input values.

```sh
bsk site context --host <host> --task <task-id>
bsk site workflow show <id> --host <host>
bsk site workflow save --from ./rec/trace.json --id <id> --task <task-id>
bsk site workflow verify <id> --host <host> --pass
bsk site candidate add --host <host> --kind better_path --claim "<one sentence>"
bsk site checkpoint --host <host> --task <task-id> --reason direct_correction
```

Three rules govern its use:

- **Read before acting.** When a task names a site, run `bsk site context --host <host>` first and
  follow what it already knows. Skipping it means repeating exploration the user already paid for.
- **Never explore to learn.** Only record what the task itself revealed. Do not click through extra
  pages, open unrelated flows, or probe a site to fill in memory.
- **Learning never fails the task.** These commands are advisory. If one fails, report it in one
  line and continue the user's actual goal. Do not retry it and do not let it block the task.

### Record the task you are already doing

To leave memory behind for a site you are working on right now, record your own run — no human
click-through, no second pass:

```sh
bsk record start --detach --url <start-url> --output ./rec --json   # prints session_id + tab_id
bsk observe --session <id>                                          # then do the real task
bsk fill @e4 --value "珠穆朗玛峰" --session <id>
bsk press Enter --session <id>
bsk record stop --output ./rec                                      # exports trace.json + states/
bsk site workflow save --from ./rec/trace.json --id <id> --task <task-id>
bsk site checkpoint --host <host> --task <task-id> --reason direct_correction
```

`--detach` returns as soon as recording is armed instead of blocking until the user clicks 结束, so
the session's busy gate stays free and your own commands are accepted. Without it `record start`
holds the session and every `observe/fill/click` comes back `session_busy`. Your CDP-driven actions
land in the bundle exactly like a human's.

`record stop` also ends the recording session, so there is nothing left to stop afterwards. For an
ordinary (unrecorded) session the id is a positional argument: `bsk session stop <id>`, not
`--session <id>`. Reusing a workflow later needs no recording at all — read it, run it, then
`bsk site workflow verify <id> --host <host> --pass`, which also clears NEEDS REVIEW.

Record only the task itself. Do not click extra pages, open unrelated flows, or take a detour to
make the recording "more complete" — a workflow derived from exploration teaches the next agent to
explore too. If the run goes wrong, `bsk record stop` still exports what happened; just do not save
a workflow from it.

`workflow save` writes into a per-task draft; `checkpoint` publishes it and takes an
`--expected-revision`. The revision counter is per host, so another site's checkpoint never
disturbs your draft. A `conflict` result means another writer committed first on *this* host.
Recover by re-running `bsk site context --host <host> --task <task-id>`: it re-seeds the draft's
`SITE.md` and `references/` from the published revision, which means **your own edits are gone
from the draft and must be replayed** on top of what you now read before you checkpoint again.
Workflows you staged in the draft are kept. The output says `draft.rebased: true` and carries a
one-line `hint` when this happened. Retry a conflict only once.

`context --task <id>` also lists the workflows staged in that draft, marked `"draft": true` — a
workflow you just saved is readable before it is published.

Recorded field values are never stored: `workflow save` turns each `fill` value into a named
parameter, so a saved workflow says which field to fill, not what the user typed. Pass
`--inline-values` only when the typed values belong to the flow rather than to the person who
recorded it. A `<select>` is different: its option `value` is a constant the site defines, so it
is kept inline and needs no parameter. Every host that looks like a banking, SSO, or
password-manager surface is refused by all of these commands.

## Recover without wandering

- Stale ref: observe again and retry the intended action once.
- Unknown tab or session: list current tabs/sessions; never guess identifiers.
- Timeout: inspect current page state before deciding whether one longer purposeful wait is useful.
- Fill result unconfirmed (`fill_value_mismatch`): observe the field first; the page may have
  formatted the value. Continue if the visible result satisfies the user's intent. Otherwise correct
  the remaining difference; do not blindly repeat fill or immediately request human help. For other
  fill errors, follow the returned hint and inspect current state before retrying.
- Unsupported command: continue with available capabilities; suggest updating only when the missing
  command is necessary.
- Unrecoverable failure: report the blocker and stop the session in a finally-style path.

The CLI's current help and error hints are authoritative for flags, parameters, and recovery
details.
