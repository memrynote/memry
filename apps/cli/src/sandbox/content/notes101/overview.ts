import type { NoteSpec } from '../../specs.ts'
import { lesson } from './lesson.ts'

export const overviewNote: NoteSpec = lesson(
  'n-overview',
  '00 What a note is',
  '📘',
  'Beginner',
  'The big picture: files, blocks, properties and how to use this folder',
  () => `Start here. This folder is a short course on notes, and every note in it is itself an example: the blocks you read are the blocks it teaches, with a few lines of explanation next to each.

## A note is a file

A note is a plain Markdown file in your vault, in a folder you can open in any editor. There is no database you cannot leave: the files are yours.

- **The title is the file name.** Rename the note and the file is renamed with it, and links to it follow.
- **The body is blocks.** Paragraphs, headings, lists, tables, images and the rest. Everything is stored as Markdown text, and a few extras as comments that other editors ignore.
- **The top of the file holds the note's data.** Tags, aliases and your own properties live there, between two lines of dashes (the frontmatter). The editor shows them as a tidy panel under the title.
- **Attachments are files too.** Images, PDFs, audio and video are copied into the vault's attachments folder, and the note points at them.

This is roughly what the top of a note looks like on disk:

\`\`\`yaml
---
tags:
  - notes-101
level: Beginner
summary: The big picture
---
\`\`\`

Memry never adds bookkeeping keys to that block. What is there, you put there.

## How to use this folder

Read in order, or jump to what you need. Each part says how to insert a block (slash menu, a Markdown shortcut, or a keyboard shortcut), then shows the result.

1. [[01 Text and formatting]]
2. [[02 Lists, checklists and tasks]]
3. [[03 Callouts, quotes, toggles and columns]]
4. [[04 Code, math and diagrams]]
5. [[05 Tables]]
6. [[06 Images, files and media]]
7. [[07 Links, mentions and backlinks]]
8. [[08 Tags and tags with fields]]
9. [[09 Properties and folder views]]
10. [[10 Note tools]]
11. [[11 Templates]]
12. [[12 Bookmarks and reminders]]
13. [[13 Locks and version history]]

Click **Notes 101** in the sidebar to open this folder as a table, with each part's level and a one-line summary.

## Three habits worth having

- Press \`/\` on an empty line to see every block you can insert.
- Type \`[[\` to link to another note. Links are how a pile of notes becomes a vault.
- Do not file too early. Write first, tag and link when the note has a shape.

## Try it now

Press **Cmd+N** (Ctrl+N on Windows and Linux) to make a scratch note, type a title, and come back here. Everything in this folder can be edited, broken and repaired; your own notes are somewhere else.

The tour of the rest of the app (tasks, inbox, journal, calendar and more) is in **Start here**, beginning with [[Welcome to Memry]].
`
)
