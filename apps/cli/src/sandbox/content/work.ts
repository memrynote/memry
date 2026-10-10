import { table, type Body } from '../body.ts'
import type { Clock } from '../clock.ts'
import type { NoteSpec } from '../specs.ts'
import { lastMonday, launchDay, reviewDay, workdayFrom } from './dates.ts'

export function workNotes(clock: Clock): NoteSpec[] {
  const mon = lastMonday(clock)
  const review = reviewDay(clock)
  const launch = launchDay(clock)
  const aurora = 'Work/Aurora'
  const meetings = 'Work/Aurora/Meetings'

  // #meeting fields: Date, Attendees (people) and Company (the studio).
  const meetingFields = (b: Body, day: number, attendees: string[]): Record<string, unknown> => ({
    Date: b.day(day),
    Attendees: attendees.map((key) => b.uri.note(key)),
    Company: [b.uri.note('co-fieldwork')]
  })

  const weekly = (
    key: string,
    offset: number,
    attendees: string[],
    body: NoteSpec['body']
  ): NoteSpec => ({
    key,
    title: `Weekly sync ${clock.date(offset)}`,
    folder: meetings,
    tags: ['aurora', 'meeting'],
    properties: (b) => ({ project: ['Aurora launch'], ...meetingFields(b, offset, attendees) }),
    body,
    created: -offset,
    modified: -offset
  })

  return [
    {
      key: 'aurora-brief',
      title: 'Aurora product brief',
      folder: aurora,
      tags: ['aurora', 'design'],
      emoji: '🌅',
      properties: (b) => ({
        project: ['Aurora launch'],
        stage: 'Approved',
        deadline: b.day(launch),
        cover: 'wash:sand'
      }),
      created: 58,
      modified: 4,
      body: (
        b
      ) => `Aurora is a reading app for people who read on purpose. No feeds, no streak shaming, no badges. You open it, the text is beautiful, and your highlights are still yours in ten years.

## The problem

Read-later apps treat reading like an inbox to clear. Our interviews kept coming back to the same feeling: people *want* to read long pieces, but the tools make them feel behind. Six of the nine people we talked to had more than 400 unread saves.

> "I don't need another list. I need a quiet room." (interview 4)

## Who it is for

- People who read long-form on a phone in the evening
- Researchers and writers who quote what they read
- Anyone who has lost highlights when an app shut down

## Principles

1. **Calm by default.** One article at a time. No counts on the home screen.
2. **Your highlights are files.** Export to Markdown, always, for free.
3. **Typography first.** If the reading view is not the best part, nothing else matters.

## Scope for 1.0

The detailed requirements live in [[Aurora PRD]]. Decisions we already made, and why, are in the [[Decision log]]. The reading view rules are frozen in [[Typography spec (signed off)]].

Launch is planned for ${b.date(launch, { format: 'full' })}. The plan on one page is the [[Aurora launch map|launch map]] canvas; it is easier to argue about there.

## Not in 1.0

- Social features of any kind
- Recommendations
- A web reader (maybe 1.1)
`
    },
    {
      key: 'aurora-prd',
      title: 'Aurora PRD',
      folder: aurora,
      tags: ['aurora'],
      emoji: '📐',
      properties: (b) => ({
        project: ['Aurora launch'],
        stage: 'In review',
        deadline: b.day(9),
        related: [b.uri.note('aurora-brief'), b.uri.event('design-review')]
      }),
      created: 41,
      modified: 1,
      body: (
        b
      ) => `Owner: Maya. Engineering: Theo, Priya. Status: in review until the design review on ${b.date(review, { time: '14:00' })}.

## Goals and metrics

${table([
  ['Goal', 'Metric', 'Target at launch'],
  ['People finish what they start', 'Articles read to the end', '60% of opened'],
  ['Highlights feel safe', 'Highlights exported per active reader', '1 or more per week'],
  ['The app stays calm', 'Notifications sent per user per week', '0 by default'],
  ['Night reading works', 'Sessions after 21:00 using night theme', '70%']
])}

## Requirements

### Reading view

- Line length between 60 and 72 characters on every device
- Three type sizes, one serif, one sans; no custom fonts in 1.0
- Night theme with warm text, never pure white on black

### Highlights

- Long-press to highlight, tap to add a note
- Highlights work offline and sync later; see the offline queue in [[Decision log#Highlights sync]]
- Export all highlights as Markdown, one file per article

### Onboarding

At most three screens. The first one shows a real article, not a feature tour.

## Open work from this doc

${b.task('a-empty-copy')}

${b.task('a-reading-speed')}

## Risks

> [!warning]
> Android font fallback still breaks small caps in the serif. If we cannot fix it, we ship sans-only on Android.

> [!info]
> Everything here is tracked in the Aurora launch project. Open it from the sidebar to see the board.
`
    },
    {
      key: 'reading-critique',
      title: 'Reading view critique',
      folder: aurora,
      tags: ['aurora', 'design'],
      assets: ['photo-loc-reading-room.jpg'],
      properties: () => ({ project: ['Aurora launch'], stage: 'Approved' }),
      created: 7,
      modified: 6,
      body: (
        b
      ) => `Critique with Lena, Sam and Theo. We looked at the reading view on three phones, in daylight and in bed with the lights off.

## The reference

${b.image('photo-loc-reading-room.jpg', { caption: 'The Library of Congress reading room. Calm comes from rhythm, not emptiness.' })}

Sam brought this photo and it reframed the whole session. The room is full of detail, but every detail repeats. Our reading view felt empty instead of calm.

## What worked

- The serif at 19 px with 1.55 line height. Nobody wanted to change it.
- Hiding the toolbar until you scroll up.

## What did not

- Margins too wide on small phones; the measure drops to 48 characters.
- Highlight color fights the night theme. Lena: "it looks like a warning".
- The progress bar is a clock in disguise. Kill it.

## Follow-ups

- Contrast audit for the night theme (Priya)
- Typography rules go into [[Typography spec (signed off)]] once Lena signs off
- Bring the before and after to the design review

Related: [[Aurora PRD]], ${b.link('weekly-1')}.
`
    },
    {
      key: 'decision-log',
      title: 'Decision log',
      folder: aurora,
      tags: ['aurora', 'decision'],
      emoji: '🧭',
      properties: () => ({ project: ['Aurora launch'] }),
      created: 50,
      modified: 12,
      body: () => `One entry per decision: what we chose, what we gave up, and when to revisit. Newest first.

## Highlights sync

**Decision:** highlights are stored as plain Markdown files and synced with a CRDT, not as rows on our server.

**Why:** it is the only option where an export is the data itself, not a copy. Theo prototyped both in a week.

**Gave up:** server-side search across highlights.

**Revisit:** if more than 10% of beta readers ask for cross-device search.

## No streaks

**Decision:** no reading streaks, no daily goals.

**Why:** five of nine interviewees described streaks as guilt. See [[Aurora product brief]].

**Gave up:** the easiest retention lever we have.

## Two typefaces only

**Decision:** one serif, one sans, three sizes.

**Why:** every extra choice made the reading view worse in testing. Details in [[Typography spec (signed off)]].

## Archive

The marketing site decisions from last spring live in [[Website v1 postmortem]].
`
    },
    {
      key: 'beta-retro',
      title: 'Beta retro',
      folder: aurora,
      tags: ['aurora', 'meeting'],
      properties: (b) => ({
        project: ['Aurora launch'],
        ...meetingFields(b, workdayFrom(clock, -10), [
          'pe-lena',
          'pe-theo',
          'pe-priya',
          'pe-sam',
          'pe-maya'
        ])
      }),
      created: 10,
      modified: 9,
      body: () => `Retro after six weeks of private beta with 140 readers.

## Numbers

${table([
  ['Metric', 'Week 1', 'Week 6'],
  ['Weekly active readers', '96', '118'],
  ['Articles finished per reader', '2.1', '3.4'],
  ['Highlights per reader', '4', '11'],
  ['Crash-free sessions', '97.2%', '99.6%']
])}

## Keep, drop, try

<details data-memry-toggle open>
<summary>Keep</summary>

- Shipping a build every Thursday
- The beta channel where readers paste passages they loved

</details>

<details data-memry-toggle>
<summary>Drop</summary>

- The weekly survey. Response rate fell to 8%.
- Testing on the office wifi only. The offline bugs all came from trains.

</details>

<details data-memry-toggle>
<summary>Try</summary>

- A second beta wave with people who read in other languages
- Pairing Priya and Sam on the night theme

</details>

## Quotes from readers

> "It is the first app that made me read the whole thing."

> "I exported my highlights just to check I could. I could."

Next: [[Decision log]] for what we changed because of this.
`
    },
    {
      key: 'typography-spec',
      title: 'Typography spec (signed off)',
      folder: aurora,
      tags: ['aurora', 'design'],
      emoji: '🔒',
      properties: () => ({ project: ['Aurora launch'], stage: 'Approved' }),
      created: 15,
      modified: 13,
      body: () => `Signed off by Lena. This note is locked so nobody edits it by accident; unlock it from the note menu if the spec really has to change.

${table([
  ['Token', 'Phone', 'Tablet', 'Notes'],
  ['Body size', '19 px', '21 px', 'Serif, never below 17 px'],
  ['Line height', '1.55', '1.6', 'Unitless'],
  ['Measure', '60-68 ch', '64-72 ch', 'Clamp margins, not size'],
  ['Paragraph gap', '0.9 em', '1 em', 'No first-line indent']
])}

## Night theme

- Background \`#121110\`, text \`#E9E2D6\`
- Highlights use a desaturated amber, 28% opacity
- Links are underlined, never colored only

## Rules

1. Never justify text on phones.
2. Hyphenation on, minimum word length 7.
3. No bold inside body text from imported articles; render it as semibold.
`
    },
    weekly(
      'weekly-1',
      mon,
      ['pe-lena', 'pe-theo', 'pe-priya', 'pe-maya'],
      (b) => `## Updates

- Reading view critique done, notes in [[Reading view critique]]
- Offline highlight queue is behind; Theo found a race when two devices edit the same highlight
- Beta wave 2 list is ready, 60 people

## Decisions

- Ship sans-only on Android if the font fallback is not fixed by the design review
- No progress bar in the reading view

## Action items

${b.task('a-contrast')}

${b.task('a-offline')}

Next sync: ${b.date(mon + 7, { time: '10:00' })}
`
    ),
    weekly(
      'weekly-2',
      mon - 7,
      ['pe-lena', 'pe-theo', 'pe-priya', 'pe-maya', 'pe-sam'],
      (b) => `## Updates

- Beta retro written up: [[Beta retro]]
- Highlights sync decision made, see [[Decision log#Highlights sync]]
- App icon v2 approved

## Discussion

Lena wants a launch date. We agreed to pick one after the onboarding flow is designed, not before.

Previous: ${b.link('weekly-3')}. Next: ${b.link('weekly-1')}.
`
    ),
    weekly(
      'weekly-3',
      mon - 14,
      ['pe-lena', 'pe-theo', 'pe-maya'],
      (b) => `## Updates

- Icon set v2 shipped to the beta
- Priya is out until Thursday

## Notes

Short one. Most of the hour went to the sync engine question; Theo will prototype two options this week and we decide next Monday.

Next: ${b.link('weekly-2')}.
`
    ),
    {
      key: 'design-review',
      title: 'Design review prep',
      folder: meetings,
      tags: ['aurora', 'meeting', 'design'],
      properties: (b) => ({
        project: ['Aurora launch'],
        ...meetingFields(b, review, ['pe-lena', 'pe-theo', 'pe-priya', 'pe-sam', 'pe-maya']),
        related: [b.uri.event('design-review'), b.uri.note('aurora-prd')]
      }),
      created: 2,
      modified: 0,
      body: (
        b
      ) => `For the review on ${b.date(review, { time: '14:00', remind: '1h' })}. Goal: sign off the reading view and onboarding so Build can start.

## Agenda

1. Reading view before and after (10 min)
2. Onboarding, three screens (15 min)
3. Night theme contrast numbers (10 min)
4. Open questions (10 min)

## Bring

- Phones: small Android, mid iPhone, the old iPad
- Printed spec: [[Typography spec (signed off)]]

## Open questions

- Do we show the article count anywhere? I say no.
- Can export live in settings, or does it need a button in the reader?
`
    },
    {
      key: 'studio-rituals',
      title: 'Studio rituals',
      folder: 'Work/Studio ops',
      tags: ['studio'],
      emoji: '🪴',
      properties: () => ({ project: ['Studio ops'] }),
      created: 70,
      modified: 20,
      body: () => `How Fieldwork runs, written down so new people do not have to guess.

## Daily

- Standup at 09:30, fifteen minutes, standing for real
- No meetings after 15:00 on Wednesdays

## Weekly

- Monday: project syncs
- Friday: weekly review, then lunch together

## Monthly

- Show and tell: everyone shows one thing they made, finished or not
- Invoices go out on the first working day

## Tools

Notes and tasks live in Memry. Files live in the shared drive. Decisions get a line in the project's decision log, like [[Decision log]].
`
    },
    {
      key: 'hiring',
      title: 'Hiring a second designer',
      folder: 'Work/Studio ops',
      tags: ['studio'],
      properties: () => ({ project: ['Studio ops'] }),
      created: 16,
      modified: 3,
      body: () => `We are hiring a product designer for two days a week, starting after the Aurora launch.

## What we look for

- Has shipped something people use daily
- Writes clearly; the portfolio case studies tell us more than the visuals
- Likes small teams

## Loop

1. Portfolio review (Maya, Lena)
2. Call, 45 minutes
3. Paid half-day exercise on a real Aurora screen
4. Lunch with the team

Twelve portfolios so far. Three stand out.
`
    },
    {
      key: 'website-postmortem',
      title: 'Website v1 postmortem',
      folder: 'Work/Website v1',
      tags: ['studio', 'decision'],
      properties: () => ({ project: ['Website v1'] }),
      created: 88,
      modified: 80,
      body: () => `The first studio site took eleven weeks instead of four. Archived the project once it shipped.

## What went well

- Writing the case studies first and designing around them
- Static hosting; it has not been down once

## What went badly

- We redesigned the navigation three times
- No owner for the copy until week seven

## Lessons we applied to Aurora

- One owner per document
- Decisions get written down the day they are made: [[Decision log]]
`
    }
  ]
}
