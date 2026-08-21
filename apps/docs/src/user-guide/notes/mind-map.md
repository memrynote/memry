# Mind Map

See the shape of a note instead of scrolling through it. The mind map draws the
note's title as the root and branches through its headings, lists, tasks and
containers.

<!-- screenshot: a note's headings drawn as a mind map -->

## Opening the Map

Press the hierarchy icon in the note header, next to the reminder and bookmark
actions. The title, properties, tags and body are replaced by the map. The
header, the breadcrumb, the note's overflow menu and the outline panel all stay
where they were.

Press the same icon again to return to the note.

The map is a **view of the note, not a document**. Nothing is saved, nothing is
edited, and the note is untouched by opening it.

## What Gets Drawn

- The **note title** is always the root — never the first heading.
- **Headings** branch by level: an H3 under an H2 under an H1 nests three deep.
- A **skipped level** (an H1 followed by an H3) does not invent a missing
  heading in between; the H3 simply nests one step deeper.
- A note whose first heading is a deep level attaches that heading straight to
  the root. Relative depth is what places a heading, not the number you wrote.
- **Bullet, numbered and checklist items** branch off the heading they sit
  under. Numbered items keep their numbers, and a list that restarts in the
  editor restarts in the map.
- **Nested list items** branch off their parent item, so the indentation you
  already wrote is what you see.
- **Tasks** are nodes of their own, so commitments are part of the note's shape
  instead of being buried in it.
- **Toggles and callouts** open into their children. Content you collapsed in
  the editor is still discoverable in the map, and a callout holding a checklist
  is not reduced to one node.
- Content before the first heading belongs to the root.

A note with no headings opens on the root alone, with a hint that adding a
heading will branch it.

### Ticked Items

A checklist item or a task you have already completed is drawn dimmed, with a
rule through its label. The map shows what is written, not what should have
been.

### Tags and Counter Badges

Some things are content rather than structure, and drawing a node for each of
them would bury the shape of the note under it. They are counted instead, never
dropped:

- **Tags** written inside a heading or a list item become a small badge on that
  node rather than nodes of their own, so a heavily tagged note does not drown
  the map.
- **Tables, code blocks, images, quotes, embeds, bookmarks and file blocks**
  are not drawn. The node above them — usually the heading they sit under —
  carries a badge saying what is there, such as `2 tables · 1 code block`.
- **Paragraphs** are never nodes. **Date mentions, link mentions and inline
  pictures** stay as plain text inside the label of the node that holds them.

## Clicking a Node

The map is navigation, not just a picture.

- Click a **heading, list, task, toggle or callout node** and the map closes and
  the note reopens at that block.
- Click the **root** — the note's title — to come back to the top of the note.
- The **outline panel** stays available while the map shows, and clicking a
  heading there does exactly the same thing. One control, one behaviour.

Nodes work from the keyboard too. Tab into the map, move between nodes with the
up and down arrows (Home and End jump to the ends), and press Enter or Space to
open the one you are on.

## The Map's Own Toolbar

A small toolbar sits at the top of the map, and only there — the note's overflow
menu is never repurposed, so the same button in the same place always does the
same thing.

- **Fit to view** frames the whole map again after you have panned or zoomed.
- **Copy as image** puts the map on the clipboard as a PNG, ready to paste into
  a note, a message or a slide.
- **Copy as vector** puts the map on the clipboard as SVG markup, which design
  tools paste as editable artwork.

Both copies contain the map **as you are looking at it**, so anything you have
opened up in the map is in the copy too. They are exported on a transparent
background and always in the map's light colours, so the same note copies the
same way whichever app theme you are in. If a copy cannot be made, memrynote
tells you rather than failing quietly.

The map's camera is not remembered. Close the map and open it again and it
frames the whole thing afresh — the same place **Fit to view** takes you.

## Coming Back to the Note

Your work is exactly where you left it. The editor is only hidden while the map
shows, never torn down, so undo history, the cursor, the selection and the
scroll position all survive the round trip.

## Per Tab, and Across Restarts

The map is remembered **per tab**. Switch to another tab and back and the map is
still open; quit and reopen memrynote and it is still open. Opening the same
note in a different tab starts in note view, because the map belongs to the
place you are working, not to the note.

## Reading Direction

In a right-to-left language the tree grows with your reading direction rather
than against it.

## Accessibility

The drawing sits beside a real tree in the page, so every node is announced by a
screen reader with its nesting level, its badges, and — for a checklist item or
a task — whether it is ticked, and every node can be reached and opened with the
keyboard. The map takes a single tab stop: arrow keys move between nodes from
there. The map region itself is labelled with the note's name and how many nodes
it holds.

## Turning It Off

The mind map rides on the **Spatial Canvas** feature. Turn that off in
**Settings → Features** and the toggle disappears from the note header.
