# Properties & Tags

Add structured metadata to notes with custom **properties** and free-form **tags**.

<!-- screenshot: properties panel and tags row at the top of a note -->

## Tags Row

A row at the top of every note for free-form labels.

- Click the tag area to add a tag
- Comma or space confirms
- Tags are global — the same tag on two notes is the same tag

Tags appear in the sidebar **Tags** section. Click any tag to drill into a list of notes that share it.

### Renaming or Deleting Tags

Manage tags globally from [Settings → Tags](/user-guide/settings#tags). Renames apply across every note instantly.

## Properties Panel

A collapsible section under the title for **structured** metadata. Properties are typed and reusable.

### Property Types

| Type | Use for | Example |
| --- | --- | --- |
| Text | Free-form short strings | "Author" |
| Number | Numeric values | "Pages" |
| Date | Dates and date ranges | "Started", "Due" |
| Select | One value from a defined set | "Status: Draft / Live" |
| Multi-select | Many values from a defined set | "Topics: Coding, Health" |
| Checkbox | Boolean | "Archived" |
| Status | Workflow stage with color | "Todo / In progress / Done" |

### Defining Properties

Open [Settings → Properties](/user-guide/settings#properties) to create, rename, recolor, or reorder property definitions and their options.

A property definition is reused across every note that adopts it — adding a `Topics` multi-select once means every note has access to the same vocabulary.

### Adding a Property to a Note

In the property panel, click **Add property** and pick from the list. Set the value inline.

## Tags vs Properties — When to Use Which

| Need | Use |
| --- | --- |
| Quick free-form labels you don't pre-define | Tags |
| A controlled vocabulary across many notes | Multi-select property |
| A single workflow state per note | Status property |
| A date or numeric value | Typed property |

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

Tags and property values live in the data DB. Tag indexes and link graphs are mirrored into the index DB for fast lookups.
