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

Use `cobrowser doctor` when a connection does not work. It checks Node, the native host, the extension build, and the helper socket.

## Read tabs

```sh
cobrowser tabs --since 30m
cobrowser tabs --match github
cobrowser read 41
cobrowser read 41 --section 2
cobrowser find 41 "release date"
cobrowser query 41 "article h2"
cobrowser selection
cobrowser screenshot --out /tmp/tab.png
cobrowser log
cobrowser --help
cobrowser --version
```

Long pages return an outline first. Use the command in the response to read one section or page. Every response has a character cap, and a continuation command when more content exists.

Private sites from the default denylist stay inside the browser. Edit the list in the extension options page. The popup also has a pause switch. A paused browser rejects every request until it is resumed.

## MCP

Run this command as an MCP stdio server:

```sh
cobrowser mcp
```

`cobrowser setup` registers it with Claude Code and Codex when either command is installed. Other MCP clients can start the same command with their normal stdio configuration.

## Development

```sh
npm ci
npm run check
```

The native browser suite uses Playwright's bundled Chromium. Real Arc verification still needs a Mac with Arc, and the checklist is in `docs/testing.md`.
