# Import from Obsidian Tasks

Memry reads task lines written by the Obsidian Tasks plugin and turns them into real Memry tasks.

There is no import wizard and no export step. You point Memry at the folder your vault already lives in, and a checkbox line becomes a Memry task the first time you open that note.

## Why it happens when you open the note

Memry will not write over a file whose bytes it has never read. Pointing Memry at an existing vault lists every note straight away, from the filename and timestamps alone, but until a note is opened its file is left exactly as its author wrote it. See [Opening a Note Written Somewhere Else](/user-guide/notes/editing#opening-a-note-written-somewhere-else).

Opening the note is the first moment Memry has genuinely read the file, so that is when the conversion runs. Nothing happens to a note you never open.

When a line converts, Memry lifts the plugin's fields off it into real Memry fields and appends its own `{task:<id>}` suffix. That suffix is how the line and the task find each other, and it has to be the last thing on the line. See [The Checkbox in the File Wins](/user-guide/tasks/capturing#the-checkbox-in-the-file-wins).

## Both syntaxes are read

The plugin can write its fields two ways, and Memry reads both:

```markdown
- [ ] Buy milk 📅 2026-09-01 ⏫ #errand
- [ ] Pay rent [due:: 2026-09-15] [priority:: high]
```

A vault half way through a migration can mix the two on a single line. Memry reads that line too, rather than guessing a format per note.

## What maps where

| Obsidian Tasks field | Symbol                   | Memry home                                                                          |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| Description          |                          | Task title. Tags stay inline where you wrote them.                                  |
| Priority             | `🔺` `⏫` `🔼` `🔽` `⏬` | Urgent, High, Medium, Low, Low                                                      |
| Due date             | `📅` `📆` `🗓`            | Due date                                                                            |
| Start date           | `🛫`                     | Start date                                                                          |
| Scheduled date       | `⏳` `⌛`                | Start date, when the line carries no start date. Otherwise kept in the description. |
| Done date            | `✅`                     | Completion time                                                                     |
| Cancelled date       | `❌`                     | Kept in the description                                                             |
| Created date         | `➕`                     | Kept in the description                                                             |
| Recurrence           | `🔁`                     | Repeat, for the rules Memry can express. Otherwise kept in the description.         |
| On completion        | `🏁`                     | Kept in the description                                                             |
| Tags                 | `#tag`                   | Task tags, original casing preserved                                                |
| Id                   | `🆔`                     | Line left alone                                                                     |
| Depends on           | `⛔`                     | Line left alone                                                                     |
| Block link           | `^blockid`               | Line left alone                                                                     |

## The original line is always kept

Every task imported this way stores the line it came from on its description, verbatim, whether or not Memry had a home for each field.

Importing rewrites the line in your vault: the plugin's fields come off it and Memry's suffix goes on. Mapping `📅 2026-09-01` into a due date still loses your symbol choice, your field order and your spacing, and a record only of the fields Memry happened to find useful is not a record. Keeping the whole line means you can always read back exactly what you wrote, or copy it straight into Obsidian to undo the import by hand.

**Kept in the description** in the table above therefore means the value lives only there. Memry has no field for a cancelled date, a created date or an on-completion action, so the description is the only place that value survives.

## Priority

The plugin has five priority levels and Memry has four. Both `⏬` lowest and `🔽` low import as **Low**. The original line on the description records which of the two it was.

## Repeat rules Memry can express

A `🔁` rule becomes a real Memry repeat when it is one of these:

- `every day`, `every 3 days`
- `every week`, `every 2 weeks`
- `every month`, `every 6 months`
- `every year`, `every 2 years`
- `every weekday`, meaning Monday to Friday
- a day list, such as `every Monday, Wednesday`

A trailing `when done` works on any of them and makes the repeat count from the day you complete the task instead of from its due date.

Any other rule imports the task without a repeat and keeps its text on the description. A rule Memry only half understood would fire on the wrong days, which is worse than no repeat at all.

## What Memry leaves alone

Three constructs stop the conversion. The line stays an ordinary checkbox and its bytes on disk do not change.

| Construct  | Symbol      |
| ---------- | ----------- |
| Task id    | `🆔 dcf64c` |
| Depends on | `⛔ dcf64c` |
| Block link | `^dcf64c`   |

Every one of the plugin's field regexes is anchored to the end of the line, and so is its block-link regex. Memry's `{task:<id>}` suffix has to go at the end of the line, so appending it would un-anchor all of them and the plugin would stop seeing its own fields.

`🆔` and `⛔` are worse than that. The two form a dependency graph spanning files Memry has not read, so rewriting one line could silently break a link in a note nobody has opened.

If you want one of these lines as a Memry task, delete the `🆔`, `⛔` or `^blockid` from the line in Obsidian first, once you are sure nothing else points at it. Reopen the note in Memry and the line converts like any other.

## Custom status characters

`- [/]`, `- [-]` and any other character between the brackets are left exactly as they are.

Standard markdown recognizes only `[ ]`, `[x]` and `[X]` as checkboxes, and those two are all Memry can write back. Converting an in-progress or a cancelled line would flatten your status character to one of them the next time the note saved. This is a deliberate decline rather than an oversight, and it matches how Memry already treats those markers in its own notes.

## Known limitations

- **The plugin's global filter is not read.** The Obsidian Tasks plugin can be configured so that only lines carrying a given tag, commonly `#task`, count as tasks. Memry does not read the plugin's settings, so it treats every checkbox line as a candidate. That is what Memry already did before it understood these fields. The filter tag itself survives as an ordinary Memry tag, so you can still filter on it.
- **Nothing imports twice.** Once a line carries `{task:<id>}` it is a Memry task, not a candidate. Reopening the note converts nothing further.
- **A plain checkbox behaves as it always has.** `- [ ] Buy milk` with no plugin fields on it takes the path it took before Memry understood this syntax. Nothing about it changed.
- **The plugin's own edits after an import are absorbed, not duplicated.** Complete an imported task back in Obsidian and the plugin appends its done date after Memry's suffix. Memry still recognises the line as the same task and marks it complete, but it drops that trailing `✅` on the next save, because the completion now lives on the Memry task.

## See Also

- [Capturing Tasks](/user-guide/tasks/capturing)
- [Subtasks & Recurrence](/user-guide/tasks/subtasks-recurrence)
- [Creating & Editing Notes](/user-guide/notes/editing)
- [Importing Notes](/user-guide/import)
