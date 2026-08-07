# Triage Mode

A focused, card-based workflow for processing the inbox one item at a time. The rest of the UI fades; the current card takes center stage.

<!-- screenshot: triage card with action buttons -->

## When to Use Triage

When the inbox has piled up and you want to clear it. Triage is built around quick, low-cognitive-load decisions: archive, snooze, file, or convert.

## Entering Triage

Click the **Triage** tab in the inbox view, or hit the triage button in the inbox header. The current pending item appears as a card.

## Card Anatomy

Each card shows:

- The item type badge (link, note, image, voice, clip, social, etc.)
- A title (or filename for files)
- A snippet of content or preview
- Source URL (if any)
- The capture timestamp
- Action buttons

## Actions

| Action                  | Result                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Archive**             | Done; file the item and move on. The item is searchable but out of the active inbox.                                                                  |
| **Snooze**              | Defer until later. Item disappears from inbox until wake time. See [Snooze & Archive](/user-guide/inbox/snooze-archive).                              |
| **Quick file**          | Move into a folder, project, or tag without converting.                                                                                               |
| **Convert to Note**     | Create a note seeded with the item's content. The original is archived with a back-reference.                                                         |
| **Convert to Task**     | Create a task in the current default project, or pick a project, due date, due time, and priority.                                                    |
| **Convert to Event**    | Create a calendar event from the item: start (and optional end) time, an all-day toggle, and a location. The item body becomes the event description. |
| **Convert to Reminder** | Create a note from the item and schedule a reminder for it at a chosen time. The time must be in the future.                                          |
| **Open**                | Open the source URL in your browser.                                                                                                                  |
| **Delete**              | Discard. (Confirms first.)                                                                                                                            |

## Triage Decisions Across Devices

Filing, archiving, and snoozing **sync across your devices**, like the item itself. File a web clip on your laptop and it leaves the inbox on your desktop too, once both have synced — you only triage an item once.

If a device is offline when you file, the decision is queued and pushes on its next sync. Until then that device's inbox is simply behind; nothing is lost.

## Keyboard Shortcuts

When the inbox or a triage card has focus:

| Action          | Shortcut                                  |
| --------------- | ----------------------------------------- |
| Refresh         | <kbd>R</kbd>                              |
| Open source URL | <kbd>O</kbd>                              |
| Archive         | <kbd>Delete</kbd> or <kbd>Backspace</kbd> |

Cards stack — finishing one slides the next in.

## Multi-Action Patterns

Many items map to a sequence:

- **Article you want to read** → Snooze 1 hour, then Archive after reading
- **Task hidden in a link** → Convert to Task, the source is preserved as a reference
- **Reference material** → Convert to Note with a tag, then Archive
- **Already obsolete** → Delete

## Converting from the Detail Panel

Opening an item shows a **Convert** row beneath the filing section with four targets: **Note**, **Task**, **Event**, and **Reminder**. Task, Event, and Reminder open a small form so you can set details before converting:

- **Task** — project, due date, due time, and priority.
- **Event** — start time (required), end time, all-day, and location.
- **Reminder** — the time to be reminded (must be in the future).

File-based items (images, PDFs, videos, and clips) can only become a **Note**, so the other three are disabled for them. Voice memos convert using their transcription, so they keep the full set of options.

## Speed-Run Mode

Working through a long backlog? Use only the keyboard. Each card has the same set of actions in the same place — repetition makes the muscle memory cheap.

## What Triage Doesn't Do

Triage doesn't auto-decide. The choice is always yours. memrynote doesn't apply ML to guess what you want — partly to keep behavior predictable, partly to keep content out of any provider's training pipeline.

## See Also

- [Capturing to Inbox](/user-guide/inbox/capturing)
- [Filters & Views](/user-guide/inbox/filters)
- [Snooze & Archive](/user-guide/inbox/snooze-archive)
