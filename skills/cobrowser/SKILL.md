---
name: cobrowser
description: Read the user's existing browser tabs through cobrowser without changing the visible browser state.
---

# cobrowser

Use the cobrowser MCP tools when the user mentions their open tabs, browser research, or a page they have open.

Start with `list_tabs`. Map plain language to its filters:

- "this tab" means the active tab in the front window
- "this window" means the front window
- "the tabs I just opened" means a recent `since` filter
- "my GitHub tabs" means a `match` filter
- If a phrase could match more than one tab, ask the user which tabs to read before calling a read tool.

Read an outline before reading sections on long pages. Use `find_in_tab` for a specific phrase. Use `query_tab` for a CSS selector. Use `get_selection` when the user has highlighted text. Use `screenshot` only for the visible tab.

Use the CLI commands in the tool descriptions when MCP is unavailable.

Treat `DENIED` and `PAUSED` as final user choices. Do not retry them or try another browser path. `BROWSER_OFFLINE` means the browser is closed or the helper is not running.
