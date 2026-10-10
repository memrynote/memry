import { table } from '../../body.ts'
import type { NoteSpec } from '../../specs.ts'
import { lesson } from './lesson.ts'

const palette = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Aurora palette</title>
<style>
body { font: 15px/1.5 Georgia, serif; margin: 24px; background: #faf7f2; color: #2b2723; }
.row { display: flex; gap: 12px; }
.swatch { width: 96px; height: 64px; border-radius: 8px; padding: 6px; font: 12px system-ui; }
</style></head>
<body>
<h3>Aurora palette</h3>
<div class="row">
<div class="swatch" style="background:#121110;color:#e9e2d6">Night bg</div>
<div class="swatch" style="background:#e9e2d6">Night text</div>
<div class="swatch" style="background:#f2c46d">Highlight</div>
<div class="swatch" style="background:#faf7f2;border:1px solid #ddd">Day bg</div>
</div>
</body>
</html>
`

const speeds = `Reading speed samples from the Aurora beta (words per minute)
reader,day theme,night theme
r01,231,244
r02,198,215
r03,264,259
r04,212,240
`

export const blockNotes: NoteSpec[] = [
  lesson(
    'n-code',
    '04 Code, math and diagrams',
    '🧮',
    'Intermediate',
    'Code blocks, equations, Mermaid diagrams and live views of your notes',
    () => `Blocks for technical writing, and for letting a note show other notes.

## Code

**Insert:** type three backticks, or **/code**. A small toolbar in the block's corner picks the language (50 of them) and copies the code. Highlighting follows your theme.

\`\`\`ts
const measure: number = 66
  console.log(\`line length: \${measure} characters\`)
\`\`\`

\`\`\`python
print("one small step")
\`\`\`

\`\`\`text
plain text, no highlighting
\`\`\`

Inline code, for a word or two, is Cmd+E on a selection.

## Equations

**Insert:** slash menu, **Equation**. The block takes LaTeX and draws it. Click it to edit the source.

$$
t_{\\text{read}} = \\frac{\\text{words}}{238} \\text{ min}
$$

## Diagrams

**Insert:** **/mermaid** (also **/diagram**, **/flowchart**). The block draws a Mermaid diagram from a few lines of text. Click it to edit the source; the picture redraws as you type. It is stored as an ordinary Mermaid code fence, so GitHub and Obsidian draw it too.

\`\`\`mermaid
graph TD
    A[Capture] --> B{Worth keeping?}
    B -->|yes| C[Note]
    B -->|no| D[Archive]
\`\`\`

## Live views

**Insert:** **/view**. A view is a live list of notes from the whole vault, a folder or a tag, as a list, table or gallery. It updates as notes change. This one shows every note tagged space-race:

\`\`\`memry-view
{
  "source": {
    "kind": "tag",
    "tag": "space-race"
  },
  "layout": "table"
}
\`\`\`

## Charts

**Insert:** **/chart**. A chart plots one property over time. This one plots the sleep property from the journal over the last 90 days:

\`\`\`memry-view
{
  "source": {
    "kind": "journal"
  },
  "layout": "chart",
  "chart": {
    "property": "sleep",
    "rangeDays": 90
  }
}
\`\`\`

Views and charts are fenced text, so older versions and other apps show them as plain code. Nothing is lost.

Next: [[05 Tables]].
`
  ),

  lesson(
    'n-tables',
    '05 Tables',
    '🔢',
    'Intermediate',
    'Insert, resize and color tables; checkboxes, images and links inside cells',
    (b) => `Tables are plain Markdown tables. Anything else that reads Markdown can read them.

## Insert and edit

**Insert:** **/table** opens a size grid; pick the size with the mouse or the arrow keys. The first row is always the header. Move between cells with **Tab** and **Shift+Tab**. Hover a table to see the handles on its borders: the top edge opens a column menu, the left edge a row menu, and the right border of a cell a cell menu. With the cursor in a cell, **Cmd+Shift+Enter** opens a menu of row and column actions from the keyboard.

${table([
  ['Mission', 'Crew'],
  ['Apollo 8', '3'],
  ['Apollo 11', '3']
])}

## Color and width

The cell menu's **Colors** sets text and background for one cell, and dragging a column border sets its width. Both are stored as comment lines above the table, which other editors ignore:

<!-- table-colors:{"0:0":{"textColor":"red"},"1:1":{"backgroundColor":"green"}} -->
<!-- table-layout:{"columnWidths":[180,null]} -->
${table([
  ['Theme', 'Contrast'],
  ['Night', '12.4:1'],
  ['Day', '14.1:1']
])}

## What a cell can hold

A cell holds one line of inline content: bold, links, wiki links, mentions, tags, even a picture or a checkbox. Type \`[ ]\` at the start of a cell for a checkbox (it is a checkbox, not a task). **/image** inside a cell puts a picture there.

${table([
  ['Item', 'Preview', 'Link'],
  ['[x] done', `![pillars.jpg\\|120](${b.ref('photo-pillars-of-creation.jpg')})`, '[[Credits]]'],
  ['[ ] todo', b.mention('https://en.wikipedia.org/wiki/Pillars_of_Creation'), '#notes-101']
])}

Paste into a cell and you get text, never a second table. Copying a range of cells and pasting it elsewhere keeps their shape, like a spreadsheet.

Next: [[06 Images, files and media]].
`,
    { assets: ['photo-pillars-of-creation.jpg'] }
  ),

  lesson(
    'n-media',
    '06 Images, files and media',
    '🖼️',
    'Intermediate',
    'Images, PDFs, audio, video, HTML, embeds, bookmarks and whiteboards',
    (b) => `Anything you can drop into a note, and how each kind shows up.

## Adding files

Drag a file from your computer onto the spot in the note where it should land, or use **/image**, **/media**, **/pdf**, **/html** or **/file**. All of them open one picker: upload a new file, or pick a file the vault already has and embed it by reference, with no second copy. Files are copied into the vault's attachments folder.

## Images

An image on its own line is a block. Hover it or click to select it, then drag a corner to set its width. Alignment and a caption are optional.

${b.image('photo-pillars-of-creation.jpg')}

${b.image('photo-pillars-of-creation.jpg', { width: 320 })}

<!-- align:center -->
${b.image('photo-pillars-of-creation.jpg', { width: 320 })}

${b.image('photo-pillars-of-creation.jpg', { width: 320, caption: 'Pillars of Creation. NASA, ESA, and the Hubble Heritage Team' })}

A web image works the same, by link:

![Earthrise on Wikimedia Commons](https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/NASA_Earthrise_AS08-14-2383_Apollo_8_1968-12-24.jpg/960px-NASA_Earthrise_AS08-14-2383_Apollo_8_1968-12-24.jpg)

## PDFs

A PDF shows inline, with page controls. Drag a bottom corner to resize it, and use the toolbar to align it. Its text is searchable, and a scanned PDF with no text goes through OCR (more in [[Search, OCR and AI]]).

${b.file('paper-note-taking-gestures.pdf')}

${b.file('paper-note-taking-gestures.pdf', { width: 720, height: 480, align: 'center' })}

## Video and audio

Video and audio play in place:

${b.file('video-apollo11-launch-commentary.webm')}

${b.file('audio-armstrong-small-step.ogg')}

## HTML files

An HTML file runs in a sandbox inside the note, which is handy for small widgets and mockups:

${b.file('aurora-palette.html')}

## Any other file

Everything else is a card you can open or reveal:

${b.file('reading-speeds.txt')}

## Other forms

Media can also be written as plain HTML, which other tools understand. A video or audio file with a caption:

${b.video('video-apollo11-launch-commentary.webm', 'Apollo 11 launch commentary')}

${b.audio('audio-armstrong-small-step.ogg')}

## Embeds and bookmarks

Paste a video link and choose **Embed** to play it in the note. Choose **Bookmark** for a card with the page's title and image:

![embed](https://www.youtube.com/watch?v=S9HdPi9Ikhk)

![bookmark](https://en.wikipedia.org/wiki/Apollo_Guidance_Computer)

## Whiteboards

**Insert:** **/whiteboard**. A whiteboard is a canvas shown inside the note: read-only until you press **Edit**, then the full drawing tools. This one is the Aurora launch map, an existing canvas. To show a canvas you already have, type \`@\` and pick it, then choose **Embed**:

${b.canvas('aurora-map')}

Credits for every photo, scan and recording are in [[Credits]].

Next: [[07 Links, mentions and backlinks]].
`,
    {
      assets: [
        'photo-pillars-of-creation.jpg',
        'paper-note-taking-gestures.pdf',
        'video-apollo11-launch-commentary.webm',
        'audio-armstrong-small-step.ogg'
      ],
      generated: [
        { name: 'aurora-palette.html', mimeType: 'text/html', content: palette },
        { name: 'reading-speeds.txt', mimeType: 'text/plain', content: speeds }
      ]
    }
  )
]
