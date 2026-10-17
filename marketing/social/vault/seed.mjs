#!/usr/bin/env node
/**
 * The social clips' base vault. It starts from the tutorial vault (Maya, a freelance designer's
 * week: marketing/tutorials/vault/seed.mjs) and adds the rest of her world that most clips show
 * in passing: folders, the people she works with, meeting notes, two weeks of journal, this
 * week's calendar and a few inbox captures. Dates are relative to the day it is seeded, so
 * clip.mjs seeds a fresh base each day. A clip that needs more adds it in its own vault.mjs.
 *
 *   node marketing/social/vault/seed.mjs <vault> [--app <checkout>]
 */
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIMEZONE, at, cliFor, day } from './cli.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export function seedBase({ app, vault }) {
  execFileSync('node', [path.join(REPO, 'marketing/tutorials/vault/seed.mjs'), vault], {
    env: { ...process.env, MEMRY_APP: app },
    stdio: 'inherit'
  })
  const cli = cliFor(app, vault)
  const byTitle = Object.fromEntries(
    cli('notes', 'list', '--limit', '500').map((n) => [n.title, n])
  )

  // Folders, with the tutorial's root notes filed where Maya would keep them.
  const FOLDERS = {
    'Studio North': [
      'Website Redesign Brief',
      'Studio North Kickoff',
      'Homepage Ideas',
      'Design Principles'
    ],
    Lisbon: ['Lisbon Packing List', 'Lisbon Ideas', 'Lisbon Itinerary'],
    People: [],
    Meetings: [],
    Reading: ['Reading List'],
    Ideas: []
  }
  for (const [folder, titles] of Object.entries(FOLDERS)) {
    cli('folders', 'create', folder)
    for (const t of titles) cli('notes', 'move', byTitle[t].id, folder)
  }

  const note = (folder, title, content, tags = [], props = {}) =>
    cli(
      'notes',
      'create',
      title,
      '--folder',
      folder,
      '--content',
      content,
      '--properties',
      JSON.stringify(props),
      ...tags.flatMap((t) => ['--tag', t])
    )

  note(
    'Studio North',
    'Studio North',
    `Architecture studio in Copenhagen, twelve people. They design small public buildings: libraries, a ferry terminal, two schools.

Contacts: [[Jonas Weber]] (founder), [[Lea Park]] (marketing).`,
    ['client']
  )
  note(
    'People',
    'Jonas Weber',
    `Founder of [[Studio North]]. Prefers a call to a long email.

Cares about: case studies, fewer pages, the site feeling calm on a phone.`
  )
  note(
    'People',
    'Lea Park',
    `Runs marketing at [[Studio North]]. Owns the brand guidelines and the photo archive.

Met at the kickoff. Sends feedback as numbered lists, which I love.`
  )
  note(
    'People',
    'Sam Okafor',
    `Front-end developer. Builds the sites I design.

Moving to Lisbon in spring, so he's my guide for the trip. Ask him about the Sintra day.`
  )
  note(
    'Meetings',
    'Weekly sync with Sam',
    `- Sam needs the hero assets by Thursday
- Mobile nav: prototype both the menu and a bottom bar
- [[Homepage Ideas]] approved for build`,
    ['meeting']
  )
  note(
    'Meetings',
    'Brand workshop with Lea',
    `- Headings stay in their serif, body text goes system
- Colors stay as they are
- Lea sends the logo files and three photo picks`,
    ['meeting']
  )
  note(
    'Reading',
    'Notes on Shape Up',
    `Appetite instead of estimates: decide how much time a problem deserves, then shape the work to fit.

- Six-week cycles, two weeks of cool-down
- A pitch has five parts: problem, appetite, solution, rabbit holes, no-gos`,
    ['reading']
  )
  note(
    'Ideas',
    'Ideas backlog',
    `- Case studies as one long scroll
- A short newsletter for past clients, twice a year
- Portfolio refresh in January
- Teach a weekend workshop on design systems`,
    ['idea']
  )

  const JOURNAL = {
    [-2]: 'Moodboard done. Sent it to [[Lea Park]] for a first look.',
    [-3]: 'Slow morning, two chapters of Refactoring UI. Afternoon on the sitemap.',
    [-4]: 'Kickoff prep. Wrote down every question I have for Jonas.',
    [-5]: 'Booked the flights to Lisbon! Sam says the Alfama apartments go fast.',
    [-6]: 'Kickoff with Studio North. Good energy. They want fewer pages, not more.',
    [-7]: 'Long walk by the water, no screens. Needed that.',
    [-8]: 'Invoice #1 paid. Bought a new sketchbook to celebrate.',
    [-9]: 'Proposal sent to Studio North. Now we wait.',
    [-10]: 'Coffee with [[Sam Okafor]]. He is moving to Lisbon in spring.',
    [-12]: 'Tidied the portfolio: three projects out, two in.'
  }
  for (const [offset, text] of Object.entries(JOURNAL))
    cli('journal', 'write', day(Number(offset)), text)

  const event = (title, offset, start, end, extra = []) =>
    cli(
      'calendar',
      'events',
      'create',
      title,
      '--start',
      at(offset, start),
      '--end',
      at(offset, end),
      '--timezone',
      TIMEZONE,
      ...extra
    )
  event('Yoga', 0, '08:00', '09:00')
  event('Design review with Studio North', 0, '11:00', '12:00', ['--location', 'Zoom'])
  event('Weekly sync with Sam', 1, '10:00', '10:30')
  event('Dentist', 1, '16:00', '16:45')
  event('Brand workshop with Lea', 2, '13:00', '15:00', ['--location', 'Studio North'])
  event('Yoga', 3, '08:00', '09:00')
  event('Portfolio review', 3, '14:00', '15:00')
  event('Design meetup drinks', 4, '18:30', '20:30')
  cli(
    'calendar',
    'events',
    'create',
    'Lisbon',
    '--start',
    day(9),
    '--end',
    day(12),
    '--timezone',
    TIMEZONE,
    '--all-day',
    'true'
  )

  for (const text of [
    'Ask Lea for the brand fonts',
    'Idea: case studies as one long scroll',
    "Sam's book tip: Four Thousand Weeks"
  ])
    cli('inbox', 'capture', text)

  console.log(`Seeded the social base vault: ${vault}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--app')
  const app = path.resolve(i < 0 ? REPO : args.splice(i, 2)[1])
  if (!args[0]) throw new Error('Usage: seed.mjs <vault> [--app <checkout>]')
  seedBase({ app, vault: path.resolve(args[0]) })
}
