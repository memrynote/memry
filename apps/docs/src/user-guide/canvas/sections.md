# Sections & Categorizing

A common way to make sense of a pile of notes is to lay them out side by side
and group the ones that belong together. On a canvas those groups are
**sections**: the canvas engine's frames. A section can also be tied to a
category, so that sorting a card into the section also files its note under a
tag or a property value. You don't have to redo the grouping afterwards in the
note tab.

## Drawing a section

Pick the **Frame** tool from the drawing toolbar's extra-tools menu (shortcut
<kbd>F</kbd>) and drag out a rectangle. Anything you drop inside it belongs to
it, and moving the section moves everything in it. Double-click the section's
title to rename it.

A section with no category is only a visual group. Nothing about your notes
changes when cards go in or out of it.

## Tying a section to a category

Select a section. A **Categorize** chip appears above its top corner. Click it
and choose one of these:

- **A tag**, e.g. `health` or a nested tag like `health/sleep`. Type a tag that
  doesn't exist yet and pick **Use new tag** to create it.
- **One value of a property** of type select, multi-select or status, e.g.
  `Status: In Progress` or `Topics: sleep`.

The section now shows a chip with its category and the number of cards inside.
If you haven't renamed the section yourself, its title changes to the category
too. Click the chip at any time to switch the section to a different category,
or choose **Stop categorizing as …** to remove the category.

If the section already holds cards when you pick its category, those cards get
the category straight away. A toast tells you how many cards changed, and its
**Undo** takes the category off them again.

Removing a section's category, or changing it to another one, does not take the
old tag or value off the cards already inside. Your notes keep what they have.

## Dropping cards into a section

Drag a card into a section tied to a category and let go. The card's item gets
the category:

| Section category       | Note                                            | Task             |
| ---------------------- | ----------------------------------------------- | ---------------- |
| Tag                    | The tag is added                                | The tag is added |
| Select or status value | Set to that value, replacing the old one        | Left as is       |
| Multi-select value     | The value is added next to the ones already set | Left as is       |

It is the same edit you would make in the note or task itself. The note's
properties panel, the folder view, tag pages and search all show it, and it
syncs like any other edit.

Dropping a note or task from the sidebar straight onto a section works the same
way.

A toast confirms the change. Its **Undo** does both halves: the card goes back
to where it was before the drop and the category comes off the item. The
canvas's own undo (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd>, or the undo
button) does the same thing when the last thing you did was that drop.

Some cards can't take a category, and those are left as they are, with a toast
that says why:

- **File cards.** A PDF or image has no tags or properties to write to.
- **Tasks in a property section.** Tasks take tags, but they don't have note
  properties.
- **Event and project cards.** These have neither.

If an item already has the category, nothing is written and no toast appears.

## Moving cards out of a section

Dragging a card out of a section tied to a category does **not** remove the
category from its item. A drag that silently deleted a tag would be easy to do
by accident and hard to notice, so the item keeps it. A toast offers **Remove
…** in case you did mean to take it off.

Moving a card straight from one status or select section to another of the same
property (e.g. from `Status: To do` to `Status: Done`) just switches the value,
so there's nothing left to remove and no toast offers it.

A card belongs to one section at a time. Sections can't be nested, so a card
never picks up two categories from one drop.

## Lay out by property

**Lay out by property**, next to **Add card** at the bottom of the canvas, sorts
the whole board in one step. Pick a select, multi-select or status property.
memrynote then:

1. creates one section per value of that property, each tied to its value,
   placed in a row to the right of everything already on the board;
2. moves every note card whose note has one of those values into the matching
   section, in a grid.

A note with several values of a multi-select goes to the section of the value
that comes first in the property's list of options. Cards whose note has none
of the values, and cards that aren't notes, stay where they are. Sections with
no cards are still created, so you have somewhere to drop cards later.

Laying out writes nothing to your notes: every card lands in the section of a
value its note already has. <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes
the whole layout.

## Sync and older versions

A section's category is stored with the section, inside the canvas. It adds a
few bytes to the board, and those bytes count toward the canvas
[size limit](./sync-and-limits.md#size-limit) like the rest of the drawing.

A device running an older release of memrynote shows these sections as plain
frames, without the chip, and dropping cards into them there changes nothing.
The category is kept when the board is edited on that device, and the section
works again once the device is updated. The tags and property values written to
your notes sync through the notes and tasks themselves, so every device sees
them either way.

## Next steps

- [Cards & Links](./cards-and-links.md): putting notes, tasks and events on a canvas
- [Sync & Limits](./sync-and-limits.md): how canvases sync
