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
- A title (seeded from the filename for files, and [renameable](#renaming-an-item))
- A snippet of content or preview
- Source URL (if any)
- The capture timestamp
- Action buttons

## Actions

| Action                  | Result                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Archive**             | Done; file the item and move on. The item is searchable but out of the active inbox.                                                                  |
| **Snooze**              | Defer until later. Item disappears from inbox until wake time. See [Snooze & Archive](/user-guide/inbox/snooze-archive).                              |
| **Quick file**          | Move into a folder, project, or tag without converting. Notes and attachments alike appear in the sidebar as soon as they are filed.                  |
| **Convert to Note**     | Create a note seeded with the item's content. The original is archived with a back-reference.                                                         |
| **Convert to Task**     | Create a task in the current default project, or pick a project, due date, due time, and priority.                                                    |
| **Convert to Event**    | Create a calendar event from the item: start (and optional end) time, an all-day toggle, and a location. The item body becomes the event description. |
| **Convert to Reminder** | Create a note from the item and schedule a reminder for it at a chosen time. The time must be in the future.                                          |
| **Open**                | Open the source URL in your browser.                                                                                                                  |
| **Delete**              | Discard. (Confirms first.)                                                                                                                            |

## Filing an Image Into a Note

When you file an image and link it to one or more notes, you choose the shape it takes:

| Choice                  | What happens                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Embed in the note**   | The image becomes an attachment of the note and renders inside it. It does **not** appear in the sidebar — it lives with the note, not as a file in your folder tree, so there is no folder to pick and the **File to** row goes away. |
| **File in the sidebar** | The image file moves into the folder you pick and shows up in the sidebar. The note gets a link to it; clicking that link opens the image in its own tab.                                                                              |

The two destinations are independent: the image can go in `Travel` while the note that links it sits under a project.

Link the same image to several notes and there is still only **one** image on disk, owned by the first note in the list. The other notes point at that copy — so deleting the first note breaks the image in the others. If you want independent copies, file the image separately for each note.

Very large images, and formats the attachment store does not accept, cannot be embedded. Filing still succeeds: memrynote tells you it could not embed and files the image as a linked file instead.

You are asked once. Tick **Don't ask again** and every later image uses the same choice, which you can change any time under **Settings → Inbox → Images**.

## Creating the Note You File Into

The note picker in the filing panel finds existing notes _and_ makes new ones. Type a name that does not match anything and pick **Create "…"** — nothing is written yet. The note is created when you press **File**, in the folder you selected, and the item lands in it.

Because creation waits for the filing, a name you type and then remove leaves nothing behind in your vault.

## Triage Decisions Across Devices

Filing, archiving, and snoozing **sync across your devices**, like the item itself. File a web clip on your laptop and it leaves the inbox on your desktop too, once both have synced — you only triage an item once.

If a device is offline when you file, the decision is queued and pushes on its next sync. Until then that device's inbox is simply behind; nothing is lost.

Items you filed on an older version of Memry are repaired automatically: the first time each device starts up and syncs after updating, it sends any triage decision that never reached your other devices. You do not need to re-file anything.

Whatever a triage decision creates syncs the same way — a note, a task, an event, a reminder, or the file itself. File an item into a folder on your laptop and the note lands in that folder on your desktop too, with its text, tags, and properties. File an image, PDF, voice memo, or video and the file is uploaded and downloaded onto your other devices, not just listed there.

One limit worth knowing: tags you add to an image, PDF, voice memo, or video while filing it stay on the device that filed it. A file has no text to carry them in. Tags on notes, tasks, and events sync normally.

Notes created by filing on an older version of Memry are repaired the same way as the triage decisions themselves: the next time that device starts up and syncs, it sends them. They arrive in the folder you originally chose. Nothing was lost in the meantime — the note has been on the device that filed it all along.

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

## Renaming an Item

Images, PDFs, and voice memos arrive named after the file you captured — `scan_final_v3.pdf` becomes a card titled "scan_final_v3". You can rename them two ways:

- **Right-click the row** and choose **Rename**. Enter commits, Escape reverts.
- **Open the item** and edit the title at the top of the detail panel. Enter or clicking away commits, Escape reverts.

Clearing the title entirely reverts to the previous name rather than saving a blank one. Renames sync across your devices like any other edit.

Reminders and notes have no Rename entry: a reminder's card shows the title of whatever it points at, and a note's title comes from its first line — edit the note body instead.

The name you choose is also **the filename the item gets when you file it**. Rename a PDF to "Q3 Invoice" and filing it into a folder writes `Q3 Invoice.pdf` to your vault. Characters a filesystem can't take (`/`, `:`, `*`, and friends) are stripped, and if a file of that name already exists, memrynote appends a number rather than overwriting it.

While an item is still in the inbox, its stored file keeps the name it was captured under. That name is internal — filing is what applies your title.

## Converting from the Detail Panel

Opening an item shows a **Convert** row beneath the filing section with four targets: **Note**, **Task**, **Event**, and **Reminder**. Task, Event, and Reminder open a small form so you can set details before converting:

- **Task** — project, due date, due time, and priority.
- **Event** — start time (required), end time, all-day, and location.
- **Reminder** — the time to be reminded (must be in the future).

File-based items (images, PDFs, videos, and clips) can only become a **Note**, so the selector is hidden for them entirely and the panel goes straight to filing. Voice memos convert using their transcription, so they keep the full set of options.

## Speed-Run Mode

Working through a long backlog? Use only the keyboard. Each card has the same set of actions in the same place — repetition makes the muscle memory cheap.

## What Triage Doesn't Do

Triage doesn't auto-decide. The choice is always yours. memrynote doesn't apply ML to guess what you want — partly to keep behavior predictable, partly to keep content out of any provider's training pipeline.

## See Also

- [Capturing to Inbox](/user-guide/inbox/capturing)
- [Filters & Views](/user-guide/inbox/filters)
- [Snooze & Archive](/user-guide/inbox/snooze-archive)
