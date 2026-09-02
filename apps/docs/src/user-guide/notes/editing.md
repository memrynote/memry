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
- Heading 1 through 6
- Bullet list, numbered list, check list
- Quote, callout
- Toggle list (collapsible section — nest text, images, even other toggles inside it)
- Code block (language picker)
- Divider
- Image, file
- Table
- Wiki-link block (or inline `[[...]]`)

## Tables

`/table` inserts a table with a header row and two body rows. The header row is
part of the table, not a style: notes are stored as markdown, and a markdown
table always writes its first row as the header.

Use the row and column handles on the edge of a table to toggle a header row or
a header column on and off. The same table controls are available in task
descriptions and in inbox items.

A column width you drag is kept when you leave the note and when you restart the
app. Like cell colours, it is stored as a comment line above the table that
other markdown editors ignore. Row heights are not stored, because the editor
has no row height to store.

### The handles on the border lines

Put the pointer in a cell and three small grey marks appear, on the table's own
border lines rather than floating beside it:

| mark                                             | where        | opens                                                             |
| ------------------------------------------------ | ------------ | ----------------------------------------------------------------- |
| on the table's left edge, beside the cell's row  | outer border | the **row** menu — delete the row, insert one above or below      |
| on the table's top edge, above the cell's column | outer border | the **column** menu — delete the column, insert one left or right |
| on the cell's own right border                   | inner border | the **cell** menu — **Colors**, and splitting or merging          |

Hover a mark and it grows into a small six-dot button; click it for the menu.
A mark's clickable area reaches a few pixels either side of the line it is
drawn on, so you do not have to land on the line itself — it is easier to hit
than it looks.

Row and column live on the table's outer edges on purpose. An inner vertical
line belongs to two cells at once — the line to a cell's left is the line to
its neighbour's right — so a mark there would be ambiguous about which one it
meant. The one inner line that is used, a cell's right border, belongs to the
cell menu, which is the only one that acts on a single cell.

While the cursor is in a cell, that cell is outlined in your accent colour, and
that one column edge cannot be dragged to resize — the mark sits on the same
line, and resizing would take the pointer before you could click it. Every
other edge resizes as usual; click into another cell to resize that one. The
marks stay up while you move along that edge, so the cell you are typing in is
the easiest one to open a menu for, not the hardest.

### Selecting cells

Drag across cells to select them. The selection is a range of cells, and
Backspace clears what is inside them and leaves the table standing. To select
the table itself as a block — to move it or delete it whole — start the drag in
the margin beside it rather than inside a cell.

### Row and column actions from the keyboard

The marks are raised by hover, which a keyboard and a touch screen do not have.
With the cursor in a cell, press **Ctrl/Cmd + Shift + Enter** — or **Shift + F10**,
or the **Context Menu** key — to open one menu holding both sets of actions:

- Delete row, Add row above, Add row below
- Delete column, Add column left, Add column right

The menu is titled with the cell it will act on (`Row 2 · Column 2`, counting
from one and counting the header row), and a screen reader announces the same
row and column as the menu's name. Move through it with the arrow keys, run an
item with Enter, and press **Escape** to close it — the cursor returns to the
cell it was opened from.

Cell colours and splitting or merging stay on the cell mark for now.

### Cell colour and formatting

Open a cell's right-hand mark and choose **Colors** to set that cell's text or
background colour. Bold, italic, underline, links and mentions all work inside
a cell exactly as they do in a paragraph — select the text and use the toolbar
or the usual shortcuts.

A markdown table has no column for a cell colour, so Memry writes it on a
comment line just above the table, the same way a coloured paragraph is stored:

```text
<!-- table-colors:{"1:0":{"backgroundColor":"red"}} -->
| Task | State |
| --- | --- |
| Shipping | Open |
```

The key is the cell's position — `row:column`, counting from zero and counting
the header row. Other markdown editors ignore the comment and show the table
normally. Text styles need no such line: markdown carries them itself.

## Slash Commands

Type `/` anywhere in the editor to insert a block. Filter by typing — `/h2` jumps straight to Heading 2. Press <kbd>Enter</kbd> to confirm.

## Markdown Shortcuts

Common markdown shortcuts work inline:

| Type         | Becomes       |
| ------------ | ------------- |
| `# `         | Heading 1     |
| `## `        | Heading 2     |
| `###### `    | Heading 6     |
| `- `         | Bullet list   |
| `1. `        | Numbered list |
| `[ ] `       | Check list    |
| `> `         | Quote         |
| `**bold**`   | **bold**      |
| `*italic*`   | _italic_      |
| `` `code` `` | `code`        |
| ` ``` `      | Code block    |

## Quotes

A quote can hold more than one paragraph. A blank quote line separates them, and a quote
indented inside another one stays nested:

```md
> [!note] Outer callout
> Outer body text
>
> > [!warning] Inner callout
> > Inner body text
```

Both survive a save, byte for byte. A note written in Obsidian with multi-paragraph or
nested quotes opens here and is written back exactly as its author wrote it, so the two
apps can edit the same vault without either one reflowing the other's quotes.

A nested quote written without the blank line between the levels (`> Outer` directly
above `> > Inner`) keeps its nesting too, but not its exact bytes: the blank quote line
is added on the first save, and the file stops changing after that. Markdown reads both
spellings as the same nested quote, and a note can only be saved in one of them.

## Toggle lists

A toggle is written to disk as a `<details>` section, so GitHub and Obsidian render it as
a real collapsible block. The blank lines around it belong to whoever wrote the file: an
extra blank line above a toggle, below it, or between two of them is still there the next
time the note is opened.

Two shapes are deliberately left alone rather than adopted:

- A `<details>` written by hand, without Memry's own marker attribute, does not become a
  toggle. It stays exactly as its author wrote it, tags and all, so a vault shared with
  Obsidian keeps its hand-written collapsible sections.
- A toggle whose closing `</details>` is missing — half-typed, or cut short in transit —
  is not closed for you. Its `<details>` and `<summary>` lines stay in the note as
  literal text, so nothing is lost; close the block by hand and it becomes a real toggle
  on the next open.

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
- **Export** — export the note to PDF or HTML. Both formats embed the note's images in the exported file itself, so the PDF prints them and an exported `.html` keeps them after you move or send it
- **Apply template** — insert a template into the note
- **Full width** — toggle the wide editor layout

**File actions**

- **Rename…** — moves focus to the title so you can rename in place
- **Move to folder…** — move the note into another folder
- **Copy path** — copy the note's vault-relative path
- **Reveal in Finder** — show the `.md` file in your operating system's file manager. The item is named for the one you have: **Reveal in Finder** on macOS, **Show in Explorer** on Windows, **Show in file manager** on Linux
- **Reveal in navigation** — highlight the note in the sidebar
- **Open in default app** — open the `.md` file in your system's default editor

**Local only** keeps the note on this device (never synced). Both halves stay put — the note's
details and its text — and editing is unaffected. Turning it back off uploads the note again,
including everything you wrote while it was local only.

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

Inside a table, dragging selects **cells**, not blocks — a drag from one cell to another selects the range between them, and <kbd>Backspace</kbd> then clears those cells and leaves the table standing. To select the table itself as a block, begin the drag in the margin beside it, the same as for any other block.

With blocks selected, <kbd>Backspace</kbd> deletes them, <kbd>Tab</kbd> and <kbd>Shift</kbd>+<kbd>Tab</kbd> indent and outdent them, and <kbd>Esc</kbd> clears the selection.

Text selected across several blocks works the same way: <kbd>Tab</kbd> and <kbd>Shift</kbd>+<kbd>Tab</kbd> indent and outdent every block the selection touches, and a single undo reverts the whole step. A block that is already as far left as it can go is left where it is; the rest still move.

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

Open the context menu on an underlined word to correct it. Suggestions sit at the top of the menu; picking one replaces the word. **Add to Dictionary** teaches the spellchecker the word so it stops being flagged, on this and future runs. Words with no suggestion show a disabled **No Suggestions** entry.

Memry does not pick a spellchecking language of its own. macOS detects the language you are writing in; Windows and Linux use the dictionary for the system locale.

## Toolbar

The formatting toolbar can be sticky at the top or float above selections — choose in [Settings → Editor](/user-guide/settings#editor).

Both modes offer the same formatting controls: the block type (paragraph, heading, list) plus inline styles, alignment, colour, indent, and links. The block type control is hidden for blocks that have no alternative type, such as tasks, callouts, and files.

The floating toolbar also carries **inline code** (`` `code` ``) next to bold, italic, underline and strikethrough, and ends with a full-width **Comment** button that opens a comment on the selection.

Opening the context menu stands the floating toolbar down, so you get one menu rather than two. It returns on your next click or keystroke.

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

### Text alignment

Centring a paragraph, or aligning it right or justified, is kept when you leave the note and when you restart MemryNote. Markdown has no syntax for alignment, so it is stored as a comment line above the paragraph (`<!-- align:center -->`) that other markdown editors ignore. Left alignment is the default and writes nothing.

### Text colours

The nine text colours are tuned so each one is legible and tellable apart from the others in every theme. Each clears the WCAG AA contrast floor for small text against the page, carries enough colour to be nameable rather than reading as grey, and stays clear of the default body text. Grey is the deliberate exception: it stays neutral, and reads as a muted colour rather than a hue.

Two consequences worth knowing:

- Yellow is a gold rather than a lemon. A yellow light enough to look like lemon cannot meet the contrast floor against a white page.
- Brown, orange and yellow share a warm range, so they are separated by how dark they are. Brown is the darkest of the three.

Colours are stored by name, not as a fixed shade, so notes you coloured in an earlier version pick up the current tuning when you open them. Highlight (background) colours are unchanged — a filled background does not need the same treatment to stay readable.

## Pasting a Link

Pasting a URL offers four ways to keep it: plain **URL**, an inline **Mention** pill, an **Embed** (for a video the app recognises), or a **Bookmark** card.

This works inside a table cell too. **Mention** replaces the pasted URL in that one cell and leaves the rest of the table alone. **Embed** and **Bookmark** are blocks in their own right and a cell holds text only, so they take the URL out of the cell and place the card after the whole table.

## Pasting into a Table Cell

Pasted text is normally read as Markdown, so a pasted `# Heading` becomes a heading and a pasted `| a | b |` becomes a table. Inside a table cell that reading is switched off: a cell holds text, and text is what you get. Paste a row of pipes into a cell and you get a row of pipes, not a second table spliced over the one you are editing.

Two things follow from a cell holding a single line of inline content:

- Pasted line breaks stay inside the one cell. A Markdown table row is a single line, so they are saved as spaces — the words all survive, the line breaks do not.
- Copying **cells** rather than text still pastes as cells. A cell or a range of cells copied from a table in memrynote keeps its shape and fills the grid from wherever the cursor is, the way a spreadsheet does.

## Images in a Table Cell

A table cell can hold a picture as well as text. With the cursor in the cell, type `/image` and pick a file, paste an image, or drag an image file onto the cell — it lands inside that cell rather than after the table, and text can sit on either side of it.

Pasting works for a picture you copied as well as one you have as a file — from another note, from a web page, from a document. A cell holds text and pictures, not blocks, so a copied picture is placed inside the cell rather than dropped on the floor, which is what used to happen. Two things are deliberately left alone: a paste that mixes a picture in with text is handed to the ordinary paste, and a picture stored inside another note is not taken, because its path is written relative to that note and would arrive here already broken.

The image is written into your note as ordinary markdown, `![name](path)`, so the row stays a normal table row that Obsidian and any other markdown editor can read. A table you wrote by hand with images already in it now opens with those images showing, instead of an empty cell.

A cell image with no size of its own is capped at the height of a few lines, so one large screenshot cannot stretch a row out of shape. To give one a size of its own, hover it and drag the handle on its trailing edge — the picture keeps its proportions and the row grows with it.

That width is saved into the note as `![name|300](path)`, the same `|` convention Obsidian uses, so the size survives a sync and other markdown editors still read the row as an ordinary table row. Obsidian's two-number form (`name|300x200`) is left exactly as written rather than rewritten to a single width.

Outside a table, an image on its own line is still a full image block with a caption and its own resize handle — that has not changed.

## Checkboxes in a Table Cell

A cell can hold a tickable checkbox. Type `[ ] ` at the start of a cell and it becomes one, or pick **Check List** from the `/` menu with the cursor in a cell. Click the box to tick it.

The checkbox is stored as the plain text a markdown table can carry — a row reads `| [x] Buy milk |` on disk — so the table stays a table that Obsidian and every other markdown editor can read, and a table you wrote by hand with `[ ]` already in its cells opens with real checkboxes in it.

Outside a table, `[ ] ` still makes a full check-list item on its own line, and that is the one that counts as a task. A checkbox inside a cell is a checkbox and nothing more: it does not appear in the task list, take a due date, or sync as a task.

A cell whose text genuinely begins `[ ] ` becomes a checkbox too. The characters on disk are the same either way, so nothing is lost — the cell just shows a box you did not ask for.

## Link Previews

Links in a note are enriched with the page title, site name and favicon, both for inline link mentions and for bookmark blocks. The lookup runs once per URL and the result is kept in memory, so reopening a note with the same links does not refetch them.

Only the URL is written to the note file, so a mention that has been through a restart or a vault switch comes back showing its site's domain. Its title and favicon return the next time that note's links are looked up.

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
- **Very long lines open shortened.** A line over about 2,000 characters — one minified JSON record,
  for example — is drawn up to that point, followed by **Show the rest of this line**. A single line
  that long wraps into a couple of hundred rows, and a screenful of those is what makes the app slow
  to answer while you scroll it. Nothing is lost: the control shows the whole line, and the file on
  disk is untouched either way.
- **Very long single lines are cut.** A line longer than 64 KB — a whole file on one line — is read
  only up to that point. Show the rest of the line and the end of it is marked `long line cut here`.
  The rest is still on disk, untouched.

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

## When a Note Changes Outside memrynote

Editing a note's file in another app — Obsidian, a script, a text editor — is picked up while
memrynote is running, and the note carries the change the next time you look at it. This does
not depend on the note being the one on screen: a note you had switched away from, or never
opened this session, is updated the same way.

A note you are looking at while its file changes merges the change in place, so an edit you
are making at the same time is not thrown away.

memrynote will not write over bytes it has not read. If a note's file has changed since
memrynote last looked at it, the app leaves the file alone until it has taken that change in,
rather than saving an older version of the note over it.

memrynote will not write over a file it has never read at all. Pointing memrynote at an
existing vault lists every note straight away, from the filename and timestamps alone. Until a
note is opened, its file is left exactly as its author wrote it — a background sync round that
touches that note skips the save rather than replacing bytes nobody here has looked at.

## Opening a Note Written Somewhere Else

Opening a note that another app wrote reads its markdown into memrynote's editor, and saving it
afterwards writes memrynote's markdown back. The two are not always byte-for-byte the same. What
is guaranteed is that nothing is _lost_ on the way through:

- **A hard line break stays a hard line break.** A line ending in two spaces keeps them, so the
  break stays a break rather than becoming a paragraph gap.
- **A reference-style link keeps both halves.** `[the docs][d]` and its `[d]: https://…`
  definition both survive, including a definition several links share. The link stays a working,
  clickable link while the note is open. Definitions are gathered at the end of the file.
- **A code fence with no language keeps no language.** A bare ` ` ``` fence is not given one,
  which is what an Obsidian Kanban board's settings block needs to keep working.

Some cosmetic details are normalized to one house style: `*` and `+` bullets become `-`, `_em_`
becomes `*em*`, an underlined `Title` heading becomes `# Title`, and a `~~~` fence becomes a
` ``` ` one. These change how the file is spelled, never what it says.
