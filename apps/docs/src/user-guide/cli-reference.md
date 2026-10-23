# CLI Reference

A flat reference for every `memrynote` command, flag, and positional argument. For a
prose walkthrough, see [Command Line](/user-guide/cli).

## Synopsis

```bash
memrynote [--vault <path>] [--json] <command> [subcommand] [args] [flags]
```

The 26 top-level commands are listed in the [usage error](https://github.com/memrynote/memry/blob/main/apps/cli/src/run.ts)
when you run `memrynote` with no arguments:

```
vault | notes | folders | properties | folder-view | tasks | projects |
inbox | journal | tags | settings | locale | reminders | templates |
bookmarks | saved-filters | calendar | sync | agent | graph | search |
canvas | home-pages | icons | import | readwise
```

## Global flags

| Flag             | Type    | Description                                                    |
| ---------------- | ------- | -------------------------------------------------------------- |
| `--vault <path>` | path    | Override the default vault for this call.                      |
| `--json`         | boolean | Emit machine-readable JSON instead of a human-formatted block. |

The CLI reads the default vault from your desktop **Settings → Command Line →
Default vault**. With multiple vaults configured, you must pick one either via
`memrynote vault use <name>` or `--vault <path>` per call.

## Output conventions

Without `--json`, primitives print as themselves and objects/arrays pretty-print
as JSON with 2-space indentation. With `--json`, the underlying `MemryApp.*`
method's return value is emitted on a single line. Delete commands return
`{ "success": boolean }`; bulk operations typically return `{ "count": number }`.

Commands that change or remove data are marked **destructive** below. Every
destructive command requires `--yes` and exits non-zero without it.

---

## vault

```
memrynote vault <list|current|use|remove|init|status|open|config|update-config|reindex|set-icon|activity|locks> [args]
```

### list

Lists known vaults from the desktop app's registry.

| Flag   | Type | Required | Description |
| ------ | ---- | -------- | ----------- |
| _none_ |      |          |             |

```bash
memrynote vault list
```

### current

Prints the active vault (from `--vault` or the configured default).

```bash
memrynote --json vault current
```

### use

Sets the default vault for future CLI calls.

| Positional             | Description                                   |
| ---------------------- | --------------------------------------------- |
| `<vault-name-or-path>` | A name from `vault list` or an absolute path. |

```bash
memrynote vault use work
```

### init

Idempotently creates `.memry/` folder layout and the local databases if missing.

```bash
memrynote vault init
```

### status

Returns vault metadata: path, version, sizes, last opened.

```bash
memrynote vault status
```

### open

Alias of `status`.

### config

Returns the vault's editable config.

```bash
memrynote vault config
```

### update-config

Merges a JSON object into the vault config.

| Positional | Description            |
| ---------- | ---------------------- |
| `<json>`   | Partial config object. |

```bash
memrynote vault update-config '{"excludePatterns":[".git","tmp"]}'
```

### reindex

Rebuilds the full-text search index (`fts_notes`, `fts_tasks`, `fts_inbox`) from scratch, as the
desktop's "Rebuild search index" does. Notes come from the files of notes the desktop has already
indexed, so a note created only through the CLI is found by the substring scan until the desktop
opens the vault. Returns `{ notes, tasks, inbox, skipped, durationMs }`. `skipped` counts indexed
notes whose file could not be read. Safe to repeat. It changes no vault files.

```bash
memrynote vault reindex
```

### set-icon

Sets the vault's icon, or resets it to the default. The desktop syncs the change to your account
the next time it runs.

| Positional | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| `<icon>`   | `icon:<Name>` (for example `icon:Star`), a single emoji, or `null` to reset. |

```bash
memrynote vault set-icon icon:Star
```

### activity

Reads or clears the vault activity log (`.memry/activity.jsonl`): files picked up, removed,
skipped or failed, and importer runs. The log stays on this device.

```bash
memrynote vault activity list [--problems] [--limit <n>]
memrynote vault activity clear --yes
```

`list` returns the newest entries first (default 200, at most 1000). `--problems` keeps skipped
and failed entries and summaries that count either. `clear` needs `--yes`.

### locks

```bash
memrynote vault locks list
```

Returns `{ notes: [<note id>], folders: [<folder path>] }` for the read-only locks on this device.
`vault locks set` exits with an error: locking protects the files on disk and syncs the lock, which
only the desktop app does.

### remove (destructive)

Takes a vault off the list of known vaults. Its files stay on disk. Needs the desktop app command
(`Settings → Command Line`) and `--yes`.

| Positional             | Description                                   |
| ---------------------- | --------------------------------------------- |
| `<vault-name-or-path>` | A name from `vault list` or an absolute path. |

```bash
memrynote vault remove work --yes
```

---

## notes

```
memrynote notes <subcommand> [args]
```

### create

| Positional | Description     |
| ---------- | --------------- |
| `<title>`  | New note title. |

| Flag                  | Type        | Description                                                                                     |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `--content <text>`    | string      | Initial body. Defaults to empty.                                                                |
| `--folder <path>`     | string      | Target folder, vault-relative. Without it the note lands in the configured default note folder. |
| `--tag <name>`        | repeatable  | Tag to add. Pass multiple times.                                                                |
| `--properties <json>` | JSON object | Initial frontmatter.                                                                            |

```bash
memrynote notes create "Draft" --content "First line" --folder Projects --tag writing
```

### list

| Flag              | Type   | Description                              |
| ----------------- | ------ | ---------------------------------------- |
| `--folder <path>` | string | Restrict to one folder (vault-relative). |
| `--limit <n>`     | number | Max rows. Default `100`.                 |

```bash
memrynote notes list --folder Projects --limit 20
```

### get

| Positional     | Description                                 |
| -------------- | ------------------------------------------- |
| `<id-or-path>` | Note id (e.g. `note_abc123`) or vault path. |

```bash
memrynote notes get note_abc123
```

### exists

Returns `{ exists: boolean }`.

| Positional     | Description      |
| -------------- | ---------------- |
| `<id-or-path>` | Note id or path. |

### preview

Resolves a wiki-link title and returns a content preview.

| Positional | Description |
| ---------- | ----------- |
| `<title>`  | Note title. |

### resolve

Resolves a wiki-link title to a concrete note record (no body). A note's
aliases resolve too; a title always wins over an alias. Pass several titles to
resolve them in one call: the output is then an object keyed by title, each value
`{ "id", "path" }` or `null`.

| Positional | Description                                          |
| ---------- | ---------------------------------------------------- |
| `<title>…` | One or more titles, aliases, or `Folder/Note` paths. |

### links

Returns inbound and outbound links for a note.

| Positional     | Description      |
| -------------- | ---------------- |
| `<id-or-path>` | Note id or path. |

### update

| Positional     | Description     |
| -------------- | --------------- |
| `<id-or-path>` | Note to modify. |

| Flag                  | Type        | Description                               |
| --------------------- | ----------- | ----------------------------------------- |
| `--title <text>`      | string      | New title.                                |
| `--content <text>`    | string      | Replace body.                             |
| `--append <text>`     | string      | Append to body.                           |
| `--tag <name>`        | repeatable  | Replace tag set. Omit to leave untouched. |
| `--properties <json>` | JSON object | Replace frontmatter.                      |

```bash
memrynote notes update note_abc123 --append "More text" --properties '{"status":"active"}'
```

### rename

Renames the note and rewrites every inbound `[[Old Title]]` wiki-link
vault-wide — headings kept, aliases untouched, case-insensitive — the same way
the desktop app does.

| Positional     | Description |
| -------------- | ----------- |
| `<id-or-path>` | Note.       |
| `<new-title>`  | New title.  |

### move

| Positional     | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| `<id-or-path>` | Note.                                                           |
| `<folder>`     | Destination folder path, vault-relative. `''` = the vault root. |

### set-local-only

| Positional     | Description                   |
| -------------- | ----------------------------- |
| `<id-or-path>` | Note.                         |
| `<true/false>` | Whether to exclude from sync. |

### local-only-count

Returns the count of notes flagged local-only.

### delete (destructive)

Requires `--yes`. Returns `{ success: boolean }`.

| Positional     | Description |
| -------------- | ----------- |
| `<id-or-path>` | Note.       |

```bash
memrynote notes delete note_abc123 --yes
```

### attach

Copies the file into the vault, appends a desktop-style embed to the note body (inline image or clickable file block), and queues the upload for sync.

| Positional    | Description                                |
| ------------- | ------------------------------------------ |
| `<note-id>`   | Note.                                      |
| `<file-path>` | Absolute path to copy in as an attachment. |

Two other sources replace `<file-path>`:

| Flag                                    | Description                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--existing <owner-note-id>/<filename>` | Embeds an attachment another note already stores. Nothing is copied or uploaded; the ref points at the owner's file.         |
| `--url <url>`                           | Downloads a public `http(s)` image (jpeg, png, webp, gif, up to 10 MB) into the note's own attachments folder and embeds it. |

### attachments

Lists attachments for a note. With `--all` it lists every attachment in the
vault instead, newest first, each with its owning note (`ownerNoteId`,
`ownerNoteTitle`, `filename`, `displayName`, `size`, `mimeType`, `type`,
`modifiedAt`). `<note-id>` is not needed with `--all`.

| Positional  | Description |
| ----------- | ----------- |
| `<note-id>` | Note.       |

| Flag    | Type | Description                         |
| ------- | ---- | ----------------------------------- |
| `--all` | bool | List the whole vault's attachments. |

### delete-attachment (destructive)

Requires `--yes`.

| Positional        | Description |
| ----------------- | ----------- |
| `<note-id>`       | Note.       |
| `<attachment-id>` | Attachment. |

### import-files

| Positional   | Description                 |
| ------------ | --------------------------- |
| `<paths...>` | Files or folders to import. |

| Flag              | Type   | Description    |
| ----------------- | ------ | -------------- |
| `--folder <path>` | string | Target folder. |

### export-html

| Positional      | Description       |
| --------------- | ----------------- |
| `<note-id>`     | Note.             |
| `<output-path>` | Destination file. |

| Flag                              | Type    | Description                                          |
| --------------------------------- | ------- | ---------------------------------------------------- |
| `--no-metadata`                   | boolean | Omit frontmatter.                                    |
| `--include-metadata <true/false>` | boolean | Force include. Default `true`.                       |
| `--include-task-markers`          | boolean | Keep each task's `{task:<id>}`. Left out by default. |

### export-pdf

Same positionals as `export-html` plus:

| Flag                              | Type    | Description                                          |
| --------------------------------- | ------- | ---------------------------------------------------- |
| `--no-metadata`                   | boolean | Omit frontmatter.                                    |
| `--include-metadata <true/false>` | boolean | Force include. Default `true`.                       |
| `--include-task-markers`          | boolean | Keep each task's `{task:<id>}`. Left out by default. |
| `--page-size <name>`              | string  | e.g. `A4`, `Letter`.                                 |

### export-markdown

| Positional      | Description             |
| --------------- | ----------------------- |
| `<note-id>`     | Note.                   |
| `<output-path>` | Destination `.md` file. |

### snapshot

Creates a manual version snapshot.

| Positional  | Description |
| ----------- | ----------- |
| `<note-id>` | Note.       |

| Flag               | Type    | Description                                     |
| ------------------ | ------- | ----------------------------------------------- |
| `--reason <label>` | string  | Snapshot label. Default `manual`.               |
| `--force`          | boolean | Take a snapshot even if content hasn't changed. |

### versions

Lists the version history of a note.

| Positional  | Description |
| ----------- | ----------- |
| `<note-id>` | Note.       |

| Flag          | Type   | Description   |
| ------------- | ------ | ------------- |
| `--limit <n>` | number | Default `50`. |

### version

Returns one snapshot.

| Positional      | Description |
| --------------- | ----------- |
| `<snapshot-id>` | Snapshot.   |

### restore-version

Restores a note to a snapshot.

### delete-version (destructive)

Requires `--yes`.

### aliases

Shows or edits a note's other names (the `aliases` frontmatter list). Edits are
deltas: removals by name (case and spacing insensitive) first, then additions.
Names are trimmed, deduplicated, never equal to the title, and capped at 32. The
output is `{ "aliases": [...] }`.

| Positional     | Description      |
| -------------- | ---------------- |
| `<id-or-path>` | Note id or path. |

| Flag              | Type   | Description                              |
| ----------------- | ------ | ---------------------------------------- |
| `--add <name>`    | string | Add an alias. Repeatable.                |
| `--remove <name>` | string | Remove an alias. Repeatable.             |
| `--set <name>`    | string | Replace the list. Repeatable; use alone. |
| `--clear`         | bool   | Remove every alias.                      |

```bash
memrynote notes aliases note_abc123 --add "Standup" --add "Sync"
```

### apply-template

Replaces a note's body with a template's content (`{{title}}` is filled in). By
default it also adds the template's tags without dropping the note's own, merges
its properties (the note's values win), and leaves the title alone. Custom
templates only; the built-in templates exist in the desktop app.

| Positional      | Description |
| --------------- | ----------- |
| `<id-or-path>`  | Note.       |
| `<template-id>` | Template.   |

| Flag          | Type | Description                                      |
| ------------- | ---- | ------------------------------------------------ |
| `--body-only` | bool | Replace the body only; keep tags and properties. |

### unlinked-mentions

Lists notes that spell this note's title or an alias as plain text without
linking to it. Notes that already link to it are left out. Each entry has
`sourceId`, `sourcePath`, `sourceTitle`, and `contexts[]` (`snippet`,
`linkStart`, `linkEnd`); a context's position in the list is its `--ordinal`.

| Positional     | Description |
| -------------- | ----------- |
| `<id-or-path>` | Note.       |

### link-mention

Turns one unlinked mention into a wiki link: `[[Title|text]]`, or `[[Title]]`
when the text already spells the title. The output is `{ "linked": true|false }`;
`false` means that mention no longer exists.

| Positional    | Description                    |
| ------------- | ------------------------------ |
| `<source-id>` | Note holding the mention.      |
| `<target-id>` | Note the link should point to. |

| Flag            | Type   | Description                                |
| --------------- | ------ | ------------------------------------------ |
| `--ordinal <n>` | number | Which mention in the source (default `0`). |

### carried-tasks

Lists the tasks a note (or every note under a folder) carries as
`- [ ] Title {task:<id>}` lines, so you know what a delete would orphan. A task
also linked to a note that stays is left out. The output is
`{ "taskIds": [...] }`. This only reads; it deletes nothing.

| Positional   | Description |
| ------------ | ----------- |
| `<note-id>…` | Notes.      |

| Flag              | Type   | Description                              |
| ----------------- | ------ | ---------------------------------------- |
| `--folder <path>` | string | Include every note under it. Repeatable. |

### similar / suggest-tags

Desktop shows similar notes and tag suggestions from its on-device embeddings
index. The CLI cannot read that index, so both commands exit non-zero with a
message saying so.

### positions

Prints the manual sidebar order as `{ "positions": { "<path>": <n> } }`.

| Flag              | Type   | Description                                    |
| ----------------- | ------ | ---------------------------------------------- |
| `--folder <path>` | string | Only that folder (use `.` for the vault root). |

### reorder

Sets the manual sidebar order of notes in one folder, first note first. Every
path must be an existing note directly inside that folder.

| Positional     | Description                          |
| -------------- | ------------------------------------ |
| `<note-path>…` | Vault-relative note paths, in order. |

| Flag              | Type   | Description                          |
| ----------------- | ------ | ------------------------------------ |
| `--folder <path>` | string | The folder. Omit for the vault root. |

### read-lines

Reads a window of lines from a note or any vault file without loading it whole,
for files too large to open. Lines are 0-based like the desktop large-file
viewer; a line over 64 KB is cut and listed in `truncated`. The output is
`{ startLine, lines, truncated, endOfFile }`.

| Positional     | Description                          |
| -------------- | ------------------------------------ |
| `<id-or-path>` | Note id, or a path inside the vault. |

| Flag          | Type   | Description                               |
| ------------- | ------ | ----------------------------------------- |
| `--from <n>`  | number | First line (default `0`).                 |
| `--count <n>` | number | Lines to read, 1 to 2000 (default `200`). |

### grep

Finds a literal text (ASCII case-insensitive, one line at a time) in a note or
vault file, streaming it. The output is `{ status, query, hits[], total, limited }`
where each hit is `{ line, ordinal }` and `hits` is capped at 2000 while `total`
counts every match.

| Positional     | Description                          |
| -------------- | ------------------------------------ |
| `<id-or-path>` | Note id, or a path inside the vault. |
| `<text>`       | Text to find, up to 200 characters.  |

### attachment-rename

Renames an attachment the note owns. The id prefix and the extension stay; the
name part is replaced (a clash gets `-2`, `-3`). The note body's embed and the
file block's `name` are updated. Other notes that borrowed the file through
`--existing` keep the old ref until it is repaired. The output is
`{ storedFilename, url, name }`.

| Positional    | Description                                       |
| ------------- | ------------------------------------------------- |
| `<note-id>`   | Owning note.                                      |
| `<filename>`  | Stored filename, as `notes attachments` shows it. |
| `<new-name>…` | New name. Words are joined with a space.          |

---

## folders

Folder paths are vault-relative: the configured default note folder is only
where an unplaced note lands, never a root the CLI resolves folders under.

### list

```bash
memrynote folders list
```

### create

| Positional | Description  |
| ---------- | ------------ |
| `<path>`   | Folder path. |

### rename

| Positional   | Description      |
| ------------ | ---------------- |
| `<old-path>` | Existing folder. |
| `<new-path>` | New path.        |

### delete (destructive)

Requires `--yes`.

| Positional | Description |
| ---------- | ----------- |
| `<path>`   | Folder.     |

### template

Shows or sets the folder's default template for new notes. Showing resolves the
way desktop does: the nearest folder up the tree with a template wins, and
`inherit: false` in a `.folder.md` stops the climb. Setting keeps the folder's
icon and views. The output is `{ "folder", "template" }`.

| Positional      | Description                                    |
| --------------- | ---------------------------------------------- |
| `<path>`        | Folder (use `.` for the vault root).           |
| `<template-id>` | Optional. Sets this template; omit to show it. |

| Flag      | Type | Description                   |
| --------- | ---- | ----------------------------- |
| `--clear` | bool | Remove the folder's template. |

---

## properties

### get

Returns custom properties for any entity (note, task, etc.) that supports them.

| Positional    | Description |
| ------------- | ----------- |
| `<entity-id>` | Entity id.  |

### set

| Positional    | Description             |
| ------------- | ----------------------- |
| `<entity-id>` | Entity.                 |
| `<json>`      | Properties JSON object. |

### rename

Renames a property key on one entity.

| Positional    | Description   |
| ------------- | ------------- |
| `<entity-id>` | Entity.       |
| `<old-key>`   | Existing key. |
| `<new-key>`   | New key.      |

### definitions

Lists workspace-wide property definitions. `select`, `multiselect`, `status`,
`date`, and `project` definitions are mirrored into `.memry/properties.md` so
the desktop app and other devices pick them up; `relation` definitions stay
DB-only by design.

### define

| Positional | Description                              |
| ---------- | ---------------------------------------- |
| `<name>`   | Definition name.                         |
| `<type>`   | e.g. `text`, `number`, `select`, `date`. |

| Flag               | Type   | Description                                  |
| ------------------ | ------ | -------------------------------------------- |
| `--options <json>` | any    | Type-specific options (e.g. select choices). |
| `--default <json>` | any    | Default value.                               |
| `--color <name>`   | string | UI color.                                    |

### update-definition

| Positional | Description |
| ---------- | ----------- |
| `<name>`   | Definition. |

| Flag               | Type   | Description  |
| ------------------ | ------ | ------------ |
| `--type <name>`    | string | New type.    |
| `--options <json>` | any    | New options. |
| `--default <json>` | any    | New default. |
| `--color <name>`   | string | New color.   |

### delete-definition (destructive)

Requires `--yes`.

### ensure

Makes sure a definition of the given type exists. An existing name of another
type takes the new type and keeps its colour.

| Positional | Description |
| ---------- | ----------- |
| `<name>`   | Property.   |
| `<type>`   | Type.       |

### option-add

Adds a choice to a `select`, `multiselect`, or `status` property. A missing
property becomes a `select`. A choice that exists is left alone.

| Positional | Description |
| ---------- | ----------- |
| `<name>`   | Property.   |
| `<value>`  | New choice. |

| Flag               | Type   | Description                                                      |
| ------------------ | ------ | ---------------------------------------------------------------- |
| `--color <name>`   | string | Choice colour (default `stone`).                                 |
| `--category <key>` | string | Status category: `todo`, `in_progress`, or `done` (status only). |

### option-remove (destructive)

Removes a choice from the definition. Notes that hold the value keep it.
Requires `--yes`.

| Positional | Description |
| ---------- | ----------- |
| `<name>`   | Property.   |
| `<value>`  | Choice.     |

### option-rename

Renames a choice in the definition only, like desktop; notes that already hold
the old value are not rewritten.

| Positional    | Description      |
| ------------- | ---------------- |
| `<name>`      | Property.        |
| `<old-value>` | Existing choice. |
| `<new-value>` | New name.        |

### option-color

| Positional | Description |
| ---------- | ----------- |
| `<name>`   | Property.   |
| `<value>`  | Choice.     |
| `<color>`  | New colour. |

### merge

Patches properties on a note or journal: only the given keys change, and a `null`
value removes its key. The output is `{ "properties", "removed" }`. `set` replaces
the whole set; `merge` does not.

| Positional    | Description          |
| ------------- | -------------------- |
| `<entity-id>` | Note or journal id.  |
| `<json>`      | JSON object of keys. |

### resolve-refs

Resolves relation URIs (`memry://note/<id>`, `task`, `event`, `external-event`,
`canvas`, `journal/<date>`) to title and existence, in input order. A malformed or
missing target comes back with `exists: false` instead of failing.

| Positional | Description                |
| ---------- | -------------------------- |
| `<uri>…`   | One or more relation URIs. |

### calendar-names

Lists the date properties set to show on the calendar.

### calendar-visibility

Shows or hides a date property on the calendar. Turning it off removes a
definition that exists only to carry the flag; one with a colour or default stays.

| Positional | Description        |
| ---------- | ------------------ |
| `<name>`   | Date property.     |
| `<show>`   | `true` or `false`. |

---

## folder-view

Per-folder view configuration (sort, filters, custom views).

### config

| Positional      | Description |
| --------------- | ----------- |
| `<folder-path>` | Folder.     |

### set-config

| Positional      | Description                |
| --------------- | -------------------------- |
| `<folder-path>` | Folder.                    |
| `<json>`        | Folder view config object. |

### views

Lists named views for a folder.

### set-view

| Positional      | Description      |
| --------------- | ---------------- |
| `<folder-path>` | Folder.          |
| `<view-json>`   | View definition. |

### delete-view

| Positional      | Description |
| --------------- | ----------- |
| `<folder-path>` | Folder.     |
| `<view-id>`     | View.       |

### list

Notes in the folder enriched with their visible properties.

| Positional      | Description |
| --------------- | ----------- |
| `<folder-path>` | Folder.     |

| Flag           | Type   | Description    |
| -------------- | ------ | -------------- |
| `--limit <n>`  | number | Default `100`. |
| `--offset <n>` | number | Default `0`.   |

### properties

Lists properties available in this folder.

### suggestions

Suggests folders for a note.

| Positional  | Description |
| ----------- | ----------- |
| `<note-id>` | Note.       |

### exists

Returns `{ exists: boolean }` for a folder path.

---

## tasks

### create

| Positional | Description |
| ---------- | ----------- |
| `<title>`  | Task title. |

| Flag                             | Type       | Description                                                                                                                                                |
| -------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--description <text>`           | string     | Body.                                                                                                                                                      |
| `--project <id>`                 | string     | Project id.                                                                                                                                                |
| `--status <id/null>`             | string     | Status id; `null` for inbox.                                                                                                                               |
| `--parent <id/null>`             | string     | Parent task id.                                                                                                                                            |
| `--due <YYYY-MM-DD>`             | string     | Due date.                                                                                                                                                  |
| `--due-time <HH:MM>`             | string     | Due time.                                                                                                                                                  |
| `--start <YYYY-MM-DD>`           | string     | Start date.                                                                                                                                                |
| `--repeat <json>`                | JSON       | Recurrence config.                                                                                                                                         |
| `--repeat-from <due/completion>` | string     | Recurrence anchor.                                                                                                                                         |
| `--source-note <id>`             | string     | Originating note.                                                                                                                                          |
| `--priority <n>`                 | number     | Default `0`.                                                                                                                                               |
| `--tag <name>`                   | repeatable | Tag.                                                                                                                                                       |
| `--link-note <id>`               | repeatable | Linked note.                                                                                                                                               |
| `--link-canvas <id>`             | repeatable | Linked canvas.                                                                                                                                             |
| `--duration <minutes>`           | number     | Duration in minutes. A positive whole number; `null` clears it on `update`.                                                                                |
| `--field <name=value>`           | repeatable | Custom field value. The value is read as JSON when it parses (`3`, `true`, `["a","b"]`) and as text otherwise. On `update`, `name=null` removes the field. |

Task records now include `fields`, an object of field values by name.

```bash
memrynote tasks create "Plan trip" --duration 45 --field effort=3 --field owner=Kaan
```

### list

| Flag                      | Type       | Description          |
| ------------------------- | ---------- | -------------------- |
| `--completed`             | boolean    | Include completed.   |
| `--archived`              | boolean    | Include archived.    |
| `--project <id>`          | string     | Filter by project.   |
| `--status <id/null>`      | string     | Filter by status.    |
| `--parent <id/null>`      | string     | Filter by parent.    |
| `--due-before <date>`     | string     | Due strictly before. |
| `--due-after <date>`      | string     | Due strictly after.  |
| `--tag <name>`            | repeatable | Tag filter.          |
| `--search <text>`         | string     | Text search.         |
| `--sort-by <field>`       | string     | Sort key.            |
| `--sort-order <asc/desc>` | string     | Sort direction.      |
| `--limit <n>`             | number     | Pagination.          |
| `--offset <n>`            | number     | Pagination.          |

```bash
memrynote tasks list --project proj_1 --due-before 2026-01-01 --sort-by due --sort-order asc
```

### get

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Task id.    |

### update

Positional `<id>`. Same flags as `create`; only specified flags are written.

### done / complete

Marks a task complete.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Task id.    |

### reopen

Reopens a completed task. Same effect as the desktop's uncomplete: it clears `completedAt` and leaves the task's status alone.

### archive / unarchive

Toggles the archive flag.

### move

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Task.       |

| Flag                 | Type   | Description                        |
| -------------------- | ------ | ---------------------------------- |
| `--project <id>`     | string | Destination project.               |
| `--status <id/null>` | string | Destination status.                |
| `--parent <id/null>` | string | New parent.                        |
| `--position <n>`     | number | Position within the status column. |

### get-subtasks

| Positional | Description  |
| ---------- | ------------ |
| `<id>`     | Parent task. |

### get-linked-tasks

| Positional  | Description                        |
| ----------- | ---------------------------------- |
| `<note-id>` | Note whose linked tasks to return. |

### today

| Flag                  | Type   | Description       |
| --------------------- | ------ | ----------------- |
| `--date <YYYY-MM-DD>` | string | Override "today". |

### upcoming

| Flag                  | Type   | Description          |
| --------------------- | ------ | -------------------- |
| `--days <n>`          | number | Window. Default `7`. |
| `--from <YYYY-MM-DD>` | string | Window start.        |

### overdue

| Flag                  | Type   | Description     |
| --------------------- | ------ | --------------- |
| `--date <YYYY-MM-DD>` | string | Reference date. |

### stats

| Flag                  | Type   | Description     |
| --------------------- | ------ | --------------- |
| `--date <YYYY-MM-DD>` | string | Reference date. |

### tags

Returns the set of tags used on tasks.

### convert-to-subtask

| Positional    | Description     |
| ------------- | --------------- |
| `<task-id>`   | Task to demote. |
| `<parent-id>` | New parent.     |

### convert-to-task

Promotes a subtask back to a top-level task.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Task.       |

### duplicate

| Positional | Description  |
| ---------- | ------------ |
| `<id>`     | Source task. |

### bulk-done / bulk-complete

| Positional | Description |
| ---------- | ----------- |
| `<id...>`  | Task ids.   |

### bulk-archive

| Positional | Description |
| ---------- | ----------- |
| `<id...>`  | Task ids.   |

### bulk-move

| Positional | Description |
| ---------- | ----------- |
| `<id...>`  | Task ids.   |

| Flag             | Type   | Required | Description          |
| ---------------- | ------ | -------- | -------------------- |
| `--project <id>` | string | yes      | Destination project. |

### bulk-delete (destructive)

Requires `--yes`. Deletes each task's subtasks with it, like desktop. Pass `--keep-subtasks` to keep them instead; see `delete`. Put the flags after the ids.

| Flag              | Type    | Description                                                                 |
| ----------------- | ------- | --------------------------------------------------------------------------- |
| `--keep-subtasks` | boolean | Move each task's direct subtasks up to its parent instead of deleting them. |

Output: `{ "count": <requested tasks that existed> }`.

### reorder

Reorders tasks within their list.

| Positional | Description                |
| ---------- | -------------------------- |
| `<id...>`  | Task ids in desired order. |

| Flag             | Type       | Description                               |
| ---------------- | ---------- | ----------------------------------------- |
| `--position <n>` | repeatable | One per id, parallel to positional order. |

### delete (destructive)

Requires `--yes`. Deletes the task and its whole subtask branch, deepest first, so no subtask keeps a parent that is gone. Each removed task queues its own sync delete, which the desktop app turns into a tombstone the next time sync starts.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Task id.    |

| Flag              | Type    | Description                                                                                                                                                |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--keep-subtasks` | boolean | Keep the subtasks: each direct subtask moves up to the deleted task's own parent (top level when it had none), as in the desktop's "keep subtasks" choice. |

Put the flags after the id (`tasks delete <id> --yes --keep-subtasks`).

### activity

Task audit log, newest first: what changed, when, and whether the change was made on this device. Shows the entries the desktop app and sync have written. The CLI does not write activity entries itself.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Task id.    |

| Flag              | Type       | Description                                                                                             |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `--limit <n>`     | number     | Page size, default `50`.                                                                                |
| `--offset <n>`    | number     | Skip entries.                                                                                           |
| `--action <name>` | repeatable | Only these actions: `created`, `updated`, `completed`, `uncompleted`, `moved`, `deleted`, `superseded`. |

Output: `{ "entries": [...], "total": n, "hasMore": bool }`. Status, project and parent changes show names instead of ids.

---

## projects

### list

```bash
memrynote projects list
```

### get

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Project id. |

### create

| Positional | Description   |
| ---------- | ------------- |
| `<name>`   | Project name. |

| Flag                   | Type   | Description |
| ---------------------- | ------ | ----------- |
| `--description <text>` | string |             |
| `--color <name>`       | string |             |
| `--icon <name>`        | string |             |

### update

Positional `<id>`. Flags `--name`, `--description`, `--color`, `--icon`.

### archive / unarchive

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Project.    |

### delete (destructive)

Requires `--yes`.

### reorder

| Positional | Description                   |
| ---------- | ----------------------------- |
| `<id...>`  | Project ids in desired order. |

| Flag             | Type       | Description |
| ---------------- | ---------- | ----------- |
| `--position <n>` | repeatable | One per id. |

### statuses

Lists statuses for a project.

| Positional     | Description |
| -------------- | ----------- |
| `<project-id>` | Project.    |

### status-create

| Positional     | Description  |
| -------------- | ------------ |
| `<project-id>` | Project.     |
| `<name>`       | Status name. |

| Flag                  | Type    | Description                               |
| --------------------- | ------- | ----------------------------------------- |
| `--color <name>`      | string  | UI color.                                 |
| `--done <true/false>` | boolean | Treats tasks in this status as completed. |

### status-update

| Positional    | Description |
| ------------- | ----------- |
| `<status-id>` | Status.     |

| Flag                     | Type    | Description                        |
| ------------------------ | ------- | ---------------------------------- |
| `--name <text>`          | string  |                                    |
| `--color <name>`         | string  |                                    |
| `--position <n>`         | number  | Column position.                   |
| `--default <true/false>` | boolean | Make default status for new tasks. |
| `--done <true/false>`    | boolean | "Done" semantics.                  |

### status-delete (destructive)

Requires `--yes`.

### status-reorder

| Positional | Description |
| ---------- | ----------- |
| `<id...>`  | Status ids. |

| Flag             | Type       | Description |
| ---------------- | ---------- | ----------- |
| `--position <n>` | repeatable | One per id. |

### link / unlink

Links a note, file or calendar event to a project, or removes the link. A markdown note's membership is stored in its `project` frontmatter property, so `link` and `unlink` rewrite that property (other properties stay as they are). Files and calendar events use the project's link table and queue a project sync update.

Give exactly one of `--note`, `--file` or `--event`. Linking twice is a no-op.

| Positional  | Description |
| ----------- | ----------- |
| `<project>` | Project id. |

| Flag           | Type    | Description                                        |
| -------------- | ------- | -------------------------------------------------- |
| `--note <id>`  | string  | Note id.                                           |
| `--file <id>`  | string  | Non-markdown file id.                              |
| `--event <id>` | string  | Calendar event id.                                 |
| `--pin`        | boolean | `link` only: pin the item to the project overview. |

```bash
memrynote projects link proj_1 --note note_9 --pin
```

### links

Lists a project's link rows (`id`, `itemType`, `itemId`, `position`, `pinned`, `createdAt`).

| Positional  | Description |
| ----------- | ----------- |
| `<project>` | Project id. |

### for-item

Lists the projects an item belongs to, oldest link first. Takes one of `--note`, `--file` or `--event`. Output: `[{ id, name, color, icon }]`.

### pin / unpin

Pins a linked item to the project overview, or unpins it. The link stays.

| Positional  | Description     |
| ----------- | --------------- |
| `<project>` | Project id.     |
| `<item>`    | Linked item id. |

### contents

What the project hub shows: linked notes, files and events, with links to missing items left out.

| Positional  | Description |
| ----------- | ----------- |
| `<project>` | Project id. |

| Flag            | Type       | Description                                            |
| --------------- | ---------- | ------------------------------------------------------ |
| `--type <list>` | repeatable | Only `note`, `file`, `event`; comma-separated allowed. |

Output: `{ "notes": [], "files": [], "events": [], "counts": { "notes": 0, "files": 0, "events": 0 } }`. Tasks are not part of it; use `tasks list --project <id>`. Unlike the desktop hub, items the desktop has not indexed yet still appear.

### set-home-note

| Positional  | Description                                |
| ----------- | ------------------------------------------ |
| `<project>` | Project id.                                |
| `<note>`    | Note id, or `null` to clear the home note. |

Output: the updated project.

### capture-url

Creates a note for a URL and links it to the project. The note title is the page's `<title>` when the page answers within 5 seconds, and the host plus path otherwise.

| Positional  | Description |
| ----------- | ----------- |
| `<project>` | Project id. |
| `<url>`     | Page URL.   |

Output: `{ "success": true, "noteId": "..." }`.

### import-files

Copies files into the vault and links them to the project. It needs the desktop app for any file that is not markdown: the CLI cannot give a new non-markdown file an id until the desktop app has indexed it. Those files are copied and reported under `failed` (exit code `1`); link them later with `projects link <project> --file <id>`.

| Positional  | Description      |
| ----------- | ---------------- |
| `<project>` | Project id.      |
| `<path...>` | Files to import. |

| Flag              | Type   | Description                  |
| ----------------- | ------ | ---------------------------- |
| `--folder <path>` | string | Vault folder to import into. |

Output: `{ "success": bool, "linked": ["<id>"], "failed": [{ "path": "", "error": "" }] }`.

---

## inbox

### capture

| Positional  | Description   |
| ----------- | ------------- |
| `<content>` | Text content. |

| Flag             | Type       | Description     |
| ---------------- | ---------- | --------------- |
| `--title <text>` | string     | Optional title. |
| `--tag <name>`   | repeatable | Tag.            |

### capture-link

| Positional | Description |
| ---------- | ----------- |
| `<url>`    | Link.       |

| Flag           | Type       | Description |
| -------------- | ---------- | ----------- |
| `--tag <name>` | repeatable | Tag.        |

### capture-file

| Positional    | Description     |
| ------------- | --------------- |
| `<file-path>` | File to import. |

| Flag             | Type       | Description             |
| ---------------- | ---------- | ----------------------- |
| `--mime <type>`  | string     | Override detected MIME. |
| `--title <text>` | string     |                         |
| `--tag <name>`   | repeatable |                         |

### get

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

### list

| Flag                | Type    | Description       |
| ------------------- | ------- | ----------------- |
| `--archived`        | boolean | Include archived. |
| `--include-snoozed` | boolean | Include snoozed.  |

### tags

Returns tags used on inbox items.

### stats

Returns counts (new, snoozed, archived, etc.).

### patterns

Returns detected filing patterns.

### archived

| Flag              | Type   | Description   |
| ----------------- | ------ | ------------- |
| `--search <text>` | string |               |
| `--limit <n>`     | number | Default `50`. |
| `--offset <n>`    | number | Default `0`.  |

### filing-history

| Flag          | Type   | Description   |
| ------------- | ------ | ------------- |
| `--limit <n>` | number | Default `20`. |

### stale-threshold

Returns the staleness cutoff in days.

### set-stale-threshold

| Positional | Description        |
| ---------- | ------------------ |
| `<days>`   | Threshold in days. |

### update

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

| Flag               | Type   | Description |
| ------------------ | ------ | ----------- |
| `--title <text>`   | string |             |
| `--content <text>` | string |             |

### add-tag / remove-tag

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |
| `<tag>`    | Tag name.   |

### mark-viewed

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

### convert-note / convert-task

Promotes an inbox item to a note or task.

### link-note

| Positional  | Description  |
| ----------- | ------------ |
| `<id>`      | Inbox item.  |
| `<note-id>` | Target note. |

| Flag           | Type       | Description |
| -------------- | ---------- | ----------- |
| `--tag <name>` | repeatable | Tag.        |

### snooze

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

| Flag              | Type   | Required | Description        |
| ----------------- | ------ | -------- | ------------------ |
| `--until <ISO>`   | string | yes      | Wake-up timestamp. |
| `--reason <text>` | string |          | Optional reason.   |

### unsnooze

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

### snoozed

Lists currently snoozed items.

### bulk-tag

| Positional | Description     |
| ---------- | --------------- |
| `<id...>`  | Inbox item ids. |

| Flag           | Type       | Description    |
| -------------- | ---------- | -------------- |
| `--tag <name>` | repeatable | Tags to apply. |

### bulk-snooze

| Positional | Description     |
| ---------- | --------------- |
| `<id...>`  | Inbox item ids. |

| Flag              | Type   | Required | Description |
| ----------------- | ------ | -------- | ----------- |
| `--until <ISO>`   | string | yes      |             |
| `--reason <text>` | string |          |             |

### bulk-archive

| Positional | Description     |
| ---------- | --------------- |
| `<id...>`  | Inbox item ids. |

### archive / unarchive

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

### delete (destructive)

Requires `--yes`. Removes the inbox item permanently.

### file

Files an item into a vault folder, as Filing does in the desktop Inbox. Text, link and clip items
become a note in the folder (tagged `inbox`); image, voice, PDF and video items are moved out of
the inbox into the folder under a name taken from the item's title. The item is marked filed and
recorded in `filing-history`. The folder is created if missing and must stay inside the vault.
Exits non-zero for an unknown item or one that is already filed.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

| Flag              | Type       | Required | Description            |
| ----------------- | ---------- | -------- | ---------------------- |
| `--folder <path>` | string     | yes      | Vault-relative folder. |
| `--tag <name>`    | repeatable |          | Extra tag on the note. |

Returns `{ success, filedTo, noteId? }`.

### bulk-file

Files several items into one folder. Prints `{ success, processedCount, errors }`; exits non-zero
when any item failed.

| Positional | Description     |
| ---------- | --------------- |
| `<id...>`  | Inbox item ids. |

Flags as in `file`.

### file-all-stale

Requires `--yes`. Files every active item older than the stale threshold (`stale-threshold`, default
7 days) into the `Unsorted` folder, as the desktop "file all stale" action does. Skips snoozed,
archived and filed items.

### convert-event

Turns a text or voice item into a calendar event and marks the item filed. Image, PDF, video and
clip items cannot become events.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

| Flag                     | Type    | Required | Description      |
| ------------------------ | ------- | -------- | ---------------- |
| `--start <ISO>`          | string  | yes      | Start time.      |
| `--end <ISO>`            | string  |          | End time.        |
| `--all-day <true/false>` | boolean |          | Default `false`. |
| `--location <text>`      | string  |          |                  |

Returns `{ success, eventId }`.

### convert-reminder

Creates a note from a text or voice item, schedules a reminder on it, and marks the item filed.
The time must be in the future.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

| Flag         | Type   | Required | Description    |
| ------------ | ------ | -------- | -------------- |
| `--at <ISO>` | string | yes      | Reminder time. |

Returns `{ success, noteId }`.

### suggestions

Suggests folders for an item from the filing history: where earlier items of the same type were
filed, with a confidence of `count / total`. Desktop also ranks with its local embedding model;
the CLI does not.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

Returns `{ suggestions: [{ destination: { type: "folder", path }, confidence, reason, suggestedTags }] }`.

### undo

`undo archive <id>` restores an archived item. `undo file <id>` reopens a filed item (it clears the
filed state; it does not delete the note or move a filed file back).

### capture-image / capture-pdf / capture-voice

Capture a file with the type checked: images (`.png .jpg .jpeg .gif .webp .svg`), PDFs (`.pdf`) or
audio (`.mp3 .wav .webm .m4a .ogg .flac .aac`). Other extensions fail. Same flags as `capture-file`
without `--mime`. `capture-voice` also queues a transcription job; the desktop app runs it the
next time it opens the vault. Pass `--transcribe false` to skip it.

| Positional    | Description |
| ------------- | ----------- |
| `<file-path>` | File.       |

| Flag                  | Type       | Description                           |
| --------------------- | ---------- | ------------------------------------- |
| `--title <text>`      | string     |                                       |
| `--tag <name>`        | repeatable |                                       |
| `--transcribe <bool>` | boolean    | `capture-voice` only. Default `true`. |

### jobs

Lists the durable background jobs (link metadata, transcription, article extraction).

| Flag              | Type       | Description                                   |
| ----------------- | ---------- | --------------------------------------------- |
| `--item <id>`     | repeatable | Only jobs for these items.                    |
| `--status <name>` | repeatable | `pending`, `running`, `failed` or `complete`. |

Returns `{ jobs: [...] }`.

### retry

Re-queues the failed metadata scrape of a link item or the transcription of a voice item and sets it
back to `pending`. The desktop app runs the job when it opens the vault. Other item types fail.

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Inbox item. |

---

## journal

### get

| Positional | Description   |
| ---------- | ------------- |
| `<date>`   | `YYYY-MM-DD`. |

### write

| Positional  | Description              |
| ----------- | ------------------------ |
| `<date>`    | `YYYY-MM-DD`.            |
| `<content>` | Replaces the entry body. |

### append

| Positional  | Description                |
| ----------- | -------------------------- |
| `<date>`    | `YYYY-MM-DD`.              |
| `<content>` | Appended to existing body. |

### delete (destructive)

Requires `--yes`.

| Positional | Description   |
| ---------- | ------------- |
| `<date>`   | `YYYY-MM-DD`. |

### month

| Positional | Description      |
| ---------- | ---------------- |
| `<year>`   | Four-digit year. |
| `<month>`  | 1–12.            |

### heatmap

| Positional | Description      |
| ---------- | ---------------- |
| `<year>`   | Four-digit year. |

### stats

| Positional | Description      |
| ---------- | ---------------- |
| `<year>`   | Four-digit year. |

### context

Returns same-day notes, tasks, and reminders.

| Positional | Description   |
| ---------- | ------------- |
| `<date>`   | `YYYY-MM-DD`. |

### tags

Returns tags used in journal entries.

### streak

Returns the current writing streak.

### properties

Returns the journal entries in a date range with their property values, as the desktop's
journal property charts read them. `rows` holds `{ id, date, path, title, properties }`,
oldest first. `properties` lists every property any journal entry uses, with its type (the
vault definition's, else the most common inferred type) and how many entries use it.

| Positional | Description                                   |
| ---------- | --------------------------------------------- |
| `<from>`   | First day, `YYYY-MM-DD`.                      |
| `[<to>]`   | Last day, `YYYY-MM-DD`. Defaults to `<from>`. |

```bash
memrynote --json journal properties 2026-03-01 2026-03-31
```

---

## tags

### list

```bash
memrynote tags list
```

### notes

| Positional | Description |
| ---------- | ----------- |
| `<tag>`    | Tag name.   |

### color / set-color

| Positional | Description                   |
| ---------- | ----------------------------- |
| `<tag>`    | Tag name.                     |
| `[color]`  | New color (or use `--color`). |

| Flag             | Type   | Description |
| ---------------- | ------ | ----------- |
| `--color <name>` | string | New color.  |

### rename

| Positional | Description   |
| ---------- | ------------- |
| `<old>`    | Existing tag. |
| `<new>`    | New name.     |

### remove-from-note

| Positional  | Description                        |
| ----------- | ---------------------------------- |
| `<note-id>` | Note.                              |
| `<tag>`     | Tag to remove from this note only. |

### merge

| Positional | Description               |
| ---------- | ------------------------- |
| `<source>` | Tag to merge from.        |
| `<target>` | Tag to merge into (kept). |

### delete (destructive)

Requires `--yes`. Removes the tag from every entity.

### Tags with fields

A tag can carry a schema of fields (see **Tags with fields** in the app). A note whose
header (frontmatter) tags include the tag is an _object_ of it. Put flags after the
positionals: a flag followed by a bare word takes the word as its value.

Every write here also queues a sync intent, so a running or later-started desktop app
sends the change to your other devices. Pinning is the exception (see `pin`).

### schema

```bash
memrynote tags schema                       # every tag with fields, plus note id -> primary object tag
memrynote tags schema <tag>                 # one tag's resolved schema (also: schema show <tag>)
```

Returns resolved tags: own, inherited and effective fields, `extends`, ancestors, template and
preset. Exits non-zero for a tag with no fields. A tag named like one of the verbs below is read with
`schema show <tag>`.

| Verb                                              | Description                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `schema add-field <tag> <field> --type <t>`       | Add a field. Types: `text`, `number`, `checkbox`, `date`, `url`, `status`, `select`, `multiselect`, `relation`.  |
| `schema remove-field <tag> <field>` (destructive) | Remove a field from the schema. Values stay in notes and tasks. Without `--yes`, it reports how many are filled. |
| `schema move-field <tag> <field> <index>`         | Move a field to a zero-based position.                                                                           |
| `schema set-relation <tag> <field> --target <t>`  | Point a field at a tag (makes it a relation).                                                                    |
| `schema set-template <tag> <template-id\|none>`   | Set or clear the template for new objects.                                                                       |
| `schema set-extends <tag> <parent\|none>`         | Inherit fields from a parent tag. Needs `--yes` when the tag would lose inherited fields.                        |

| Flag                | Used by                       | Description                                                                  |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `--type <t>`        | `add-field`                   | Field type. The vault-wide property definition wins when one already exists. |
| `--options a,b,c`   | `add-field`                   | Options for `select` and `multiselect` when the property is new.             |
| `--index <n>`       | `add-field`                   | Insert at this position instead of the end.                                  |
| `--target <tag>`    | relation fields               | Required for a relation.                                                     |
| `--many`            | relation fields               | The relation holds several notes.                                            |
| `--inverse <label>` | relation fields               | Label of the inverse list on the target.                                     |
| `--autofill`        | `set-template`                | Fill the template into new objects automatically.                            |
| `--yes`             | `remove-field`, `set-extends` | Confirm.                                                                     |

`add-field` creates the property definition (and `.memry/properties.md` entry) when none of that
name exists. These need the desktop app and fail with a clear error here: `schema rename-field`
(rewrites the property in every note and task, with progress and resume) and `schema add-preset`
(localized preset catalog).

### impact

Counts what a change would affect, before you run it.

```bash
memrynote tags impact remove-field <tag> <field>      # { filled, empty }
memrynote tags impact rename-field <field>            # { notes, tasks, tags }
memrynote tags impact delete-tag <tag>                # { notes, tasks, values, fields, templateName }
memrynote tags impact set-extends <tag> <parent|none> # { notes, gained, lost }
memrynote tags impact become-objects <tag>            # { notes }
```

### objects

```bash
memrynote tags objects [<tag>] [--query <text>] [--limit <n>]
```

Searches objects (notes with the tag in their header). `<tag>` limits it to that tag and the tags
that extend it. `--query` matches titles, ignoring case and diacritics. `--limit` is 1 to 50 (default 12).
Returns `{ matches: [{ noteId, title, tag, groupTag, viaTag, subtitle, modified }], complete }`.

### linked-here

```bash
memrynote tags linked-here <note-id> [--limit <n>]
```

Groups what points at the note: notes through a relation field, tasks through a task field, and
notes that link it in their body. `--limit` is items per group, 1 to 500 (default 2).

### categories

| Command                                     | Description                                      |
| ------------------------------------------- | ------------------------------------------------ |
| `tags categories` or `tags categories list` | Categories with their tag counts.                |
| `tags categories create <name>`             | Create a category.                               |
| `tags categories rename <id> <name>`        | Rename.                                          |
| `tags categories reorder <id>...`           | Set the category order to the order given.       |
| `tags categories delete <id>` (destructive) | Requires `--yes`. Its tags become uncategorized. |

### set-icon

```bash
memrynote tags set-icon <tag> <icon>    # an emoji or "icon:Name"
memrynote tags set-icon <tag> --clear
```

### pin / unpin

```bash
memrynote tags pin <tag> <note-id>
memrynote tags unpin <tag> <note-id>
```

Pins a note at the top of the tag page. Pins live in the search index that the desktop app
maintains, so a note the desktop app has not indexed yet fails with a message to open it there first.
Pins are local to this device.

### reorder

```bash
memrynote tags reorder <tag>... [--category <id|none>]
```

Sets the sort order of the listed tags to the order given. `--category` moves them all into a
category (or `none`); without it each tag keeps its category.

### fill-status / fill-fields

Filling a tag's fields asks an AI model and uses the desktop app's AI settings and disclosure, so
both commands exit non-zero and name the desktop app.

---

## settings

### list

Returns all key/value settings.

### groups

Lists logical groups (UI sections): `general`, `editor`, `tasks`, `keyboard`, `sync`,
`backup`, `graph`, `calendar` (and `calendar.google`, `calendar.ics`, `calendar.caldav`),
`voiceTranscription`, `journal`, `tabs`, `noteEditor`, `features`, `inbox`, `sticky`,
`graphViews`, `tagSearches` and `sidebar`.

`sidebar` is a view over the desktop's `sidebar.*` settings with the fields `navCollapsed`,
`notesFirst` and `showFiles` (booleans), `sectionOrder` and `railOrder` (arrays of ids) and
`sortModes` (an object). `set-group sidebar` rejects unknown fields and values of the wrong type.
The CLI does not queue these changes for sync, like the other groups.

### group

| Positional | Description |
| ---------- | ----------- |
| `<name>`   | Group name. |

### set-group

| Positional | Description                            |
| ---------- | -------------------------------------- |
| `<name>`   | Group name.                            |
| `<json>`   | Partial settings object for the group. |

### ai

Returns AI settings.

### set-ai

| Positional     | Description                    |
| -------------- | ------------------------------ |
| `<true/false>` | Enable or disable AI features. |

### get

| Positional | Description  |
| ---------- | ------------ |
| `<key>`    | Setting key. |

### set

| Positional | Description                         |
| ---------- | ----------------------------------- |
| `<key>`    | Setting key.                        |
| `<value>`  | Value (parsed as JSON if possible). |

### delete (destructive)

Requires `--yes`.

---

## locale

### get

Returns the active locale code.

### set

| Positional | Description                          |
| ---------- | ------------------------------------ |
| `<code>`   | Locale code (e.g. `en-US`, `tr-TR`). |

### list

Lists supported locales.

---

## reminders

### create

| Positional      | Description                        |
| --------------- | ---------------------------------- |
| `<target-type>` | `note`, `journal`, or `highlight`. |
| `<target-id>`   | Id of the targeted entity.         |

| Flag                      | Type   | Required | Description             |
| ------------------------- | ------ | -------- | ----------------------- |
| `--at <ISO>`              | string | yes      | Fire time.              |
| `--title <text>`          | string |          |                         |
| `--note <text>`           | string |          |                         |
| `--highlight-text <text>` | string |          | For `highlight` target. |
| `--highlight-start <n>`   | number |          | Character offset.       |
| `--highlight-end <n>`     | number |          | Character offset.       |

### get

| Positional | Description  |
| ---------- | ------------ |
| `<id>`     | Reminder id. |

### update

| Positional | Description  |
| ---------- | ------------ |
| `<id>`     | Reminder id. |

| Flag                  | Type   | Description    |
| --------------------- | ------ | -------------- |
| `--at <ISO>`          | string | New fire time. |
| `--title <text/null>` | string |                |
| `--note <text/null>`  | string |                |

### list

| Flag                   | Type   | Description                                        |
| ---------------------- | ------ | -------------------------------------------------- |
| `--target-type <name>` | string | `note`, `journal`, or `highlight`.                 |
| `--target-id <id>`     | string |                                                    |
| `--status <name>`      | string | `pending`, `triggered`, `dismissed`, or `snoozed`. |
| `--from <ISO>`         | string | Window start.                                      |
| `--to <ISO>`           | string | Window end.                                        |
| `--limit <n>`          | number | Default `50`.                                      |
| `--offset <n>`         | number | Default `0`.                                       |

### for-target

| Positional      | Description                        |
| --------------- | ---------------------------------- |
| `<target-type>` | `note`, `journal`, or `highlight`. |
| `<target-id>`   | Entity id.                         |

### due

Returns reminders past their fire time.

### upcoming

| Flag         | Type   | Description          |
| ------------ | ------ | -------------------- |
| `--days <n>` | number | Window. Default `7`. |

### dismiss

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Reminder.   |

### snooze

| Positional | Description                     |
| ---------- | ------------------------------- |
| `<id>`     | Reminder.                       |
| `[until]`  | New ISO time, or use `--until`. |

| Flag            | Type   | Description    |
| --------------- | ------ | -------------- |
| `--until <ISO>` | string | New fire time. |

### count-pending

Returns the count of pending reminders.

### bulk-dismiss

| Positional | Description   |
| ---------- | ------------- |
| `<id...>`  | Reminder ids. |

### delete (destructive)

Requires `--yes`.

---

## templates

Custom templates live in the vault database (`data.db`) and sync across
devices, the same store the desktop app uses. Legacy `.memry/templates/*.md`
files are imported once on first run and then left on disk as a downgrade
path. Desktop's built-in templates are not listed here.

### list

```bash
memrynote templates list
```

### get

| Positional | Description  |
| ---------- | ------------ |
| `<id>`     | Template id. |

### create

| Positional | Description    |
| ---------- | -------------- |
| `<name>`   | Template name. |

| Flag                   | Type       | Description    |
| ---------------------- | ---------- | -------------- |
| `--description <text>` | string     |                |
| `--icon <name>`        | string     |                |
| `--content <text>`     | string     | Template body. |
| `--tag <name>`         | repeatable | Tag.           |

### update

Positional `<id>`. Flags `--name`, `--description`, `--icon`, `--content`, `--tag`.

### duplicate

| Positional   | Description             |
| ------------ | ----------------------- |
| `<id>`       | Source template.        |
| `<new-name>` | Name for the duplicate. |

### delete (destructive)

Requires `--yes`.

---

## bookmarks

### list

| Flag            | Type   | Description          |
| --------------- | ------ | -------------------- |
| `--type <name>` | string | Filter by item type. |

### get

| Positional | Description  |
| ---------- | ------------ |
| `<id>`     | Bookmark id. |

### get-by-item

| Positional    | Description          |
| ------------- | -------------------- |
| `<item-type>` | e.g. `note`, `task`. |
| `<item-id>`   | Item id.             |

### list-by-type

| Positional    | Description       |
| ------------- | ----------------- |
| `<item-type>` | Item type filter. |

### add

| Positional    | Description |
| ------------- | ----------- |
| `<item-type>` | Item type.  |
| `<item-id>`   | Item id.    |

### toggle

Same positionals as `add`. Adds if missing, removes if present.

### remove

| Positional    | Description |
| ------------- | ----------- |
| `<item-type>` | Item type.  |
| `<item-id>`   | Item id.    |

### delete (destructive)

Requires `--yes`. Removes by bookmark id.

| Positional | Description  |
| ---------- | ------------ |
| `<id>`     | Bookmark id. |

### has

| Positional    | Description |
| ------------- | ----------- |
| `<item-type>` | Item type.  |
| `<item-id>`   | Item id.    |

Returns `{ bookmarked: boolean }`.

### reorder

| Positional | Description                    |
| ---------- | ------------------------------ |
| `<id...>`  | Bookmark ids in desired order. |

### bulk-create

| Positional     | Description                               |
| -------------- | ----------------------------------------- |
| `<json-array>` | JSON array of `{ "itemType", "itemId" }`. |

```bash
memrynote bookmarks bulk-create '[{"itemType":"note","itemId":"note_1"}]'
```

### bulk-delete

| Positional | Description   |
| ---------- | ------------- |
| `<id...>`  | Bookmark ids. |

---

## saved-filters

### list

```bash
memrynote saved-filters list
```

### get

| Positional | Description      |
| ---------- | ---------------- |
| `<id>`     | Saved filter id. |

### create

| Positional | Description  |
| ---------- | ------------ |
| `<name>`   | Filter name. |

| Flag              | Type | Description                      |
| ----------------- | ---- | -------------------------------- |
| `--config <json>` | JSON | Filter config. Defaults to `{}`. |

### update

| Positional | Description      |
| ---------- | ---------------- |
| `<id>`     | Saved filter id. |

| Flag              | Type   | Description |
| ----------------- | ------ | ----------- |
| `--name <text>`   | string | New name.   |
| `--config <json>` | JSON   | New config. |

### reorder

| Positional | Description                  |
| ---------- | ---------------------------- |
| `<id...>`  | Filter ids in desired order. |

| Flag             | Type       | Description |
| ---------------- | ---------- | ----------- |
| `--position <n>` | repeatable | One per id. |

### delete (destructive)

Requires `--yes`.

---

## calendar

Calendar groups several sub-namespaces. The top-level subcommands are:

```
sources | select-source | provider-status | google-settings |
set-default-google-calendar | range | external <action> |
bindings <action> | events <action>
```

### sources

| Flag                | Type    | Description                   |
| ------------------- | ------- | ----------------------------- |
| `--provider <name>` | string  | Filter by provider.           |
| `--kind <name>`     | string  | Filter by kind.               |
| `--selected`        | boolean | Only return selected sources. |

### select-source

| Positional    | Description |
| ------------- | ----------- |
| `<source-id>` | Source id.  |

| Flag                      | Type    | Description                      |
| ------------------------- | ------- | -------------------------------- |
| `--selected <true/false>` | boolean | Selection state. Default `true`. |

### provider-status

| Positional   | Description                          |
| ------------ | ------------------------------------ |
| `[provider]` | Provider name (or use `--provider`). |

| Flag                | Type   | Required            | Description    |
| ------------------- | ------ | ------------------- | -------------- |
| `--provider <name>` | string | yes (or positional) | Provider name. |
| `--account <id>`    | string |                     | Account scope. |

### google-settings

Returns the active Google calendar configuration.

### set-default-google-calendar

| Positional           | Description                             |
| -------------------- | --------------------------------------- |
| `<calendar-id/null>` | Google calendar id, or `null` to clear. |

| Flag                             | Type    | Description                |
| -------------------------------- | ------- | -------------------------- |
| `--calendar <id/null>`           | string  | Alternative to positional. |
| `--mark-onboarding <true/false>` | boolean | Default `true`.            |

### range

Returns events from all selected sources in a window.

| Flag                   | Type    | Required | Description                 |
| ---------------------- | ------- | -------- | --------------------------- |
| `--start <ISO>`        | string  | yes      | Window start.               |
| `--end <ISO>`          | string  | yes      | Window end.                 |
| `--include-unselected` | boolean |          | Include unselected sources. |

### external list

| Flag            | Type    | Description       |
| --------------- | ------- | ----------------- |
| `--source <id>` | string  | Source filter.    |
| `--archived`    | boolean | Include archived. |
| `--start <ISO>` | string  | Window start.     |
| `--end <ISO>`   | string  | Window end.       |

### external get

| Positional   | Description        |
| ------------ | ------------------ |
| `<event-id>` | External event id. |

### external promote

Promotes an external event to a managed memrynote event.

| Positional   | Description        |
| ------------ | ------------------ |
| `<event-id>` | External event id. |

### bindings list

| Flag                   | Type    | Description |
| ---------------------- | ------- | ----------- |
| `--source-type <name>` | string  |             |
| `--source <id>`        | string  |             |
| `--provider <name>`    | string  |             |
| `--archived`           | boolean |             |

### bindings get

| Positional     | Description |
| -------------- | ----------- |
| `<binding-id>` | Binding id. |

### events create

| Positional | Description  |
| ---------- | ------------ |
| `<title>`  | Event title. |

| Flag                     | Type    | Required | Description      |
| ------------------------ | ------- | -------- | ---------------- |
| `--start <ISO>`          | string  | yes      | Start time.      |
| `--end <ISO>`            | string  |          | End time.        |
| `--timezone <tz>`        | string  |          | Default `UTC`.   |
| `--description <text>`   | string  |          |                  |
| `--location <text>`      | string  |          |                  |
| `--all-day <true/false>` | boolean |          | Default `false`. |

### events get

| Positional   | Description |
| ------------ | ----------- |
| `<event-id>` | Event id.   |

### events list

| Flag            | Type    | Description       |
| --------------- | ------- | ----------------- |
| `--start <ISO>` | string  | Window start.     |
| `--end <ISO>`   | string  | Window end.       |
| `--archived`    | boolean | Include archived. |

### events update

| Positional   | Description |
| ------------ | ----------- |
| `<event-id>` | Event id.   |

| Flag                        | Type    | Description |
| --------------------------- | ------- | ----------- |
| `--title <text>`            | string  |             |
| `--start <ISO>`             | string  |             |
| `--end <ISO/null>`          | string  |             |
| `--timezone <tz>`           | string  |             |
| `--description <text/null>` | string  |             |
| `--location <text/null>`    | string  |             |
| `--all-day <true/false>`    | boolean |             |

### events delete (destructive)

Requires `--yes`.

### events search

Title search over events, upcoming and past, nearest to now first (the desktop picker's ranking).

| Positional | Description                  |
| ---------- | ---------------------------- |
| `<text>`   | Case-insensitive title text. |

| Flag                 | Type    | Description                                                      |
| -------------------- | ------- | ---------------------------------------------------------------- |
| `--limit <n>`        | number  | Default `20`, at most `100`.                                     |
| `--include-external` | boolean | Also search mirrored provider events (`kind: "external_event"`). |

Returns `{ events: [{ id, title, startAt, endAt, isAllDay, kind? }] }`.

### linked-notes

Notes whose relation properties link to an event.

| Positional   | Description |
| ------------ | ----------- |
| `<event-id>` | Event id.   |

| Flag         | Type    | Description                             |
| ------------ | ------- | --------------------------------------- |
| `--external` | boolean | The id is a mirrored provider event id. |

Returns `{ notes: [{ id, title, emoji }] }`.

### providers

Lists the providers the desktop app knows (`google`, `caldav`, `apple-eventkit`, `ics`) with whether
an account is connected and how many calendars this vault mirrored. Connecting or disconnecting a
provider needs the desktop app's sign-in and is not available here.

### provider-calendars

The calendars this vault mirrored for a provider, plus the current default (Google only). Desktop
asks the provider live; the CLI reads what was last synced.

| Flag                | Type   | Required | Description  |
| ------------------- | ------ | -------- | ------------ |
| `--provider <name>` | string | yes      | Provider id. |

### set-default-calendar

Sets the calendar new events are written to. Only `--provider google` (the default) works from the
CLI; other providers exit non-zero and point at the desktop app.

| Flag                             | Type    | Description                                                     |
| -------------------------------- | ------- | --------------------------------------------------------------- |
| `--provider <name>`              | string  | Default `google`.                                               |
| `--calendar <id/null>`           | string  | Calendar id, or `null` to clear (or pass it as the positional). |
| `--mark-onboarding <true/false>` | boolean | Default `true`.                                                 |

### refresh / retry-sync / writer-compat

`refresh --provider <name>`, `retry-sync <source-id>` and `writer-compat --provider <name>` need
the desktop app's provider sign-in and network sync. They check their arguments, then exit non-zero
with a message that says so.

### ics subscribe

Subscribes to a calendar feed by URL (`http`, `https`, `webcal`). The feed is fetched first, so a
wrong link fails with a reason (`invalid_url`, `unreachable`, `timeout`, `not_found`,
`unauthorized`, `http_error`, `too_large`, `not_a_calendar`) instead of leaving an empty calendar.
Subscribing to an already-subscribed URL returns that source; a removed one is restored. The CLI
writes the source row; the desktop app's feed runner reads the events on its next pass.

| Positional | Description |
| ---------- | ----------- |
| `<url>`    | Feed URL.   |

| Flag            | Type   | Description                                         |
| --------------- | ------ | --------------------------------------------------- |
| `--name <text>` | string | Title. Default: the feed's own name, then its host. |

### ics unsubscribe (destructive)

Requires `--yes`. Archives the subscription and drops this vault's mirrored events for it.

| Positional    | Description |
| ------------- | ----------- |
| `<source-id>` | ICS source. |

### ics update

| Positional    | Description |
| ------------- | ----------- |
| `<source-id>` | ICS source. |

| Flag             | Type   | Description                                                                                                                                      |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--name <text>`  | string | New title.                                                                                                                                       |
| `--color <name>` | string | One of the event colours: `tomato`, `flamingo`, `tangerine`, `banana`, `sage`, `basil`, `peacock`, `blueberry`, `lavender`, `grape`, `graphite`. |

### ics refresh

Needs the desktop app (it parses the feed); exits non-zero with a message that says so.

---

## sync

### status

Returns the live sync state (linked? paused? last cursor? errors?).

### queue-size

Returns the pending outbound queue size.

### history

| Flag           | Type   | Description   |
| -------------- | ------ | ------------- |
| `--limit <n>`  | number | Default `50`. |
| `--offset <n>` | number | Default `0`.  |

### devices

Lists known devices for this account.

### storage

Returns the encrypted-blob storage breakdown by type.

### quarantine

Lists items the engine quarantined (typically schema mismatches).

### check-device

Verifies this device is still authorized.

### pause / resume

Toggles the sync engine.

### settings

Returns the synced-settings snapshot.

### update-setting

| Positional | Description                                |
| ---------- | ------------------------------------------ |
| `<path>`   | Dot-separated path within synced settings. |
| `<value>`  | New value (parsed as JSON if possible).    |

### trigger / progress / rename-device / remove-device

`trigger` (Sync now), `progress` (live attachment transfer progress), `rename-device <id> <name>` and
`remove-device <id> --yes` need the desktop app's signed-in session or its in-memory state. They
exit non-zero with a message that says so. Use `status`, `queue-size` and `devices` to read state.

### note-state

How far a note's body got toward the server, from local facts: `not_syncing`, `local_only`,
`pending`, `sent`, `rejected`, `confirmed` or `not_recorded`. The CLI treats the vault as syncing
when it has a linked current device.

| Positional | Description      |
| ---------- | ---------------- |
| `<note>`   | Note id or path. |

Returns `{ state, waitingSince, lastSentAt, bodyConfirmedAt, lastFailedAt, lastRejectedAt }`.

### unsent-notes

Notes with changes the server has not stored (queued body or record changes, a file the note's
document has not taken, or a refused push). Rejected notes first, then oldest. Returns
`{ total, notes: [{ id, title, path, state, waitingSince, reasons }] }`, at most 200 notes.

### large-notes

Notes at or over the per-note sync size ceiling. Returns `{ maxBytes, notes: [{ id, title, path,
sizeBytes, status }] }` with `status` `approaching` or `over`, largest first, at most 50.

### binding

The account choice stored in this vault: `{ status: "unbound" | "sync" | "local-only", mode }`.
Desktop's `needs-decision` and `foreign` states depend on a server check and are not computed here.

---

## agent

### backends

Returns availability + version info for each agent backend.

### models

| Positional  | Description                                                          |
| ----------- | -------------------------------------------------------------------- |
| `[backend]` | `claude_cli`, `codex_cli` or `antigravity_cli` (or use `--backend`). |

| Flag               | Type   | Description                                     |
| ------------------ | ------ | ----------------------------------------------- |
| `--backend <name>` | string | `claude_cli`, `codex_cli` or `antigravity_cli`. |

### local-settings

Returns the local-provider settings used by Agent Chat.

### set-local-settings

| Flag                                | Type    | Description                                      |
| ----------------------------------- | ------- | ------------------------------------------------ |
| `--preset <name>`                   | string  | `ollama`, `lm_studio`, `llama_cpp`, or `custom`. |
| `--base-url <url>`                  | string  | Base URL.                                        |
| `--model <name>`                    | string  | Default model.                                   |
| `--allow-non-loopback <true/false>` | boolean | Allow non-localhost URLs.                        |

### conversations / conversation

`conversations` lists Agent Chat conversations, newest first. `conversation <id>` shows one.
Each record is `{ id, backend, backendModel, pinned, messageCount, createdAt, updatedAt }`. Titles
and messages are encrypted with the vault key held in the OS keychain, so the CLI cannot read
them and never prints them.

### local-models

Lists the models the configured local provider serves (`GET <base-url>/models`). An unreachable
provider returns `{ "models": [] }`. A non-loopback URL needs `--allow-non-loopback true` in
`set-local-settings`. The provider's API key lives in the keychain and is not sent.

### test-local

Checks the local provider is reachable and serves the chosen model. Returns `{ connected,
modelAvailable, streamingSupported, toolCallingSupported, toolContinuationSupported, toolsEnabled,
detail }` (the CLI does not probe tool calling).

### preferences / set-preferences / mcp-status / mcp

`preferences`, `set-preferences`, `mcp-status`, `mcp status` and `mcp rotate-token --yes` read state
the desktop app keeps in its own config or in memory (chat access and approval mode, the MCP server
URL and token). They exit non-zero with a message that says so; the token is never printed here.

---

## graph

### data

Returns the full link graph for visualization.

### local

| Positional  | Description  |
| ----------- | ------------ |
| `<note-id>` | Center note. |

| Flag          | Type   | Description            |
| ------------- | ------ | ---------------------- |
| `--depth <n>` | number | Hops out. Default `2`. |

---

## search

### stats

Returns index size and last-build info.

### reasons

Lists recent items the search engine highlighted.

### add-reason

| Positional       | Description                            |
| ---------------- | -------------------------------------- |
| `<item-id>`      | Item id.                               |
| `<item-type>`    | `note`, `journal`, `task`, or `inbox`. |
| `<item-title>`   | Display title.                         |
| `<search-query>` | Query that surfaced the item.          |

### clear-reasons

Removes all stored search reasons.

### tags

Returns tags discovered while indexing.

### rebuild-index

Reports the index size. Returns `{ started: true, indexed: <n> }` and does not rebuild
anything. To rebuild the search index, run [`vault reindex`](#reindex).

### (free text)

Any other subcommand or arguments are joined with spaces and treated as a search
query. Results are an array of `{ kind, id, title, path?, snippet? }`. Notes, journal
entries, tasks and inbox items that the full-text index knows come first, ranked like
the desktop search (matching alias, then words next to each other, then relevance), and
a substring scan adds what the index has not caught up with. Text, quoted phrases and
`AND`/`OR`/`NOT` work as in the desktop search.

| Flag                | Description                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--type <kind>`     | Only these kinds: `note`, `journal`, `task`, `inbox`, `reminder`, `template`, `calendar`. Repeat or comma-separate. |
| `--tag <tag>`       | Only items with any of these tags. Repeat or comma-separate. Leading `#` is ignored.                                |
| `--from <date>`     | Only items modified at or after this ISO date or time.                                                              |
| `--to <date>`       | Only items modified at or before this ISO time. A bare `YYYY-MM-DD` covers that whole day.                          |
| `--project <id>`    | Only tasks in this project.                                                                                         |
| `--folder <prefix>` | Only notes and journal entries whose path starts with this prefix (for example `Projects/`).                        |
| `--limit <n>`       | Return at most `n` results (at least 1).                                                                            |
| `--offset <n>`      | Skip the first `n` results.                                                                                         |

`--tag`, `--from`, `--to`, `--project` and `--folder` apply to notes, journal entries,
tasks and inbox items only. Setting any of them leaves out reminders, templates and
calendar events. Semantic (embedding) search and the fuzzy title fallback need the desktop app
and are not part of the CLI search.

```bash
memrynote search project plan
memrynote --json search "encryption nonce"
memrynote search zebra --type note --tag animals --folder Zoo/ --limit 10
memrynote search "weekly review" --from 2026-01-01 --to 2026-01-31
```

---

## canvas

Canvases are `.excalidraw` documents under `<vault>/canvases/`, indexed in the data
database. The CLI lists, reads, creates, copies, deletes and exports them. Drawing is done
in the desktop app.

### list

| Flag              | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `--folder <path>` | Only canvases in this folder (relative to `canvases/`). |

Returns `[{ id, title, folder, icon, ownerNoteId, createdAt, updatedAt, itemCount, unreadable }]`,
newest first. `itemCount` is the number of note, task, event, project and file cards.
`unreadable` is `true` when the document is missing from disk.

### get

| Positional | Description |
| ---------- | ----------- |
| `<id>`     | Canvas id.  |

| Flag         | Description               |
| ------------ | ------------------------- |
| `--no-scene` | Leave out the scene JSON. |

Returns the summary plus `scene`, the Excalidraw scene as a JSON string. `unreadable: true` and an
empty scene mean the document is missing.

### create

| Flag                  | Description                                                                      |
| --------------------- | -------------------------------------------------------------------------------- |
| `--title <text>`      | Title. The file is named after it (`Plan.excalidraw`, `Plan 2.excalidraw`, ...). |
| `--folder <path>`     | Folder under `canvases/`, up to 8 levels deep.                                   |
| `--icon <icon>`       | Icon name or emoji.                                                              |
| `--scene-file <path>` | Start from this Excalidraw JSON file. It must parse as JSON.                     |

Writes the document, indexes its entity cards and arrows, and returns the canvas. The row
has no sync clock; the desktop app seeds it on its next start.

### duplicate

`memrynote canvas duplicate <id>` copies the scene and its image asset rows next to the
original (same folder and icon, title numbered). Fails when the original is missing or unreadable.

### delete (destructive)

`memrynote canvas delete <id> --yes` removes the document file and returns
`{ deleted, syncPending }`. A canvas that never synced is also tombstoned in the database. One that
has synced keeps its row (listed as `unreadable`) and `syncPending` is `true`: the desktop
app turns the missing document into a synced delete the next time it runs.

### export

`memrynote canvas export <id> [--out <path>]` writes the scene as a plain Excalidraw file
(without Memry's sidecar) to `--out`, or prints it to stdout. It refuses to overwrite an
existing file.

---

## home-pages

Reads the home boards. Widgets and covers are edited in the desktop app.

### list

Returns every board in position order: `[{ id, name, icon?, position, widgets, cover? }]`.
Boards saved before the resizable grid get coordinates from their size letter, as in the
desktop app.

### get

`memrynote home-pages get <id>` returns one board. Fails when it does not exist.

---

## icons

The vault's custom icon library (`.memry/icons/`).

### list

Returns `[{ id, name, ext, path, createdAt }]`. A missing icon file is rebuilt from the database row.

### add

| Positional | Description               |
| ---------- | ------------------------- |
| `<path>`   | An `.svg` or `.png` file. |

| Flag            | Description                                            |
| --------------- | ------------------------------------------------------ |
| `--name <text>` | Label, up to 60 characters. Defaults to the file name. |

SVG is sanitized like the desktop app does (scripts, event handlers, external references
removed). The desktop app re-encodes raster images to PNG and downscales them; the CLI cannot, so it
accepts only PNG files up to 128 px on the longest edge and up to 2 MB, and asks you to convert
other formats first.

### rename

`memrynote icons rename <id> <new-name>`.

### delete (destructive)

`memrynote icons delete <id> --yes` removes the icon and its file. An icon that has synced
also gets a pending-delete record so the desktop app can tell your other devices; the result's
`syncPending` says so.

---

## import

Brings files from other apps into the vault, using the parsers the desktop importers use.

### sources

Lists every importer the desktop app has, as `[{ id, name, extensions, directory, cli, reason? }]`.
`cli: true` sources run from the command line: `markdown`, `csv`, `roam`. For the others,
`reason` says why they stay in the desktop app (attachments, tasks, account sign-in, or the macOS
Notes container and its password prompt). `import start` on one of them exits non-zero with that reason.

### preview

`memrynote import preview <source> <path...> [--folder <vault-folder>]` plans the import and prints
`{ groups: [{ label, counts, sampleTitles, warnings?, error? }] }` per source file. Nothing is written.

### start

`memrynote import start <source> <path...> [--folder <vault-folder>]`

| Source     | Reads                                | Default folder |
| ---------- | ------------------------------------ | -------------- |
| `markdown` | `.md` / `.markdown` files or folders | `Markdown`     |
| `csv`      | CSV files, one note per row          | `CSV`          |
| `roam`     | Roam JSON exports                    | `Roam`         |

`--folder` replaces the importer's own root and keeps subfolders (`Markdown/sub` becomes
`<folder>/sub`). Returns `{ importer, imported, attachments, skipped, failed, warnings, notes }`.

Differences from the desktop import, listed in `warnings`: attachments are not copied (`attachments`
is always `0`), checklists stay plain markdown instead of becoming tasks, and Roam page dates are
not carried over. Importing the same files twice creates the notes twice.

---

## readwise

The part of the Readwise importer that needs only the vault's databases. The token lives in the
OS keychain and pulls run in the desktop app's scheduler, so those stay in the desktop app.

### status

Returns `{ connected, options, lastSyncAt, needsAttention, attention, hasImported, lastRun, pullingDevice }`.
`connected` is always `null`: the CLI never reads the keychain. `hasImported` and `lastSyncAt`
show whether a run has completed. `pullingDevice` names the device that holds the pull claim.

### list-deleted

Lists notes the user deleted that Readwise will not recreate: `[{ readwiseBookId, noteId, deletedAt }]`,
newest first. The desktop app also shows titles and highlight counts, which need the Readwise API.

### set-options

| Flag                                  | Description                                                             |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `--root-folder <path>`                | Vault folder for imported notes.                                        |
| `--folder-layout <by-category\|flat>` | Folder layout.                                                          |
| `--cadence <manual\|hourly\|daily>`   | How often the desktop app pulls.                                        |
| `--category <name>=on\|off`           | Repeatable. `books`, `articles`, `tweets`, `podcasts`, `supplementals`. |
| `--reader-documents on\|off`          | Also import saved Reader documents.                                     |
| `--reader-full-text on\|off`          | Import their full text.                                                 |
| `--journal on\|off`                   | Add new highlights to the journal.                                      |

Writes the same `readwise` settings group the desktop app uses, and flags a full re-read when a
category or Reader documents switch on. Returns the new status.

### sync-now / restore-book / reimport-book / refresh-book / take-over

Exit non-zero with a pointer to Settings → Import → Readwise. They need the stored token and the
desktop app's sync scheduler, and a second runner from the CLI could race it.

---

## Exit codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| `0`  | Success.                                        |
| `1`  | Any thrown error. Message is written to stderr. |

The most common error messages are:

- `Missing <label>` — a required positional is missing.
- `Invalid number: <value>` or `Invalid boolean: --<flag>` — a flag failed to parse.
- `Pass --yes to delete a <thing>` — a destructive command needs the safety flag.
- `Multiple vaults found. Choose one with memrynote vault use ... or run with --vault <path>.`
- `No default vault configured. Open memrynote and choose Settings > Command Line > Default vault, or run with --vault <path>.`

---

## Environment variables

| Variable               | Meaning                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMRY_MIGRATIONS_DIR` | Directory holding `drizzle-data/` and `drizzle-index/`. An escape hatch — the CLI finds them on its own, both from a packaged install and from a source checkout. Set it only if it ever reports that it could not. |

If a command fails with `Could not find the drizzle-data migrations folder`, the
error lists every path that was checked; point `MEMRY_MIGRATIONS_DIR` at the
right one and please open an issue, since finding them should not need help.
