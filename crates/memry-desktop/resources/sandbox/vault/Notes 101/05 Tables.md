---
tags:
  - notes-101
level: Intermediate
summary: 'Insert, resize and color tables; checkboxes, images and links inside cells'
---
Tables are plain Markdown tables. Anything else that reads Markdown can read them.

## Insert and edit

**Insert:** **/table** opens a size grid; pick the size with the mouse or the arrow keys. The first row is always the header. Move between cells with **Tab** and **Shift+Tab**. Hover a table to see the handles on its borders: the top edge opens a column menu, the left edge a row menu, and the right border of a cell a cell menu. With the cursor in a cell, **Cmd+Shift+Enter** opens a menu of row and column actions from the keyboard.

| Mission   | Crew |
| --------- | ---- |
| Apollo 8  | 3    |
| Apollo 11 | 3    |

## Color and width

The cell menu's **Colors** sets text and background for one cell, and dragging a column border sets its width. Both are stored as comment lines above the table, which other editors ignore:

<!-- table-colors:{"0:0":{"textColor":"red"},"1:1":{"backgroundColor":"green"}} -->
<!-- table-layout:{"columnWidths":[180,null]} -->
| Theme | Contrast |
| ----- | -------- |
| Night | 12.4:1   |
| Day   | 14.1:1   |

## What a cell can hold

A cell holds one line of inline content: bold, links, wiki links, mentions, tags, even a picture or a checkbox. Type `[ ]` at the start of a cell for a checkbox (it is a checkbox, not a task). **/image** inside a cell puts a picture there.

| Item     | Preview                                                                                               | Link        |
| -------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| [x] done | ![pillars.jpg\|120](../attachments/note_y7DzkeGRQJuX/file_dB5c_X3_hxNt-photo-pillars-of-creation.jpg) | [[Credits]] |
| [ ] todo | ((mention:https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FPillars%5Fof%5FCreation))                           | #notes-101  |

Paste into a cell and you get text, never a second table. Copying a range of cells and pasting it elsewhere keeps their shape, like a spreadsheet.

Next: [[06 Images, files and media]].
