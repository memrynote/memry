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
