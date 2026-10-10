import { table } from '../../body.ts'
import type { NoteSpec } from '../../specs.ts'
import { lesson } from './lesson.ts'

export const linkNotes: NoteSpec[] = [
  lesson(
    'n-links',
    '07 Links, mentions and backlinks',
    '🔗',
    'Beginner',
    'Wiki links, aliases, heading links, @ mentions, backlinks and the graph',
    (
      b
    ) => `Links are what turn a folder of notes into a vault. Links go both ways: every note knows what points at it.

## Link to a note

**Insert:** type \`[[\` and start typing a title. Press **Enter** to link the match. If nothing matches, **Enter** creates a new note with that title and links it. The slash menu's **Link to note** types the brackets for you.

- A hub note with many links: [[Notes in the space race]]
- Several links in a row: [[Earthrise]], [[Apollo 1 memo, 1967]], [[Checklists as external memory]]
- A link by folder path, for two notes with the same name: [[Research/Space race/Earthrise]]

## Show different text

Type \`|\` after the title and write the words you want in the sentence. The link still points at the note: here is [[Aurora product brief|the brief]].

## Link to a heading

Add \`#\` and the heading: [[Decision log#Highlights sync]] opens the decision log at that section. A link to a heading in this very note starts with the hash: [[#Link to a note]].

## Link to a canvas

Canvases are linkable too, by title: [[Aurora launch map]]. Type \`@\` and pick one to embed it instead.

## People and things

A note tagged with a tag that has fields (like person or company) is drawn as that thing wherever it is linked: the colored icon or the person's initials in front of the title, and a hover card with the first filled fields. The file still holds a plain wiki link.

- A person: [[Lena Visser]] and [[Theo Bakker]]
- A company: [[Fieldwork]]
- A client, which is a kind of company: [[Northlight Health]]

Type \`@\` and a name to find them. Matches are grouped by tag, with their first fields on a second line. The last row is **Create**, which asks what kind of note it should be.

## Dates and mentions

\`@\` also inserts dates and web links. A date chip: ${b.date(3, { time: '10:00' })}. A link mention: ${b.mention('https://en.wikipedia.org/wiki/Margaret_Hamilton_(software_engineer)')}. Both are covered in [[01 Text and formatting]].

## A link to nothing yet

A link to a note that does not exist stays visible with a dashed underline, so you can create it later: [[A note I have not written yet]]. Click it and Memry offers to create it. Deleting a note turns links to it into the same kind of link, and recreating a note with that title makes them live again.

## Backlinks and outgoing links

Scroll to the bottom of any note. **Backlinks** lists every note that links here, with a snippet of the surrounding text. Relation properties and canvas arrows count as links too. Below it, **Outgoing links** lists every note this one links to, once each. Open [[Checklists as external memory]] and look at its backlinks.

On a person or a company, **Linked here** replaces Backlinks. It lists the meetings that include them, the tasks waiting on them, and the notes that mention them: open [[Harriet Cole]] to see it.

## The graph

The sidebar's **Graph** draws every note as a dot and every link as a line. Clusters are topics, loose dots are notes that link to nothing. Turn on tag nodes to group notes by tag. More in [[Graph]].

Renaming a note updates every link to it, so it is safe to retitle things as you learn what they are about.

Next: [[08 Tags and tags with fields]].
`
  ),

  lesson(
    'n-tags',
    '08 Tags and tags with fields',
    '🏷️',
    'Intermediate',
    'Plain tags, and tags that give a note fields, a template and a table',
    (b) => `A tag can be a label, or it can say what a note is.

## Plain tags

**Insert:** the tags row under the title (hover above the title and choose **Add tag**), or type a hash and a name in the text. A note's tags row is its header: \`tags:\` in the frontmatter. This note's header holds notes-101, and in the text it shows as a chip: #notes-101.

Click a tag anywhere to see every note, task and inbox item that carries it. Tags nest with a slash (aurora/beta), and they have colors, icons and categories.

## Tags with fields

A tag with fields also gives a note properties, a template and a table. Tag a note with person and it gets the Person fields (Company, Role, Email, Phone), the Person template, and a row in the person table. Everything is stored as ordinary frontmatter:

\`\`\`yaml
---
tags:
  - person
Company:
  - memry://note/<id of the company note>
Role: Design director
---
\`\`\`

Empty fields write nothing. A note is an *object* of a tag only when the tag is in its header, or when a tag in its header extends it. A tag written in the text of a note stays a label: this sentence mentions a #person, but this note is not one. It is listed under **Mentioned in** on the Person tag's page, and clicking such a label offers **Make this note a Person**.

## The ready-made tags

The Tags hub has a **Ready-made tags** strip with Person, Company, Meeting and Book. Nothing is created until you click **Add**. In this vault all four are already added:

${table([
  ['Tag', 'Fields', 'Look at'],
  ['person', 'Company, Role, Email, Phone', '[[Maya Okafor]]'],
  ['company', 'Website, Industry, Location', '[[Fieldwork]]'],
  ['meeting', 'Date, Attendees, Company', '[[Northlight kickoff]]'],
  ['book', 'Author, Shelf, Rating, Finished', '[[Carrying the Fire]]']
])}

Person and Meeting are connected: a meeting's **Attendees** field is a *relation* to people, and it shows on each person as **Linked here**. A relation is stored as a list of \`memry://note/<id>\` links. Meeting's **Date** is shown on the calendar.

## Your own tags

Open a tag's page and choose **Edit tag**. You can add a field of any type (text, number, date, URL, select, multi-select, status, checkbox or relation), set a template that fills empty notes when they get the tag, and choose a tag to extend.

- **recipe** is a custom tag with its own fields (Course, Time, Servings, Rating, source) and a Recipe template: [[Wild mushroom risotto]]. Rating is shared with the Book tag; field names are vault-wide.
- **client** extends company. Every client gets the Company fields and appears in the company table with a small client label: [[Brightwater Co-op]].

## Tags on tasks

A task has no text to put tags in, so every tag on it counts. A tag with fields shows its fields in the task drawer. The **waiting** tag has one field, **Waiting on**, a relation to a person. The first filled relation appears on the task's row as a chip, and the person's note lists the task under **Linked here**. Here is a live list of every task tagged waiting:

\`\`\`memry-view
{
  "source": {
    "kind": "tag",
    "tag": "waiting"
  },
  "layout": "list"
}
\`\`\`

## Tables

Every tag with fields has a table. Click one in the sidebar's tags section, or put one in a note with **/view**: this is the person table.

\`\`\`memry-view
{
  "source": {
    "kind": "tag",
    "tag": "person"
  },
  "layout": "table"
}
\`\`\`

Next: [[09 Properties and folder views]].
`
  )
]
