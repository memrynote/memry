# Mind Map

See the shape of a note instead of scrolling through it. The mind map draws the
note's title as the root and branches through its headings.

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
- Paragraphs and other blocks are not drawn yet. Content before the first
  heading belongs to the root.

A note with no headings opens on the root alone, with a hint that adding a
heading will branch it.

## Clicking a Node

The map is navigation, not just a picture.

- Click a **heading node** and the map closes and the note reopens at that
  heading.
- Click the **root** — the note's title — to come back to the top of the note.
- The **outline panel** stays available while the map shows, and clicking a
  heading there does exactly the same thing. One control, one behaviour.

Nodes work from the keyboard too. Tab into the map, move between nodes with the
up and down arrows (Home and End jump to the ends), and press Enter or Space to
open the one you are on.

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
screen reader with its nesting level, and every node can be reached and opened
with the keyboard. The map takes a single tab stop: arrow keys move between
nodes from there. The map region itself is labelled with the note's name and how
many nodes it holds.

## Turning It Off

The mind map rides on the **Spatial Canvas** feature. Turn that off in
**Settings → Features** and the toggle disappears from the note header.
