import { table } from '../body.ts'
import type { NoteSpec } from '../specs.ts'

const SPACE = 'Research/Space race'

export const researchNotes: NoteSpec[] = [
  {
    key: 'r-hub',
    title: 'Notes in the space race',
    folder: SPACE,
    tags: ['space-race', 'essay'],
    emoji: '🚀',
    created: 62,
    modified: 2,
    body: () => `Hub for the essay research. The question: **how did people keep track of what they knew when the stakes were a crew on the Moon?** The essay itself lives in [[Space race essay draft]].

## Concepts

- [[Checklists as external memory]]
- [[The flight plan as a shared notebook]]
- [[CAPCOM and the spoken log]]
- [[Margaret Hamilton's listings]]
- [[Marginalia]]

## Primary sources

- [[Apollo 1 memo, 1967]], a scanned memo to President Johnson
- [[In Event of Moon Disaster]], the speech nobody had to give
- [[One small step]], the audio
- [[Launch commentary]], Jack King calling the Apollo 11 launch
- [[Earthrise]] and [[The Blue Marble]], the two photographs

## Secondary

- [[Note-taking gestures (paper)]]
- The [[Reading list]] folder, with ratings

## Still missing

- [[Gene Kranz's white vest]] (not written yet; the link stays red until I write it)
- Something on the women who computed trajectories by hand; start with *Hidden Figures* from the reading list
`
  },
  {
    key: 'r-checklists',
    title: 'Checklists as external memory',
    folder: SPACE,
    tags: ['space-race', 'concept'],
    created: 55,
    modified: 11,
    body: () => `Apollo crews flew with cuff checklists: small spiral-bound pages strapped to the wrist. They were not reminders for things the crew did not know. They were insurance against the moment when a trained person forgets under stress.

## Why it matters for the essay

A checklist moves memory out of the head and into the world, where two people can look at the same line. That is the whole argument of the essay in miniature.

## Connections

- The same idea scaled up is [[The flight plan as a shared notebook]]
- Gawande makes the hospital version of the argument in *The Checklist Manifesto*; my notes are in [[The Checklist Manifesto]]
- Aurora's highlight export is a tiny version of this: get it out of the app, into a file you control. See [[Aurora product brief]]

## Open question

Did crews annotate their checklists in flight? The Apollo 12 cuff checklist famously had jokes and Playboy clippings slipped in by the backup crew. Annotation as morale.
`
  },
  {
    key: 'r-flight-plan',
    title: 'The flight plan as a shared notebook',
    folder: SPACE,
    tags: ['space-race', 'concept'],
    created: 52,
    modified: 14,
    body: () => `The Apollo flight plan was a book, hundreds of pages, timeline down the left, crew activity on the right. Mission Control had the same book. Changes were read up over the radio and both sides wrote them in by hand.

So the flight plan was a document edited by two parties 380,000 km apart, kept in sync by voice. It is a CRDT with a human merge function.

## Notes

- Changes were called "pads" and read up in a fixed order so the crew could copy them without asking questions
- Collins describes the flight plan as the thing he trusted most; see [[Carrying the Fire]]
- The spoken side of the sync is in [[CAPCOM and the spoken log]]

## For the essay

This is the section where the essay turns from history to tools. Every note-taking app since has been trying to make this kind of shared book easy.
`
  },
  {
    key: 'r-capcom',
    title: 'CAPCOM and the spoken log',
    folder: SPACE,
    tags: ['space-race', 'concept'],
    created: 49,
    modified: 21,
    body: () => `Only one person in Mission Control talked to the crew: the capsule communicator, CAPCOM, always an astronaut. Everything else was routed through them.

Everything said on the loop was recorded and transcribed. The transcripts are the most complete notes of the program, and nobody "took" them. The log was a side effect of talking in one place.

## Related

- [[One small step]] is the most famous line in that log
- [[Launch commentary]] is the public version, a different loop entirely
- Compare with [[The flight plan as a shared notebook]]: written and spoken notes kept each other honest
`
  },
  {
    key: 'r-agc',
    title: "Margaret Hamilton's listings",
    folder: SPACE,
    tags: ['space-race', 'concept'],
    created: 44,
    modified: 18,
    body: (
      b
    ) => `The famous photo of Margaret Hamilton standing next to a stack of printouts as tall as she is: those are the listings of the Apollo Guidance Computer software. Code printed out so people could read it, annotate it and argue about it on paper.

Background: ${b.mention('https://en.wikipedia.org/wiki/Margaret_Hamilton_(software_engineer)')}

## Why I keep coming back to it

- The listings are notes about notes: the code is instructions, the margins are the thinking
- Mindell's *Digital Apollo* is the best account of how the crews and the computer shared control; reading it now, see [[Digital Apollo]]
- It is the strongest image for the essay's opening, stronger than any rocket

## To check

- Who owned the annotated copies? Are any scanned?
`
  },
  {
    key: 'r-marginalia',
    title: 'Marginalia',
    folder: SPACE,
    tags: ['concept', 'writing'],
    created: 40,
    modified: 25,
    body: () => `Writing in the margins is the oldest note-taking interface. It keeps the note next to the thing it is about, which every digital tool since has struggled to do.

- Hamilton's listings were covered in it: [[Margaret Hamilton's listings]]
- The gestures paper asks what margin-writing should feel like on a tablet: [[Note-taking gestures (paper)]]
- Aurora's highlight-plus-note is marginalia with an export button

> The note belongs next to the passage. Everything else is retrieval.
`
  },
  {
    key: 'r-apollo1',
    title: 'Apollo 1 memo, 1967',
    folder: SPACE,
    tags: ['space-race', 'apollo', 'source'],
    assets: ['scan-apollo1-memo-1967.pdf'],
    created: 36,
    modified: 30,
    properties: () => ({
      source:
        'https://commons.wikimedia.org/wiki/File:Memorandum_from_Jim_Jones_to_President_Johnson_about_the_Fire_on_Apollo_1_-_DPLA_-_66e171fa968a328938ba41954cc63f33.pdf'
    }),
    body: (
      b
    ) => `A one-page memo from Jim Jones to President Johnson on the evening of 27 January 1967, the night of the Apollo 1 fire. It is a scan with no text layer. Memry reads the page with OCR so its words show up in search.

${b.file('scan-apollo1-memo-1967.pdf', { width: 640, height: 820, align: 'center' })}

## Why it is in the essay

It is a note written in the first hours after a disaster, before anyone knew what had happened. Short sentences, times, names. The form of the memo carries the shock better than any later account.

## Notes

- Compare with the Safire memo, written *before* a disaster that never happened: [[In Event of Moon Disaster]]
- The fire led to the redesigned hatch and to far stricter procedures, which is where [[Checklists as external memory]] gets its weight
`
  },
  {
    key: 'r-safire',
    title: 'In Event of Moon Disaster',
    folder: SPACE,
    tags: ['space-race', 'apollo', 'source'],
    emoji: '🌑',
    assets: ['scan-safire-moon-disaster-memo-1969.pdf'],
    created: 34,
    modified: 2,
    properties: () => ({
      source:
        'https://commons.wikimedia.org/wiki/File:Memorandum_from_Speechwriter_William_Safire_to_President_Nixon_-_DPLA_-_59737d7b7830ac53d6541b2e61abd477.pdf'
    }),
    body: (
      b
    ) => `William Safire's memo to H. R. Haldeman, dated 18 July 1969, two days before the landing: the statement the President would read if Armstrong and Aldrin could not leave the Moon.

${b.file('scan-safire-moon-disaster-memo-1969.pdf')}

The pages are scanned images. Search still finds words inside them because Memry runs OCR on scanned PDFs; try searching for a phrase you can read on the page.

## What strikes me

The memo is also a checklist. Before the statement, the President should telephone each of the widows-to-be. After it, a clergyman commends their souls to "the deepest of the deep". Grief, planned as a procedure.

## For the essay

This is the closing image. A note written so that nobody would ever have to read it.

${b.task('p-safire-quote')}

Related: [[Apollo 1 memo, 1967]], [[One small step]].
`
  },
  {
    key: 'r-earthrise',
    title: 'Earthrise',
    folder: SPACE,
    tags: ['space-race', 'apollo', 'photo'],
    assets: ['photo-earthrise.jpg'],
    created: 30,
    modified: 29,
    properties: (b) => ({ cover: b.ref('photo-earthrise.jpg'), coverFocus: 40 }),
    body: (
      b
    ) => `Bill Anders, Apollo 8, 24 December 1968. The crew had been told to photograph the lunar surface for landing sites. The Earth came up over the horizon and the transcript records the scramble for color film.

${b.image('photo-earthrise.jpg', { width: 520 })}

The best photograph of the program was not on the flight plan. Worth a paragraph in the essay: the notes and plans made room for the unplanned.

See also [[The Blue Marble]] and [[The flight plan as a shared notebook]].
`
  },
  {
    key: 'r-blue-marble',
    title: 'The Blue Marble',
    folder: SPACE,
    tags: ['space-race', 'apollo', 'photo'],
    assets: ['photo-blue-marble.jpg'],
    created: 29,
    modified: 29,
    body: (
      b
    ) => `Apollo 17, December 1972, the last crewed Moon mission. The whole Earth, lit from behind the spacecraft.

${b.image('photo-blue-marble.jpg', { width: 420 })}

Pairs with [[Earthrise]]. Four years apart, the first and the last look back.
`
  },
  {
    key: 'r-armstrong',
    title: 'One small step',
    folder: SPACE,
    tags: ['space-race', 'apollo', 'audio'],
    assets: ['audio-armstrong-small-step.ogg'],
    created: 27,
    modified: 27,
    body: (b) => `Twenty-four seconds of the loop, 21 July 1969.

${b.file('audio-armstrong-small-step.ogg')}

The missing "a" debate is a lovely example of a note that cannot be corrected: the recording is the record. More on the loop in [[CAPCOM and the spoken log]].
`
  },
  {
    key: 'r-launch',
    title: 'Launch commentary',
    folder: SPACE,
    tags: ['space-race', 'apollo', 'video'],
    assets: ['video-apollo11-launch-commentary.webm'],
    created: 26,
    modified: 26,
    body: (b) => `Jack King, NASA public affairs, calling the Apollo 11 launch on 16 July 1969.

${b.file('video-apollo11-launch-commentary.webm')}

King reads numbers from a sheet in front of him. Even the most famous countdown is someone reading their notes aloud. Related: [[CAPCOM and the spoken log]].
`
  },
  {
    key: 'r-gestures',
    title: 'Note-taking gestures (paper)',
    folder: 'Research/Papers',
    tags: ['paper', 'note-taking', 'design'],
    created: 22,
    modified: 22,
    properties: () => ({
      source: 'https://arxiv.org/abs/2112.12126',
      topics: ['Note-taking', 'Design']
    }),
    body: () => `Gero, Chilton, Melancon and Cleron, *Eliciting Gestures for Novel Note-taking Interactions* (CC BY 4.0). The PDF is in this folder as its own file; open it from the sidebar.

## Takeaways

- People proposed the same few gestures for selecting and annotating, regardless of background
- Circling beats underlining for "this matters"
- Nobody wanted a gesture to delete

## For Aurora

Long-press to highlight is fine, but a lasso for multi-paragraph highlights tested well here. Parked for 1.1. Related: [[Marginalia]].
`
  },
  {
    key: 'reading-list',
    title: 'Reading list',
    folder: 'Research/Reading list',
    tags: ['space-race'],
    emoji: '📚',
    created: 66,
    modified: 5,
    body: () => `Every book note in this folder is tagged book: Author, Shelf, Rating and Finished are the tag's fields, and topics, owned and url are the note's own properties. The folder opens as a table, and the view switcher has a card gallery and a list of finished books. The same books also show up in the Book tag's table, grouped by shelf.

## Currently reading

- [[Digital Apollo]]
- [[The Elements of Style]]

## Next

- [[Hidden Figures]]

## Notes on the list

${table([
  ['Book', 'Why it is here'],
  ['[[Carrying the Fire]]', 'The best astronaut memoir'],
  ['[[A Man on the Moon]]', 'Reference for every mission'],
  ['[[The Checklist Manifesto]]', 'The checklist argument'],
  ['[[How to Take Smart Notes]]', 'The note-taking argument']
])}
`
  }
]

interface BookSpec {
  key: string
  title: string
  author: string
  shelf: 'To read' | 'Reading' | 'Read'
  rating?: number
  readOn?: number
  topics: string[]
  owned: boolean
  related?: string
  wash: string
  emoji: string
  created: number
  text: string
}

const books: BookSpec[] = [
  {
    key: 'b-collins',
    emoji: '🛰️',
    title: 'Carrying the Fire',
    author: 'Michael Collins',
    shelf: 'Read',
    rating: 5,
    readOn: -41,
    topics: ['Spaceflight', 'History'],
    owned: true,
    related: 'r-flight-plan',
    wash: 'slate',
    created: 64,
    text: 'Collins stayed in orbit while the others walked on the Moon. The book is funny and exact, and it is the best source on what the flight plan felt like from inside. His habit of writing everything on the flight plan margins is the seed of [[The flight plan as a shared notebook]].'
  },
  {
    key: 'b-chaikin',
    emoji: '🌕',
    title: 'A Man on the Moon',
    author: 'Andrew Chaikin',
    shelf: 'Read',
    rating: 5,
    readOn: -66,
    topics: ['Spaceflight', 'History'],
    owned: true,
    wash: 'fog',
    created: 80,
    text: 'The reference I keep open while writing. Every mission, built from interviews with the crews. Chapter on Apollo 1 sends me to [[Apollo 1 memo, 1967]].'
  },
  {
    key: 'b-mindell',
    emoji: '💻',
    title: 'Digital Apollo',
    author: 'David A. Mindell',
    shelf: 'Reading',
    topics: ['Spaceflight', 'Design'],
    owned: true,
    related: 'r-agc',
    wash: 'plum',
    created: 20,
    text: "How the crews and the guidance computer shared control. Halfway through. Most useful so far: the pilots fought for a role in the loop, and the designers found that keeping them in it made the system safer. Notes go into [[Margaret Hamilton's listings]]."
  },
  {
    key: 'b-gawande',
    emoji: '📋',
    title: 'The Checklist Manifesto',
    author: 'Atul Gawande',
    shelf: 'Read',
    rating: 3,
    readOn: -52,
    topics: ['Note-taking', 'Design'],
    owned: false,
    related: 'r-checklists',
    wash: 'sage',
    created: 57,
    text: 'One good essay stretched into a book. The surgical checklist story is worth it. My argument for the essay is in [[Checklists as external memory]].'
  },
  {
    key: 'b-ahrens',
    emoji: '🗃️',
    title: 'How to Take Smart Notes',
    author: 'Sönke Ahrens',
    shelf: 'Read',
    rating: 4,
    readOn: -70,
    topics: ['Note-taking', 'Writing'],
    owned: true,
    wash: 'wheat',
    created: 74,
    text: 'The Zettelkasten book. I do not follow the system, but the idea that writing starts long before the draft changed how I keep this vault. See [[Learning log]].'
  },
  {
    key: 'b-shetterly',
    emoji: '🧮',
    title: 'Hidden Figures',
    author: 'Margot Lee Shetterly',
    shelf: 'To read',
    topics: ['Spaceflight', 'History'],
    owned: false,
    wash: 'lilac',
    created: 12,
    text: 'The women who computed trajectories at Langley. Needed for the section I have not written yet; the gap is listed in [[Notes in the space race]].'
  },
  {
    key: 'b-strunk',
    emoji: '✒️',
    title: 'The Elements of Style',
    author: 'William Strunk Jr.',
    shelf: 'Reading',
    rating: 4,
    topics: ['Writing'],
    owned: true,
    related: 'x-craft',
    wash: 'ash',
    created: 18,
    text: 'Rereading the 1920 edition one rule a day. Rule 13 is pinned in [[Omit needless words]].'
  }
]

export const bookNotes: NoteSpec[] = books.map((book) => ({
  key: book.key,
  title: book.title,
  folder: 'Research/Reading list',
  tags: ['book'],
  emoji: book.emoji,
  created: book.created,
  modified: Math.max(1, book.created - 6),
  properties: (b) => ({
    // Author, Shelf, Rating and Finished are fields of the #book tag.
    Author: book.author,
    Shelf: book.shelf,
    topics: book.topics,
    owned: book.owned,
    url: `https://openlibrary.org/search?q=${encodeURIComponent(book.title)}`,
    cover: `wash:${book.wash}`,
    ...(book.rating ? { Rating: book.rating } : {}),
    ...(book.readOn ? { Finished: b.day(book.readOn) } : {}),
    ...(book.related ? { related: [b.uri.note(book.related)] } : {})
  }),
  body: () => `${book.text}\n`
}))
