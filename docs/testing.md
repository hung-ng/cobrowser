# Testing

Use Node.js 22.12 or later for Vitest and the other development tools. The installed CLI and helper support Node.js 20 or later.

Run the full check with:

```sh
npm ci
npx playwright install chromium
npm run check
```

The check runs formatting, TypeScript, unit tests, the Playwright suite, and distribution checks. The browser tests use Playwright's bundled Chromium, a temporary profile, and a native-messaging helper. They require permission to launch Chromium, local servers, and Unix sockets. The CLI setup tests use private homes and agent config directories.

On a fresh Linux machine, use `npx playwright install --with-deps chromium` to install the browser and its system libraries.

For individual suites:

```sh
npm test
npm run test:e2e
npm run test:distribution
```

Set `HEADED=1` to show the test browser. Set `KEEP_E2E=1` to retain temporary profiles and logs for debugging.

The tests cover tab filtering, whole and paged reads, cache invalidation, loading pages, shared requests, pause and denylist enforcement, output limits, special documents, screenshots, MCP, setup, and helper lifecycle. They also follow capped tab lists, read pages across MCP, CLI JSON and socket clients, reject password selections, and preserve Unicode agent names in the log. Command tests compare active tabs, focused windows, and tab counts before and after each read.

Extraction tests preserve code blank lines and section headings, search visible phrases across Markdown formatting, keep Unicode matches in their excerpts, and distinguish empty rendered text from missing `innerText`. Paged reads reconstruct paragraph separators exactly. Selection tests cover open, closed and nested shadow roots, retained selections after blur, ordinary controls and API fallback. Captured native frames confirm that denied password selections send no text or mask length.

Markdown regressions cover list-contained fences, quoted tilde fences, quoted indented code and literal backticks next to inline code. CLI, MCP and socket reads preserve that code while converting prose links. Outlines, section reads and search keep the same section numbers after the code blocks.

Privacy regressions deny redirected documents during streaming and after caching, discard reads after a brief pause, and match encoded denylist paths. PDF fixtures cover literal operator names, credential redaction, physical pages, textless pages and bookmark destinations. Continuation tests reconstruct long queries through the CLI, socket and MCP without losing characters or cutting commands. MCP tests hold reads open while checking ping, independent tools, cancellation, concurrency limits and reused-connection deadlines.

Redirect tests check intermediate hosts through CLI, socket and MCP reads. They preserve ordinary and partitioned cookies, read cached redirect chains without network requests, isolate concurrent reads from unmarked fetches, and verify the existing CORS fallback and local PDF path. Scoped event-delivery faults exercise missing markers, ambiguous identity and invalid event order while Chromium still performs real requests. Deadline, trace-size, hop and 16-operation limits discard content and release their slots. Every command compares tabs, focus and scroll positions before and after.

The temporary profile enables Developer mode through the extensions page before tests start. Chromium accepts the initial command-line extension load without it, but disables the extension on reload. The reload test asks the helper to restart and verifies that the extension reconnects without changing browser state. It does not use an installed browser profile.

A separate Playwright CLI pass verified a live installed upgrade from 0.1.0 to 0.1.1 on macOS. Setup installed both the extension and native host in a private profile. The pass rejected an incomplete build, upgraded the running helper and extension, preserved pause and denylist settings, read a background tab, reran setup, and reopened the browser. With web pages active, both windows, all three tabs, the focused window and scroll positions stayed unchanged. The helper removed its socket when the browser closed and started again on reopening. Local screenshots and state comparisons are under `output/playwright/upgrade-check/`.

Chromium closes the extension's own UI tabs during `chrome.runtime.reload()`. The probe observed this with `popup.html` opened as a regular tab. If that tab is active, Chromium selects its neighbor. This differs from reading a web tab, which preserves the browser state. Setup reruns with regular web pages active passed the full state comparison.

The follow-up now avoids that reload when the assets are unchanged and the connected worker reports the installed revision. A fresh Playwright CLI pass verified that the active options tab, selected tabs, focused window and scroll positions survive while a new helper reconnects. Changed assets and stale or unknown workers still get a full reload. Its local evidence is under `output/playwright/upgrade-r4/`.

A later Playwright CLI pass upgraded an installed five-permission build to the build with `webRequest`. The private unpacked extension reloaded and reconnected without an approval click. Its actual running revision matched the new files, privacy settings survived, and tab IDs, selection, focus and scroll positions stayed unchanged. The installed CLI denied a forbidden intermediate host and read the same redirect chain when allowed. The browser, helper, server and installation were cleaned up. Evidence is under `output/playwright/permission-upgrade-r5/`. This verifies unpacked Chromium updates; it does not claim packaged-store update behavior.

The setup tests cover saved custom directories, shared-directory conflicts, missing installed files, ESM runtime metadata, agent registration upgrades, and failed installs. Fault probes run copied builds and verify that failed updates restore working files or preserve recovery backups. Agent registration tests preserve environment settings, tool policies and disabled state across regular and inline TOML layouts.

Concurrent setup tests hold private processes at filesystem boundaries and check that all registrations survive. They cover physical-root aliases, dead owners, replacement-lock cleanup and reserved lock paths. Manifest, empty-file and unreadable-file probes check rejection before replacement, doctor repair guidance and successful setup repairs. CLI tests check early error caps and literal flag-shaped search arguments through their actual continuations.

Options tests save from multiple editors and verify the resulting policy through the CLI and socket. They cover unseen additions and removals, queued edits, dirty drafts, delayed replies, storage failures, capacity limits and exact default resets. Refresh cases check events from both before and after the acknowledged write. Saves also work while the native helper is offline.

Helper-process tests coordinate simultaneous starts and socket replacement through a private Node preload. They verify that failed binds, stale probes and old-process shutdown leave the surviving helper reachable through the socket and CLI. Privacy tests compare capture-time document epochs across same-URL reloads, changing policies and byte-bounded guard batches. Link tests preserve code while converting nested list links, and continuation tests follow every returned command at small caps.

Screenshot tests delay real Chrome API delivery while synthetic local pages switch in the requested window. Before the fix, the public socket and CLI returned one tab's pixels with the other tab's ID. The regression now rejects the capture before sending a native image or writing an output file. Controls cover stable targets, switches in another window, pause and same-URL reload.

Distribution checks build and pack a temporary source copy, install it with an empty offline npm cache, remove access to development dependencies, and exercise the installed CLI and copied helper/client runtime inside a CommonJS project. They also cover failed builds and failed rollback. Set `COBROWSER_TEST_NODE` to an absolute Node binary path to check runtime compatibility separately from the development Node version.

## Browser coverage

The full check passed on macOS and Debian 13 arm64 in an isolated OrbStack VM on 2026-10-23, with 114 unit tests, 298 browser and CLI integration tests, and four distribution scenarios on each platform. The Linux run used Node.js 22.23.4 and `COBROWSER_TEST_NODE=/opt/cobrowser-node20/bin/node` to verify the installed CLI, copied runtime, helper and client on Node.js 20.19.2. Both platforms read the fixture's native host manifest from `<user-data-dir>/NativeMessagingHosts/cobrowser.json`.

Playwright Chromium is the acceptance path selected for this work. It does not model Arc spaces or prove Arc-specific behavior. Direct Arc checks can add browser-specific evidence when that browser is available; they do not block this automated validation.
