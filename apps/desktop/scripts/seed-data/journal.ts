import { generateJournalId } from '../../src/main/lib/id'
import type { NoteFile } from '../seed-vault/file-writer'
import { seedDateOnly } from './date'

interface JournalSpec {
  date: string
  mood: number
  tags: string[]
  body: string
}

const TODAY_DATE = seedDateOnly(0)

const ENTRIES: JournalSpec[] = [
  {
    date: '2026-04-09',
    mood: 4,
    tags: ['daily', 'planning'],
    body: `Started the week sketching out the [[2026 Cut]] plan in earnest. Numbers feel doable. Trick is to *not* eyeball it.

Coffee was good. Slept poorly. Lifted anyway.

- Wrote 600 words on [[memrynote Launch]] post
- Fixed a sync edge case in CRDT push order
- Walked 8k steps`
  },
  {
    date: '2026-04-10',
    mood: 3,
    tags: ['daily', 'work'],
    body: `Brain fog all morning. Took a walk before lunch and it cleared. Wrote down everything I was *supposed* to do today and then just did the top one.

Started reading [[Sapiens]]. Slow start, characteristically Harari.`
  },
  {
    date: '2026-04-11',
    mood: 5,
    tags: ['daily', 'flow'],
    body: `Best day of the month. 06:00–10:00 in the cave on the [[memrynote Architecture]] doc. No notifications, no Slack.

Lifted heavy in the afternoon. Squat PR (140kg × 5).

> "The only way out is through." — old climbing instructor; turns out it applies to writing too.`
  },
  {
    date: '2026-04-12',
    mood: 5,
    tags: ['daily', 'travel', 'tokyo'],
    body: `Departure day. [[Tokyo Trip]] begins. Up at 04:30. Coffee in the airport lounge — see [[Airport Lounges]].

15 hours later, Haneda. The light is different. The air is different. *Everything* is different and I haven't even left the airport.`
  },
  {
    date: '2026-04-13',
    mood: 5,
    tags: ['daily', 'travel'],
    body: `Tokyo Tower. Onigiri. A tiny bookstore in Jimbocho where I bought a book I cannot read. Still bought it.

Walked 22,000 steps. Feet hurt but the *good* kind.`
  },
  {
    date: '2026-04-14',
    mood: 4,
    tags: ['daily', 'travel'],
    body: `Shibuya scramble at 18:00. Fewer people than the YouTube videos suggest. More than I'd want to *be* in regularly.

Late ramen — see [[Tokyo Cafes]] for where. Already plotting return.`
  },
  // skip 2026-04-15 to leave a gap, then add it back as a heavy day
  {
    date: '2026-04-15',
    mood: 5,
    tags: ['daily', 'travel', 'kyoto'],
    body: `[[Kyoto Day Trip]] — left at 06:30, back at 22:00, my legs are *gone*. Worth it.

Fushimi Inari at dawn was the moment. The torii gates with no one in them, the way the light filtered through. I will remember this.`
  },
  {
    date: '2026-04-16',
    mood: 4,
    tags: ['daily', 'travel'],
    body: `Ghibli Museum. Don't take photos. *Don't take photos.* They mean it. And honestly, you don't want to.

Watched [[Spirited Away]] on the train back. Tenth time. Still cried.`
  },
  {
    date: '2026-04-17',
    mood: 5,
    tags: ['daily', 'travel'],
    body: `Coffee crawl day. Five spots, [[Tokyo Cafes]] updated.

Best espresso of my life at Bear Pond. They closed at noon, sharp.`
  },
  {
    date: '2026-04-18',
    mood: 4,
    tags: ['daily', 'travel'],
    body: `Disney Sea. Yes I'm an adult. Yes I bought the Toy Story popcorn bucket. No regrets.`
  },
  {
    date: '2026-04-19',
    mood: 3,
    tags: ['daily', 'travel', 'goodbye'],
    body: `Last day. Walked Tokyo Station for 90 minutes. Bought too many KitKats.

Cried on the escalator. *Cried on an escalator.* This place got me.

Flight home tonight.`
  },
  // gap — 2026-04-20 traveling/jetlagged
  {
    date: '2026-04-21',
    mood: 2,
    tags: ['daily', 'jetlag'],
    body: `Home. Jetlagged. Slept from 16:00 to 22:00 and now I'm wide awake at 02:00 writing this.

Skipped lifting. Will get back tomorrow.`
  },
  {
    date: '2026-04-22',
    mood: 3,
    tags: ['daily', 'fitness'],
    body: `Sunday weigh-in: 85.5 kg. Down 1.6 kg over Tokyo (which I expected to be flat). Walking 22k steps for a week is a hell of a thing.

Updated [[Cutting Log]].`
  },
  {
    date: '2026-04-23',
    mood: 4,
    tags: ['daily', 'work'],
    body: `Back in the swing. [[memrynote Launch]] is now my main thread. Next 8 weeks are about *finishing*, not adding.

Said no to a side project today. Felt good.`
  },
  {
    date: '2026-04-24',
    mood: 4,
    tags: ['daily', 'work', 'meetings'],
    body: `Sprint planning. Team is *into* the Inbox redesign. Validates the call.

Lunch with M. — first time in a month. Wonderful.`
  },
  {
    date: '2026-04-25',
    mood: 3,
    tags: ['daily', 'low-energy'],
    body: `Slow day. Didn't push it. Read [[Atomic Habits]] for an hour. Walked. Made dinner with my partner.

Some days are maintenance days.`
  },
  {
    date: '2026-04-26',
    mood: 4,
    tags: ['daily', 'fitness'],
    body: `Sunday weigh-in: 85.0 kg. Stalled vs. last week. Patient. Will trust the plan.

Pushed lifts hard. Squat felt heavy. Bench was good.`
  },
  {
    date: '2026-04-27',
    mood: 4,
    tags: ['daily', 'work'],
    body: `Inbox snooze feature in the can. PR up. Quick review and out.

Started [[The Mystery Guest]]. Cozy, easy.`
  },
  {
    date: '2026-04-28',
    mood: 5,
    tags: ['daily', 'flow', 'work'],
    body: `Three uninterrupted hours on the calendar IPC layer. Solved a TZ bug that's been nagging since [[Tokyo Trip]] (turns out: events from Asia/Tokyo were drifting on West Coast displays).

Pair with [[Drizzle ORM]] note — \`field_clocks\` saved me here.`
  },
  {
    date: '2026-04-29',
    mood: 4,
    tags: ['daily', 'reading'],
    body: `Reading [[The Almanack of Naval Ravikant]]. Some bits are slick startup-broism, some bits genuinely cracked something open.

Lifted. Felt strong. 3rd lift week of the [[2026 Cut]] and lifts haven't dropped.`
  },
  {
    date: '2026-04-30',
    mood: 4,
    tags: ['daily', 'reflection'],
    body: `End of April. Net: solid. Tokyo, the cut, memrynote doc landed. Three good things.

Three improvements: write more in public, sleep on schedule, *do not check phone before 09:00*.`
  },
  {
    date: '2026-05-01',
    mood: 4,
    tags: ['daily', 'fitness'],
    body: `May. New month, same plan.

[[Cutting Log]] update: 84.8 kg → moving.`
  },
  {
    date: '2026-05-02',
    mood: 5,
    tags: ['daily', 'flow', 'writing'],
    body: `Wrote 1100 words on the [[Conference Talk]] outline. Best stretch of writing in weeks.

Mackerel teishoku for lunch — see [[Food Diary]]. Easily a 4/5.`
  },
  {
    date: '2026-05-03',
    mood: 5,
    tags: ['daily', 'fitness'],
    body: `Sunday weigh-in: 84.0 kg. Whoosh week. Trusting the plan paid off.

Long walk with my partner in the afternoon. Talked about [[Iceland Ring Road]] plans.`
  },
  // gap — 2026-05-04 (I genuinely didn't journal that day, leaving it that way)
  {
    date: '2026-05-05',
    mood: 4,
    tags: ['daily', 'work'],
    body: `Finished the inbox suggestions UI. The little "AI suggests filing here" pill is *cute*. Hard not to smile when you see it work.

Linked tasks under [[memrynote Launch]] are all moving.`
  },
  {
    date: '2026-05-06',
    mood: 4,
    tags: ['daily', 'reading'],
    body: `Korean BBQ tonight. Stayed lean — see [[Food Diary]].

More [[Sapiens]]. Chapter on agriculture. The wheat take feels stretched but in a productive *huh* way.`
  },
  {
    date: '2026-05-07',
    mood: 5,
    tags: ['daily', 'flow', 'work'],
    body: `Wrote, lifted, shipped.

Best day this week. The morning routine — see [[Morning Routine]] — is *paying for itself.* Two months in.`
  },
  {
    date: TODAY_DATE,
    mood: 4,
    tags: ['daily', 'reflection'],
    body: `A quiet day with enough space to notice what helped.

## Schedule

- 09:00 Morning walk and coffee
- 12:30 Lunch prep from [[Food Diary]]
- 18:30 Dinner with Mina
- 21:00 Plan the Lisbon weekend in [[Lisbon Notes]]

## Tasks

- [ ] Buy flowers on the way home
- [ ] Reply to Mina about dinner
- [ ] Add two restaurant ideas to [[Lisbon Notes]]
- [ ] Finish the book chapter before bed

Small win: took a longer walk after lunch and came back with a clearer head.`
  }
]

const dateToCreatedISO = (date: string): string => {
  const d = new Date(date + 'T08:30:00.000Z')
  return d.toISOString()
}

const dateToModifiedISO = (date: string): string => {
  const d = new Date(date + 'T22:30:00.000Z')
  return d.toISOString()
}

export const JOURNAL_NOTES: NoteFile[] = ENTRIES.map((entry) => ({
  relativePath: `journal/${entry.date}.md`,
  // User keys only — no Memry keys; dates land on the file via mtime
  frontmatter: {
    date: entry.date,
    mood: entry.mood,
    ...(entry.tags.length > 0 ? { tags: entry.tags } : {})
  },
  body: entry.body,
  modified: dateToModifiedISO(entry.date)
}))

/** Canonical note_metadata rows so journal ids stay stable across indexing. */
export const JOURNAL_METADATA = ENTRIES.map((entry) => ({
  id: generateJournalId(entry.date),
  path: `journal/${entry.date}.md`,
  title: entry.date,
  journalDate: entry.date,
  createdAt: dateToCreatedISO(entry.date),
  modifiedAt: dateToModifiedISO(entry.date)
}))
