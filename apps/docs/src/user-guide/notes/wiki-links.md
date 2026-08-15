# Wiki Links & Backlinks

Connect notes with `[[wiki links]]`. memrynote tracks links bidirectionally, so every note knows what points to it.

<!-- screenshot: wiki link autocomplete in the editor -->

## Creating a Link

Type `[[` and start typing the title. An autocomplete dropdown appears with matching notes.

- **Match found**: press <kbd>Enter</kbd> or click to insert a link to that note.
- **No match**: pressing <kbd>Enter</kbd> creates a new note with that title and links it.
- **Audio file found**: pick **Link** for a normal reference or **Embed** for an inline audio block.

The link displays the target's current title, but the underlying reference uses a stable ID — renaming the target doesn't break the link.

## Following a Link

Click any wiki link to open the target in a new tab. <kbd>⌘</kbd>+click to open in the background; <kbd>⌥</kbd>+click to open in a split pane.

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

## Renaming Targets

Renaming a note:

- Updates the **display text** in inbound links
- Preserves the **link target** (stable ID)
- Updates search and the backlinks panel immediately

You don't need to find-and-replace `[[Old title]]` references — memrynote rewires display text everywhere.

## Deleting a Linked Note

Deleting a target leaves "broken" wiki links rendered with a strikethrough. Recreating a note with the same title doesn't automatically restore the link — wiki links bind to IDs, not titles.

If you need to repair broken links, use the inline link menu: it lets you re-target to an existing note or create a new one with the displayed title.

## Practical Patterns

- **Index notes** — a note titled "Inbox" or "Daily" that links to many others. Backlinks make navigation trivial.
- **Tag-as-link** — type `[[topic]]` once at the bottom of any note. Click it later to see everything that mentions the topic.
- **MOCs (Maps of Content)** — short curated notes that link out to a topic's key references.

## Power Tip

Wiki link autocomplete also matches on tags and audio files. Typing `[[#topic]]` searches notes that
carry that tag. (Tags themselves are tracked separately — see
[Properties & Tags](/user-guide/notes/properties-tags).)
