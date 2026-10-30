// Regenerates the journal vectors from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-journal-vectors.mjs
// Writes journal-format.json next to this file.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The sources are CommonJS under tsx, so named imports are read off the namespace.
const load = async (path) => {
  const ns = await import(path)
  return ns.default ?? ns
}
const format = await load('../../../../packages/storage-vault/src/journal-format.ts')
const migration = await load('../../../../apps/desktop/src/main/vault/journal-format-migration.ts')
const {
  formatJournalFilename,
  parseJournalDate,
  normalizeJournalDateFormat,
  normalizeJournalFolder
} = format
const { isCompleteJournalFormat, planJournalRenames } = migration

const formats = [
  '',
  'YYYY-MM-DD',
  'YYYY-MM-DD dddd',
  'DD.MM.YY',
  'dddd, D-M-YYYY',
  'YYYY/MMMM/YYYY-MM-DD',
  'YYYY/MM/DD',
  'MMM D, YYYY',
  'ddd YYYY-MM-DD',
  'YY-M-D',
  'YYYYMD',
  'D MMMM YYYY',
  'YYYY.MM.DD (ddd)',
  '[YYYY] MMMMM DDD',
  'Y-M-D',
  'YYYYY',
  'Week of YYYY-MM-DD',
  'YYYY-MM-DD 日記',
  'YYYY-MM',
  'MM-DD',
  'YYYY dddd',
  'notes'
]
const dates = [
  '2026-09-25',
  '2025-01-14',
  '2026-11-28',
  '2031-12-31',
  '2000-02-29',
  '2024-02-29',
  '1999-12-31',
  '2025-05-05',
  '2025-02-31',
  '2099-07-04',
  '0100-03-01',
  '9999-12-31'
]
const render = formats.flatMap((fmt) =>
  dates.map((date) => {
    const stem = formatJournalFilename(date, fmt)
    return { format: fmt, date, stem, parsed: parseJournalDate(stem, fmt) }
  })
)

const parseCases = [
  ['2025-02-31', 'YYYY-MM-DD'],
  ['2025-13-01', 'YYYY-MM-DD'],
  ['2025-00-10', 'YYYY-MM-DD'],
  ['2025-01-00', 'YYYY-MM-DD'],
  ['2025-01-32', 'YYYY-MM-DD'],
  ['2025-1-14', 'YYYY-MM-DD'],
  ['2025-01-14 ', 'YYYY-MM-DD'],
  ['２０２５-01-14', 'YYYY-MM-DD'],
  ['2026-09-25 Friday', 'YYYY-MM-DD dddd'],
  ['2026-09-25 Monday', 'YYYY-MM-DD dddd'],
  ['2026-09-25 friday', 'YYYY-MM-DD dddd'],
  ['2025/January/2025-01-14', 'YYYY/MMMM/YYYY-MM-DD'],
  ['2025/February/2025-01-14', 'YYYY/MMMM/YYYY-MM-DD'],
  ['2024/January/2025-01-14', 'YYYY/MMMM/YYYY-MM-DD'],
  ['2025/02/2025-01-14', 'YYYY/MM/YYYY-MM-DD'],
  ['25-6-5', 'YY-M-D'],
  ['99-01-01', 'YY-MM-DD'],
  ['0050-01-01', 'YYYY-MM-DD'],
  ['2025111', 'YYYYMD'],
  ['202511', 'YYYYMD'],
  ['20251231', 'YYYYMD'],
  ['May 5, 2025', 'MMM D, YYYY'],
  ['Sept 5, 2025', 'MMM D, YYYY'],
  ['5 May 2025', 'D MMMM YYYY'],
  ['Mon 2025-01-13', 'ddd YYYY-MM-DD'],
  ['Tue 2025-01-13', 'ddd YYYY-MM-DD'],
  ['2025-01', 'YYYY-MM'],
  ['01-14', 'MM-DD'],
  ['2025 Tuesday', 'YYYY dddd'],
  ['2025 Wednesday', 'YYYY dddd'],
  ['notes', 'notes'],
  ['2025-01-14', ''],
  ['a.b', 'a.b'],
  ['2025-01-14', 'YYYY-MM-DD+'],
  ['2025-01-14+', 'YYYY-MM-DD+'],
  ['2025x01x14', 'YYYY.MM.DD'],
  ['2025.01.14', 'YYYY.MM.DD']
].map(([stem, fmt]) => ({ stem, format: fmt, parsed: parseJournalDate(stem, fmt) }))

const normalizeInputs = [
  'journal',
  '/journal/',
  ' Daily Notes ',
  'a\\b//c',
  './journal/../x',
  '\uFEFFjournal\u00A0',
  '  /  ',
  '',
  'YYYY / MMMM / YYYY-MM-DD dddd',
  '\tYYYY-MM-DD dddd\n',
  'a/./b/../c',
  'x\u0085'
]
const normalize = normalizeInputs.map((input) => ({
  input,
  format: normalizeJournalDateFormat(input),
  folder: normalizeJournalFolder(input)
}))

const complete = formats.map((fmt) => ({ format: fmt, complete: isCompleteJournalFormat(fmt) }))

const DAILY = 'YYYY-MM-DD'
const WEEKDAY = 'YYYY-MM-DD dddd'
const NESTED = 'YYYY/MMMM/YYYY-MM-DD'
const planCases = [
  [['2026-09-25.md', '2026-09-26.md', 'ideas.md', '2026-09-27.txt'], DAILY, WEEKDAY],
  [['2026-09-26.md', '2026-09-26 Saturday.md'], DAILY, WEEKDAY],
  [['2026-09-26.md', '2026-09-26 saturday.md'], DAILY, WEEKDAY],
  [['26-6-5.md', '26-06-05.md'], 'YY-M-D', DAILY],
  [['05-06-2026.md', '06-05-2026.md'], 'DD-MM-YYYY', 'MM-DD-YYYY'],
  [['2025-01-14.md', 'ideas.md', '2025/notes.md'], DAILY, NESTED],
  [['2025/January/2025-01-14.md', '2025/notes.md'], NESTED, DAILY],
  [['2025-01-14.md', '2025-01-15.md'], DAILY, 'YYYY-MM'],
  [['2025-01-14.md'], DAILY, DAILY],
  [['2025-01-14.md'], DAILY, ''],
  [['Jan 14, 2025.md'], 'MMM D, YYYY', 'mmm d, yyyy'],
  [['2025-01-14.MD', '2025-01-15.md'], DAILY, WEEKDAY],
  [['2025-01-14.md', '2025-01-14 Tuesday.MD'], DAILY, WEEKDAY],
  [['14-01-25.md', '2025-01-14.md'], 'DD-MM-YY', DAILY],
  [['2025-01-14.md', '2025-01-14.md.md'], DAILY, WEEKDAY],
  [['2025-01-14.md'], DAILY, 'YYYY-MM-DD/YYYY'],
  [['2025-01-14.md', '2025-01-14/2025.md'], DAILY, 'YYYY-MM-DD/YYYY'],
  [['b/2025-01-14.md', 'a/2025-01-15.md', '2025-01-16.md'], 'YYYY-MM-DD', WEEKDAY],
  [['2025-01-14 Tuesday.md', '2025-01-14.md'], WEEKDAY, DAILY],
  [['ΣΑΣ 2025-01-14.md', 'σας 2025-01-14 Tuesday.md'], 'ΣΑΣ YYYY-MM-DD', 'σας YYYY-MM-DD dddd']
]
const plan = planCases.map(([files, from, to]) => ({
  files,
  from,
  to,
  plan: planJournalRenames(files, from, to)
}))

const here = dirname(fileURLToPath(import.meta.url))
writeFileSync(
  join(here, 'journal-format.json'),
  JSON.stringify({ render, parse: parseCases, normalize, complete, plan }, null, 2) + '\n'
)
