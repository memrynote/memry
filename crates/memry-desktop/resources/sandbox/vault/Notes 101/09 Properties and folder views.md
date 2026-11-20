---
tags:
  - notes-101
level: Intermediate
summary: >-
  Typed fields in the frontmatter, and folders that open as tables, galleries
  and lists
Rating: 5
owned: true
deadline: '2026-01-21'
url: 'https://docs.memrynote.com'
topics:
  - Note-taking
  - Design
stage: In review
project:
  - Studio ops
related:
  - 'memry://note/note_PkatBircUm1i'
---
Properties are typed fields at the top of a note. This note has one of nearly every type, so open the properties panel under the title and read along.

## Property types

| Type         | Use it for                                              | On this note |
| ------------ | ------------------------------------------------------- | ------------ |
| Text         | A short free-form string                                | summary      |
| Number       | A count, a score, an amount                             | Rating       |
| Checkbox     | A yes or no                                             | owned        |
| Date         | A day, optionally on the calendar                       | deadline     |
| URL          | A web address                                           | url          |
| Select       | One value from a list                                   | level        |
| Multi-select | Several values from a list                              | topics       |
| Status       | A stage that is to do, in progress or done              | stage        |
| Relation     | Links to notes, tasks, events, canvases or journal days | related      |
| Project      | Joins the note to a project                             | project      |

**Insert:** hover above the title and choose **Add property**, or open the panel and click **Add property**. Pick an existing property or create one. Everything is stored in the frontmatter, so it reads as plain text in any editor:

```yaml
---
summary: Typed fields in the frontmatter
level: Intermediate
deadline: 2026-01-21
owned: true
---
```

## Definitions are shared

A property definition is vault-wide: its type, its options and their colors. Add a Topics multi-select once and every note can use the same vocabulary. Manage them in **Settings, Properties**. A status property has three built-in categories; a select option has a color; and a value that matches no option still shows, in gray.

## Show a date on the calendar

On a date property's row, click the small calendar icon. Every note with that property then appears on the calendar as an all-day chip on its date, and clicking the chip opens the note. This note's **deadline** does that, so look for it on the calendar in a week.

## Relations and projects

A relation chip shows the title of what it points at and updates when that is renamed. The property also counts as a link: the target lists this note in its backlinks. The **project** property ties the note to a project, and the note appears on the project's page.

## Folders as databases

Click a folder in the sidebar and it opens as a database over the notes inside it. Each folder keeps its own **views**: a table, a gallery of cards or a list, each with its own columns, filters, sort order and grouping.

- **Notes 101** opens as a table of these chapters, with the level and summary properties as columns
- **Research/Reading list** is a table with a gallery and a list of finished books as other views
- **Kitchen/Recipes** opens as a gallery, with a second view grouped by course

Open a folder, then use the view switcher at the top to change layout. Click a column header to sort, and drag a column border to resize it. A folder can also have an icon and a default template, both set from its menu.

Tags with fields get the same kind of table, built from the tag's fields: [[08 Tags and tags with fields]]. A view can also sit inside a note, as in [[04 Code, math and diagrams]].

Next: [[10 Note tools]].
