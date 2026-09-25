/**
 * Inputs for the `journal.json` class (spec 005-journal JP011). Outputs are
 * never written here: `journal.ts` records them from the real functions.
 */

export const PREVIEW_CASES: ReadonlyArray<{ name: string; content: string; maxLength?: number }> = [
  { name: 'empty', content: '' },
  { name: 'plain', content: 'Walked to the lake this morning.' },
  { name: 'heading levels', content: '# Title\n## Sub\n###### Deep\nbody text' },
  { name: 'hash without space stays', content: '#tag and #another' },
  { name: 'markdown link', content: 'Read [the post](https://example.com/a) today' },
  { name: 'image dropped', content: 'Look ![a cat](cat.png) here' },
  {
    name: 'image after link pass',
    content: '![alt](x.png) and [label](y) and ![](z.png)'
  },
  { name: 'wiki plain', content: 'see [[Sprint Notes]] today' },
  { name: 'wiki alias', content: 'see [[Sprint Notes|retro]] today' },
  { name: 'wiki heading', content: 'see [[Sprint Notes#Retro]] today' },
  { name: 'wiki heading alias', content: 'see [[Sprint Notes#Retro|the retro]] today' },
  { name: 'wiki self heading', content: 'jump to [[#Plans]] now' },
  { name: 'wiki nested heading', content: 'see [[Note#H1#H2]] now' },
  { name: 'wiki block ref', content: 'see [[Note#^abc123]] now' },
  { name: 'wiki blank alias', content: 'see [[Note|  ]] now' },
  { name: 'wiki date', content: 'yesterday was [[2099-06-14]]' },
  { name: 'bold', content: 'a **bold** word' },
  { name: 'italic', content: 'an *italic* and _under_ word' },
  { name: 'bold italic', content: 'very ***strong*** and ___both___' },
  { name: 'unbalanced emphasis', content: 'a **half open and *mixed_ end' },
  { name: 'whitespace collapse', content: '  line one\n\n\tline   two \r\n three  ' },
  { name: 'list and quote markers kept', content: '- item one\n- [ ] task\n> quoted' },
  { name: 'non-ascii', content: 'Günaydın — çok güzel bir gün 🌅 İstanbul' },
  {
    name: 'truncate at word boundary',
    content:
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'
  },
  {
    name: 'truncate hard when last space early',
    content: 'Short ' + 'x'.repeat(150)
  },
  { name: 'exactly max length', content: 'a'.repeat(100) },
  { name: 'one over max length', content: 'a'.repeat(101) },
  { name: 'space at 70 percent', content: 'a'.repeat(70) + ' ' + 'b'.repeat(40) },
  { name: 'space at 71', content: 'a'.repeat(71) + ' ' + 'b'.repeat(40) },
  {
    name: 'custom max 50',
    content: 'The quick brown fox jumps over the lazy dog again and again',
    maxLength: 50
  },
  { name: 'custom max 10 no space', content: 'abcdefghijklmnop', maxLength: 10 },
  { name: 'emoji utf16 truncation', content: '😀'.repeat(60) },
  { name: 'only markup', content: '# \n![](a.png)\n' }
]

export const WORD_TEXTS: ReadonlyArray<string> = [
  '',
  '   ',
  'one',
  'one two',
  '  leading and trailing  ',
  'tabs\tand\nnewlines\r\nmixed',
  'hyphen-ated words count once',
  'Günaydın dünya',
  '😀 🌅',
  'a'.repeat(100),
  'a'.repeat(101),
  '😀'.repeat(50),
  '😀'.repeat(51)
]

export const ACTIVITY_COUNTS: ReadonlyArray<number> = [
  0, 1, 2, 99, 100, 101, 250, 499, 500, 501, 999, 1000, 1001, 5000
]

export const STREAK_CASES: ReadonlyArray<{ name: string; dates: string[]; today: string }> = [
  { name: 'empty', dates: [], today: '2099-06-15' },
  { name: 'today only', dates: ['2099-06-15'], today: '2099-06-15' },
  { name: 'yesterday only', dates: ['2099-06-14'], today: '2099-06-15' },
  { name: 'two days ago only', dates: ['2099-06-13'], today: '2099-06-15' },
  {
    name: 'run ending today',
    dates: ['2099-06-11', '2099-06-12', '2099-06-13', '2099-06-14', '2099-06-15'],
    today: '2099-06-15'
  },
  {
    name: 'run ending yesterday',
    dates: ['2099-06-12', '2099-06-13', '2099-06-14'],
    today: '2099-06-15'
  },
  {
    name: 'gap breaks current',
    dates: ['2099-06-10', '2099-06-11', '2099-06-13', '2099-06-15'],
    today: '2099-06-15'
  },
  {
    name: 'longest across year end',
    dates: ['2098-12-29', '2098-12-30', '2098-12-31', '2099-01-01', '2099-01-02', '2099-06-15'],
    today: '2099-06-15'
  },
  {
    name: 'leap day in run',
    dates: ['2096-02-27', '2096-02-28', '2096-02-29', '2096-03-01'],
    today: '2096-03-01'
  },
  {
    name: 'no leap day',
    dates: ['2097-02-27', '2097-02-28', '2097-03-01'],
    today: '2097-03-02'
  },
  {
    name: 'future entries ignored by current, counted by longest',
    dates: ['2099-06-15', '2099-06-16', '2099-06-17', '2099-06-18'],
    today: '2099-06-15'
  },
  {
    name: 'duplicates and unsorted',
    dates: ['2099-06-14', '2099-06-12', '2099-06-14', '2099-06-13'],
    today: '2099-06-15'
  },
  { name: 'month boundary', dates: ['2099-05-31', '2099-06-01'], today: '2099-06-01' }
]

export const MONTH_DAY_CASES: ReadonlyArray<{ year: number; month: number; today: string }> = [
  { year: 2099, month: 5, today: '2099-06-15' },
  { year: 2099, month: 1, today: '2099-06-15' },
  { year: 2096, month: 1, today: '2096-02-29' },
  { year: 2100, month: 1, today: '2099-06-15' },
  { year: 2000, month: 1, today: '1999-12-31' },
  { year: 2099, month: 11, today: '2099-12-31' },
  { year: 2099, month: 6, today: '2099-06-30' },
  { year: 2098, month: 3, today: '2099-06-15' }
]

/** Heatmaps: `[date, characterCount]` pairs; the level is computed. */
export const MONTH_ACTIVITY_CASES: ReadonlyArray<{
  name: string
  year: number
  days: Array<[string, number]>
}> = [
  { name: 'empty year', year: 2099, days: [] },
  {
    name: 'mixed june',
    year: 2099,
    days: [
      ['2099-06-01', 50],
      ['2099-06-03', 600],
      ['2099-06-08', 0],
      ['2099-06-15', 1500],
      ['2099-06-29', 101],
      ['2099-06-30', 1000]
    ]
  },
  {
    name: 'every month once',
    year: 2099,
    days: Array.from({ length: 12 }, (_, m): [string, number] => [
      `2099-${String(m + 1).padStart(2, '0')}-${String((m % 28) + 1).padStart(2, '0')}`,
      m * 150
    ])
  },
  {
    name: 'fifth block and the 31st',
    year: 2099,
    days: [
      ['2099-01-29', 20],
      ['2099-01-31', 900],
      ['2099-02-28', 400]
    ]
  },
  { name: 'other year ignored', year: 2099, days: [['2098-06-01', 700]] }
]

/** Index rows: `[date, wordCount, characterCount]`. */
export const YEAR_STATS_CASES: ReadonlyArray<{
  name: string
  rows: Array<[string, number | null, number | null]>
}> = [
  { name: 'empty', rows: [] },
  {
    name: 'three months',
    rows: [
      ['2099-01-02', 10, 50],
      ['2099-01-03', 200, 1200],
      ['2099-03-04', 0, 0],
      ['2099-06-15', 90, 480],
      ['2099-06-16', 5, 30],
      ['2099-06-17', 150, 900]
    ]
  },
  {
    name: 'averages that round',
    rows: [
      ['2099-02-01', 1, 1],
      ['2099-02-02', 1, 101],
      ['2099-02-03', 1, 2000]
    ]
  },
  {
    name: 'unsorted months',
    rows: [
      ['2099-12-01', 3, 20],
      ['2099-02-01', 4, 600]
    ]
  }
]
