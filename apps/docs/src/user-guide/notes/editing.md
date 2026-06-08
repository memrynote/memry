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

## Comments & Suggestion Mode

Select text to open the floating toolbar. **Comment** creates an anchored review card in the right rail; selecting the text itself does not open the rail. **Suggest** turns on page-level suggestion mode, shown by a `Suggesting` pill near the reminder and bookmark controls.

While suggestion mode is active, inserts, deletes, and replacements stay visible as review marks instead of raw CriticMarkup. Selected text deleted with Backspace remains visible as a deletion suggestion, including mouse-drag and block-marquee selections, so reopening the note or journal entry restores the deletion card and inline mark. The right rail aligns each card beside the marked text. Comment cards can be resolved or deleted; suggestion cards can be accepted or rejected.

## What Notes Are Made Of

Under the hood, every note is a Yjs CRDT (`Y.Doc`). Markdown is a derived export, not the canonical form — this is what lets edits from two devices merge cleanly. See [CRDT & Notes Sync](/architecture/crdt) for details.
