// An Apple Journal HTML export, one file per entry in the shape the shipped importer reads
// (.pageHeader date, .p2/.p3 paragraphs, .reflectionPrompt). Six entries over the last three
// years, dated from today. Written to vault/assets/apple-journal-import-export/ on every seed.
import * as fs from 'node:fs'
import * as path from 'node:path'

const OFFSETS = [-1050, -820, -610, -400, -210, -45]
const ENTRIES = [
  [
    'First week in the new studio. Boxes everywhere.',
    'Hung the big print above the desk. It finally feels like mine.',
    'What are you grateful for today?'
  ],
  ['Train to Porto with Lea.', 'Two hours of window and a notebook full of sketches.', null],
  [
    'Finished the brand workshop. Tired, in a good way.',
    'Everyone left with a clearer idea of what Studio North is.',
    'What did you learn today?'
  ],
  [
    'Slow Sunday. Bread, coffee, no screens.',
    'Read three chapters and went for a long walk by the river.',
    null
  ],
  [
    'The portfolio is live.',
    'Sam sent a screenshot from his phone. It looks better than I hoped.',
    'What are you proud of today?'
  ],
  ['Rain all day, so I stayed in and drew.', 'Started a new series of little street scenes.', null]
]

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function () {
  const dir = path.resolve(import.meta.dirname, '../../vault/assets/apple-journal-import-export')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  OFFSETS.forEach((offset, i) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    const header = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const [a, b, prompt] = ENTRIES[i]
    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Apple Journal Entry</title></head>
  <body>
    <header class="pageHeader">${header}</header>
    <p class="p2">${a}</p>
    <p class="p3">${b}</p>
${prompt ? `    <div class="reflectionPrompt">${prompt}</div>\n` : ''}  </body>
</html>
`
    fs.writeFileSync(path.join(dir, `${stamp}.html`), html)
  })
}
