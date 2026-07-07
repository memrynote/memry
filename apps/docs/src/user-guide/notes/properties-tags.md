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

Tags appear in the sidebar **Tags** section. Click any tag to drill into a list of notes that share it.

### Renaming or Deleting Tags

Manage tags globally from [Settings → Tags](/user-guide/settings#tags). Renames apply across every note instantly.

### Tag Icons

Give any tag a custom icon to tell it apart at a glance. In [Settings → Tags](/user-guide/settings#tags), click the icon next to a tag name and pick an emoji or icon (or clear it to fall back to the default). The icon is stored on the tag and syncs across your devices.

You can also set a tag's icon straight from the sidebar: drill into a tag and click the chip in its detail header. Once set, the icon shows everywhere the tag appears — the sidebar tag list, the tag chips on a note or journal entry, and inline `#tags` in the editor.

## Properties Panel

A collapsible section under the title for **structured** metadata. Properties are typed and reusable.

### Property Types

| Type         | Use for                        | Example                     |
| ------------ | ------------------------------ | --------------------------- |
| Text         | Free-form short strings        | "Author"                    |
| Number       | Numeric values                 | "Pages"                     |
| Date         | Dates and date ranges          | "Started", "Due"            |
| Select       | One value from a defined set   | "Status: Draft / Live"      |
| Multi-select | Many values from a defined set | "Topics: Coding, Health"    |
| Checkbox     | Boolean                        | "Archived"                  |
| Status       | Workflow stage with color      | "Todo / In progress / Done" |

### Defining Properties

Open [Settings → Properties](/user-guide/settings#properties) to create, rename, recolor, or reorder property definitions and their options.

A property definition is reused across every note that adopts it — adding a `Topics` multi-select once means every note has access to the same vocabulary.

### Adding a Property to a Note

In the property panel, click **Add property** and pick from the list. Set the value inline.

For a `Date` property, clicking the value opens a calendar pop-up — pick a day, or type the date directly. Dates display in the format chosen at **Settings → General → Date Format**.

### Showing Dates on the Calendar

A `Date` property can surface its value on the [calendar](/user-guide/calendar). On a date property's row, click the calendar icon to turn on **Show on calendar** — the icon stays tinted while it's on, so you can see the state at a glance. The note then appears as an all-day chip on that date, and clicking the chip opens the note. The setting is vault-wide per property name and syncs across your devices.

## Tags vs Properties — When to Use Which

| Need                                        | Use                   |
| ------------------------------------------- | --------------------- |
| Quick free-form labels you don't pre-define | Tags                  |
| A controlled vocabulary across many notes   | Multi-select property |
| A single workflow state per note            | Status property       |
| A date or numeric value                     | Typed property        |

Tags are zero-cost and discoverable. Properties are structured and great for filtering [Folder View](/user-guide/folder-view).

## Filtering and Discovery

- **Sidebar tag list** — click any tag for a tag detail view
- **Folder view columns** — show any property as a sortable column
- **Search palette** — type `#tag` to filter results by tag

## Where Tags Show Up

- Tags row on each note
- Sidebar Tags section (alphabetical, with usage counts)
- Wiki link autocomplete (`[[#tag]]`)
- Search (`#tag` filter)

## Storage

Properties are written into the note file itself as top-level YAML frontmatter keys, formatted exactly the way Obsidian writes properties — you can open the vault in Obsidian, edit a property there, and the file round-trips without formatting churn. Only `tags` and `aliases` have special meaning; every other frontmatter key is a property. Notes written by older Memry versions that nested properties under a `properties:` block are still read; the block migrates to top-level keys the next time the note's properties are saved.

MemryNote keeps its internal bookkeeping — the note id and created/modified dates — in the local database and never writes its own keys into your files; a note with no properties has no frontmatter block at all.

Tags and property values are also indexed in the data DB. Tag indexes and link graphs are mirrored into the index DB for fast lookups.
