# Wiki Links & Backlinks

Connect notes with `[[wiki links]]`. memrynote tracks links bidirectionally, so every note knows what points to it.

<!-- screenshot: wiki link autocomplete in the editor -->

## Creating a Link

Type `[[` and start typing the title. An autocomplete dropdown appears with matching notes.

- **Match found**: press <kbd>Enter</kbd> or click to insert a link to that note.
- **No match**: pressing <kbd>Enter</kbd> creates a new note with that title and links it.
- **Audio file found**: pick **Link** for a normal reference or **Embed** for an inline audio block.

The slash menu's **Link to note** item types the `[[` for you and opens the same dropdown.

Every row in that dropdown can be given a **display name**: type `|` after the title and
write the words you want in the sentence — `[[Continent#North America|North of America]]`.
Once both halves are settled the dropdown becomes a single **Display as** row that commits
it. The link still points at the note; only the visible text changes.

## Linking a Canvas

Canvases sit in the same dropdown as notes, below them, with the canvas icon. Pick one and
the link is written as `[[Sprint Board]]` — the canvas title, exactly the way a note link
carries a note title. Clicking it opens the canvas.

A canvas has no headings, so `#` does nothing for one: `[[Sprint Board#Ideas]]` opens the
board itself.

Notes are matched first. A note and a canvas that share a name both keep working — the link
opens the note, as it always has — so rename one of them if you need to reach the other.

From the sidebar, a canvas's row menu has **Copy link**, which puts `[[Sprint Board]]` on the
clipboard ready to paste into a note.

Untitled canvases are not offered: there is no title for the link to carry, so give the
canvas a name first.

## Linking Selected Text

Select a word or a sentence and press **Link to note** in the selection toolbar (next to the
external-link button). The selected text becomes the link's display name and the dropdown
opens for you to choose the target — any note, or a heading inside one by typing `#`. The
sentence reads exactly as it did before; the words are now a link.

Pick nothing and click away, and the text goes back to being ordinary text.

The link stores the target's **title** — `[[Meeting]]` in the file means "the note titled
Meeting", matched case-insensitively. Renaming the target therefore leaves existing links
pointing at the old title; see [Broken Links](#broken-links) for how such a link looks and
what clicking it does.

## Following a Link

Click any wiki link to open the target in a new tab — or in this tab, if you have turned "clicking a page opens a new tab" off in settings.

A click on the link itself always follows it, however long you hold the button down, and the link never flashes its markdown on the way. One consequence: a drag that begins on a link does not select text — begin it in the words beside the link instead. Placing the cursor beside a link is a separate gesture — see “Seeing a link’s markdown” below — and clicking on the link never does that instead of opening the note.

## Linking to a Heading

A link can name a heading inside its target, the way an Obsidian vault writes it:

- `[[Meeting#Decisions]]` — opens **Meeting** and scrolls to its "Decisions" heading
- `[[#Decisions]]` — stays in the note you're reading and scrolls to that heading
- `[[Meeting#Q3#Decisions]]` — a nested heading path; the last part names the heading
- `[[Meeting#Decisions|the outcome]]` — an alias works exactly as it does elsewhere

You don't have to remember the heading. Once the part before the `#` is a note's title
**exactly**, typing `#` swaps the dropdown for that note's headings, indented as an outline;
keep typing to filter them, and pick one to write the whole `[[Note#Heading]]` link. Delete
the `#` and the note list comes back. If the note has no headings, the dropdown says so —
memrynote will not add a heading to someone else's note.

**A heading picked this way labels itself with the heading.** `[[Continent#North America]]`
reads "North America" in the note rather than the whole `Continent#North America`; hovering
it still names the note it points at. The label is written into the link as an alias —
`[[Continent#North America|North America]]` — so the file says exactly what you see, and
Obsidian shows the same thing. Change the heading later and the label follows it; write your
own and yours is kept.

Links you wrote before this are left as they are. Open one (below) and pick its heading again
to give it a label.

Because an exact title is what switches modes, `[[Sprint #` still lists notes: `Sprint` is
not a note here, so nothing about `[[Sprint #4]]` changes. Block references (`#^`) are never
offered.

### Seeing a link's markdown

Put the cursor immediately before or after a link — by arrow key, or by clicking in the
text beside it rather than on the link itself — and that link shows its markdown for as long
as the cursor stays beside it:
`[[Continent#North America|North America]]`, exactly what the vault file holds. Move the
cursor away and it goes back to reading as a link.

This is display only. Nothing is written, so moving the cursor around a note never marks it
edited and never lands on the undo stack. To actually change the link, open it:

A link you have just written is the one exception. Picking a note from the `[[` dropdown
leaves the cursor against the new chip, and the link reads as a chip there rather than as
its markdown — you see what you made. Move the cursor away and back and the markdown shows
as it does beside any other link.

### Adding a heading to a link you already inserted

A finished link is a single chip, so there is nothing to type a `#` into. Press
<kbd>Backspace</kbd> (or <kbd>←</kbd>) right after one and it opens back up as its plain text
— `[[Meeting]]`, or `[[Meeting|the outcome]]` — with the cursor at the end of the title and
the `[[` `]]` dimmed. Type `#` and the heading dropdown appears, exactly as when writing the
link from scratch. Move the cursor out of the brackets, or click elsewhere, and it becomes a
chip again.

This is also where a link's display name is edited: type `|` and the words you want. If the
link already carried a label the heading picker wrote, the new one replaces it.

::: warning Backspace next to a link now opens it instead of deleting it
This applies to **every** wiki link, not only ones with a heading. To delete a link, press
<kbd>Backspace</kbd> a second time once it is plain text, or select it and delete. Removing
the `[[` or `]]` yourself is also allowed — that turns the link back into ordinary prose,
which is sometimes what you want.
:::

Heading matching ignores case and surrounding spaces, and the first heading with that text
wins — the link records the heading's text, not its level or its position. If the heading
has since been renamed or deleted, the note still opens, at the top.

A note whose title genuinely contains `#` still works: `[[Sprint #4]]` opens the note called
"Sprint #4" if there is one, and is only read as a heading link when there isn't.

Backlinks and the graph treat `[[Meeting#Decisions]]` as a link to **Meeting** — the heading
narrows where you land, not what the link points at.

### Where a link cannot be a chip

Search results, note and journal previews, the Home journal widget, and HTML or PDF export
are plain text, so a link is shown as its label rather than as a chip. The label is the
alias when the link has one, and the note's title otherwise: `[[Meeting#Decisions]]` reads
"Meeting" and `[[Meeting#Decisions|the outcome]]` reads "the outcome". The heading half is
dropped rather than shown, because a preview has no note to scroll.

One consequence is worth knowing: these previews cannot tell `Sprint #4` the title apart
from a heading link, so `[[Sprint #4]]` reads "Sprint" in a search snippet even though the
link itself still opens the note called "Sprint #4". Nothing in the file changes.

::: warning Block references are not supported
`[[Meeting#^block-id]]` opens **Meeting** at the top rather than jumping to the block.
memrynote does not assign persistent block ids, so there is nothing to scroll to.
:::

::: tip Journal entries
Journal entries use the same editor as notes, so heading links behave identically there:
`[[Meeting#Decisions]]` opens **Meeting** at that heading, `[[#Decisions]]` scrolls to a
heading inside the entry you are reading, and typing `#` after a note's exact title offers
that note's headings.
:::

## Formatting a Link

Write the formatting around the link **in markdown** and it is kept, on screen and in the
vault file:

- `**[[Roadmap]]**` stays bold
- `*[[Roadmap|the plan]]*` keeps both the alias and the italics
- strikethrough, inline code, underline and text or highlight colour work the same way

Colour and underline have no markdown syntax, so they are written the way memrynote writes
every coloured run — as a `<span style="…">` around the link, which Obsidian renders too.

::: warning Formatting applied to an existing link chip is not saved
Selecting a link chip in the editor and pressing <kbd>⌘</kbd>+<kbd>B</kbd> styles it on
screen, but the change reaches neither the synced document nor the file — the same is true
of a link inserted through the `[[` autocomplete inside already-bold text. Formatting is
carried only when the markdown is written or pasted with the link already inside it, as
above. Tracked as a known gap.
:::

::: warning A link inside a formatted sentence stays plain text
When the formatting covers more than the link — `~~Cancelled: [[Meeting]]~~`, or
`**See [[Roadmap]] for details**` — the link is left as plain `[[…]]` text rather than
turned into a clickable chip. Splitting the formatted run around the link produces markdown
whose delimiters GFM reads as literal characters, so the file is left exactly as written
instead. Put the formatting on the link alone to get the chip.
:::

::: warning
Inline code combined with bold, italic or strikethrough on the same link is displayed and
written correctly, but reading the file back keeps only the code formatting. This is a
limitation of the markdown parser and applies to ordinary text the same way.
:::

## Image Embeds

A wiki link written with a leading `!` and pointing at an image embeds the picture instead
of linking to it. This is the syntax Obsidian vaults use, so notes written elsewhere render
their images without any conversion step:

- `![[photo.png]]` — looked up anywhere in the vault by filename
- `![[Images/photo.png]]` — a path relative to the vault root, or to your notes folder
- `![[photo.png|300x200]]` — the size hint is ignored; resize the image in the editor

Only real image files embed this way. `![[Some Note]]` and `![[report.pdf]]` stay as they
are, and a target that doesn't match any file in the vault is left untouched rather than
rendered as a broken image — so a typo stays visible and fixable.

::: tip
Editing a note that contains `![[photo.png]]` rewrites the embed to memrynote's standard
image syntax the next time the note is saved — `![photo.png](../Images/photo.png)`. The
picture and its position are unchanged; only the markup differs.

The rewritten link is **relative to the note**, so it keeps working after the note syncs to
your other devices, and the vault stays readable by Obsidian.
:::

## Links Written Outside memrynote

A `[[wiki link]]` typed into a note file by something other than memrynote — Obsidian, a
script, another editor, or a note arriving from one of your other devices — is a chip as
soon as you open the note. You do not have to edit the note to wake the links up, and
opening it does not change the file: a link is stored as `[[Target]]` either way.

This holds whether or not the note was the one on screen when the file changed. An edit
made to a note you had switched away from is picked up the same way, and the note shows it
the next time you open it.

Earlier builds could show such a page as plain, unclickable text until you typed into the
note or reopened it a few times. Opening the note is now enough.

## Link Syntax in Code

Link syntax written inside inline code or a fenced code block is text, not a link. A note
that documents the syntax, such as `` `[[Example]]` `` or a code block of sample markdown,
adds no backlink, no outgoing link and no graph node for it.

A link inside an HTML comment still counts: `<!-- [[Topic]] -->` is a hidden link, and it
shows in backlinks and the graph like any other.

Earlier builds counted link syntax in code as real links, which left unresolved nodes on the
graph. The first time a vault opens after the update, memrynote refreshes the links of the
notes that have link syntax inside code, once, in the background. The note files are not
changed.

## Backlinks Panel

The collapsible **Backlinks** section at the bottom of every note lists every other note that links to it — including notes that point to it through a `[[wiki link]]` or through a
[Relation property](/user-guide/notes/properties-tags#relation-properties), and notes
connected to it by an arrow on a [canvas](/user-guide/canvas/cards-and-links#connecting-cards).
A canvas entry says **Connected on** and the canvas name, and has no text snippet.

<!-- screenshot: backlinks section under a note -->

Each entry shows:

- The source note's title
- A snippet of the surrounding text (for a relation, the property name and value instead)
- A timestamp
- A click target to open the source note

## Outgoing Links

Below **Backlinks**, a collapsible **Outgoing links** section lists every note this note
links to, in alphabetical order. It shows each `[[wiki link]]` once, however many times the
note repeats it. Journal entries show the same section.

Clicking an entry does exactly what clicking the link in the editor does. It opens the
note, file, or canvas. A link whose target does not exist is not left out. It shows with
a dashed underline and **Not created yet**, and clicking it offers to create the note, the
same as a [broken link](#broken-links). Deleting a note turns links to it into
**Not created yet** entries, and recreating a note with that title makes them live again.

An arrow drawn from this note's card to another note's card on a canvas is listed here
too, marked **Connected on** and the canvas name.

The list is read-only. To change what a note links to, edit the links in the note itself,
or the arrows on the canvas.

## Graph View

The sidebar **Graph** entry opens a force-directed map of your notes and the links between them. Useful for finding orphan notes or unexpectedly large clusters.

- Nodes are notes; edges are wiki links and [relation properties](/user-guide/notes/properties-tags#relation-properties) (drawn thinner, to tell them apart from wiki links).
- Arrows between cards on a [canvas](/user-guide/canvas/cards-and-links#connecting-cards) are edges too, drawn in their own colour. Turn them off with **Canvas connections** under the gear icon → **Filters**.
- Click a node to open the note in a tab.
- Hover to highlight neighbors.
- Drag a node to pull it around — linked notes follow it, and the graph settles again when you let go.
- A node you drag stays where you drop it. Pinned nodes carry a thin ring; right-click one → **Unpin** to let it drift back into the layout.

### Editing From the Graph

You can connect notes without leaving the graph:

- **Link by dragging.** Hold <kbd>Alt</kbd> (<kbd>Option</kbd> on macOS) and drag from one
  note onto another. A dashed line follows the pointer; releasing over a note adds that note
  to the first note's `related` [relation property](/user-guide/notes/properties-tags#relation-properties),
  and the edge appears right away. The note body is not touched. `related` is created the
  first time you use it. If the note already has a `related` property holding something other
  than note links, nothing is written and a message says so.
- **Right-click a note** for **Link to…** (search the notes in the graph and pick one) and
  **Add tag…** (pick a tag already in use, or type a new one). A new tag recolours and
  refilters the graph like any other tag change.
- **Remove a relation link** from the same menu: every relation edge on the note, in either
  direction, is listed as **Remove link to …**. Removing one takes that note out of every
  relation property on the linking note. Wiki links are not listed, since they live in the
  note text; open the note to change them.

Each edit shows a short message with **Undo**. Undo reverses only that edit and keeps
anything you changed in the note since.

These edits work between notes only. Journal entries, tasks, projects, tag nodes, and
not-yet-created notes cannot be edited from the graph; to link a note to a journal entry or
a task, use the relation property in the note's properties panel. The local graph panel
inside a note is view-only.

The layout is a live simulation: it arranges itself when the view opens, comes to rest on
its own, and wakes up again whenever you drag something. Where everything came to rest,
pins included, is saved, so the graph reopens the way you left it, including after a restart.
To start over, open the gear icon → **Display** → **Re-layout**. That releases every pin and
lets the graph settle into a fresh arrangement.

Saved layouts stay on the device and do not sync. Rebuilding the search index also clears
them, and the graph then starts from a fresh arrangement again.

Edits made while the graph is open are folded into the arrangement you are looking at. A
new note or link appears beside what it links to, and the neighbours shift to make room.
Pinned nodes stay put, nothing else moves, and the graph does not rebuild itself from
scratch on every save. Notes added while the graph was closed are placed the same way the
next time you open it.

Turn the motion off with **Live motion** under the gear icon → **Display** if you prefer a
still graph — the same forces then run once and stop, which is also the lighter option on
very large vaults.

**Show Labels**, in the same **Display** section, keeps note names on the map. It is off by
default, and names then appear only on hover. With it on, most names show at the default zoom
and every name shows once you zoom in; where names would overlap, the graph shows one per
area and fills in the rest as you zoom closer.

### Filters and saved views

The gear icon's **Filters** section hides entity types, orphans, or everything outside a
search. Right-click a node → **Focus on this node** to show only its neighbourhood. The
graph tab remembers all of it: switching tabs, restarting Memry, or closing the graph and
opening it again brings back the same filters. A graph tab opened from scratch starts from
whatever the last graph tab showed.

The menu at the top of the gear panel saves the current arrangement as a named **view** —
filters, colouring, and collapsed categories together. Pick a view to switch to it.
When you change something after picking one, the menu marks it **Edited** and offers
**Update** to overwrite it; the trash icon deletes a view. Saved views stay on the device
they were made on and do not sync. Node positions and pins are not part of a view: every
view shares the one saved arrangement.

### Tag categories

The **Tag categories** section uses the categories from the
[tag hub](/user-guide/notes/properties-tags#tag-categories):

- **Color by category** colours each note by the category of its tags, with a legend next to
  each category. A note whose tags fall in several categories takes the first one in the
  hub's order; notes without a categorised tag are grey.
- The collapse button next to a category folds every note carrying one of its tags into a
  single node, sized by how many it holds and labelled with the count. Links from those
  notes to the rest of the graph are merged onto that node. Click the node (or right-click
  → **Expand**) to open it again; its notes return to where they were, and pinned notes keep
  their pin, including after a restart while collapsed. Right-clicking any note in a
  category also offers **Collapse**.

### Local graph

The local graph panel under a note follows the note the page shows. The pin button keeps it
on the current note instead, so it stays put while you move through linked notes in the same
tab; the panel then names the note it is pinned to. Click the pin again to follow the open
note.

Memry turns on Chromium's software WebGL renderer, so a device without GPU acceleration — a
remote desktop session, a virtual machine, a blocklisted graphics driver, or a launch where Memry
disabled hardware acceleration after a GPU crash — still draws the graph, only more slowly.

If even the software renderer cannot start, Memry shows a safe fallback instead of opening the
graph. Your notes remain available, and **Close** removes the graph tab so it will not be
restored on the next launch.

## Renaming a Linked Note

Renaming a note updates every wiki link that points at it, across the whole vault: each
inbound `[[Old Title]]` becomes `[[New Title]]` in the source note itself, so the link
keeps opening the same note and backlinks, mention counts, and the graph carry on
unchanged. This covers every link form — `[[Old Title#Heading]]` keeps its heading,
`[[Old Title|label]]` keeps its label (the visible text you chose never changes) — and it
applies to attached files too: rename a PDF inside Memry and notes linking to it by name
follow along.

The rewrite is an ordinary edit to each source note, so it appears in open editors right
away and syncs to your other devices like any other change. Links written in another app
before the rename (or renames done outside Memry, in Finder or Explorer) are not covered —
those show up as broken links below.

## Broken Links

A wiki link whose target does not exist — a typo, a note renamed outside Memry, or a
deleted one — is
shown with a **dashed underline and a muted tint** instead of the usual link colour, in
both the note editor and the journal. Hovering it shows a small card reading
**"Not found — click to create"** instead of the usual preview.

Clicking a broken link asks before doing anything: a dialog offers to **create** a note
with that title, or **cancel** and leave everything as it was. (Earlier builds created the
note silently, which could mint an unwanted duplicate when the link was merely stale.)
Confirming creates the note in your default folder and opens it — exactly what the old
one-click behaviour did.

The styling stays current without a reload: creating, renaming, or deleting a note — on
this device or another — restyles the links in every open editor. Recreating a note with a
broken link's title makes that link live again, because links match by title.

Only the note half is checked: `[[Meeting#Decisions]]` is broken when there is no note
titled "Meeting", not when the heading is missing — a link to a renamed or deleted heading
still opens the note at the top, as before.

## Practical Patterns

- **Index notes** — a note titled "Inbox" or "Daily" that links to many others. Backlinks make navigation trivial.
- **Tag-as-link** — type `[[topic]]` once at the bottom of any note. Click it later to see everything that mentions the topic.
- **MOCs (Maps of Content)** — short curated notes that link out to a topic's key references.

## Power Tip

Wiki link autocomplete matches note titles, including audio and other attached files. It
does not search tags — `[[#topic]]` is a heading link, not a tag search. Tags are tracked
separately; see [Properties & Tags](/user-guide/notes/properties-tags).
