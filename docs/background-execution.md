# Background execution (0.5.2)

## Contract

Opening with `active: false` and subsequent DOM/native actions no longer activate
the controlled tab, focus its window, or restore a minimized window. Explicit
`active: true` when opening a tab remains an intentional user/agent choice.
Safe/Risk/Read-only restrictions and existing profile/session ownership still apply.

An executor interaction owns a short, private CDP lease for the exact tab:

1. Revalidate ownership, mode, cancellation and document binding before attachment.
2. Attach only Tabora's debugger; never detach a competing debugger.
3. Enable `Emulation.setFocusEmulationEnabled` before DOM preparation and privacy
   masks, making the renderer act focused/visible without desktop activation.
4. Start a fixed `Page.startScreencast` stream (`jpeg`, quality 0, max 1 x 1 pixel).
   ACK only that target's frame events. Discard image bytes in the extension:
   no artifacts, logs, broker messages or provider input. This maintains rendering
   frames; it is not an image-reading channel.
5. Prepare and validate the exact observed element, dispatch fixed Chrome Input
   commands or bounded DOM actions, wait for the requested outcome, then observe.
   Input/capture reuse the same lease instead of attaching another debugger.
6. Stop rendering, disable focus emulation, detach, and remove listeners in finally,
   including when preparation, dispatch or verification fails.

The observed element's focus/identity/geometry checks remain in force. Background
execution removes only the requirement for OS window focus and an active tab.
Prepared writes are single-use; an uncertain dispatch is never blindly replayed.
There is no foreground fallback, `document.visibilityState` prototype patch,
virtual-clock manipulation, global Chrome flag or ordinary-profile file change.

Without the required `debugger` permission being granted by Chrome, ordinary DOM actions still
run without activation, but visibility-sensitive websites lack focus emulation.
Native input and image capture require that permission. Unsupported focus or
rendering commands fail before dispatch with a specific error. Native permission
dialogs, OS pickers, authentication handoffs, frozen/discarded pages and websites
with anti-automation restrictions remain separate limitations.

Executor concurrency remains bounded across profiles and within each profile.
This change does not introduce parallel session writes or serialize model inference.
Emulation is held during an interaction, not throughout model thinking or an idle
session. `browser_state` and ordinary reads do not acquire it.

## Inspiration

- [Playwright Chromium page implementation](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts)
  enables CDP focus emulation independently of its explicit bring-to-front method.
- [Nanobrowser page implementation](https://github.com/nanobrowser/nanobrowser/blob/master/src/background/browser/page.ts)
  attaches Puppeteer to the exact extension tab and uses page-target screenshots.
  Tabora retains fixed commands and document-bound targets rather than importing
  its arbitrary page-evaluation or shadow-DOM modification paths.
- [Chromium Page handler](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc)
  implements target screenshot capture and StartScreencast/StopScreencast through
  the video consumer. Tests below establish whether the technique helps our
  installed Chromium; the source alone does not prove compatibility or speed.

## Validation and timings

`npm run test:background` launches an isolated, plain Chromium with no global
timer/renderer-throttling overrides. Playwright connects using `noDefaults: true`;
the fixture must actually report `document.hidden === true` before execution and
again after cleanup. Product actions all traverse real MCP/native messaging and
the extension. A separate server counts actual commits and checks trusted events,
focus and visibility; browser state is independently inspected by the test harness.

Checks cover DOM action, native mouse, native fill/key, hover, HTML drag/drop,
masked target screenshot, capture-bound canvas click, competing debugger refusal,
minimized-window execution and same-tab navigation. The witness user tab stays
active, retains its editor value, and receives no tab-activation events during
execution. Run with `TABORA_BACKGROUND_HEADFUL=1` for a normal window.

The report at `reports/background/latest.json` includes six balanced warm pairs
of identical active/background native commits, excluding observation/preparation
and model inference from the stopwatch. Wall time includes MCP transport and CDP
lease setup/cleanup. Executor timings separately report native preparation, input,
readiness, observation and total time. This is an executor integration comparison,
not an independent full agent benchmark or evidence of superiority to other agents.
