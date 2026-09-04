# Properties & Tags

Add structured metadata to notes with custom **properties** and free-form **tags**.

<!-- screenshot: properties panel and tags row at the top of a note -->

Use **Add property** or **Add tag** above the note title to attach metadata before you start writing.

## Tags Row

A row under the title shows the note's free-form labels.

- Click the tag area to add a tag
- Comma or space confirms
- Tags are global — the same tag on two notes is the same tag
- Tags keep the capitalization you type (`#Work` stays `#Work`), but identity is case-insensitive: `#Work` and `#work` are the same tag with one color and one combined count. This also applies to imported notes — an Obsidian vault's tag casing survives the import.

Tags appear in the sidebar **Tags** section, grouped by category (see
[Tag Categories](#tag-categories) below). Click any tag — in the sidebar, on a note, or in
the tag hub — to open its own tab: the same [Folder View](/user-guide/folder-view), scoped to
that tag, listing every note, task, and inbox item that carries it. Filter by `kind` (notes /
tasks / inbox) alongside any other property. See [Capturing Tasks](/user-guide/tasks/capturing)
for tagging tasks.

The tag itself shows as a locked `tag = <name>` filter chip — it defines the view and can't be
removed, unlike every other filter you add. The tag page includes nested tags: opening `work`
also lists items tagged `work/urgent`. (The task filter bar matches exactly, so filtering tasks
on `work` there won't include `work/urgent`.)

A tag's saved views (columns, sort, group, filters) are scoped to that tag — a "By status" view
saved on `work` doesn't show up on `personal` — and sync to your other devices along with the
tag itself. See [Saved Views](/user-guide/folder-view#saved-views).

### Renaming or Deleting Tags

Manage tags globally from [Settings → Tags](/user-guide/settings#tags), or open a tag's own
page and use its header menu to rename, recolor, or delete it directly. Renames apply across
every note instantly.

Renaming or deleting a tag currently updates your **notes** only — tasks keep the original
tag, so a task tagged `MIT` stays `MIT` even after you rename that tag. **Merging** two tags
does carry across tasks. To retag a task directly, edit it in the task detail drawer.

### Tag Icons

Give any tag a custom icon to tell it apart at a glance. In [Settings → Tags](/user-guide/settings#tags), click the icon next to a tag name and pick an emoji or icon (or clear it to fall back to the default). The icon is stored on the tag and syncs across your devices.

You can also set a tag's icon straight from its own page: click the chip in the page header. Once set, the icon shows everywhere the tag appears — the sidebar tag list, the tag chips on a note or journal entry, and inline `#tags` in the editor.

## Tag Categories

Group related tags together and give the sidebar a stable, deliberate order. Open the **tag
hub** to manage categories and tags in one place — either from the grid icon next to the
sidebar's **Tags** section header, or by picking **Tags** in the create menu (the chevron
beside the sidebar's **New** button, and the **+** on the tab bar).

- **New category** — click **New category**, name it, press Enter.
- **New tag** — click **New tag** in the hub, name it, and pick a starting color. (You can
  still create a tag the usual way, by typing `#tag` on a note or in the tags row — this is
  just a second entry point that lets you place it in a category up front.) The tag appears
  in the hub straight away with a count of 0 and stays there until you use it, so you can lay
  out a set of tags before writing anything. It keeps the capitalisation you typed —
  `Reading` stays `Reading` — and because tag names ignore case, typing `reading` afterwards
  reopens the same tag rather than making a second one. Until a note or task uses it, an
  empty tag shows in the hub, in tag pickers, and in the editor's `#` autocomplete, but not in
  the sidebar's Tags section, which lists the tags actually in use.
- **Rename or delete a category** — hover its heading for the pencil and trash icons.
  Deleting a category does not delete its tags; they fall back to **Uncategorized**.
- **Reorder** — drag a category to reorder categories, or drag a tag chip between or within
  categories to change its category and its position at the same time.
- **Search** — the hub's search box filters both category and tag names as you type.

The sidebar's Tags section mirrors the hub's categories and order. Its sort control defaults
to **Manual** (the hub's drag order), with Most used, Least used, A → Z, and Z → A as
alternatives. A tag with no category — or one whose category was deleted on another device
before this one synced — shows under **Uncategorized** rather than disappearing.

Categories and each tag's category/position sync across your devices like everything else in
the vault.

## Properties Panel

A collapsible section under the title for **structured** metadata. Properties are typed and reusable.

### Property Types

| Type         | Use for                                | Example                       |
| ------------ | -------------------------------------- | ----------------------------- |
| Text         | Free-form short strings                | "Author"                      |
| Number       | Numeric values                         | "Pages"                       |
| Date         | Dates and date ranges                  | "Started", "Due"              |
| Select       | One value from a defined set           | "Status: Draft / Live"        |
| Multi-select | Many values from a defined set         | "Topics: Coding, Health"      |
| Checkbox     | Boolean                                | "Archived"                    |
| Status       | Workflow stage with color              | "Todo / In progress / Done"   |
| Relation     | Links to other notes, tasks, or events | "Related to: Project Kickoff" |
| Project      | Link to one or more projects           | "Project: Website Redesign"   |

### Defining Properties

Open [Settings → Properties](/user-guide/settings#properties) to create, rename, recolor, or reorder property definitions and their options.

A property definition is reused across every note that adopts it — adding a `Topics` multi-select once means every note has access to the same vocabulary.

Option names are unique within a property. Adding an option whose name already exists keeps the existing one, including its color, rather than creating a second entry.

A status property you have not customized yet shows the built-in `Todo` / `In progress` / `Done` set. The first option you add to it saves that set alongside your new option, so what the picker shows and what the vault stores stay the same.

Property definitions sync across your devices. A `select` you define on the desktop reaches your
other desktop and your phone with its type and its option colors intact, so the same value shows
the same colored chip everywhere. A value that no longer matches any option — an option renamed on
another device before this note synced — still renders, in gray, rather than disappearing.

### Adding a Property to a Note

In the property panel, click **Add property** and pick from the list. Set the value inline.

For a `Date` property, clicking the value opens a calendar pop-up — pick a day, or type the date directly. Dates display in the format chosen at **Settings → General → Date Format**.

### Showing Dates on the Calendar

A `Date` property can surface its value on the [calendar](/user-guide/calendar). On a date property's row, click the calendar icon to turn on **Show on calendar** — the icon stays tinted while it's on, so you can see the state at a glance. The note then appears as an all-day chip on that date, and clicking the chip opens the note. The setting is vault-wide per property name and syncs across your devices.

### Relation Properties

A `Relation` property points to one or more other notes, tasks, or events. Each value renders as a chip showing the target's title and an icon for its kind. Titles are resolved live, so renaming a target updates every chip pointing at it.

Use the relation picker to search and add targets, and to remove existing ones. A target that's been deleted still shows its chip, dimmed, so the reference isn't silently dropped.

Relation properties also feed the [Backlinks panel and Graph view](/user-guide/notes/wiki-links) on the note(s) they point to, alongside wiki links — so a relation and a `[[wiki link]]` to the same note both show up as connections.

### Project Property

A note or journal entry joins a project through its **`project` property**, not a menu. Choose **Add property → Project** to create the row; only one `project` property is allowed per note, so once it's added, that entry in the Add property list is disabled.

- **Value** — a list of project names, picked from a dropdown. Each choice shows the project's color and icon; archived projects still resolve to their real appearance there, they just don't appear in the picker for new links. A name that matches no project (a typo, or a project deleted on another device before this note synced) still renders, muted, rather than being silently dropped.
- **Remove** — click the `×` on a chip.
- **Storage** — the value lives in the note's **frontmatter** as a plain list of project names, so it's visible and editable in a plain markdown editor and travels with the file. memrynote writes it alongside the note's other properties, under the `properties:` key:

  ```yaml
  ---
  properties:
    project:
      - Website Redesign
  ---
  ```

  A `project:` list written at the top level by another editor is read as well, as long as that note has no `properties:` block of its own. Frontmatter is the source of truth; the [project hub](/user-guide/projects#project-hub) reflects it, not the other way around.

- **Renaming or deleting a project** rewrites the `project` value in every linked note's frontmatter — a rename updates the name in place, a delete removes it from the list.
- Dragging a note or journal entry onto a project in the sidebar sets this same property.
- **In a [folder view](/user-guide/folder-view) column**, each project shows as a pill with the project's color and icon; clicking one opens that project's page, the way clicking a tag opens its tag page. The cell is read-only there — a `project` value is a list of project _names_, so editing it as free text in a table would point the note at a project that doesn't exist. Add, remove, and rename projects from the note's property row or the project itself.

::: tip First open after upgrading
Notes that were already linked to a project before this property existed get that link written into their frontmatter once, the first time you open the vault. Those notes are saved in the same pass, so their frontmatter is normalised the way any memrynote save normalises it: tags written inline in the note body are lifted into the `tags:` list, and tag capitalisation follows what memrynote has indexed. Nothing is removed, and the note body is untouched.
:::

Files and calendar events have no frontmatter, so they keep their own **Add to project** action instead of a property — see [Projects](/user-guide/projects#linking-notes-events-and-files).

## Tags vs Properties — When to Use Which

| Need                                        | Use                   |
| ------------------------------------------- | --------------------- |
| Quick free-form labels you don't pre-define | Tags                  |
| A controlled vocabulary across many notes   | Multi-select property |
| A single workflow state per note            | Status property       |
| A date or numeric value                     | Typed property        |

Tags are zero-cost and discoverable. Properties are structured and great for filtering [Folder View](/user-guide/folder-view).

## Filtering and Discovery

- **Sidebar tag list or tag hub** — click any tag to open its page
- **Folder view columns** — show any property as a sortable column
- **Search palette** — type `#tag` to filter results by tag

## Where Tags Show Up

- Tags row on each note
- Sidebar Tags section (grouped by category, with usage counts)
- The tag hub (organize categories) and each tag's own page (everything tagged with it)
- Wiki link autocomplete (`[[#tag]]`)
- Search (`#tag` filter)

## Storage

Tags and property values live in the data DB, alongside tag categories and each tag's
category/sort order. Tag indexes and link graphs are mirrored into the index DB for fast
lookups.

In the vault's markdown files, a note's frontmatter contains only your own properties (plus `tags` and `aliases`). MemryNote keeps its internal bookkeeping — the note id and created/modified dates — in the local database and never writes its own keys into your files; a note with no properties has no frontmatter block at all.

Frontmatter in your `.md` files is treated as yours: memrynote re-emits the original block byte-for-byte (comments, key order, and quoting included) unless you actually edit a property, tag, or alias in the app. Saving a note without changing anything writes nothing to disk at all.

### A `#tag` in the body stays in the body

A tag written inline in a note's text is indexed like any other — it shows in the sidebar, in
search, and on the tag's own page — but **opening that note does not lift it into the
`tags:` frontmatter**. The file is left exactly as you wrote it, which matters if you keep
your tags in the body the way an Obsidian vault often does.

Adding or removing an inline tag while editing still updates the note's tags, as it always
has. Only _opening_ a note is now a read.

Body tags hold up across devices too. A note's tags sync as its `tags:` frontmatter, so a tag
that lives only in the body isn't part of what travels — each device reads it back out of the
note's own text instead, and a note edited elsewhere keeps its inline tags here rather than
dropping out of the sidebar and tag search until the vault is re-indexed. Nothing is written
into your frontmatter to make that work.

::: tip
Notes that already had a `tags:` block added by an earlier version keep it. An injected block
is indistinguishable from one you wrote yourself, so nothing tries to unpick it — delete the
block by hand if you would rather the tag lived only in the body.
:::

If a note's frontmatter isn't valid YAML — an unterminated quote, an unclosed list — the note is still indexed. Its text stays searchable and its links still show up in the graph; only its properties, tags, and aliases are unavailable until the YAML is fixed. The broken block is left on disk untouched, so you can repair it in memrynote or any other editor.
