---
tags:
  - notes-101
level: Beginner
summary: 'Wiki links, aliases, heading links, @ mentions, backlinks and the graph'
---
Links are what turn a folder of notes into a vault. Links go both ways: every note knows what points at it.

## Link to a note

**Insert:** type `[[` and start typing a title. Press **Enter** to link the match. If nothing matches, **Enter** creates a new note with that title and links it. The slash menu's **Link to note** types the brackets for you.

- A hub note with many links: [[Notes in the space race]]
- Several links in a row: [[Earthrise]], [[Apollo 1 memo, 1967]], [[Checklists as external memory]]
- A link by folder path, for two notes with the same name: [[Research/Space race/Earthrise]]

## Show different text

Type `|` after the title and write the words you want in the sentence. The link still points at the note: here is [[Aurora product brief|the brief]].

## Link to a heading

Add `#` and the heading: [[Decision log#Highlights sync]] opens the decision log at that section. A link to a heading in this very note starts with the hash: [[#Link to a note]].

## Link to a canvas

Canvases are linkable too, by title: [[Aurora launch map]]. Type `@` and pick one to embed it instead.

## People and things

A note tagged with a tag that has fields (like person or company) is drawn as that thing wherever it is linked: the colored icon or the person's initials in front of the title, and a hover card with the first filled fields. The file still holds a plain wiki link.

- A person: [[Lena Visser]] and [[Theo Bakker]]
- A company: [[Fieldwork]]
- A client, which is a kind of company: [[Northlight Health]]

Type `@` and a name to find them. Matches are grouped by tag, with their first fields on a second line. The last row is **Create**, which asks what kind of note it should be.

## Dates and mentions

`@` also inserts dates and web links. A date chip: ((date:eyJhbmNob3JJZCI6ImRtX24tbGlua3NfMSIsImRhdGVJU08iOiIyMDI2LTAxLTE3VDEwOjAwOjAwLjAwMFoiLCJoYXNUaW1lIjp0cnVlLCJkYXRlRm9ybWF0IjoicmVsYXRpdmUiLCJyZW1pbmQiOiJub25lIiwidGltZUZvcm1hdCI6InN5c3RlbSJ9)). A link mention: ((mention:https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FMargaret%5FHamilton%5F%28software%5Fengineer%29)). Both are covered in [[01 Text and formatting]].

## A link to nothing yet

A link to a note that does not exist stays visible with a dashed underline, so you can create it later: [[A note I have not written yet]]. Click it and Memry offers to create it. Deleting a note turns links to it into the same kind of link, and recreating a note with that title makes them live again.

## Backlinks and outgoing links

Scroll to the bottom of any note. **Backlinks** lists every note that links here, with a snippet of the surrounding text. Relation properties and canvas arrows count as links too. Below it, **Outgoing links** lists every note this one links to, once each. Open [[Checklists as external memory]] and look at its backlinks.

On a person or a company, **Linked here** replaces Backlinks. It lists the meetings that include them, the tasks waiting on them, and the notes that mention them: open [[Harriet Cole]] to see it.

## The graph

The sidebar's **Graph** draws every note as a dot and every link as a line. Clusters are topics, loose dots are notes that link to nothing. Turn on tag nodes to group notes by tag. More in [[Graph]].

Renaming a note updates every link to it, so it is safe to retitle things as you learn what they are about.

Next: [[08 Tags and tags with fields]].
