# Search

Press <kbd>⌘</kbd>+<kbd>K</kbd> to search everything in the vault from anywhere in the app.

<!-- screenshot: search open with mixed results and the preview -->

## Opening

| Where                 | Shortcut                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Anywhere in the app   | <kbd>⌘</kbd>+<kbd>K</kbd> (rebindable in [Settings → Keyboard Shortcuts](/user-guide/settings#keyboard-shortcuts)) or <kbd>⌘</kbd>+<kbd>P</kbd> |
| Sidebar search button | Click                                                                                                                                           |

<kbd>Esc</kbd> closes search. When a filter menu is open, the first <kbd>Esc</kbd> closes the menu and the second closes search.

## Scope

Type to search across:

- **Notes**: title and body, and the text inside their HTML blocks (see [Text in HTML blocks](#text-in-html-blocks))
- **PDFs and images** filed in the vault, by the text inside them (see [Text in PDFs and images](#text-in-pdfs-and-images))
- **Journal entries**: title and body
- **Tasks**: title, description, project name
- **Inbox items**: title, source URL, captured text

Results are grouped by type. Each group shows its first five results; the last row of a longer group shows the rest. Every row has one hint on the right: the note's folder, the journal day, the task's due date, or the inbox item's site. A task row also shows its priority.

## Preview

The result you have selected is previewed beside the list. The preview never takes focus, so the arrow keys keep moving through results.

- **Notes and journal entries** show the folder, when the note was last edited, its word count and tags, the opening lines, and up to three lines where your words appear.
- **Tasks** show the project, status, due date, priority, repeat rule, and description.
- **Inbox items** show the source link, when it was captured, whether it has been filed, and the captured text.

In a window narrower than 720 px the preview is hidden and the list takes the full width.

## Filters

Filters narrow what the query matches. Each filter shows as a chip in the search field, and filters stack: Tasks plus This week plus `#work` finds this week's tasks tagged `work`.

- Type <kbd>/</kbd> into an empty search field to open the filter menu. Keep typing to narrow it, for example `/tas` for Tasks, then press <kbd>Enter</kbd>.
- <kbd>⌘</kbd>+<kbd>1</kbd> … <kbd>⌘</kbd>+<kbd>4</kbd> turn on or off Notes, Journal, Tasks, and Inbox.
- Type `#` at the start of the field or after a space to pick a tag. The list shows each tag with how many items carry it.
- The **Modified** filters (Today, This week, This month) narrow results to items changed in that stretch. They read your local calendar, so "Today" is your own midnight-to-midnight day rather than UTC's, and a note edited late in the evening still counts as today's.
- Click the × on a chip to remove it, or press <kbd>⌫</kbd> in an empty field to remove the last one.

When a filtered search finds nothing, search offers **Search everywhere** (drops the type filters) and **Clear filters**.

## Recents

When the search field is empty it shows your recent trail: the items you last opened from search, each with the query that led you to them. It is a way back to a note you found yesterday without remembering how you phrased it. Below the trail, **Search in** starts a search limited to one type or to a tag.

The trail is keyboard-navigable like any result list. <kbd>↑</kbd> / <kbd>↓</kbd> move between entries and <kbd>Enter</kbd> opens the highlighted one. **Clear** wipes the trail.

## Keys

The bar at the bottom names what <kbd>Enter</kbd> does for the selected row (Open note, Open task, Add filter, and so on). The same actions can be clicked there.

| Key                                          | Action                                      |
| -------------------------------------------- | ------------------------------------------- |
| <kbd>↑</kbd> / <kbd>↓</kbd>                  | Move the selection                          |
| <kbd>Enter</kbd>                             | Open the selected result in the current tab |
| <kbd>Tab</kbd> / <kbd>⇧</kbd>+<kbd>Tab</kbd> | Jump to the next or previous group          |
| <kbd>/</kbd>                                 | Filter menu                                 |
| `#`                                          | Tag picker                                  |
| <kbd>⌘</kbd>+<kbd>1</kbd> … <kbd>4</kbd>     | Notes, Journal, Tasks, Inbox filter         |
| <kbd>⌫</kbd> in an empty field               | Remove the last filter                      |
| <kbd>Esc</kbd>                               | Close the menu, then search                 |

A note opens in the editor, and a PDF or image filed as a note opens in the file viewer. A journal entry opens on its day, a task opens in its project's detail drawer, and an inbox item opens in the Inbox with the item highlighted.

While the search index is being built, the bottom bar shows its progress, and results may be incomplete until it finishes.

## Semantic Search

If embeddings are enabled in [Settings → AI](/user-guide/settings#ai), search results are ranked by both keyword match **and** semantic similarity. This means:

- Queries phrased differently from the source can still find it
- "Setting up authentication" matches notes about "OAuth flow" even without keyword overlap
- Older notes resurface when their meaning matches your current query

See [Embeddings & Semantic Search](/user-guide/ai/embeddings-search) for setup.

## Text in PDFs and images

Memry reads the text inside the PDFs and images you file in the vault, and inside the ones you paste or attach into a note, so search finds them by what is written on them. The snippet under the result shows the matching text.

- A filed PDF or image comes up as its own result and opens in the file viewer.
- A screenshot or PDF inside a note brings up that note. Removing it from the note removes its text from search, even though the file stays in the note's attachments folder.

- A PDF page that already carries text (a document saved or exported as PDF) is read from that text.
- A scanned page, a photo, or a screenshot goes through OCR. OCR runs on your device, and no file leaves the machine.
- OCR reads English and the app language by default. Choose more languages in **Settings > General > Text recognition**. English ships with the app and works offline. Every other language downloads once from Memry's server, a few MB each, and stays on this device. Memry uses a download only when it matches the file this app version expects.
- Adding a language reads the text of scans and images again in the background. Their old text stays searchable until then. Removing a language deletes its data and reads nothing again.
- When a download fails, OCR keeps reading with the languages already on the device. The setting shows why, and **Retry** tries again. Memry also tries again at the next start.
- The work runs in the background after the vault opens, one file and one page at a time, at low priority. A long scan becomes searchable while it is read, and a restart continues with the pages it has not finished.
- A file whose contents change is read again. Renaming or moving a filed file is not.
- A file that could not be read, or a page in it that could not be read, is tried again after an app update, or a day later.

The text lives in the index on this device and does not sync. Each device reads its own copy of the files, and rebuilding the index reads them again.

Agents read the same text through `vault_read_note` (see [Agent MCP](/user-guide/ai/agent-mcp#notes-and-filed-files)). Similar-notes suggestions use it too: a filed PDF or image can be suggested by its text and opens in the file viewer, and a note's attachment text counts toward that note.

## Text in HTML blocks

An HTML block (an `.html` file attached to a note, or one an agent adds with `vault_add_html_artifact`) is searchable by the text it shows. A match brings up the note that embeds the block.

- Only the visible text counts. Scripts, styles and the tags themselves are left out, and the block's scripts never run while it is read.
- A `[[wiki link]]` written in the block's text links the note like one in the note's body: it shows up in the graph, in the target note's backlinks and in `memrynote graph`. Link syntax inside code (`<code>`, `<pre>`, `<kbd>` or `<samp>`) is not a link, the same as inside code in a note's markdown. Its text is still searchable.
- Renaming a note does not update links to it inside HTML blocks. The block's file keeps the old title, so the link stops reaching the renamed note once the note that embeds the block is read again. Links to it in note bodies are updated as usual.
- `memrynote graph` reads the block text the desktop app stored for the vault, so it sees these links only after the app has opened the vault and read the block.
- The block's file is only read, never changed, so it keeps its scripts, styles and layout.
- A block file larger than 2 MB is not read for search. The block still shows in the note.
- A block whose file changes is read again when the note changes, when the file arrives through sync, and every time the vault opens. Removing the block from the note removes its text and links from search, the graph and backlinks.

Like the text in PDFs and images, it lives in the index on this device and does not sync.

## Performance

Search runs against the **index DB** for keyword match. Embedding-based ranking happens on the **device**, not the server. Even with semantic search enabled, queries don't leave your machine.

For large vaults, the keyword index is FTS5-backed and stays sub-100ms even with 10k+ documents.

## If the Search Index Is Damaged

The search index is a cache. It is rebuilt from your notes, so it can be thrown away and re-derived at any time — your notes, tasks and vault files are never at risk.

A disk fault or an unclean shutdown can still leave it unreadable. Memry checks the index when it opens a vault, and again whenever a background repair pass touches it. If the index turns out to be damaged, Memry drops it, rebuilds it from your notes, and tells you it did so with a short "Search index repaired" notice. There is nothing to do — search works again once the rebuild finishes.

Reopening the vault is enough to trigger the check by hand.
