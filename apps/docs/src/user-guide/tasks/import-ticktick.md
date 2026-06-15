# Import from TickTick

Bring your existing TickTick tasks into Memry from a TickTick CSV backup.

## Export your data from TickTick

In TickTick, open **Settings → Backup** and download the backup. You get a
`.csv` file (for example `TickTick-backup-2026-06-15.csv`).

## Run the import

1. Open Memry **Settings → Import**.
2. Click **Import from TickTick (CSV)**.
3. Choose your exported `.csv` file.

Memry parses the file and creates everything in one pass, then shows a summary
of what was imported and any items it skipped.

## What gets imported

| TickTick             | Memry                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| List                 | Project (the **Inbox** list maps to your existing Inbox — it is never duplicated) |
| Kanban columns       | Project statuses                                                                  |
| Task title & content | Task title & description (content is kept verbatim)                               |
| Tags                 | Task tags                                                                         |
| Priority             | Task priority (none / low / medium / high)                                        |
| Start & due dates    | Start and due dates (times are kept unless the task is all‑day)                   |
| Subtasks             | Subtasks (parent/child relationships are preserved)                               |
| Completed / won't‑do | Completed / archived tasks                                                        |
| Reminders            | Task reminders (reminders in the past are skipped)                                |
| Repeat rules         | Recurring tasks                                                                   |

## Notes

- The import always **creates fresh** items. Running it twice imports the data
  again, so import each backup once.
- TickTick **folders** have no equivalent in Memry and are not imported; this is
  reported in the summary.
- Anything that can't be mapped (an unsupported repeat rule, a reminder with no
  date, an unrecognized value) is skipped and listed in the summary's warnings —
  the rest of the task still imports.
