# Creating & Editing Notes

memrynote's editor is built on **BlockNote** — a block-based rich text editor with full markdown support. Every paragraph, heading, list item, code block, and image is a block you can drag, duplicate, or delete.

<!-- screenshot: note editor with the slash menu open -->

## Creating a Note

| How                                      | What you get                          |
| ---------------------------------------- | ------------------------------------- |
| <kbd>⌘</kbd>+<kbd>N</kbd>                | Untitled note in the current folder   |
| Sidebar **+** affordance                 | Same, scoped to the section you click |
| From a [Template](/user-guide/templates) | New note seeded with template content |
| `[[New title]]` in another note          | Linked note created on first save     |

The new note opens in a tab. The title field has focus.

The sidebar follows along: the folder the note landed in is opened — nested folders included — and
the note is scrolled into view and briefly highlighted, so you can see where it went without going
looking for it. This matters most when the note did not land where you were standing: with **Create
in Selected Folder** off and a **Default Location for New Notes** set, the note goes to that folder,
and the sidebar takes you there. It is the same jump as **Reveal in navigation** in a note's `⋯`
menu.

Every way of making a note does this: <kbd>⌘</kbd>+<kbd>N</kbd>, the sidebar's **New** button, the
**New note** icon on the Collections header, the tab bar's **+**, and **New note** on a folder's
right-click menu — including when that folder is closed.

## Block Types

Available from the slash menu (`/`) or the block-handle drag-out:

- Paragraph
- Heading 1, 2, 3
- Bullet list, numbered list, check list
- Quote, callout
- Code block (language picker)
- Divider
- Image, file
- Table
- Wiki-link block (or inline `[[...]]`)

## Slash Commands

Type `/` anywhere in the editor to insert a block. Filter by typing — `/h2` jumps straight to Heading 2. Press <kbd>Enter</kbd> to confirm.

## Markdown Shortcuts

Common markdown shortcuts work inline:

| Type         | Becomes       |
| ------------ | ------------- |
| `# `         | Heading 1     |
| `## `        | Heading 2     |
| `- `         | Bullet list   |
| `1. `        | Numbered list |
| `[ ] `       | Check list    |
| `> `         | Quote         |
| `**bold**`   | **bold**      |
| `*italic*`   | _italic_      |
| `` `code` `` | `code`        |
| ` ``` `      | Code block    |

## Title

The title is editable inline at the top of the editor. Renames are live — the title updates in tabs, the sidebar, search, and any inbound wiki links.

If you leave the title empty, memrynote generates a fallback ("Untitled" or the first heading).

Titles become filenames in your vault, so characters that are invalid in filenames or break
Obsidian wiki links (`< > : " / \ | ? * [ ] # ^`) are stripped on save — a note titled
`Draft [v2] #1` is saved as `Draft v2 1.md`. Existing files are never renamed retroactively.

## Note Menu

The **⋯ button** in the top-right of a note (the _More actions_ menu) collects note-wide and file actions, so you can act on the note you are viewing without going back to the list.

**View & tools**

- **Local graph** — show or hide the note's local link graph
- **Find…** — open in-note search (also <kbd>⌘</kbd>+<kbd>F</kbd>)
- **Version history** — browse and restore past versions
- **Export** — export the note to PDF or HTML
- **Apply template** — insert a template into the note
- **Full width** — toggle the wide editor layout

**File actions**

- **Rename…** — moves focus to the title so you can rename in place
- **Move to folder…** — move the note into another folder
- **Copy path** — copy the note's vault-relative path
- **Reveal in Finder** — show the `.md` file in your operating system's file manager (Finder on macOS, File Explorer on Windows, your file manager on Linux)
- **Reveal in navigation** — highlight the note in the sidebar
- **Open in default app** — open the `.md` file in your system's default editor

**Local only** keeps the note on this device (never synced).

**Delete note** moves the note to the trash after a confirmation, then closes its tab. This does the same thing as deleting from the note list — you no longer need to close the note first.

## Drag-and-Drop Blocks

Hover the gutter on the left to reveal the block handle. Drag a block to:

- Reorder within the note
- Move out into a different note (drop on a sidebar item or another open tab)

## Selecting Text and Blocks

Dragging that **starts inside a line** always selects text, however far it travels and in whatever direction. Dragging straight down across several paragraphs selects the text between the two points, exactly as dragging diagonally does.

To select whole blocks instead, start the drag **outside the text column**:

- the gray margin to the left or right of the column
- the bullet or number in front of a list item
- the strip to the left of an indented block
- a block with no editable text of its own — a task, a file or a video
- the empty area below the last block

A selection box follows the pointer and every block it touches is highlighted, the same way selecting files works in a file manager. The box only appears once you have moved a few pixels, so a plain click in the margin still just puts the cursor at the end of the note.

A bookmark card is the one exception: its whole surface is a link, so clicking it opens the link and a drag has to begin in the margin beside it instead.

With blocks selected, <kbd>Backspace</kbd> deletes them, <kbd>Tab</kbd> and <kbd>Shift</kbd>+<kbd>Tab</kbd> indent and outdent them, and <kbd>Esc</kbd> clears the selection.

One consequence worth knowing: the empty space to the right of a short line still counts as that line's text, so the right-hand margin outside the column is the place to begin a right-side block selection.

## Saving

Saves are **automatic and debounced** (default ~1 second). Changes also flush on:

- Tab close
- App quit
- Sync push

You can flush manually with <kbd>⌘</kbd>+<kbd>S</kbd>. Auto-save delay is configurable in [Settings → Editor](/user-guide/settings#editor).

## Word Count

If enabled in [Settings → Editor](/user-guide/settings#editor), word count appears in the editor footer.

## Spell Check

Off by default. Turn on **Check Spelling** in [Settings → Editor](/user-guide/settings#editor) to underline misspelled words as you write.

## Toolbar

The formatting toolbar can be sticky at the top or float above selections — choose in [Settings → Editor](/user-guide/settings#editor).

Both modes offer the same formatting controls: the block type (paragraph, heading, list) plus inline styles, alignment, colour, indent, and links. The block type control is hidden for blocks that have no alternative type, such as tasks, callouts, and files.

### Turning existing lines into a list

Select the lines — a whole pasted block of them if you like — and press **Bulleted list**, **Numbered list**, or **Check list** on the toolbar. Every selected line is converted, not just the one holding the cursor, and pressing the same button again turns them back into paragraphs. Blocks that cannot become list items, such as tasks and files, are left as they are.

## Text Formatting

Bold, italic and strikethrough are written to the vault as plain Markdown (`**bold**`, `*italic*`, `~~strike~~`).

Markdown has no syntax for underline, text color or highlight, so those are written as inline HTML, which Obsidian renders:

```md
<span style="text-decoration:underline">underlined</span>
<span style="color:red">red</span>
<span style="background-color:yellow">highlighted</span>
```

Color and underline are kept on separate nested spans, so an older version of MemryNote opening the same vault still reads the color.

Formatting applied in MemryNote round-trips. Underline written any other way — Obsidian's `<u>` tags, for example — is not read back, and is dropped the next time MemryNote saves the note.

## Link Previews

Links in a note are enriched with the page title, site name and favicon, both for inline link mentions and for bookmark blocks. The lookup runs once per URL and the result is kept in memory, so reopening a note with the same links does not refetch them.

That in-memory cache holds the 200 most recently used links and evicts the least recently used entry beyond that, which keeps a long session with many link-heavy notes from growing without a limit. Evicted links are simply fetched again the next time they are shown.

## Comments

Select text to open the floating toolbar. **Comment** creates an anchored review card in the right rail; selecting the text itself does not open the rail. The right rail aligns each card beside the marked text. Comment cards can be resolved or deleted.

Comments can carry file attachments. Image attachments show an inline thumbnail; clicking an image or PDF opens it in the in-app viewer (close with Esc, a click outside, or the ✕). Other file types open in your operating system's default app.

### Formatting a Comment

Comment text supports bold, italic, underline, strikethrough and inline code. Select text inside the comment box and a small toolbar appears above the selection, or use the usual shortcuts:

| Shortcut                                   | Mark          |
| ------------------------------------------ | ------------- |
| <kbd>⌘</kbd>+<kbd>B</kbd>                  | Bold          |
| <kbd>⌘</kbd>+<kbd>I</kbd>                  | Italic        |
| <kbd>⌘</kbd>+<kbd>U</kbd>                  | Underline     |
| <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Strikethrough |
| <kbd>⌘</kbd>+<kbd>E</kbd>                  | Inline code   |

Markdown shortcuts work too — typing `**bold**` or `` `code` `` formats as you type. The toolbar stays hidden while the `@` mention picker is open.

The comment text itself is stored in your note file as plain text, with the formatting recorded separately alongside the comment's other metadata. Comments written before this feature keep rendering exactly as they did, and a comment you format still reads cleanly if you open the note in another markdown editor. Editing a comment's text outside memrynote drops its formatting rather than applying it to the wrong words.

## What Notes Are Made Of

Under the hood, every note is a Yjs CRDT (`Y.Doc`). Markdown is a derived export, not the canonical form — this is what lets edits from two devices merge cleanly. See [CRDT & Notes Sync](/architecture/crdt) for details.

## Very Large Files

A markdown file can be too big to edit. memrynote decides this when the file arrives in the vault,
and it uses two limits, not one:

| Limit                                                | Value  |
| ---------------------------------------------------- | ------ |
| File size                                            | 1 MB   |
| Largest run of lines with no blank line between them | 128 KB |

A file has to clear **both** to open as an editable note. 1 MB is around 150,000 words — several
novels — so ordinary notes, however long, are nowhere near it.

The second limit is the one that catches log dumps, exported transcripts and pasted data. What
makes markdown slow to open is how dense one unbroken run of lines is, not how many bytes the file
has: 128 KB of paragraphs opens in about 50 ms, while 128 KB of table rows or minified JSON takes a
full second. A file with no blank lines in it is one block, however long it is.

A file that misses either limit still appears in the sidebar. Opening it shows the file in a
read-only viewer instead of the editor, under a bar naming its size, the limit it passed, and
**read-only · not synced**:

- It does not open in the editor, so it cannot be edited in memrynote.
- It is not synced to your other devices.
- **The file on disk is not touched.** Nothing is truncated, rewritten or deleted, and you can
  still open it in any other editor.

The limits apply to notes arriving over sync too. A device still running an older version can send
you a note that is over them; memrynote keeps every byte of it and writes the file to your vault,
but opens it read-only rather than in the editor, exactly as if you had dropped it in yourself.

### Reading a large file

The viewer scrolls the file without loading it. On first open it makes one pass over the file to
find where each line starts, showing a progress bar while it does; after that, scrolling anywhere in
the file is instant, and only the lines on screen are read. Switching tabs and coming back does not
repeat the pass.

The file is set the way a note is — same type, same width, no line numbers and no gutter.

Three things to expect:

- **No editing.** There is no cursor and no way to type. Use Reveal in Finder or your own editor to
  change the file.
- **Long lines wrap.** A line wider than the pane continues on the next line, as a note's text does.
  There is nothing to scroll sideways to, and nothing sitting past the edge.
- **Very long single lines are cut.** A line longer than 64 KB — minified JSON, for example — is
  shown up to that point and marked `long line cut here` at the end of the wrapped text. The rest of
  the line is still on disk, untouched.

Because lines wrap, a row is as tall as the pane's width makes it, and that is only known for the
part of the file you have looked at. In a file of very long lines the scrollbar is an estimate: it
settles as you read, so it can shift while you scroll through a stretch for the first time. Which
line you are on is never affected — only how far along the bar says you are.

The viewer opens files up to **2 GB**. Above that, the file still appears in the sidebar, and
opening it explains that it is past the limit and offers to open it in your default app or show it
in your file manager.

### Finding text in a large file

Search does not index these files, so the global search box will not find anything inside one. The
viewer has its own find instead, on the same shortcut as everywhere else — `Cmd/Ctrl+F` — or from
**Find** in the note menu.

Type and it searches the whole file, not the part on screen. `Enter` moves to the next match,
`Shift+Enter` to the previous one, and `Esc` closes the bar. Matches are highlighted on the lines
you can see, and moving between them scrolls the file to each one.

Three things worth knowing:

- **The count grows while it searches.** A pass over 2 GB takes a few seconds, so the bar shows
  `12 so far…` until it has crossed the whole file, then settles on the final count.
- **Only the first 2,000 matches are navigable.** A query matching a million lines still reports the
  real count, shown as `1/2000 of 1000000`; `Enter` walks the first 2,000. Narrow the query to reach
  the rest.
- **Case is ignored for A–Z only.** `error` finds `ERROR`, but `é` does not find `É`.

Notes you already have keep working exactly as before — nothing is re-scanned or re-indexed, and
existing notes under these limits are unaffected.

## When a New File Appears in the Sidebar

Dropping a file into your vault folder from Finder or Explorer shows it in the sidebar
straight away, whatever its size. To draw that row memrynote reads only the filename and the
file's timestamps — not the file itself. A quarter-gigabyte paste costs the same as a one-line
note.

Everything that needs the file's contents happens a moment later, in the background, smallest
file first:

- word count
- the preview snippet under the note title
- search

So a brand-new row can briefly show no word count and no snippet. That is the measurement not
having arrived yet, not an empty note — it fills itself in within a second or two for ordinary
notes, and a little later for very large ones. Nothing is lost if you quit before it finishes;
the file is measured again next time it changes.

Very large files are measured in pieces rather than loaded all at once, so even a file too big
to fit in memory gets a word count and becomes searchable. For those, search covers the
beginning of the file rather than all of it.
