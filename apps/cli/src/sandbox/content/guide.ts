import { table } from '../body.ts'
import type { NoteSpec } from '../specs.ts'

const GUIDE = 'Start here'

const guide = (
  key: string,
  title: string,
  emoji: string,
  body: NoteSpec['body'],
  extra: Partial<NoteSpec> = {}
): NoteSpec => ({
  key,
  title,
  folder: GUIDE,
  tags: ['guide'],
  emoji,
  body,
  created: 0,
  modified: 0,
  ...extra
})

export const guideNotes: NoteSpec[] = [
  guide(
    'g-welcome',
    'Welcome to Memry',
    '👋',
    () => `This is a sandbox vault: a full, lived-in vault you can click through, edit and break. It belongs to **Maya Okafor**, a product designer building a calm reading app called Aurora, writing an essay about how people kept notes during the space race, cooking, and planning a hiking trip.

Nothing here touches your own vault. When you are done, switch back with the vault switcher at the top of the sidebar (⌘⇧O).

## Start with Notes 101

New to notes? The **Notes 101** folder is a short course where every note is a live example of what it teaches: text, lists, tables, media, links, tags with fields, properties, templates and more. Begin with [[00 What a note is]].

## How this vault is organized

${table([
  ['Folder', 'What is in it'],
  ['Notes 101', 'A course on notes. Each note is an example with the explanation beside it'],
  ['Start here', 'This guide: one note per app feature, each linking to a live example'],
  ['Work', 'The Aurora launch project, meetings, client meetings, decisions, studio ops'],
  ['People', 'Teammates, client contacts and friends: notes tagged person, with fields'],
  ['Companies', 'The studio, two clients and a publisher: tagged company or client'],
  ['Research', 'Essay research: concepts, scanned memos, photos, papers, books'],
  ['Kitchen', 'Recipes in a gallery view, a meal plan, a grocery list'],
  ['Travel', 'A trip three weeks from now, with tasks and calendar days'],
  ['Writing', 'The essay draft with version history, a learning log'],
  ['journal', 'Daily entries for the last two and a half months']
])}

Canvases live in their own section of the sidebar.

## Take the app tour

1. [[Tasks and projects]]
2. [[Inbox]]
3. [[Journal]]
4. [[Calendar and day panel]]
5. [[Canvas]]
6. [[Search, OCR and AI]]
7. [[Graph]]
8. [[Sync and privacy]]
9. [[Keyboard shortcuts]]

Photos, papers and recordings are credited in [[Credits]].
`
  ),
  guide(
    'g-tasks',
    'Tasks and projects',
    '✅',
    () => `Tasks live in projects. Each project has its own statuses and a board.

## Live examples

- **Aurora launch** uses custom statuses: Backlog, Design, Build, Review, Done. Switch the Tasks page to the board view to see them as columns.
- **Studio ops** has repeating tasks: a daily standup note and a weekly review.
- **Website v1** is archived.
- *Ship Aurora 1.0* has subtasks three levels deep.
- Some tasks are overdue on purpose, some are due today, some have start dates.
- Five tasks are delegated: they carry the waiting tag, whose **Waiting on** field points at a person. The row shows a chip such as "Waiting on Priya Nair", and the person's note lists the task. See [[08 Tags and tags with fields]].

## Tasks inside notes

A task can live in a note as a checkbox line and stay in sync with the Tasks page. Examples: [[Aurora PRD]], [[Packing list]], and today's journal entry. [[02 Lists, checklists and tasks]] shows how. Plain checklists that should *not* become tasks, like the [[Grocery list]], use the checklist block instead.

## Saved filters

Open the filter menu on the Tasks page: *Aurora this week*, *Overdue and important* and *Trip prep* are saved there.
`
  ),
  guide(
    'g-inbox',
    'Inbox',
    '📥',
    () => `The inbox is where things land before you decide where they go: quick notes, links, images, PDFs.

## Live examples

- Links you saved more than a week ago are marked stale
- Two items are snoozed and come back on their own (tomorrow and next week)
- Images of printed pages are readable by search after OCR
- Filed items show where they went: a note, a task, or an existing note

Open the inbox and try triage: one item at a time, file or archive. A filed capture ended up in [[Notes in the space race]] under *Inbox Captures*.
`
  ),
  guide(
    'g-journal',
    'Journal',
    '📓',
    () => `One entry per day. The journal shows a heatmap of the days you wrote, your current streak, and the tasks and events for each day.

## Live examples

- Maya wrote most days for the last two and a half months, with a few gaps
- Each entry has \`mood\`, \`energy\`, \`sleep\` and \`workout\` properties; the chart on Home plots mood
- Today's entry has a plan with real tasks in it
- New entries start from the *Daily journal* template

See also [[11 Templates]].
`
  ),
  guide(
    'g-calendar',
    'Calendar and day panel',
    '📅',
    () => `The calendar shows events, tasks with due dates, notes with a date property marked *show on calendar*, and reminders.

## Live examples

- Standups every workday this week and next
- The Aurora design review later this week, prepared in [[Design review prep]]
- The trip as an all-day event, five days long: [[Grand Teton trip]]
- A dentist appointment, a dinner, 1:1s
- Meeting notes with a **Date** field, shown as chips on their day: the Meeting tag's date is set to show on the calendar

The day panel on the right shows the selected day: its tasks, schedule and journal entry.
`
  ),
  guide(
    'g-canvas',
    'Canvas',
    '🎨',
    (
      b
    ) => `A canvas is an infinite whiteboard. Cards on it are live: a note card shows the note, a task card can be ticked, a project card shows progress.

## Live examples

- **Aurora launch map**: the brief, key tasks, the project, the design review and a PDF, joined by arrows, inside a section
- **Space race essay board**: notes, a photo, a link to a journal day and a web link

A canvas can also sit inside a note:

${b.canvas('essay-board')}
`
  ),
  guide(
    'g-search',
    'Search, OCR and AI',
    '🔎',
    () => `Press ⌘K to search everything: notes, tasks, inbox items, and the text inside files.

## Text inside files

Memry extracts text from attachments so search finds it:

- PDFs with a text layer, like the papers in Research/Papers
- Scanned PDFs with no text layer at all, through OCR: [[In Event of Moon Disaster]] and [[Apollo 1 memo, 1967]]. Try searching for *rest in peace*.
- Photos of printed pages: [[Strawberry shortcake, 1918]], [[Omit needless words]], and the nutrition label in [[Weekday granola]]

## Similar notes

Memry can build local embeddings of your notes, on your device, to suggest related notes and power semantic search. The space race notes are written to cluster together; open one and look at its related notes once indexing is done.

## AI

Agent chat and writing tools work with a provider you choose in Settings. They read your vault through a local server; changes need your approval.
`
  ),
  guide(
    'g-graph',
    'Graph',
    '🕸️',
    () => `The graph draws every note as a dot and every link as a line.

## What to look for

- The space race cluster around [[Notes in the space race]]
- Aurora notes linked through [[Aurora product brief]] and [[Decision log]]
- Recipes linked from [[Meal plan]]
- People and companies linked to the meetings they attended: try [[Lena Visser]]
- A few notes that link to nothing: orphans sit at the edge

Turn on tag nodes to see notes grouped by #guide and other tags.
`
  ),
  guide(
    'g-sync',
    'Sync and privacy',
    '🛡️',
    () => `Memry is local first. Your notes are Markdown files on your disk and everything works offline.

When you turn on sync, notes, tasks and files are encrypted on your device before they leave it. The server stores ciphertext; it never sees your notes or your keys.

This sandbox is not signed in, so nothing here syncs.
`
  ),
  guide(
    'g-shortcuts',
    'Keyboard shortcuts',
    '⌨️',
    () => `The ones worth learning first. The full list is under Help.

${table([
  ['Action', 'Shortcut'],
  ['Search', 'Cmd+K'],
  ['New note', 'Cmd+N'],
  ['New tab', 'Cmd+T'],
  ['Split right', 'Cmd+Backslash'],
  ['Toggle sidebar', 'Cmd+B outside a note'],
  ['Switch vault', 'Cmd+Shift+O'],
  ['Jump to sidebar section', 'Cmd+1 to Cmd+6'],
  ['Find in page', 'Cmd+F'],
  ['Shortcut list', 'Cmd+/']
])}

On Windows and Linux use Ctrl instead of Cmd.

In a note, type \`/\` for the block menu and \`[[\` for a link.
`
  ),
  guide(
    'g-credits',
    'Credits',
    '🙏',
    () => `The photos, scans, papers and recordings in this vault are public domain or openly licensed. Credits below. NASA material is used under NASA's media guidelines; its use here does not imply endorsement by NASA.

## Images

- *Earthrise*, Bill Anders / NASA, Apollo 8, public domain
- *The Blue Marble*, Apollo 17 crew / NASA, public domain
- *Pillars of Creation* (2014), NASA, ESA, and the Hubble Heritage Team (STScI/AURA), public domain
- *Library of Congress Main Reading Room* and *Grand Teton National Park*, Carol M. Highsmith, public domain (Library of Congress)
- *Romanesco broccoli* and *Edible fungi in basket*, George Chernilevsky, CC BY 4.0
- *FDA Nutrition Facts Label*, U.S. Food and Drug Administration, public domain

## Scans

- Memorandum, Jim Jones to President Johnson, 27 January 1967. National Archives via DPLA and Wikimedia Commons, public domain
- *In Event of Moon Disaster*, William Safire to H. R. Haldeman, 18 July 1969. National Archives via DPLA and Wikimedia Commons, public domain
- Fannie Merritt Farmer, *The Boston Cooking-School Cook Book* (c1918), p. 83. University of California Libraries via Internet Archive, public domain
- William Strunk Jr., *The Elements of Style* (1920), p. 24. Cornell University Library via Internet Archive, public domain

## Papers

- Gero, Chilton, Melancon, Cleron, *Eliciting Gestures for Novel Note-taking Interactions*, arXiv:2112.12126, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)

## Audio and video

- Neil Armstrong, "one small step", 21 July 1969, NASA, public domain
- Jack King's Apollo 11 launch commentary, NASA Kennedy Space Center, public domain

The people, studio and app in this vault are fictional.
`
  )
]
