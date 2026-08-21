import { generateJournalId } from '../../src/main/lib/id'
import type { NoteFile } from '../seed-vault/file-writer'
import { seedJournalDate } from './date'

interface JournalSpec {
  date: string
  mood: number
  tags: string[]
  body: string
}

// Narrative dates below run on a fixed timeline; seedJournalDate shifts them so the
// story lands around the run day. JOURNAL_ANCHOR (2026-05-08) maps to the day the
// seed runs, so the entries before it land in the past and the ones after it in the
// future — the journal opens with history behind today and plans ahead of it.
const ENTRIES: JournalSpec[] = [
  {
    date: '2026-03-26',
    mood: 3,
    tags: ['daily', 'planning', 'work'],
    body: `Spent the morning untangling what "finish memrynote" actually means. Wrote the list. It is shorter than the anxiety suggested.

- Drafted the first cut of [[memrynote Roadmap]]
- Closed two stale branches
- Bought running shoes I have been putting off for a month`
  },
  {
    date: '2026-03-28',
    mood: 4,
    tags: ['daily', 'reading'],
    body: `Finished [[Four Thousand Weeks]] on the balcony. The argument lands harder at 34 than it would have at 24.

> "You will not get everything done, and pretending otherwise is the problem."

Made pasta. Went to bed early for once.`
  },
  {
    date: '2026-03-31',
    mood: 4,
    tags: ['daily', 'reflection'],
    body: `End of March. Quiet month, and quiet turned out to be the point.

**Worked:** morning writing block, no phone before 09:00, Sunday meal prep.
**Did not:** evening screen curfew, stretching, replying to anything on time.`
  },
  {
    date: '2026-04-02',
    mood: 3,
    tags: ['daily', 'work', 'low-energy'],
    body: `Debugged a sync ordering bug for four hours and it turned out to be a clock comparison. Four hours.

Note to self, written in anger and kept on purpose: *read the timestamps before reading the logic.*`
  },
  {
    date: '2026-04-05',
    mood: 4,
    tags: ['daily', 'fitness', 'planning'],
    body: `Weighed in at 87.1 kg. That is the starting line for [[2026 Cut]] and I am writing it down so it is real.

Plan is boring on purpose: protein floor, three lifts, one long walk, weekly weigh-in. See [[Training Split]].`
  },
  {
    date: '2026-04-07',
    mood: 5,
    tags: ['daily', 'flow', 'writing'],
    body: `First proper flow session in weeks. 06:10 to 09:40 without looking up once.

Wrote the whole "why local-first" section of the [[Conference Talk]] outline. It reads like someone who believes it.`
  },
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
    date: '2026-05-08',
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
  },
  {
    date: '2026-05-09',
    mood: 4,
    tags: ['daily', 'planning', 'work'],
    body: `Sketched next week before it sketches me.

## Focus

1. Ship the calendar property chips — see [[memrynote Roadmap]]
2. Second draft of the [[Conference Talk]]
3. Lisbon bookings in [[Lisbon Notes]]

Everything else is negotiable.`
  },
  {
    date: '2026-05-10',
    mood: 5,
    tags: ['daily', 'fitness'],
    body: `Sunday weigh-in: 83.6 kg. Six weeks in and the trend line is boringly straight, which is exactly what I wanted.

Long walk, then groceries, then nothing at all. Updated [[Cutting Log]].`
  },
  {
    date: '2026-05-12',
    mood: 4,
    tags: ['daily', 'work', 'meetings'],
    body: `Sprint planning ran long but landed somewhere honest: cut two features, keep the date.

Lunch outside. First warm day where sitting still felt good.`
  },
  {
    date: '2026-05-13',
    mood: 5,
    tags: ['daily', 'flow', 'writing'],
    body: `Three hours on the launch post. It finally sounds like a person instead of a changelog.

Pairs with [[memrynote GTM]] — the positioning line from there is doing a lot of work.`
  },
  {
    date: '2026-05-15',
    mood: 4,
    tags: ['daily', 'travel', 'planning'],
    body: `Lisbon logistics evening. Flights held, one hotel booked, the rest deliberately empty.

- [x] Book flights
- [x] Hotel in Alfama
- [ ] Pick two dinners, leave the rest to chance
- [ ] Reread [[Packing List]] the night before`
  },
  {
    date: '2026-05-17',
    mood: 5,
    tags: ['daily', 'reflection', 'gratitude'],
    body: `A slow Sunday that I did not try to optimize.

Three things worth keeping: coffee on the balcony, the long call with my brother, finishing a book in one sitting.`
  },
  {
    date: '2026-05-19',
    mood: 4,
    tags: ['daily', 'work'],
    body: `Beta invites out to the first twelve people. The nervous kind of good.

Two bugs reported within the hour, both small, both fixed before dinner. See [[memrynote Launch]].`
  },
  {
    date: '2026-05-21',
    mood: 4,
    tags: ['daily', 'reading', 'reflection'],
    body: `Started [[Man's Search for Meaning]] again. Different book at a different age, same three pages that stop me every time.

Lifted. Slept eight hours. Nothing dramatic, which is the whole trick.`
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

// Resolve narrative dates to real dates around the run day before building files.
const RESOLVED_ENTRIES = ENTRIES.map((entry) => ({
  ...entry,
  date: seedJournalDate(entry.date)
}))

export const JOURNAL_NOTES: NoteFile[] = RESOLVED_ENTRIES.map((entry) => ({
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
export const JOURNAL_METADATA = RESOLVED_ENTRIES.map((entry) => ({
  id: generateJournalId(entry.date),
  path: `journal/${entry.date}.md`,
  title: entry.date,
  journalDate: entry.date,
  createdAt: dateToCreatedISO(entry.date),
  modifiedAt: dateToModifiedISO(entry.date)
}))
