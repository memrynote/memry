# AlternativeTo listing

Issue #3464. AlternativeTo ranks for "<app> alternative" searches, and list articles copy from it.
memrynote has no listing yet. This file holds everything Kaan needs to create it from his account.
Nothing has been submitted.

Every claim below matches the README, the landing pricing in `apps/landing/src/lib/constants.ts`,
or the importer list in `apps/desktop/src/main/import/register-builtins.ts` as of 2026-11-17.
Check the pricing and platforms again on the day you submit.

## Basics

| Field         | Value                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| Name          | memrynote                                                                                  |
| Website       | `https://memrynote.com/?utm_source=alternativeto&utm_medium=referral&utm_campaign=listing` |
| Source code   | `https://github.com/memrynote/memry`                                                       |
| Category      | Office & Productivity, Note-taking                                                         |
| License       | Open source, AGPL-3.0                                                                      |
| Pricing model | Freemium. Every feature is free. Sync between devices is paid.                             |
| Platforms     | Mac, Windows, Linux, iPhone (beta, TestFlight invite), Chrome and Firefox (web clipper)    |
| Logo          | `apps/desktop/build/icon.png`, 1024 x 1024 PNG                                             |

The UTM tags follow `marketing/utm.md`, so visits from the listing show as their own source on the
growth page.

## One-line description

> Notes, tasks, a journal and a calendar in one open-source app. Your notes are Markdown files on
> your disk, and sync is end-to-end encrypted.

## Long description

> memrynote is a desktop app for notes, tasks, a daily journal and a calendar. Your vault is a
> folder of Markdown files on your own disk, so any editor can open it. The app works offline and
> needs no account.
>
> Notes use a block editor that saves Markdown, with wiki links, backlinks, a graph view,
> properties, attachments and version history. Tasks and projects have list and kanban views,
> subtasks and recurring tasks. The journal gives each day one page, with templates and a
> heatmap. The calendar shows your events and dated tasks, and can show Google Calendar. The
> inbox collects links, files, voice memos, PDFs and pages from the web clipper until you file
> them. A canvas places notes, tasks and events as cards next to your drawings.
>
> An optional AI agent works on your vault through tools on a local MCP server. It runs with
> Claude Code, Codex, Antigravity or a local OpenAI-compatible model, and you approve each change
> it makes.
>
> Sync between devices is the only paid part. The app encrypts each change on your device with
> XChaCha20-Poly1305 and signs it with Ed25519 before upload, so the server stores ciphertext and
> the metadata it needs to route it. The apps are open source under AGPL-3.0.
>
> Importers bring over Markdown folders and Obsidian vaults, Notion, Evernote, OneNote, Apple
> Notes (on macOS), Apple Journal, Bear, Roam Research, Google Keep, NotePlan, Readwise, Todoist,
> TickTick, Raindrop, HTML files and CSV.

## Pricing

| Plan     | Price                     | Encrypted sync storage | Synced vaults |
| -------- | ------------------------- | ---------------------- | ------------- |
| Free     | $0                        | No sync                | -             |
| Plus     | $5 a month or $48 a year  | 1 GB                   | 1             |
| Pro      | $10 a month or $96 a year | 10 GB                  | 10            |
| Believer | $500 once                 | 50 GB                  | Unlimited     |

Every paid plan has a 14-day money-back guarantee.

## Feature tags

Pick the closest existing AlternativeTo tag for each. Add a new tag only when none fits.

- End-to-end encryption
- Local-first
- Markdown support
- Works offline
- No registration required
- Ad-free
- Privacy focused
- Journal
- Daily notes
- Task management
- Kanban boards
- Calendar
- Backlinks
- Wiki-style links
- Graph view
- Web clipper
- Import from other apps
- AI assistant

Leave out self-hosting, Android and a web app. memrynote does not ship them.

## "Alternative to" pairings

Each line gives the reason a user of that app would look at memrynote. The comparison page is the
one on memrynote.com for that app, if AlternativeTo asks for a link.

| Alternative to | Reason                                                                                                   | Comparison page               |
| -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Obsidian       | The same folder of Markdown files with wiki links and backlinks. Tasks, calendar and inbox are built in. | `/obsidian-alternative`       |
| Notion         | Notes, tasks and projects that live on your disk and work offline, with end-to-end encrypted sync.       | `/notion-alternative`         |
| Evernote       | A built-in Evernote importer, and notes kept as Markdown files.                                          | `/evernote-alternative`       |
| OneNote        | A built-in OneNote importer that signs in to your Microsoft account. Notes become Markdown files.        | `/onenote-alternative`        |
| Standard Notes | Open source with end-to-end encrypted sync, plus tasks, a calendar and a canvas.                         | `/standard-notes-alternative` |
| Notesnook      | Open source with end-to-end encrypted sync, and the vault stays a folder of Markdown files.              | `/notesnook-alternative`      |
| Joplin         | Open source Markdown notes with encrypted sync, plus projects, a calendar, a journal and a canvas.       | `/joplin-alternative`         |
| Anytype        | Local-first and encrypted, and every note is a plain Markdown file.                                      | `/anytype-alternative`        |
| Logseq         | Markdown files, backlinks and a daily journal, plus task views, a calendar and encrypted sync.           | `/logseq-alternative`         |
| Day One        | One journal page per day with templates and a heatmap, next to your notes and tasks.                     | `/day-one-alternative`        |
| Bear           | Markdown notes that also run on Windows and Linux. A built-in Bear importer.                             | `/bear-alternative`           |
| Apple Notes    | A built-in Apple Notes importer on macOS, and an app for Windows and Linux too.                          | `/apple-notes-alternative`    |
| Capacities     | Notes with properties, backlinks and a graph, stored as Markdown files that work offline.                | `/capacities-alternative`     |
| NotePlan       | Daily notes, tasks and a calendar in one app. A built-in NotePlan importer.                              | `/noteplan-alternative`       |
| Roam Research  | Wiki links, backlinks and daily notes in local files. A built-in Roam importer.                          | `/roam-research-alternative`  |
| Google Keep    | Quick capture into an inbox, and a built-in Google Keep importer.                                        | `/google-keep-alternative`    |

## Screenshots

AlternativeTo shows the first screenshot as the listing's main image, so order matters. Capture
each in the light theme at a window of about 1440 x 900, from a demo vault with no personal data,
and upload as PNG. The `apps/landing/public/screenshots/` files are WebP crops in uneven sizes, so
use them as a guide for the content of each shot, not as the upload.

| Order | App screen                                                                   | Landing reference             |
| ----- | ---------------------------------------------------------------------------- | ----------------------------- |
| 1     | A note with tags, a task list and wiki links, next to the day's calendar     | `hero_white.webp`             |
| 2     | Tasks grouped by due date, with one task's subtasks and project open         | `task_white.webp`             |
| 3     | A journal day with its schedule and linked notes, next to the month calendar | `journal_white.webp`          |
| 4     | The calendar week view with events and scheduled tasks                       | `calendar_white.webp`         |
| 5     | The graph view of a vault with linked notes                                  | `graph_white.webp`            |
| 6     | The inbox with links, photos and a voice memo, one item being filed          | `inbox_white.webp`            |
| 7     | A canvas with note cards in sections, joined by arrows                       | `canvas_white.webp`           |
| 8     | The AI agent editing a note, with its reply in the side panel                | `note_white.webp`             |
| 9     | Settings > Import with the importer list open                                | none, capture new             |
| 10    | Settings > Account with the linked devices list                              | none, capture new             |
| 11    | The web clipper popup on an article                                          | `webclipper-front_white.webp` |
| 12    | The iPhone app's task list (marked beta in the caption)                      | `ios/1-tasks.webp`            |

## After the listing is live

- Add the pairings above from the listing page.
- Check that alternativeto.net appears as a referrer in the Kanallar section of the growth page.
