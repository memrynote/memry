---
tags:
  - notes-101
level: Beginner
summary: 'Templates for notes, journal days and tags, and how each one gets applied'
---
A template is starting content for a note: a body, and optionally tags, properties and an icon. It saves you retyping the same headings.

## Templates in this vault

| Template                       | Where it applies                                            |
| ------------------------------ | ----------------------------------------------------------- |
| Person, Company, Meeting, Book | Automatically, when you add that tag to an empty note       |
| Recipe                         | Automatically, when you add the recipe tag to an empty note |
| Paper note                     | The default for new notes in Research/Papers                |
| Daily journal                  | The default for new journal days                            |

Open **Settings, Templates** to see them next to the built-in ones (Daily Reflection, Weekly Review, Meeting Notes, Project Brief, Standup, Decision Log and Reading Notes). Built-ins are read-only; **Duplicate and Edit** makes your own copy.

## Four ways to apply one

1. **Create a note from it**: the create dialog has a template picker.
2. **Tag template**: a tag with fields can point at a template that fills an empty note when it gets the tag. Try adding the meeting tag to a new empty note, or look at [[Northlight kickoff]], which started from the Meeting template.
3. **Folder default**: a folder can name a template, so every new note in it starts from that one.
4. **Apply or insert**: on an existing note, the **...** menu has **Apply Template** (replaces the body, and can add tags and properties) and **Insert template content...**, which drops a template at the cursor and touches nothing else. Type **/** and the template's name for the quick way.

## Variables

Placeholders are filled in when a template is applied. They are stored as written, so editing the note never changes the template:

```text
## {{title}}
Date: {{date:YYYY-MM-DD}}
Weekday: {{day-of-week}}
```

Also available: `{{date}}` for the full date, and `{{time}}`.

## Make your own

Open a note you like and choose **Save as Template** from its **...** menu, or start from scratch in Settings. Edits to a template are saved a moment after you stop typing.

A checkbox in a template stays a plain checkbox; the notes made from it turn them into tasks of their own only when you start editing.

See also [[Journal]] for the journal's default template.

Next: [[12 Bookmarks and reminders]].
