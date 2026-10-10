import type { JournalSpec } from '../specs.ts'
import { reviewDay } from './dates.ts'

// Days without an entry, so the heatmap shows a real habit instead of a solid block.
const GAPS = new Set([-15, -16, -22, -29, -30, -31, -38, -45, -52, -53, -60, -66, -67, -71])
const FIRST_DAY = -74

/** Deterministic 0..1 noise per day, so every generation has the same shape. */
const noise = (day: number, salt: number): number => {
  const x = Math.sin(day * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function trackers(day: number): Record<string, unknown> {
  const sleep = Math.round((6 + noise(day, 1) * 2.5) * 10) / 10
  const mood = Math.max(3, Math.min(10, Math.round(4 + (sleep - 6) * 1.4 + noise(day, 2) * 3)))
  return {
    mood,
    energy: Math.max(1, Math.min(5, Math.round(mood / 2))),
    sleep,
    workout: noise(day, 3) > 0.45
  }
}

// The last two weeks are written out; older days combine a "day" line and an
// "evening" line from the pools below.
const recent: Record<
  number,
  { tags: string[]; text: (b: Parameters<JournalSpec['body']>[0]) => string }
> = {
  0: {
    tags: ['essay', 'aurora'],
    text: (
      b
    ) => `Design review is ${b.date(reviewDay(b.clock), { time: '14:00' })}, so today is for the contrast audit, due at two. Prep list in [[Design review prep]].

## Plan

${b.task('p-outline')}

${b.task('p-hidden-figures')}

## Notes

Woke up thinking about the essay ending again. [[In Event of Moon Disaster]] is the right last image; I just need the loop section to earn it.
`
  },
  [-1]: {
    tags: ['aurora'],
    text: () => `Long day on the PRD. Theo pushed back on exporting from inside the reader, and he is right that it clutters the toolbar. Moved it to the share sheet. [[Aurora PRD]] is updated.

Ran 5 km along the river after work. Legs still remember the hills from the weekend.
`
  },
  [-2]: {
    tags: ['essay'],
    text: () => `Transcribed the Safire memo for the essay. Reading it slowly, the strange part is the stage directions: who calls whom, in what order. It is a checklist for grief.

Wrote 600 words for the [[Space race essay draft]]. Most of them will go.
`
  },
  [-3]: {
    tags: ['cooking', 'travel'],
    text: () => `Jonah and Ines came over. Made the [[Wild mushroom risotto]]; Ines approved, which is the only review that counts. We sat with a map and picked the hikes. Cascade Canyon is on, Delta Lake is off. Details in [[Grand Teton trip]].
`
  },
  [-4]: {
    tags: [],
    text: () => `Slow Saturday. Market in the morning, then two chapters of [[Digital Apollo]] on the balcony. Mindell's point that pilots fought to stay in the loop keeps showing up in my Aurora thinking too: people want to be in control of their reading, not managed by it.
`
  },
  [-5]: {
    tags: ['aurora'],
    text: () => `Friday review. Aurora is on track except the offline queue. Studio lunch was long and loud and good.

Started breaking in the new boots. Two hours in and nothing hurts yet.
`
  },
  [-6]: {
    tags: ['aurora', 'design'],
    text: () => `The critique was the best meeting in weeks. Sam's photo of the reading room changed the conversation from "make it emptier" to "make it rhythmic". Notes in [[Reading view critique]].
`
  },
  [-7]: {
    tags: ['aurora'],
    text: (
      b
    ) => `Monday sync, notes in ${b.link('weekly-1')}. Theo found the race condition in the highlight queue. Not fun, but better now than after launch.
`
  },
  [-8]: {
    tags: [],
    text: () => `Rain all day. Stayed in, made [[Shakshuka for two]] for one, read Collins again for the flight plan chapter.
`
  },
  [-9]: {
    tags: ['aurora'],
    text: () => `Wrote up the [[Beta retro]]. The numbers are better than I felt they were. Readers finish 60% more articles than in week one.
`
  },
  [-10]: {
    tags: ['aurora'],
    text: () => `Beta retro meeting. We agreed to drop the weekly survey; people talk to us in the channel anyway.

Bad sleep, too much coffee.
`
  },
  [-11]: {
    tags: ['essay'],
    text: () => `Library day. Found a good passage on cuff checklists and added it to [[Checklists as external memory]]. The reading room there is nothing like the Library of Congress, but it is quiet and that is enough.
`
  },
  [-12]: {
    tags: ['aurora', 'decision'],
    text: () => `We decided how highlights sync: files plus a CRDT, no server-side copy. It took a week of prototypes and one hour of discussion. Logged in [[Decision log]].
`
  },
  [-13]: {
    tags: ['essay'],
    text: () => `Outline for the essay finally has a shape: Hamilton's listings, checklists, the shared flight plan, the loop, the Safire memo. Put it on the [[Space race essay board]] to move things around.
`
  }
}

const dayLines: Array<{ tag: string; text: string }> = [
  {
    tag: 'aurora',
    text: 'Beta feedback day. Three readers asked for a way to export highlights, which is the best possible thing to be asked for.'
  },
  {
    tag: 'aurora',
    text: 'Paired with Priya on the night theme. We tried six highlight colors and hated five.'
  },
  {
    tag: 'aurora',
    text: 'Interview with a reader who reads only on the train. Offline has to be perfect, not good.'
  },
  {
    tag: 'aurora',
    text: 'Long design session on the reading view margins. The answer was in the measure, not the font size.'
  },
  { tag: 'aurora', text: 'Shipped the Thursday beta build. Crash rate down again.' },
  {
    tag: 'aurora',
    text: 'Lena asked for a launch date. I asked for two more weeks of onboarding work first.'
  },
  {
    tag: 'aurora',
    text: 'Theo demoed the sync prototype. Two phones, airplane mode, and the highlights still merged.'
  },
  {
    tag: 'design',
    text: 'Sketched icon ideas for an hour before anyone else came in. Best hour of the day.'
  },
  {
    tag: 'design',
    text: 'Spent the morning on typography tests: same paragraph, nine settings, printed and pinned to the wall.'
  },
  {
    tag: 'studio',
    text: 'Admin morning: invoices, the font license renewal, two portfolio reviews.'
  },
  {
    tag: 'studio',
    text: 'Show and tell at the studio. Sam showed watercolors for the Aurora splash screen.'
  },
  {
    tag: 'studio',
    text: 'Quiet day at the studio, half the team out. Got through the whole backlog of small fixes.'
  },
  {
    tag: 'essay',
    text: 'Read about the Apollo flight plan for the essay. Changes were read up over the radio and written in by hand on both ends.'
  },
  {
    tag: 'essay',
    text: 'Started the essay research properly. Every note goes in the hub so I can see the shape.'
  },
  {
    tag: 'essay',
    text: 'Listened to the "one small step" audio ten times. The crackle is part of the record.'
  },
  { tag: 'essay', text: 'Found the scanned Apollo 1 memo. Short, factual, devastating.' },
  {
    tag: 'essay',
    text: 'Read the note-taking gestures paper. Half the ideas are things people already do with a pen.'
  },
  { tag: 'essay', text: 'Wrote nothing for the essay. Read instead. That counts, a little.' },
  {
    tag: 'cooking',
    text: 'Made a big batch of granola. The flat smells like cinnamon for the rest of the day.'
  },
  {
    tag: 'cooking',
    text: 'Tried roasting the romanesco hotter. Much better, the tips char before the stems go soft.'
  },
  { tag: 'cooking', text: 'Market run: mushrooms, lemons, too many tomatoes.' },
  { tag: 'reading', text: 'Finished a book on the tram. The ending made me miss my stop.' },
  {
    tag: 'reading',
    text: 'Rereading Strunk one rule a day. Today: put statements in positive form.'
  },
  {
    tag: 'travel',
    text: 'Booked the cabin for the Teton trip. Jonah sent eleven trail videos within the hour.'
  },
  { tag: 'travel', text: 'Looked at flights. Cheapest one leaves at 7:10, of course.' },
  { tag: 'health', text: 'Ran before work. 6 km, slow, happy.' },
  {
    tag: 'health',
    text: 'Skipped the run, walked to the studio instead. Forty minutes of podcast.'
  },
  { tag: 'health', text: 'Yoga class with Ines. Everything hurts in the good way.' }
]

const eveningLines: string[] = [
  'Evening: dinner, a long call with Mum, early night.',
  'Evening: read in the bath until the water went cold.',
  'Evening: cooked, cleaned, watched half a film.',
  'Evening: walked along the canal. The light is getting shorter.',
  'Evening: too tired to read. Phone down at ten anyway.',
  'Evening: wrote two paragraphs I like and four I do not.',
  'Evening: dinner with Jonah, mostly talking about the trip.',
  'Evening: tidied the vault, merged three notes about checklists into one.',
  'Evening: watered the fig, fed the sourdough, nothing else.',
  'Evening: a long call with Ines about her new job.',
  'Evening: drew for an hour, badly, happily.',
  'Evening: answered beta emails until I stopped making sense.',
  'Evening: rain on the window, tea, the Collins book.',
  'Evening: nothing planned, which was the plan.',
  'Evening: cinema with Sam. The film was better than the reviews.',
  'Evening: went to bed early and still slept badly.',
  'Evening: made soup for the week.',
  'Evening: wrote the week down here instead of thinking about it in bed.'
]

export function journalSpecs(): JournalSpec[] {
  const specs: JournalSpec[] = []
  let index = 0
  for (let day = FIRST_DAY; day <= 0; day++) {
    if (GAPS.has(day)) continue
    const written = recent[day]
    if (written) {
      specs.push({ day, tags: written.tags, properties: trackers(day), body: written.text })
      continue
    }
    const line = dayLines[(index * 11) % dayLines.length]
    const evening = eveningLines[(index * 5) % eveningLines.length]
    index++
    specs.push({
      day,
      tags: line.tag === 'health' || line.tag === 'reading' ? [] : [line.tag],
      properties: trackers(day),
      body: () => `${line.text}\n\n${evening}\n`
    })
  }
  specs.push({
    day: 1,
    tags: ['essay'],
    properties: {},
    body: () => `Plan: library at 17:30 for [[Hidden Figures]], then write the loop section.\n`
  })
  return specs
}
