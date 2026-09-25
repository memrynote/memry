# Journal on iPhone

The iPhone app has a Journal tab. It reads and writes the same days, templates, reminders and journal settings as the desktop app, and every change syncs both ways. The rules are shared as well: streaks, month and year counts, previews and template dates come from the same code on both, so a day looks the same wherever you open it.

This page covers what works on the phone and where it behaves differently from the desktop.

## A day

The Journal tab opens on today. The header shows the weekday, how far the day is from today ("Yesterday", "3 days ago", "in 2 days") and the date. A TODAY badge marks the current day.

Below the header:

- the day's tags and properties
- the entry, in the same block editor as notes
- the tasks due that day (today also shows the overdue count, which opens the Tasks tab)
- **Linked from**: notes and days that link to this one
- the stats footer, when it is turned on in settings

Opening an empty day creates nothing. The day is created by the first line you type, as on the desktop. If a template applies to that date, the day opens with the template already filled in, and a day that another device already filled in is never filled in twice.

## Moving between days

| How                     | Action                          |
| ----------------------- | ------------------------------- |
| Swipe left or right     | Next or previous day            |
| **‹** and **›**         | Previous or next day            |
| **Today**               | Back to today (shown off today) |
| Tap the date title      | Month, Year, or Go to date…     |
| ← / → on a keyboard     | Previous or next day            |
| Esc or ⌘. on a keyboard | Up to the month                 |

An edit you have not finished always stays on the day you typed it on, even if you page away straight after.

## Month and Year

**Month** lists the days of the month, newest first. Each row shows how much was written that day, the weekday and a one-line preview. Future days say "Future", past days without an entry say "No entry". The subtitle shows the year, the number of entries and your current streak.

**Year** shows the twelve months with their entry counts, the year's totals, your current streak and your best one. Tap a month to open it.

## Reminders

The bell offers the desktop's presets (in a week, a month, three months, a year, each at 9:00) and a custom date and time. When a day has a reminder the bell is filled. Tap it to change, snooze, dismiss or delete the reminder.

The notification shows the date only, never the entry's text. Tapping it opens the day.

## Links

A wiki link to a date, such as `[[2026-05-07]]`, opens that day. Search results, backlinks on notes and the **Related** section of a task all open journal days in the Journal tab.

## Settings

Open **More → Journal**, or **Journal Settings** from a day's **…** menu. You can choose:

- the default template
- a template for each weekday; an unset weekday uses the default
- whether to show the stats footer; this setting is kept on the phone only

Templates and the per-weekday choices are shared with the desktop.

## What is different from the desktop

- **Tags and properties are read-only on a journal day.** Desktop releases up to 2026.919.1 empty a journal day's file on disk when another device changes only its tags or properties. Until a desktop release with the fix is out, the phone shows them but does not change them. Edit them on your computer.
- **Changes from other devices arrive on the next sync.** That is when you open the app, return to it, or make a change yourself. They are not pushed live.
- There are no journal folder or file name settings on the phone. Those describe the desktop's files on disk.

## Offline

Days you write offline are saved on the phone and sync the next time you are online. Two devices writing in the same day while apart are merged when they reconnect, and both sets of writing are kept.
