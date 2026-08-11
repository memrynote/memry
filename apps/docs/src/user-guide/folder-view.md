# Folder View

A table view over a collection of notes with sortable columns and grouping. Like a database for your notes.

<!-- screenshot: folder view as a sortable table -->

## When to Use

When you want a database-like overview rather than the linear sidebar list. Especially useful when notes have **custom properties** you want to compare side-by-side.

## Columns

By default the table shows:

- Title
- Tags
- Created
- Modified

You can show / hide columns including any custom property:

- Click the **column picker** in the header
- Toggle each property on/off
- Drag headers to reorder

Property columns let you sort and filter by typed values (numbers, dates, select).

## Sorting

Click any header to sort. Click again to reverse direction. <kbd>⇧</kbd>+click for **secondary sort** (sort by A then B).

## Grouping

Group rows by:

- Folder
- Tag
- Property value (e.g. all rows with `Status: Live`)

Group headers count rows and roll up subgroup counts.

## Filtering

A filter bar above the table accepts:

- Free-text search across visible columns
- Property-specific filters (e.g. `Created after: 2026-01-01`)
- Tag filters (`#tagname`)

Active filters show as chips you can dismiss.

## Density

A density toggle in the toolbar:

| Density  | Row height      |
| -------- | --------------- |
| Compact  | minimal padding |
| Normal   | comfortable     |
| Spacious | extra room      |

Persisted per device.

## Inline Editing

Click any editable cell to update a property in place. Supported types:

- Text
- Number
- Date
- Select / multi-select
- Checkbox

Some fields (e.g. created date) are read-only.

## Bulk Operations

Select rows with checkboxes for:

- Move to folder
- Add / remove tags
- Set / clear properties (for editable types)
- Delete

The bulk action bar appears at the top of the table when rows are selected.

## Saved Views

Save the current columns, sort, group, and filters as a named view with **Add view** in the toolbar. Switch between saved views from the same dropdown, duplicate one as a starting point, set one as the default, or delete it. Saved views persist across restarts and sync to your other devices.

Opening a tag (see [Properties & Tags](/user-guide/notes/properties-tags)) shows this same folder view, scoped to that tag, with its own set of saved views — a "By status" view saved on tag `work` doesn't show up on tag `personal`. Renaming a saved view isn't available for tags yet; rename, duplicate, default, and delete all work normally.

## Breadcrumb

If you opened folder view from a folder, a breadcrumb at the top lets you navigate up to parent folders. A tag-scoped folder view shows the tag instead, as a locked `tag = <name>` filter chip that can't be removed — it defines the view.

## Staying Up To Date

A folder view refreshes itself as the vault changes, so you can keep one open in a split pane next to the note you are writing.

Rows appear, disappear, and move immediately when a note is created, renamed, moved to another folder, or deleted — whether you did it in Memry, another device did it and it arrived over sync, or you did it in Finder, Explorer, or Obsidian. Tag-scoped views update the same way when a note gains or loses the tag.

Row _contents_ — Modified, word count, properties, title, emoji — settle a few seconds after you stop typing rather than on every autosave. Which notes are listed is never delayed; only their columns are.

## See Also

- [Properties & Tags](/user-guide/notes/properties-tags)
- [Tabs & Split View](/user-guide/tabs-split-view) — folder views open as tabs
