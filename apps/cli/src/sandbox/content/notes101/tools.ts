import { table } from '../../body.ts'
import type { NoteSpec } from '../../specs.ts'
import { lesson } from './lesson.ts'

export const toolNotes: NoteSpec[] = [
  lesson(
    'n-props',
    '09 Properties and folder views',
    '🗂️',
    'Intermediate',
    'Typed fields in the frontmatter, and folders that open as tables, galleries and lists',
    (
      b
    ) => `Properties are typed fields at the top of a note. This note has one of nearly every type, so open the properties panel under the title and read along.

## Property types

${table([
  ['Type', 'Use it for', 'On this note'],
  ['Text', 'A short free-form string', 'summary'],
  ['Number', 'A count, a score, an amount', 'Rating'],
  ['Checkbox', 'A yes or no', 'owned'],
  ['Date', 'A day, optionally on the calendar', 'deadline'],
  ['URL', 'A web address', 'url'],
  ['Select', 'One value from a list', 'level'],
  ['Multi-select', 'Several values from a list', 'topics'],
  ['Status', 'A stage that is to do, in progress or done', 'stage'],
  ['Relation', 'Links to notes, tasks, events, canvases or journal days', 'related'],
  ['Project', 'Joins the note to a project', 'project']
])}

**Insert:** hover above the title and choose **Add property**, or open the panel and click **Add property**. Pick an existing property or create one. Everything is stored in the frontmatter, so it reads as plain text in any editor:

\`\`\`yaml
---
summary: Typed fields in the frontmatter
level: Intermediate
deadline: ${b.day(7)}
owned: true
---
\`\`\`

## Definitions are shared

A property definition is vault-wide: its type, its options and their colors. Add a Topics multi-select once and every note can use the same vocabulary. Manage them in **Settings, Properties**. A status property has three built-in categories; a select option has a color; and a value that matches no option still shows, in gray.

## Show a date on the calendar

On a date property's row, click the small calendar icon. Every note with that property then appears on the calendar as an all-day chip on its date, and clicking the chip opens the note. This note's **deadline** does that, so look for it on the calendar in a week.

## Relations and projects

A relation chip shows the title of what it points at and updates when that is renamed. The property also counts as a link: the target lists this note in its backlinks. The **project** property ties the note to a project, and the note appears on the project's page.

## Folders as databases

Click a folder in the sidebar and it opens as a database over the notes inside it. Each folder keeps its own **views**: a table, a gallery of cards or a list, each with its own columns, filters, sort order and grouping.

- **Notes 101** opens as a table of these chapters, with the level and summary properties as columns
- **Research/Reading list** is a table with a gallery and a list of finished books as other views
- **Kitchen/Recipes** opens as a gallery, with a second view grouped by course

Open a folder, then use the view switcher at the top to change layout. Click a column header to sort, and drag a column border to resize it. A folder can also have an icon and a default template, both set from its menu.

Tags with fields get the same kind of table, built from the tag's fields: [[08 Tags and tags with fields]]. A view can also sit inside a note, as in [[04 Code, math and diagrams]].

Next: [[10 Note tools]].
`,
    {
      properties: (b) => ({
        level: 'Intermediate',
        summary:
          'Typed fields in the frontmatter, and folders that open as tables, galleries and lists',
        Rating: 5,
        owned: true,
        deadline: b.day(7),
        url: 'https://docs.memrynote.com',
        topics: ['Note-taking', 'Design'],
        stage: 'In review',
        project: ['Studio ops'],
        related: [b.uri.note('n-overview')]
      })
    }
  ),

  lesson(
    'n-tools',
    '10 Note tools',
    '🧰',
    'Intermediate',
    'Icon, cover, find, outline, mind map, writing tools and everything in the note menu',
    () => `Around the text there is a small toolbox. Most of it lives in the note's header and the **...** menu.

## Icon and cover

Hover above the title: **Add icon** picks an emoji, a built-in icon or one of your own images. **Add cover** puts a band across the top of the page: a gradient wash (twelve ship with the app), or a photo. This note uses a wash. The icon shows in the sidebar, in tabs and in link previews.

## Find in page

**Cmd+F** opens a small bar in the note: **Enter** goes to the next match, **Shift+Enter** to the previous one, **Esc** closes it. It searches this note only; **Cmd+K** searches everything.

## Outline and mind map

The header's hierarchy icon turns the note into a **mind map**: the title is the root, headings branch from it, and lists, tasks and wiki links hang under their headings. It is a view, not a document, so nothing is saved and the note is untouched. Press the icon again to go back. This note has many headings, so try it.

## Writing tools

The pen button in the header opens the writing tools:

- **Alternatives**: select a sentence, choose **Add alternative**, and write another version. Arrow keys swap between versions in place.
- **Ghost**: fade a passage out without deleting it. It leaves the word count too, and **Revive** brings it back.
- **Overflow**: a scratch list beside the note for spare paragraphs and outlines.
- **Lab**: with AI on, checks for convoluted sentences and trims. It never rewrites your text.

The same menu turns a live **word count** on.

## Blocks

Hover the left gutter of a block: the six dots drag it, and clicking them opens the block menu, where **Turn into** changes its type, **Colors** colors it, **Duplicate** (Cmd+D) copies it, **Move to...** sends it to another note, and **Comment** opens a comment on it. Dragging a block onto a sidebar note moves it there.

## Make more notes

- **Cmd+N** makes a note; type its name and press **Enter**.
- **New note from this note** (right-click a note in the sidebar) copies its folder, icon, tags and properties into a fresh empty note. Good for the third meeting in a series.
- **Cmd+T** opens a tab, **Cmd+Backslash** splits the window, so you can read one note while writing another.

## Share and keep

- **Export to PDF** is in the File menu.
- **Set local only** keeps one note on this device and out of sync.
- **Reveal in navigation** jumps to the note in the sidebar.

Next: [[11 Templates]].
`,
    {
      properties: () => ({
        level: 'Intermediate',
        summary:
          'Icon, cover, find, outline, mind map, writing tools and everything in the note menu',
        cover: 'wash:lilac'
      })
    }
  ),

  lesson(
    'n-templates',
    '11 Templates',
    '🧩',
    'Beginner',
    'Templates for notes, journal days and tags, and how each one gets applied',
    () => `A template is starting content for a note: a body, and optionally tags, properties and an icon. It saves you retyping the same headings.

## Templates in this vault

${table([
  ['Template', 'Where it applies'],
  ['Person, Company, Meeting, Book', 'Automatically, when you add that tag to an empty note'],
  ['Recipe', 'Automatically, when you add the recipe tag to an empty note'],
  ['Paper note', 'The default for new notes in Research/Papers'],
  ['Daily journal', 'The default for new journal days']
])}

Open **Settings, Templates** to see them next to the built-in ones (Daily Reflection, Weekly Review, Meeting Notes, Project Brief, Standup, Decision Log and Reading Notes). Built-ins are read-only; **Duplicate and Edit** makes your own copy.

## Four ways to apply one

1. **Create a note from it**: the create dialog has a template picker.
2. **Tag template**: a tag with fields can point at a template that fills an empty note when it gets the tag. Try adding the meeting tag to a new empty note, or look at [[Northlight kickoff]], which started from the Meeting template.
3. **Folder default**: a folder can name a template, so every new note in it starts from that one.
4. **Apply or insert**: on an existing note, the **...** menu has **Apply Template** (replaces the body, and can add tags and properties) and **Insert template content...**, which drops a template at the cursor and touches nothing else. Type **/** and the template's name for the quick way.

## Variables

Placeholders are filled in when a template is applied. They are stored as written, so editing the note never changes the template:

\`\`\`text
## {{title}}
Date: {{date:YYYY-MM-DD}}
Weekday: {{day-of-week}}
\`\`\`

Also available: \`{{date}}\` for the full date, and \`{{time}}\`.

## Make your own

Open a note you like and choose **Save as Template** from its **...** menu, or start from scratch in Settings. Edits to a template are saved a moment after you stop typing.

A checkbox in a template stays a plain checkbox; the notes made from it turn them into tasks of their own only when you start editing.

See also [[Journal]] for the journal's default template.

Next: [[12 Bookmarks and reminders]].
`
  ),

  lesson(
    'n-bookmarks',
    '12 Bookmarks and reminders',
    '🔖',
    'Beginner',
    'Pin things you come back to, and be told when to come back',
    (b) => `Two small tools for coming back to things.

## Bookmarks

**Insert:** click the bookmark icon in a note's header (or the same action on a task, folder, tag, journal day or canvas). Bookmarked items appear in the sidebar's **Bookmarks** section and in the **Bookmarks** widget on Home. Reorder them by dragging. A bookmark is a flag: it does not move or change what it points at.

This vault bookmarks one of everything: notes, a journal day, a task, a folder, a tag, a canvas, a PDF, an image, an audio file and a video. Open the Home board to see them.

## Reminders

**Insert:** click the bell in a note's header, a task, a journal day or an inbox item, and pick a time: a quick choice (in an hour, tomorrow morning, next week) or a custom date and time with an optional message.

- When it is due, Memry shows a toast with the title and **Open**, **Snooze** (5 minutes, 10 minutes or a custom time) and **Dismiss**. Notes with an upcoming reminder show a small bell badge in the sidebar and the tab bar.
- A note or a journal day carries one reminder. Picking another time moves it.
- A highlighted passage can carry a reminder too, to bring back a quote.
- A snoozed reminder comes back at the time you chose; a dismissed one does not come back.

Reminders in this vault: one on [[Aurora PRD]] for tomorrow morning, one on the Grand Teton permit task, one on tomorrow's journal day, one on a passage in [[In Event of Moon Disaster]], plus an overdue one, a snoozed one and a dismissed one. The bell on each shows the state.

## Reminders in the text

A date chip can remind you too. The one in this sentence, ${b.date(1, { time: '09:00', remind: '15m' })}, reminds you fifteen minutes before. Click the date to change it, its format or its reminder lead time.

More about snoozing is in [[Inbox]], where the same idea sorts what to deal with later.

Next: [[13 Locks and version history]].
`
  ),

  lesson(
    'n-locks',
    '13 Locks and version history',
    '🔒',
    'Advanced',
    'Read-only locks, version history, restoring and local-only notes',
    () => `Two ways to make a note safe: stop it changing, or be able to go back.

## Read-only locks

Lock a note, or a whole folder, when it should stay exactly as it is: a signed contract, a finished spec, reference material for an AI agent. **Insert:** right-click a note or folder in the sidebar and choose **Lock note** or **Lock folder**, or use the lock item in the note's **...** menu.

[[Typography spec (signed off)]] is locked in this vault. Open it: a line above the text says it is read-only, and the title, tags, properties and body cannot change. The lock also stops renames, moves, deletes, template applies, restoring a version, and every AI write. Unlock it from the same menu.

A folder lock covers every note in it, including ones that arrive later. Locks sync, though a change made on a device that does not know the lock yet still arrives.

## Version history

Memry saves versions of a note while you write: after a pause, before big automated changes, and now and then in a long session. Open **Version history** from the note's **...** menu to see the timeline. Select a version to preview it, switch on the diff to see what changed, and **Restore** to bring it back. Restoring is not destructive: the current text is saved as a new version first.

[[Space race essay draft]] has several saved drafts, so its history has something to show. Versions are kept on this device and thin out with age: dense for the last day, sparse for the last month.

## Local only

**Set local only** (note menu) keeps a note on this device. It is never uploaded, and everything written while it is local stays put. Locked notes cannot be switched.

Nothing in this vault syncs anyway; more on that in [[Sync and privacy]].

Back to the start: [[00 What a note is]].
`
  )
]
