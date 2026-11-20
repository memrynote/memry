---
tags:
  - notes-101
level: Intermediate
summary: 'Plain tags, and tags that give a note fields, a template and a table'
---
A tag can be a label, or it can say what a note is.

## Plain tags

**Insert:** the tags row under the title (hover above the title and choose **Add tag**), or type a hash and a name in the text. A note's tags row is its header: `tags:` in the frontmatter. This note's header holds notes-101, and in the text it shows as a chip: #notes-101.

Click a tag anywhere to see every note, task and inbox item that carries it. Tags nest with a slash (aurora/beta), and they have colors, icons and categories.

## Tags with fields

A tag with fields also gives a note properties, a template and a table. Tag a note with person and it gets the Person fields (Company, Role, Email, Phone), the Person template, and a row in the person table. Everything is stored as ordinary frontmatter:

```yaml
---
tags:
  - person
Company:
  - memry://note/<id of the company note>
Role: Design director
---
```

Empty fields write nothing. A note is an *object* of a tag only when the tag is in its header, or when a tag in its header extends it. A tag written in the text of a note stays a label: this sentence mentions a #person, but this note is not one. It is listed under **Mentioned in** on the Person tag's page, and clicking such a label offers **Make this note a Person**.

## The ready-made tags

The Tags hub has a **Ready-made tags** strip with Person, Company, Meeting and Book. Nothing is created until you click **Add**. In this vault all four are already added:

| Tag     | Fields                          | Look at                |
| ------- | ------------------------------- | ---------------------- |
| person  | Company, Role, Email, Phone     | [[Maya Okafor]]        |
| company | Website, Industry, Location     | [[Fieldwork]]          |
| meeting | Date, Attendees, Company        | [[Northlight kickoff]] |
| book    | Author, Shelf, Rating, Finished | [[Carrying the Fire]]  |

Person and Meeting are connected: a meeting's **Attendees** field is a *relation* to people, and it shows on each person as **Linked here**. A relation is stored as a list of `memry://note/<id>` links. Meeting's **Date** is shown on the calendar.

## Your own tags

Open a tag's page and choose **Edit tag**. You can add a field of any type (text, number, date, URL, select, multi-select, status, checkbox or relation), set a template that fills empty notes when they get the tag, and choose a tag to extend.

- **recipe** is a custom tag with its own fields (Course, Time, Servings, Rating, source) and a Recipe template: [[Wild mushroom risotto]]. Rating is shared with the Book tag; field names are vault-wide.
- **client** extends company. Every client gets the Company fields and appears in the company table with a small client label: [[Brightwater Co-op]].

## Tags on tasks

A task has no text to put tags in, so every tag on it counts. A tag with fields shows its fields in the task drawer. The **waiting** tag has one field, **Waiting on**, a relation to a person. The first filled relation appears on the task's row as a chip, and the person's note lists the task under **Linked here**. Here is a live list of every task tagged waiting:

```memry-view
{
  "source": {
    "kind": "tag",
    "tag": "waiting"
  },
  "layout": "list"
}
```

## Tables

Every tag with fields has a table. Click one in the sidebar's tags section, or put one in a note with **/view**: this is the person table.

```memry-view
{
  "source": {
    "kind": "tag",
    "tag": "person"
  },
  "layout": "table"
}
```

Next: [[09 Properties and folder views]].
