// Maya's journal reaching back over a year and a half, so a split into year and month folders has
// something to fold: a handful of entries in each of the last ~16 months, dated from today, on top
// of the two weeks the base vault already has. Plain journal files, byte for byte what the app
// writes for an entry (the app indexes them when it opens the vault).
import * as fs from 'node:fs'
import * as path from 'node:path'

const LINES = [
  'Long walk by the water after lunch.',
  'Deep work on the homepage grid. Good flow.',
  'Coffee with Sam, then errands.',
  'Rainy day. Stayed in and read.',
  'Portfolio tidy-up. Three projects out.',
  'Drew all afternoon, no screens.',
  'Yoga, then two hours of sketching.',
  'Slow morning. Felt rested.',
  'Client calls most of the day. Wrapped up early.',
  'Cooked for friends. Bed too late.'
]

export default function ({ vault, day }) {
  const dir = path.join(vault, 'journal')
  const have = new Set(fs.readdirSync(dir).map((f) => f.replace(/\.md$/, '')))
  let n = 0
  for (let offset = -480; offset <= -16; offset += 9) {
    const date = day(offset)
    if (have.has(date)) continue
    fs.writeFileSync(path.join(dir, `${date}.md`), `${LINES[n++ % LINES.length]}\n`)
  }
}
