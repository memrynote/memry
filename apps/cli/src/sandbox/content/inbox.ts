import type { AssetName } from '../context.ts'

export interface InboxSpec {
  key: string
  kind: 'text' | 'link' | 'file'
  title?: string
  content?: string
  url?: string
  asset?: AssetName
  tags?: string[]
  /** Days ago it was captured; older than 7 shows as stale. */
  age: number
  viewed?: boolean
  /** Snooze until this many days from now, 09:00. */
  snooze?: number
  archived?: boolean
  /** Filing outcome: a new note, a task, or a link appended to an existing note. */
  filed?: { action: 'note' } | { action: 'task' } | { action: 'linked'; note: string }
}

export const inboxSpecs: InboxSpec[] = [
  {
    key: 'streaks',
    kind: 'text',
    title: 'Reading streaks without guilt?',
    content:
      'What if Aurora showed the days you read, but never the days you did not? A calendar with only good news.',
    tags: ['idea', 'aurora'],
    age: 1,
    viewed: true
  },
  {
    key: 'kranz',
    kind: 'text',
    title: 'Gene Kranz quote',
    content:
      '"Failure is not an option" was written for the film. Find what he actually said in the room.',
    tags: ['essay'],
    age: 3
  },
  { key: 'film', kind: 'text', content: 'Pick up the film from the lab before Saturday', age: 0 },
  {
    key: 'risograph',
    kind: 'text',
    title: 'Risograph zine for the essay?',
    content: 'Print the essay as a small risograph zine for the studio show and tell. Ask Sam.',
    tags: ['idea', 'essay'],
    age: 4,
    snooze: 7
  },
  {
    key: 'winter-reading',
    kind: 'text',
    title: 'Plan the winter reading list',
    content: 'Three novels, one long history, nothing about productivity.',
    tags: ['book'],
    age: 2,
    snooze: 1
  },
  {
    key: 'highlight-conflicts',
    kind: 'text',
    title: 'Ask Theo how highlight conflicts resolve',
    content:
      'Same passage highlighted on two offline devices with different notes. Which note wins, or do both stay?',
    tags: ['aurora'],
    age: 5,
    viewed: true,
    filed: { action: 'task' }
  },
  {
    key: 'margins',
    kind: 'text',
    title: 'Margin notes on the listings',
    content:
      "Hamilton's team wrote review comments directly on the printouts. Find a scan of an annotated page.",
    tags: ['essay'],
    age: 9,
    viewed: true,
    filed: { action: 'note' }
  },
  {
    key: 'pads',
    kind: 'text',
    title: 'Read-up pads',
    content:
      'Flight plan changes were read up in a fixed order so the crew could copy without questions. Same idea as a form.',
    tags: ['essay'],
    age: 6,
    viewed: true,
    filed: { action: 'linked', note: 'r-hub' }
  },
  {
    key: 'talk',
    kind: 'text',
    title: 'Conference talk on calm software',
    content: 'Dropped: no time before launch.',
    tags: ['idea'],
    age: 26,
    viewed: true,
    archived: true
  },
  {
    key: 'agc',
    kind: 'link',
    url: 'https://en.wikipedia.org/wiki/Apollo_Guidance_Computer',
    tags: ['essay'],
    age: 12
  },
  {
    key: 'alsj',
    kind: 'link',
    title: 'Apollo Lunar Surface Journal',
    url: 'https://www.hq.nasa.gov/alsj/',
    tags: ['essay'],
    age: 18,
    viewed: true
  },
  {
    key: 'zettelkasten',
    kind: 'link',
    url: 'https://en.wikipedia.org/wiki/Zettelkasten',
    tags: ['book'],
    age: 9
  },
  {
    key: 'line-length',
    kind: 'link',
    title: 'Line length, from Practical Typography',
    url: 'https://practicaltypography.com/line-length.html',
    tags: ['design', 'aurora'],
    age: 2
  },
  {
    key: 'teton-park',
    kind: 'link',
    title: 'Grand Teton National Park, NPS',
    url: 'https://www.nps.gov/grte/index.htm',
    tags: ['travel'],
    age: 4
  },
  {
    key: 'romanesco-wiki',
    kind: 'link',
    url: 'https://en.wikipedia.org/wiki/Romanesco_broccoli',
    tags: ['recipe'],
    age: 30,
    viewed: true,
    archived: true
  },
  {
    key: 'label',
    kind: 'file',
    asset: 'ocr-fda-nutrition-facts.png',
    title: 'Granola label from the shop',
    tags: ['recipe'],
    age: 8
  },
  {
    key: 'strunk-page',
    kind: 'file',
    asset: 'ocr-strunk-elements-of-style-p24.jpg',
    title: 'Strunk, rule 13',
    tags: ['writing'],
    age: 1
  },
  {
    key: 'apollo1-scan',
    kind: 'file',
    asset: 'scan-apollo1-memo-1967.pdf',
    title: 'Apollo 1 memo scan from the archive',
    tags: ['essay'],
    age: 11,
    viewed: true
  },
  {
    key: 'earthrise',
    kind: 'file',
    asset: 'photo-earthrise.jpg',
    title: 'Earthrise, full resolution',
    tags: ['essay'],
    age: 0
  }
]
