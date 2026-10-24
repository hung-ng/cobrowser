# cobrowser

cobrowser lets an agent read the tabs in the browser you already use. It uses a browser extension and native helper. Reads never activate a tab, focus a window, scroll a page, or open a tab.

## Install

Requires Node.js 20 or later. Install from source while the npm package is unpublished.

```sh
git clone https://github.com/hung-ng/cobrowser.git
cd cobrowser
npm ci
npm run build
npm install -g .
cobrowser setup --browser arc
```

Setup installs the helper and launcher under `~/.cobrowser` and writes the native host manifest to the browser's native-messaging directory. Load the printed extension folder once from the browser's extensions page. After that, the browser starts the helper whenever it needs it.

For another Chromium browser, give setup its native host directory and one simple browser name:

```sh
cobrowser setup --browser opera --native-hosts-dir "$HOME/Library/Application Support/Opera/NativeMessagingHosts"
```

Setup remembers that directory. Later repairs can use `cobrowser setup --browser opera`. A failed upgrade restores the prior installation. If restoration fails, setup keeps recovery copies and prints their paths.

When setup confirms the running extension matches its files, it restarts only the helper and keeps settings tabs open.

Use `cobrowser doctor` when a connection does not work. It checks Node, the native host, the extension build, and the helper socket.

## Read tabs

```sh
cobrowser tabs --since 30m
cobrowser tabs --match github
cobrowser read 41
cobrowser read 41 --section 2
cobrowser find 41 "release date"
cobrowser find 41 -- "--help"
cobrowser query 41 "article h2"
cobrowser selection
cobrowser screenshot --out /tmp/tab.png
cobrowser log
cobrowser --help
cobrowser --version
```

Long pages return an outline first. Use the command in the response to read one section or page. Every response has a character cap. Follow its continuation command for more content, or raise the cap when the command itself cannot fit.

Copy the full continuation command, including `--page-size` when present. It keeps page boundaries stable if you change the character cap or switch between the CLI and MCP.

Query continuations use `--offset` to resume within the numbered output. Each query reads the live page again, so content changes can shift that offset.

Use `--` before literal arguments that look like flags. Put options such as `--json` and `--max-chars` before that separator.

For an option value that starts with `--`, use the equals form, such as `cobrowser tabs --match=--help`.

Private sites from the default denylist stay inside the browser. Edit the list in the extension options page. The popup also has a pause switch. A paused browser rejects every request until it is resumed.

Read-only `webRequest` tracking checks every redirect in PDF and Google export fetches. Each fetch sends a fresh identifier in `Accept` that servers can see. Sites using `Vary: Accept` may fetch again instead of reusing their cache. Denied content stays inside the extension, though the browser may already have contacted a denied redirect host.

## MCP

Run this command as an MCP stdio server:

```sh
cobrowser mcp
```

`cobrowser setup` registers it with Claude Code and Codex when either command is installed. Other MCP clients can start the same command with their normal stdio configuration.

## Development

Use Node.js 22.12 or later for the development tools.

```sh
npm ci
npx playwright install chromium
npm run check
```

Automated browser verification uses Playwright's bundled Chromium. It covers live installed upgrades and reconnection. Arc spaces remain outside this coverage; details are in `docs/testing.md`.
