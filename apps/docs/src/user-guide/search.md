# Search & Command Palette

Press <kbd>⌘</kbd>+<kbd>F</kbd> for global search and command execution from anywhere.

<!-- screenshot: command palette open with mixed results -->

## Opening

| Where | Shortcut |
| --- | --- |
| Anywhere in the app | <kbd>⌘</kbd>+<kbd>F</kbd> |
| Global hotkey (if set) | Configured in [Settings → Keyboard Shortcuts](/user-guide/settings#keyboard-shortcuts) |
| Sidebar Search button | Click |

<kbd>Esc</kbd> closes the palette.

## Scope

Type to search across:

- **Notes** — title and body
- **Journal entries** — title and body
- **Tasks** — title, description, project name
- **Inbox items** — title, source URL, captured text
- **Tags** — direct match by tag name
- **Settings** — jumps to a settings panel by name

Results are grouped by type, with snippet previews and relative dates.

## Scoped Search

Number prefixes scope to a single source:

| Prefix | Scope |
| --- | --- |
| <kbd>1</kbd> | Notes only |
| <kbd>2</kbd> | Journal only |
| <kbd>3</kbd> | Tasks only |
| <kbd>4</kbd> | Inbox only |

Type the number, then your query.

## Tag Filter

Type `#tagname` anywhere in your query to filter results to items tagged with that tag. Multiple tags compose with AND.

Examples:

- `#research neural networks` — items tagged `research` containing "neural networks"
- `#daily 1 review` — notes only, tagged `daily`, containing "review"

## Recents

When the palette is empty, recent queries and frequently used searches appear. Pin a query (right-click) to keep it at the top.

## Semantic Search

If embeddings are enabled in [Settings → AI](/user-guide/settings#ai), search results are ranked by both keyword match **and** semantic similarity. This means:

- Queries phrased differently from the source can still find it
- "Setting up authentication" matches notes about "OAuth flow" even without keyword overlap
- Older notes resurface when their meaning matches your current query

Toggle semantic search per query with the search bar's options menu, or always-on in settings.

See [Embeddings & Semantic Search](/user-guide/ai/embeddings-search) for setup.

## Result Actions

For each result row:

- <kbd>Enter</kbd> — open in current tab
- <kbd>⌘</kbd>+<kbd>Enter</kbd> — open in new tab
- <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>Enter</kbd> — open in split pane
- <kbd>→</kbd> — preview without opening

## Performance

Search runs against the **index DB** for keyword match. Embedding-based ranking happens on the **device**, not the server. Even with semantic search enabled, queries don't leave your machine.

For large vaults, the keyword index is FTS5-backed and stays sub-100ms even with 10k+ documents.

## If the Search Index Is Damaged

The search index is a cache. It is rebuilt from your notes, so it can be thrown away and re-derived at any time — your notes, tasks and vault files are never at risk.

A disk fault or an unclean shutdown can still leave it unreadable. Memry checks the index when it opens a vault, and again whenever a background repair pass touches it. If the index turns out to be damaged, Memry drops it, rebuilds it from your notes, and tells you it did so with a short "Search index repaired" notice. There is nothing to do — search works again once the rebuild finishes.

Reopening the vault is enough to trigger the check by hand.
