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

## Backlinks Panel

The collapsible **Backlinks** section at the bottom of every note lists every other note that links to it — including notes that point to it through a `[[wiki link]]` or through a
[Relation property](/user-guide/notes/properties-tags#relation-properties).

<!-- screenshot: backlinks section under a note -->

Each entry shows:

- The source note's title
- A snippet of the surrounding text (for a relation, the property name and value instead)
- A timestamp
- A click target to open the source note

## Graph View

The sidebar **Graph** entry opens a force-directed map of your notes and the links between them. Useful for finding orphan notes or unexpectedly large clusters.

- Nodes are notes; edges are wiki links and [relation properties](/user-guide/notes/properties-tags#relation-properties) (drawn thinner, to tell them apart from wiki links).
- Click a node to open the note in a tab.
- Hover to highlight neighbors.
- Drag a node to pull it around — linked notes follow it, and the graph settles again when you let go.

The layout is a live simulation: it arranges itself when the view opens, comes to rest on
its own, and wakes up again whenever you drag something. Node positions are not saved, so
each time you open the graph it settles into a fresh arrangement.

Edits made while the graph is open are folded into the arrangement you are looking at. A
new note or link slides into place and the neighbours shift to make room; nothing else
moves, and the graph does not rebuild itself from scratch on every save.

Turn the motion off with **Live motion** under the gear icon → **Display** if you prefer a
still graph — the same forces then run once and stop, which is also the lighter option on
very large vaults.

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
