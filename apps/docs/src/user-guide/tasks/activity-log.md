# Activity Log

Every task keeps a record of what changed, when, and whether the change was later replaced by an edit from another device. Open a task and scroll to **Activity** in the detail panel.

## Reading the feed

The panel shows the three most recent entries. Select **Show all** to open the full timeline, grouped by day and newest first.

Each entry names the field that changed and shows the old value struck through against the new one:

- **Due date** Aug 12 → Aug 20
- **Status** Todo → In Progress
- **Created** Buy milk

Reordering a task in a list is not recorded — position changes carry no information worth keeping, and dragging a long list would otherwise write hundreds of entries.

## Description edits

Descriptions are recorded as a length change (`+42 chars`), never as the text itself. Task descriptions can be as long as a note, and copying them into the log would multiply the size of your vault and of every encrypted sync payload.

## Replaced changes

When you edit the same field on two devices at once, one edit wins and the other is discarded. Before, that edit disappeared with no trace. Now the timeline records it as **Replaced by another device**, with the discarded value struck through, so you can see what you lost and set it again.

Both devices record the same conflict, and the two entries merge into one as they sync.

## Where the entries come from

Activity is written wherever a task changes — the task list, the Kanban board, Agent Chat, the Todoist and TickTick importers, checkbox edits made directly in a note's markdown, and writebacks from Google Calendar. Changes Google Calendar makes are labelled as such rather than attributed to you.

## Filtering

The full timeline has a filter for the kind of change: created, updated, completed, moved, deleted, or replaced. The inline preview in the detail panel always shows everything.

## Privacy and retention

Activity is encrypted and synced like the rest of your vault — the server stores only ciphertext and never sees a field name or a value.

Entries are kept for 90 days and then removed. Every device applies the same rule, so a removed entry does not come back from another device.

Entries do not name the device that made a change. They say **You** for this device and **Another device** for anything that arrived over sync.

## Deleted tasks

Deleting a task does not immediately erase its history — the deletion itself is an entry. Those entries are cleaned up once they pass the 90-day retention window.
