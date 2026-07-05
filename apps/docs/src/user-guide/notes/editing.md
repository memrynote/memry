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

## Link Cards & YouTube Embeds

Paste a URL and pick from the paste menu: keep it as a plain link, turn it into a **bookmark card** (title, description, preview image), or — for YouTube URLs — an **embedded player**.

In the vault's `.md` file both stay ordinary markdown, so notes opened in other editors (e.g. Obsidian) show a normal link instead of app-specific syntax:

- A bookmark card is saved as `[Title](https://example.com/article)` on its own line.
- A YouTube embed is saved as the bare video URL on its own line.

The upgrade also works in reverse when a note is opened: a titled link standing alone on its own line renders as a bookmark card, and a standalone YouTube URL (bare, `<autolink>`, or titled) renders as an embedded player. Links inside sentences, list items, headings, or quotes are never converted, and a standalone bare non-YouTube URL stays a plain link. Lines written outside memrynote are re-emitted byte-for-byte on save.

## Title

The title is editable inline at the top of the editor. Renames are live — the title updates in tabs, the sidebar, search, and any inbound wiki links.

If you leave the title empty, memrynote generates a fallback ("Untitled" or the first heading).

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

Toggle browser spellcheck in [Settings → Editor](/user-guide/settings#editor).

## Toolbar

The formatting toolbar can be sticky at the top or float above selections — choose in [Settings → Editor](/user-guide/settings#editor).

## Comments

Select text to open the floating toolbar. **Comment** creates an anchored review card in the right rail; selecting the text itself does not open the rail. The right rail aligns each card beside the marked text. Comment cards can be resolved or deleted.

## What Notes Are Made Of

Under the hood, every note is a Yjs CRDT (`Y.Doc`). Markdown is a derived export, not the canonical form — this is what lets edits from two devices merge cleanly. See [CRDT & Notes Sync](/architecture/crdt) for details.
