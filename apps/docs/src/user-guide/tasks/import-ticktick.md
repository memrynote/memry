# Import from TickTick

Bring your existing TickTick tasks into Memry from a TickTick CSV backup.

## Export your data from TickTick

In TickTick, open **Settings → Backup** and download the backup. You get a
`.csv` file (for example `TickTick-backup-2026-06-15.csv`).

## Import into Memry

1. Open **Settings → Import**.
2. Click **Import** next to **TickTick**.
3. **Choose file** and select one or more exported `.csv` backups.
4. Review the preview for each file — counts (projects, tasks, sub-tasks, reminders), a few sample task titles, and any warnings.
5. Click **Import**. Items are created with live progress you can **Cancel** at any time, and a summary lists anything skipped.

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
