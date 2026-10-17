# Testing

Run the full check with:

```sh
npm ci
npm run check
```

The check runs formatting, TypeScript, unit tests, and the Playwright suite. The browser tests use Playwright's bundled Chromium, a temporary profile, and a native-messaging helper. They require permission to launch Chromium, local servers, and Unix sockets.

For individual suites:

```sh
npm test
npm run test:e2e
```

Set `HEADED=1` to show the test browser. Set `KEEP_E2E=1` to retain temporary profiles and logs for debugging.

The tests cover tab filtering, whole and paged reads, cache invalidation, loading pages, shared requests, pause and denylist enforcement, output limits, special documents, screenshots, MCP, setup, and helper lifecycle. Command tests compare active tabs, focused windows, and tab counts before and after each read.

## Browser coverage

Arc requires manual checks for tabs across spaces and extension reloads after upgrades. Run these in a separate browser profile. Browser-specific behavior can differ from the bundled Chromium fixture.
