# CLI Reference

A flat reference for every `memrynote` command, flag, and positional argument. For a
prose walkthrough, see [Command Line](/user-guide/cli).

## Synopsis

```bash
memrynote [--vault <path>] [--json] <command> [subcommand] [args] [flags]
```

The 21 top-level commands are listed in the [usage error](https://github.com/memrynote/memry/blob/main/apps/cli/src/run.ts)
when you run `memrynote` with no arguments:

```
vault | notes | folders | properties | folder-view | tasks | projects |
inbox | journal | tags | settings | locale | reminders | templates |
bookmarks | saved-filters | calendar | sync | agent | graph | search
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
memrynote vault <list|current|use|init|status|open|config|update-config> [args]
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

Resolves a wiki-link title to a concrete note record (no body).

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

| Positional    | Description                                |
| ------------- | ------------------------------------------ |
| `<note-id>`   | Note.                                      |
| `<file-path>` | Absolute path to copy in as an attachment. |

### attachments

Lists attachments for a note.

| Positional  | Description |
| ----------- | ----------- |
| `<note-id>` | Note.       |

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

| Flag                              | Type    | Description                    |
| --------------------------------- | ------- | ------------------------------ |
| `--no-metadata`                   | boolean | Omit frontmatter.              |
| `--include-metadata <true/false>` | boolean | Force include. Default `true`. |

### export-pdf

Same positionals as `export-html` plus:

| Flag                              | Type    | Description                    |
| --------------------------------- | ------- | ------------------------------ |
| `--no-metadata`                   | boolean | Omit frontmatter.              |
| `--include-metadata <true/false>` | boolean | Force include. Default `true`. |
| `--page-size <name>`              | string  | e.g. `A4`, `Letter`.           |

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

| Flag                             | Type       | Description                  |
| -------------------------------- | ---------- | ---------------------------- |
| `--description <text>`           | string     | Body.                        |
| `--project <id>`                 | string     | Project id.                  |
| `--status <id/null>`             | string     | Status id; `null` for inbox. |
| `--parent <id/null>`             | string     | Parent task id.              |
| `--due <YYYY-MM-DD>`             | string     | Due date.                    |
| `--due-time <HH:MM>`             | string     | Due time.                    |
| `--start <YYYY-MM-DD>`           | string     | Start date.                  |
| `--repeat <json>`                | JSON       | Recurrence config.           |
| `--repeat-from <due/completion>` | string     | Recurrence anchor.           |
| `--source-note <id>`             | string     | Originating note.            |
| `--priority <n>`                 | number     | Default `0`.                 |
| `--tag <name>`                   | repeatable | Tag.                         |
| `--link-note <id>`               | repeatable | Linked note.                 |

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

Reopens a completed task.

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

Requires `--yes`.

### reorder

Reorders tasks within their list.

| Positional | Description                |
| ---------- | -------------------------- |
| `<id...>`  | Task ids in desired order. |

| Flag             | Type       | Description                               |
| ---------------- | ---------- | ----------------------------------------- |
| `--position <n>` | repeatable | One per id, parallel to positional order. |

### delete (destructive)

Requires `--yes`.

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

---

## settings

### list

Returns all key/value settings.

### groups

Lists logical groups (UI sections).

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

---

## agent

### backends

Returns availability + version info for each agent backend.

### models

| Positional  | Description                                       |
| ----------- | ------------------------------------------------- |
| `[backend]` | `claude_cli` or `codex_cli` (or use `--backend`). |

| Flag               | Type   | Description                  |
| ------------------ | ------ | ---------------------------- |
| `--backend <name>` | string | `claude_cli` or `codex_cli`. |

### local-settings

Returns the local-provider settings used by Agent Chat.

### set-local-settings

| Flag                                | Type    | Description                                      |
| ----------------------------------- | ------- | ------------------------------------------------ |
| `--preset <name>`                   | string  | `ollama`, `lm_studio`, `llama_cpp`, or `custom`. |
| `--base-url <url>`                  | string  | Base URL.                                        |
| `--model <name>`                    | string  | Default model.                                   |
| `--allow-non-loopback <true/false>` | boolean | Allow non-localhost URLs.                        |

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

Schedules a full reindex. Returns `{ started: true, indexed: <n> }`.

### (free text)

Any other subcommand or arguments are joined with spaces and treated as a search
query.

```bash
memrynote search project plan
memrynote --json search "encryption nonce"
```

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
