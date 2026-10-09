# Tags With Fields

A plain tag is a label. A **tag with fields** also says what a note is. Tag a note `#person`
and it gets the Person fields (Company, Role, Email, Phone), the Person template, and a row in
the `#person` table.

For example, you write a note called "Ahmet Yılmaz" and add `#person` in its tags row. The
properties panel shows a **Person** group with four empty fields. You fill in Company, and the
note's frontmatter gains one line:

```yaml
---
tags:
  - person
Company:
  - memry://note/<id of the company note>
---
```

The empty fields write nothing. Ahmet's note now shows in the `#person` table, and the
company's note lists him under **Linked here**.

## Which notes get the fields

A note gets a tag's fields only when the tag is in its **tags row** (the `tags:` frontmatter),
or when a tag in its tags row [extends](#extends) that tag. These notes are the tag's
_objects_.

- A `#person` typed in the text of a note stays a label. The note is listed under
  **Mentioned in** on the tag's page, not in its table. Clicking the inline tag offers
  **Make this note a Person**, which adds the tag to the tags row. See
  [An inline tag with fields](/user-guide/notes/wiki-links#an-inline-tag-with-fields).
- A plain inline tag (one without fields) still joins the tags row when you type it, as
  described in [Properties & Tags](/user-guide/notes/properties-tags#tags-row). A tag with
  fields, its own or inherited, never does.
- Child tags do not count: `#person/vip` is its own tag. It is an object of `#person` only
  if it extends `#person`.
- Journal entries, PDFs, images and other attachments are never objects.
- When a plain tag gains fields, notes that already have it in their tags row become objects.
  The dialog that adds the fields says how many.

## Ready-made tags

The Tags hub shows a **Ready-made tags** strip with Person, Company, Meeting and Book. Memry
never creates them on its own: each one exists only after you click **Add**. **Not now** hides
the strip for this vault.

| Tag     | Fields                                                         | Template sections           |
| ------- | -------------------------------------------------------------- | --------------------------- |
| Person  | Company (one Company), Role, Email, Phone                      | Context, Notes              |
| Company | Website, Industry, Location                                    | Overview, Notes             |
| Meeting | Date (shown on the calendar), Attendees (many People), Company | Agenda, Notes, Action items |
| Book    | Author, Shelf (To read, Reading, Read), Rating, Finished       | Highlights, Thoughts        |

Tag and field names are created in the app language, so a Turkish app adds `#kişi`. If a tag
with that name already exists, the button reads **Add fields**: the dialog says how many notes
carry the tag, and they keep everything they have. **Use another name** adds the ready-made tag
under a new name instead. Adding Meeting or Person also adds the tags their relation fields
point at, when those are missing.

The `@` menu offers ready-made tags you have not added yet when you create a note from it; see
[Finding and creating them with @](/user-guide/notes/wiki-links#finding-and-creating-them-with).

## Editing a tag

On a tag's page, **Edit tag** opens its settings beside the table: appearance, **Extends**,
**Fields** and **Template**. Changes sync to your other devices.

### Fields

A field's name is the frontmatter key on notes. Names are shared across the vault: if `#meeting`
and `#project` both have Status, they share one Status property, with one type and one set of
options. Adding a field whose name already exists as a property asks whether to share it.

- **Add field** picks a type (text, number, date, URL, status, select, multi-select, checkbox,
  relation) or reuses an existing property. Adding a field rewrites no files.
- **Remove** takes the field off the tag. Notes keep their values as their own properties.
- **Rename** renames the key in every note and task that has a value, and in every other tag
  that lists the field, with progress shown. Other Markdown apps see the new name too.

### Relations

A relation field links to other notes, such as a meeting's Attendees. Its settings set:

- **Points to notes tagged**: the picker offers only objects of that tag, and can create one.
  Leave it empty to link to any note.
- **How many**: one or many.
- **List them as**: the label on the linked note's **Linked here** panel, such as Meetings on
  a person. That list is read-only; nothing is written to the linked note.

You can also drag a note from the sidebar onto a relation field. If the note does not have
the target tag yet, Memry asks before it adds the tag to the note's header and links it. A
field set to one link replaces its value when you pick or drop another note.

The value is stored as a list of `memry://note/<id>` links, even for "one".

### Extends

A tag can extend one other tag. If `#client` extends `#company`, every `#client` note gets the
Company fields and shows in the `#company` table with a small `#client` label. Chains work
(`#vip-client` extending `#client`). The picker does not offer a tag that would make a loop.

Inherited fields are edited on the parent; the child shows them as **From #company · edit
there**. A child without its own template uses its parent's.

### Templates

A tag can point at one of your [templates](/user-guide/templates). With **Fill empty notes when
they get #tag** on:

- Adding the tag to an empty note fills it with the template. The toast has **Undo**, which
  removes the template text and keeps the tag. If you edited the note in the meantime, the
  template stays.
- Adding the tag to a note that already has text shows a row offering **Add the Person template
  below your text**. Dismissing it is remembered for that note.

### Deleting a tag

**Delete tag** removes the tag from every note's tags row and removes its fields and template.
Values stay on the notes as properties, and a `#tag` written in the text stays as plain text.

## On a note

Each tag with fields shows as a group named after the tag at the top of the properties panel.
The note's other properties stay below, under **This note**. The tag picker marks tags with
fields and lists their field names.

- **Empty fields write nothing.** A value reaches the file only when you type one.
- **Untagging** keeps every filled value as a property of the note. **Undo** puts the tag back.
- How objects appear in links, the `@` menu and **Linked here** is covered in
  [People and Things in Links](/user-guide/notes/wiki-links#people-and-things-in-links).
- The tag's table is a [folder view](/user-guide/folder-view#tags-with-fields).

## On a task

A task has no inline tags, so every tag on it counts. A tag with fields shows its fields in the
task drawer, under Tags. The values live on the task and sync with it. The first filled relation
field appears on the task's row as a chip, for example "Waiting on Ahmet Yılmaz", and the linked
note lists the task under **Linked here**.

## Fill from note

When AI is on and an [inline AI provider](/user-guide/ai/provider-setup) is set up, a field
group with empty fields shows **Fill from note**. The model reads that note and suggests values
for the empty fields.

- Nothing is saved until you accept. Click ✓ on one suggestion, × to drop it, **Accept all**
  (<kbd>⌘</kbd><kbd>↵</kbd>), or **Dismiss**.
- Hovering a suggestion highlights the sentence it came from.
- A suggested relation value with no note yet, such as a new company, is created as a note
  with the target tag when you accept it.
- The first time, Memry names the model and says that only this note is sent. With a local
  model, it says nothing leaves the device. You confirm once per device.

On a tag's page, **Fill empty fields** reads the tag's notes one at a time, with progress and
**Stop**, and lists what it found. **Accept all** saves everything, and **Review one by one**
lets you accept or skip each note.

## Renaming a tag

Renaming a tag with fields works like any [tag rename](/user-guide/notes/properties-tags#renaming-or-deleting-tags):

- It renames the tag in every note's tags row, in `#tags` written in note and journal text, and
  on tasks.
- Child tags follow: `person` to `people` turns `person/vip` into `people/vip`, with their
  colours, icons, views and fields.
- If the new name already exists, the two tags merge. The existing tag keeps its colour and
  fields.
- Tags that extend the renamed tag, and relation fields that point at it, follow the new name.

Renaming a **field** is different: it changes the frontmatter key in each note, as described in
[Fields](#fields).
