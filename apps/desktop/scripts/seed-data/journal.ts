import { generateJournalId } from '../../src/main/lib/id'
import type { NoteFile } from '../seed-vault/file-writer'
import { seedJournalDate } from './date'

interface JournalSpec {
  /** Days from the day `pnpm seed` runs. 0 = today, negative = days ago. */
  dayOffset: number
  mood: number
  tags: string[]
  body: string
}

// Narrative dates below run on a fixed timeline; seedJournalDate shifts them so the
// story lands around the run day. The final entry (JOURNAL_ANCHOR) maps to today.
const ENTRIES: JournalSpec[] = [
  {
    dayOffset: -26,
    mood: 4,
    tags: ['daily', 'planning'],
    body: `Started the week by sketching out the [[2026 Cut]] plan for real this time, not just in my head. The numbers actually feel doable if I hold the line on the deficit and stop eyeballing portions. Coffee was good, sleep was rough, but I lifted anyway and felt better for it afterward. Spent the morning writing 600 words on the [[memrynote Launch]] post and it finally has a spine. Also fixed a nagging sync edge case in the CRDT push order that's been bugging me for days. Walked 8k steps between calls, mostly to clear my head. Feeling like the week has a shape now.`
  },
  {
    dayOffset: -25,
    mood: 3,
    tags: ['daily', 'work'],
    body: `Brain fog all morning — the kind where you read the same line four times and retain nothing. Took a walk before lunch and it mostly cleared, which is becoming a pattern worth trusting. Wrote down everything I was *supposed* to do today, then just did the single most important one and let the rest wait. Made real progress on the [[memrynote Launch]] checklist even so. Started reading [[Sapiens]] in the evening; slow opening, characteristically Harari, but I'm in. Kept dinner light and stayed on plan for the [[2026 Cut]]. Some days you win by not losing.`
  },
  {
    dayOffset: -24,
    mood: 5,
    tags: ['daily', 'flow'],
    body: `Best day of the month so far. Four uninterrupted hours in the cave on the [[memrynote Architecture]] doc — no notifications, no Slack, phone in another room. The whole sync model finally clicked and I wrote it down before it could evaporate. Lifted heavy in the afternoon and hit a squat PR at 140kg × 5, which I did not expect on a cut. Ate well, slept early, felt genuinely proud of the day.

> "The only way out is through." — my old climbing instructor; turns out it applies to writing too.`
  },
  {
    dayOffset: -23,
    mood: 5,
    tags: ['daily', 'travel', 'tokyo'],
    body: `Departure day — the [[Tokyo Trip]] finally begins. Up at 04:30, weirdly awake, running on adrenaline more than coffee. Killed an hour in the airport lounge with a flat white and my [[memrynote Launch]] notes. Fifteen hours in the air, two mediocre movies, and one surprisingly good nap later: Haneda. The light is different, the air is different, *everything* is different and I haven't even left the airport yet. Customs was fast, the train was spotless, and I already feel three time zones lighter. Tomorrow, the city.`
  },
  {
    dayOffset: -22,
    mood: 5,
    tags: ['daily', 'travel'],
    body: `First full day in Tokyo and I walked until my feet gave out. Tokyo Tower in the morning, onigiri from a convenience store that put most restaurants back home to shame, and a tiny bookstore in Jimbocho where I bought a book I cannot read. Still bought it — the object itself is beautiful. Logged 22,000 steps and my legs are the *good* kind of sore. Added three new spots to [[Tokyo Cafes]]. Stayed roughly on plan food-wise despite the temptation on every corner. Fell asleep before 22:00 for the first time in months.`
  },
  {
    dayOffset: -21,
    mood: 4,
    tags: ['daily', 'travel'],
    body: `Shibuya scramble at 18:00 — fewer people than the YouTube videos suggest, more than I'd ever want to *be* inside of regularly. Wandered the backstreets after and found the city I actually came for: quiet, low, lantern-lit. Late ramen at a counter with six seats and no English menu; I pointed and got lucky. Updated [[Tokyo Cafes]] with the espresso place from the afternoon. Already plotting a return trip before this one is even over, which is probably a good sign. Slept hard.`
  },
  // gap — one travel day with no entry
  {
    dayOffset: -19,
    mood: 5,
    tags: ['daily', 'travel', 'kyoto'],
    body: `[[Kyoto Day Trip]] — left at 06:30, back at 22:00, and my legs are simply *gone*. Worth every step. Fushimi Inari at dawn was the moment of the whole trip: the torii gates with no one in them, the light filtering through in slats, the silence. I stood there far longer than I planned to and didn't check my phone once. Kinkaku-ji was crowded but still stopped me cold. Ate a proper kaiseki lunch and logged it in [[Food Diary]]. This is a day I'll remember for a long time.`
  },
  {
    dayOffset: -18,
    mood: 4,
    tags: ['daily', 'travel'],
    body: `Ghibli Museum today. Don't take photos — they mean it, and honestly you don't want to; being present there is the entire point. The building itself is the exhibit, all spiral staircases and stained glass and small doors made for wonder. Watched [[Spirited Away]] on the train back, tenth time, still cried at the same scene. Picked up a few gifts I'll pretend aren't mostly for me. Kept the day gentle on purpose after yesterday's Kyoto march. Early night again — the routine is holding even on the road.`
  },
  {
    dayOffset: -17,
    mood: 5,
    tags: ['daily', 'travel'],
    body: `Coffee crawl day — five spots, all logged in [[Tokyo Cafes]]. Best espresso of my life at Bear Pond in Shimokitazawa; they close at noon sharp and now I understand why they can. Between cafes I read another chapter of [[Sapiens]] on a park bench in the sun. Bought beans to take home even though I know they'll never taste the same in my kitchen. Walked a slow 15k and let the day be unhurried. Journaling this over a nightcap of hojicha. A near-perfect day.`
  },
  // gap — a long park day, camera stayed in the bag
  {
    dayOffset: -15,
    mood: 4,
    tags: ['daily', 'travel'],
    body: `DisneySea. Yes, I'm an adult; yes, I bought the Toy Story popcorn bucket; no regrets whatsoever. The theming is on another level — they build worlds, not rides. Stood in line for 70 minutes for a boat ride and would do it again. Ate my way around the park and gave the [[2026 Cut]] the day off, guilt-free. Legs held up better than expected after the last week of walking. Home to the hotel late, feet throbbing, grinning like an idiot. Trip winding down and I'm already sad about it.`
  },
  {
    dayOffset: -14,
    mood: 3,
    tags: ['daily', 'travel', 'goodbye'],
    body: `Last full day. Spent 90 minutes just walking Tokyo Station, buying too many KitKats in flavors that shouldn't work but do. Cried on the escalator — *actually cried, on an escalator* — which is when I knew this place had gotten to me. Did a final loop of my favorite neighborhood to fix it in memory. Packed badly, as always, and sat on the suitcase to close it. Wrote a long entry in [[Tokyo Trip]] so I don't lose the small details. Flight home tonight; part of me is staying.`
  },
  // gap — the flight home, jetlagged and asleep
  {
    dayOffset: -12,
    mood: 2,
    tags: ['daily', 'jetlag'],
    body: `Home, and thoroughly wrecked. Slept from 16:00 to 22:00 and now I'm wide awake at 02:00 writing this by lamplight. The apartment feels too big and too quiet after two weeks of Tokyo density. Skipped lifting — my body has no idea what time it is and I'm not going to fight it. Unpacked half a suitcase and gave up. Made tea, ate toast, stared at the wall for a while. Tomorrow I try to rejoin my own time zone.`
  },
  {
    dayOffset: -11,
    mood: 3,
    tags: ['daily', 'fitness'],
    body: `Weigh-in morning: 85.5 kg, down 1.6 kg across the trip, which I fully expected to be flat given all the ramen. Turns out walking 22k steps a day is a hell of a thing. Updated the [[Cutting Log]] and the trend line still points the right way. Slept a normal-ish stretch for the first time since landing. Eased back into food tracking in [[Food Diary]] without being precious about it. Short walk, no lifting yet — one more day of grace. Back on the horse tomorrow.`
  },
  {
    dayOffset: -10,
    mood: 4,
    tags: ['daily', 'work'],
    body: `Back in the swing properly. [[memrynote Launch]] is now my one main thread, and the next stretch is about *finishing*, not adding. Said no to a tempting side project today and it felt genuinely good to protect the focus. Cleared two weeks of travel backlog out of the inbox in one brutal but satisfying pass. Re-read the [[memrynote Architecture]] doc I wrote in Tokyo and it still holds up. Lifted for the first time since the trip; lighter than before, but everything moved. Momentum is a real thing and I have it again.`
  },
  {
    dayOffset: -9,
    mood: 4,
    tags: ['daily', 'work', 'meetings'],
    body: `Sprint planning this morning and the team is genuinely *into* the Inbox redesign, which validates the call I've been nervous about. Good energy, tight scope, no scope creep for once. Lunch with M. afterward — first time in over a month and exactly what I needed. Spent the afternoon breaking the redesign into tasks under [[memrynote Launch]] so nothing lives only in my head. Reviewed two PRs and kept my own moving. Lifted in the evening and the strength is coming back fast. Solid, unglamorous, productive day.`
  },
  // gap — a low day I didn't feel like writing
  {
    dayOffset: -7,
    mood: 3,
    tags: ['daily', 'low-energy'],
    body: `Slow day and I didn't fight it. Energy was low from the jump, so I picked the one thing that mattered and let the rest slide. Read [[Atomic Habits]] for an hour on the couch, which is either self-improvement or procrastination depending on how you squint. Walked, made a proper dinner with my partner, stayed off screens after eight. Held the line on the [[2026 Cut]] without white-knuckling it. Some days are maintenance days and that's the whole point of having a system. No guilt.`
  },
  {
    dayOffset: -6,
    mood: 4,
    tags: ['daily', 'fitness'],
    body: `Weigh-in: 85.0 kg, basically stalled versus last week, and I'm choosing to be patient about it. The plan works over weeks, not days, and I keep having to relearn that. Pushed lifts hard today — squat felt heavy, bench felt strong, the ledger balances. Logged everything in the [[Cutting Log]] and [[Food Diary]]. Long walk in the afternoon that turned into an unexpectedly good podcast binge. Cooked a big lean dinner and actually enjoyed the process. Trusting the trend, not the number.`
  },
  // gap
  {
    dayOffset: -4,
    mood: 5,
    tags: ['daily', 'flow', 'work'],
    body: `Three uninterrupted hours on the calendar IPC layer and I finally squashed the timezone bug that's been haunting me since the [[Tokyo Trip]]. Turns out events created in Asia/Tokyo were drifting by a day on West Coast displays — a classic UTC-vs-local slip. The [[Drizzle ORM]] note on \`field_clocks\` is what actually saved me here. Wrote a regression test so it can never come back. Shipped the fix, closed the tab, and felt the specific joy of killing an old bug. Lifted after and hit every rep. This is the version of the job I love.`
  },
  {
    dayOffset: -3,
    mood: 4,
    tags: ['daily', 'reading'],
    body: `Reading [[The Almanack of Naval Ravikant]] in the evenings. Some of it is slick startup-broism I roll my eyes at, and some of it genuinely cracked something open about leverage and patience. Underlined more than I expected to. Kept the workday tight and cleared two more items off the [[memrynote Launch]] board. Lifted and felt strong; third lift week of the [[2026 Cut]] and the numbers haven't dropped, which is the whole goal. Made Korean BBQ at home and stayed lean, all logged in [[Food Diary]]. Good, balanced day.`
  },
  {
    dayOffset: -2,
    mood: 5,
    tags: ['daily', 'flow', 'writing'],
    body: `Wrote 1,100 words on the [[Conference Talk]] outline and it was the best stretch of writing I've had in weeks. The argument finally has a through-line instead of a pile of good points. Ideas kept arriving faster than I could type, which almost never happens. Mackerel teishoku for lunch — easily a 4/5, noted in [[Food Diary]]. Capped the afternoon with a walk to let the draft settle. Lifted in the evening, nothing heroic, just consistent. Days like this are why I keep the [[Morning Routine]].`
  },
  {
    dayOffset: -1,
    mood: 4,
    tags: ['daily', 'fitness'],
    body: `Weigh-in: 84.0 kg — a whoosh week, and trusting the plan through the stall paid off exactly like it was supposed to. Updated the [[Cutting Log]] with a genuinely satisfying downward step. Long walk with my partner in the afternoon where we mostly talked about the [[Lisbon Notes]] trip. Finished the inbox suggestions UI at work; the little "AI suggests filing here" pill is absurdly satisfying to watch work. Everything under [[memrynote Launch]] is moving in the right direction. Cooked, read, slept early. A quietly great day.`
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
  }
]

/** Resolve each entry's relative offset to a concrete `YYYY-MM-DD` at seed time. */
const DATED_ENTRIES = ENTRIES.map((entry) => ({
  date: seedDateOnly(entry.dayOffset),
  mood: entry.mood,
  tags: entry.tags,
  body: entry.body
}))

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
