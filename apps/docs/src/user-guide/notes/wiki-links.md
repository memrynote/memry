# Wiki Links & Backlinks

Connect notes with `[[wiki links]]`. Memry tracks links bidirectionally, so every note knows what points to it.

<!-- screenshot: wiki link autocomplete in the editor -->

## Creating a Link

Type `[[` and start typing the title. An autocomplete dropdown appears with matching notes.

- **Match found**: press <kbd>Enter</kbd> or click to insert a link to that note.
- **No match**: pressing <kbd>Enter</kbd> creates a new note with that title and links it.
- **Audio file found**: pick **Link** for a normal reference or **Embed** for an inline audio block.

The link displays the target's current title, but the underlying reference uses a stable ID — renaming the target doesn't break the link.

## Following a Link

Click any wiki link to open the target in a new tab. <kbd>⌘</kbd>+click to open in the background; <kbd>⌥</kbd>+click to open in a split pane.

## Backlinks Panel

The collapsible **Backlinks** section at the bottom of every note lists every other note that links to it.

<!-- screenshot: backlinks section under a note -->

Each entry shows:

- The source note's title
- A snippet of the surrounding text
- A timestamp
- A click target to open the source note

## Graph View

The sidebar **Graph** entry opens a force-directed map of your notes and the links between them. Useful for finding orphan notes or unexpectedly large clusters.

- Nodes are notes; edges are wiki links.
- Click a node to open the note in a tab.
- Hover to highlight neighbors.

## Renaming Targets

Renaming a note:

- Updates the **display text** in inbound links
- Preserves the **link target** (stable ID)
- Updates search and the backlinks panel immediately

You don't need to find-and-replace `[[Old title]]` references — Memry rewires display text everywhere.

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
