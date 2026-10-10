import type { NoteSpec } from '../../specs.ts'
import { lesson } from './lesson.ts'

export const textNotes: NoteSpec[] = [
  lesson(
    'n-text',
    '01 Text and formatting',
    '🔤',
    'Beginner',
    'Bold, italic, colors, headings, alignment, comments, dates and link previews',
    (b) => `Text is the base layer. Everything on this page is live: click into it and change it.

## Marks on a selection

Select text and a toolbar appears. The same marks work from the keyboard and from Markdown shortcuts typed as you write:

- **Bold**: Cmd+B, or wrap text in two asterisks
- *Italic*: Cmd+I, or one asterisk
- <span style="text-decoration:underline">Underline</span>: Cmd+U
- ~~Strikethrough~~: Cmd+Shift+S, or two tildes
- \`Inline code\`: Cmd+E, or a backtick on each side
- A [web link](https://docs.memrynote.com): select text and use the toolbar's link button

On Windows and Linux use Ctrl where this guide says Cmd.

## Color

The toolbar's color menu sets the text color and the highlight: <span style="color:red">red text</span>, <span style="background-color:yellow">highlighted</span>, <span style="color:blue;background-color:gray">both at once</span>, and marks combine, as in <span style="color:purple">**bold purple**</span>. Colors are stored as small style tags, so other Markdown apps show the plain text.

## Headings

Type \`#\` and a space for a heading, up to six hashes. The section titles on this page are Heading 2. The rest, for reference:

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

Headings feed the outline, the mind map and heading links like \`[[Note#Heading]]\`.

## Alignment and block color

Open a block's menu (hover it and click the six dots) to change alignment or color of the whole block:

<!-- align:center -->
A centered paragraph

<!-- align:right -->
## A right-aligned heading

<!-- colors:{"textColor":"blue","backgroundColor":"yellow"} -->
Blue text on a yellow block

<!-- colors:{"textColor":"red"} -->
<!-- align:center -->
Red and centered

Alignment and colors are stored on the line above the block as a comment, which other apps ignore.

## Hidden text

Anything inside an HTML comment stays in the file and out of sight: <!-- like this one -->. Obsidian-style percent comments work too: %% this one %%. Use them for notes to yourself that should never be read aloud.

<!-- a comment on its own line -->

## Dates

Type \`@\` followed by a date phrase such as "friday" to insert a date. It is a live chip: the day is ${b.date(2, { time: '14:00' })}, and this one has a reminder the day before: ${b.date(14, { remind: '1d', format: 'full' })}. Click a date to change it, its format or its reminder. Dates also show on the calendar's day panel.

## Link previews

Paste a URL and Memry offers four ways to keep it: plain **URL**, an inline **Mention** chip, an **Embed** for a video it recognizes, or a **Bookmark** card. A mention is a small titled chip, like ${b.mention('https://en.wikipedia.org/wiki/Apollo_Guidance_Computer')}. Only the URL is stored in the file.

## Comments

Select text and press **Comment** in the toolbar to leave a note to yourself or a reviewer. The comment appears beside the marked text in the right rail, and can be resolved or deleted.

## Dividers

Type three dashes on an empty line (or use the slash menu's **Divider**) for a horizontal rule. On disk it is written as three asterisks, so it never gets mistaken for frontmatter:

***

Next: [[02 Lists, checklists and tasks]].
`
  ),

  lesson(
    'n-lists',
    '02 Lists, checklists and tasks',
    '📋',
    'Beginner',
    'Bullets, numbers, checklists, and checkboxes that are real tasks',
    (b) => `Three kinds of lists, and one kind of line that is a task.

## Bullets and numbers

**Insert:** type \`- \` or \`* \` for bullets, \`1. \` for a numbered list, or pick them from the slash menu. **Tab** indents an item, **Shift+Tab** outdents it.

- Bullets
  - can nest
    - as deep as you like
- Back to the top

Numbers renumber themselves:

1. First
2. Second
   1. A nested step
3. Third

A numbered list can start anywhere, by typing the number you want first:

5. Starts at five
6. Six

A bullet can hold more than one block. Press Tab on the line under it to nest a paragraph:

- A bullet with a paragraph inside it

<!-- memry:block-nesting-level=1 -->

Nested blocks are indented with Tab, and they travel with their parent when you drag it.

<!-- memry:block-nesting-level=0 -->

## Checklists

**Insert:** type \`[] \` or \`[ ] \`, or use the slash menu's **Check list**. Click the box to tick it.

A plain checklist is just a list with boxes. It never shows up on the Tasks page, which makes it right for packing lists and groceries:

- [ ] Pack the headlamp {check}
- [x] Book the cabin {check}

## Tasks in a note

A checkbox can also be a real task. In the slash menu, press **Cmd+Enter** on **Check list** to insert a linked task. A linked task has a title, a due date and priority, and it lives in a project. The note only shows it:

${b.task('g-try')}
  ${b.task('g-try-sub')}

${b.task('g-read')}

Tick the first line here and it is done on the Tasks page too, and the other way around. Subtasks nest under their task. Open the task from the note to set a due date, a project or a priority.

Use a plain checklist when the items are only for this note. Use tasks when you want to see them in Today, the board or the calendar. The full tour is in [[Tasks and projects]].

## Where lists go next

- A task line in a meeting note becomes an action item: see ${b.link('weekly-1')}
- The [[Grocery list]] is a plain checklist

Next: [[03 Callouts, quotes, toggles and columns]].
`
  ),

  lesson(
    'n-containers',
    '03 Callouts, quotes, toggles and columns',
    '🧱',
    'Beginner',
    'Blocks that hold other blocks: quotes, callouts, toggles and columns',
    () => `Some blocks hold other blocks. They give a page structure without making it long.

## Quotes

**Insert:** \`> \` and a space, or the slash menu. A quote can hold more than one paragraph and can nest.

> A quote
> over two lines

> A quote with more than one paragraph
>
> Second paragraph
>
> > And a quote inside it

## Callouts

**Insert:** slash menu, **Callout**, then pick a type from the block's menu. Callouts are for the one thing the reader must not miss.

> [!info]
> An info callout with **bold** text

> [!warning]
> A warning callout

> [!error]
> An error callout

> [!success]
> A success callout

A callout can have a block color too (block menu, **Color**):

<!-- colors:{"textColor":"red"} -->
> [!warning]
> A red warning

## Toggles

**Insert:** slash menu, **Toggle list** (or Toggle heading 1 to 3 for a section). Click the arrow to open it. A toggle can hold anything, including other toggles.

<details data-memry-toggle>
<summary>A collapsed toggle</summary>

Hidden until you open it

- with a list

</details>

<details data-memry-toggle open>
<summary>An open toggle</summary>

Visible body

<details data-memry-toggle>
<summary>A toggle inside a toggle</summary>

Deeper

</details>

</details>

<!-- colors:{"backgroundColor":"blue"} -->
<details data-memry-toggle>
<summary>A blue toggle</summary>

Body

</details>

## Columns

**Insert:** slash menu, **Two columns** up to **Five columns**. Drag a block into a column, drag the divider to resize. Columns are a good fit for before and after, or a short list beside a long one.

--- start-multi-column: n101-cols
\`\`\`column-settings
Number of Columns: 3
Column Size: [25%, 50%, 25%]
\`\`\`

### Left

- a
- b

--- end-column ---

The middle column is wider.

<details data-memry-toggle>
<summary>A toggle in a column</summary>

Body

</details>

--- end-column ---

> [!info]
> A callout on the right

--- end-multi-column

Next: [[04 Code, math and diagrams]].
`
  )
]
