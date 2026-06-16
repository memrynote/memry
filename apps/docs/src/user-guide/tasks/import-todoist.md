# Import from Todoist

Bring a Todoist project into Memry by importing its CSV export. Each CSV becomes a new Memry **project** containing its tasks.

## Export from Todoist

In Todoist, open a project → **⋯** menu → **Export as a template** → **Export as CSV**. This downloads a `.csv` file named after the project (e.g. `Personal.csv`).

> Todoist exports one CSV per project. To migrate several projects, export each and select them all at once during import.

## Import into Memry

1. Open **Settings → Import**.
2. Click **Import** next to **Todoist**.
3. **Choose file** and select one or more exported `.csv` files.
4. Review the preview for each file — project name, counts (tasks, sub-tasks, dated, comments, skipped), a few sample task titles, and any warnings.
5. Click **Import**. A new project is created per file, with live progress you can **Cancel** at any time.

## What gets imported

| Todoist                | Memry                                                       |
| ---------------------- | ----------------------------------------------------------- |
| CSV file               | New project, named from the filename                        |
| Task content           | Task title                                                  |
| Task description       | Task description                                            |
| Priority (P1–P4)       | Priority (Urgent / High / Medium / None)                    |
| Indented sub-tasks     | Sub-tasks (nested under their parent)                       |
| Due date               | Best-effort due date (see below)                            |
| Comments / attachments | Appended to the task description; attachments become a link |

### Due dates

Memry parses Todoist due dates on a best-effort basis:

- Absolute dates (`2026-06-20`, `Jun 20`) import exactly.
- Relative dates (`in 2 days`, `tomorrow`, weekday names) are resolved from the day you import.
- Recurring values (`every day`) and anything unrecognized import the task **without** a due date and add a warning.

## Not imported

- **Sections** are flattened — their tasks join the project directly (the section name is reported as a warning).
- **Completed tasks** are not part of a Todoist project CSV export.
- **Labels** (`@label`) stay as literal text in the task title.
- **Attachment files** are linked, not downloaded.
- Re-importing the same file always creates a **new** project (no de-duplication).
