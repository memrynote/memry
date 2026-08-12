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
