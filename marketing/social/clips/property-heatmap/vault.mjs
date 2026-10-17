// A year of Maya's journal with a `sleep` property (hours), so a chart has twelve months to draw:
// longer nights on weekends and over the holidays, short ones in deadline weeks, and August, the
// month she stopped writing. The days the base vault already has get theirs through the CLI. The
// other ~300 are written as journal files with frontmatter, byte for byte what the app writes for a
// journal entry with properties (see `properties set`), and the app indexes them when it opens the
// vault, like days written in any other editor. A CLI call per day would take ten minutes.
import * as fs from 'node:fs'
import * as path from 'node:path'

// Deterministic, so every take draws the same year.
let s = 20261222
const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648

const LINES = [
  'Client calls most of the day. Wrapped up early.',
  'Deep work on the homepage grid. Good flow.',
  'Yoga, then two hours of sketching.',
  'Rainy day. Stayed in and read.',
  'Invoices and email. Not the most fun day.',
  'Long walk by the water after lunch.',
  'Worked from the café on the corner.',
  'Typeface tests for the case studies.',
  'Late night fixing the mobile nav.',
  'Coffee with Sam, then errands.',
  'Slow morning. Felt rested.',
  'Portfolio tidy-up. Three projects out.',
  'Drew all afternoon, no screens.',
  'Cooked for friends. Bed too late.',
  'Feedback round from Lea. Mostly good.',
  'Gym, groceries, an early night.'
]
const ROUGH = [
  ['11-17', '11-23'],
  ['01-19', '01-25'],
  ['03-09', '03-15'],
  ['05-25', '05-31'],
  ['09-21', '09-27']
]
const GOOD = [
  ['12-22', '01-02'],
  ['04-03', '04-06'],
  ['06-15', '06-21']
]
const inSpan = (md, spans) =>
  spans.some(([a, b]) => (a <= b ? md >= a && md <= b : md >= a || md <= b))
const quarter = (x) => Math.round(x * 4) / 4

function sleepOn(date) {
  const d = new Date(`${date}T12:00:00`)
  const md = date.slice(5)
  const weekend = d.getDay() === 0 || d.getDay() === 6
  const winter = Math.cos(((d.getMonth() + 0.5) / 12) * 2 * Math.PI) // 1 in Jan, -1 in Jul
  let h = 7.05 + 0.25 * winter + (weekend ? 0.65 : 0) + (rand() - 0.5) * 0.9
  if (inSpan(md, ROUGH)) h -= 1.4 + rand() * 0.5
  if (inSpan(md, GOOD)) h += 0.9 + rand() * 0.3
  return Math.min(9.5, Math.max(4.5, quarter(h)))
}

export default function ({ cli, vault, day }) {
  const dir = path.join(vault, 'journal')
  const existing = new Set(fs.readdirSync(dir).map((f) => f.replace(/\.md$/, '')))
  for (let offset = -365; offset <= 0; offset++) {
    const date = day(offset)
    const sleep = sleepOn(date)
    if (existing.has(date)) {
      const entry = cli('journal', 'get', date)
      cli('properties', 'set', entry.id, JSON.stringify({ sleep }))
      continue
    }
    // August: the month she stopped writing. And the odd day off, like anyone's journal.
    if (date.slice(5, 7) === '08' && date.slice(8) >= '03') continue
    if (rand() < 0.07) continue
    const text = LINES[Math.floor(rand() * LINES.length)]
    fs.writeFileSync(path.join(dir, `${date}.md`), `---\nsleep: ${sleep}\n---\n${text}\n`)
  }
  // The note the chart goes into, on camera. Full-width editor, so a year of squares has room.
  cli(
    'notes',
    'create',
    '2026 in numbers',
    '--folder',
    'Ideas',
    '--content',
    'How the year went, straight from the journal.'
  )
  cli('settings', 'set-group', 'editor', JSON.stringify({ width: 'full' }))
}
