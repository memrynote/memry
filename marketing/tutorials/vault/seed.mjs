#!/usr/bin/env node
/**
 * Builds the tutorial vault: one freelance designer's real-looking week, holding exactly what
 * the Tasks & Projects tutorial shows. Every write goes through the memrynote CLI, so the data
 * is what the app itself would write. Dates are relative to today, so Today and This Week are
 * full on any recording day.
 *
 *   node marketing/tutorials/vault/seed.mjs [/tmp/memry-tutorials/vault/Tutorial]
 *
 * The CLI runs under Electron's Node because the native modules are built for Electron.
 * MEMRY_APP=<checkout> uses that checkout's CLI, so the data matches the build being filmed.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const VAULT = path.resolve(process.argv[2] ?? '/tmp/memry-tutorials/vault/Tutorial')
const APP = path.resolve(process.env.MEMRY_APP ?? ROOT)
const ELECTRON = createRequire(path.join(APP, 'apps/desktop/package.json'))('electron')
const CLI = path.join(APP, 'apps/cli/src/index.ts')

function cli(...args) {
  const r = spawnSync(
    ELECTRON,
    [
      '--no-warnings',
      '--experimental-strip-types',
      '--experimental-transform-types',
      CLI,
      '--vault',
      VAULT,
      '--json',
      ...args
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }
  )
  if (r.status !== 0) throw new Error(`memrynote ${args.join(' ')}\n${r.stderr || r.stdout}`)
  return r.stdout.trim() ? JSON.parse(r.stdout) : null
}

const pad = (n) => String(n).padStart(2, '0')
const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const PRIORITY = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }
const repeat = (frequency, extra = {}) =>
  JSON.stringify({
    frequency,
    interval: 1,
    endType: 'never',
    completedCount: 0,
    createdAt: new Date().toISOString(),
    ...extra
  })

if (fs.existsSync(VAULT)) {
  if (!VAULT.startsWith('/tmp/') && !VAULT.startsWith(fs.realpathSync('/tmp'))) {
    throw new Error(`Refusing to overwrite ${VAULT}; pass a fresh path or one under /tmp`)
  }
  fs.rmSync(VAULT, { recursive: true, force: true })
}
fs.mkdirSync(VAULT, { recursive: true })
cli('vault', 'init')
cli('vault', 'update-config', JSON.stringify({ title: 'Maya' }))

// ---------------------------------------------------------------- projects
function project(name, color, icon, statuses) {
  const p = cli('projects', 'create', name, '--color', color, '--icon', icon)
  const byName = {}
  const existing = cli('projects', 'statuses', p.id)
  if (statuses) {
    // Default workflow is To Do / In Progress / Done; reshape it into the project's own.
    const [todo, doing, done] = existing
    cli('projects', 'status-update', todo.id, '--name', statuses[0])
    cli('projects', 'status-update', doing.id, '--name', statuses[1], '--color', '#8b5cf6')
    const extra = statuses
      .slice(2, -1)
      .map((n) => cli('projects', 'status-create', p.id, n, '--color', '#f59e0b'))
    cli('projects', 'status-update', done.id, '--name', statuses.at(-1))
    cli(
      'projects',
      'status-reorder',
      todo.id,
      doing.id,
      ...extra.map((s) => s.id),
      done.id,
      ...[0, 1, ...extra.map((_, i) => i + 2), extra.length + 2].flatMap((i) => [
        '--position',
        String(i)
      ])
    )
  }
  let doneStatus
  for (const s of cli('projects', 'statuses', p.id)) {
    byName[s.name] = s.id
    if (s.isDone) doneStatus = s.name
  }
  return { id: p.id, status: byName, doneStatus }
}

const web = project('Website Redesign', '#0ea5e9', '🎨', ['Backlog', 'Design', 'Review', 'Done'])
const lisbon = project('Lisbon Trip', '#f59e0b', '✈️')
const home = project('Home', '#10b981', '🏡')

// ---------------------------------------------------------------- notes
const note = (title, content, props = {}, tags = []) =>
  cli(
    'notes',
    'create',
    title,
    '--content',
    content,
    '--properties',
    JSON.stringify(props),
    ...tags.flatMap((t) => ['--tag', t])
  )

const brief = note(
  'Website Redesign Brief',
  `## Goal
A calmer, faster site for Studio North that turns visitors into enquiries.

## Scope
- New homepage with a single clear hero
- Case study template
- Style guide page the team can keep using

## Timeline
Design sign-off at the end of next week, launch two weeks later.

## Contacts
Jonas (founder), Lea (marketing)`,
  { project: ['Website Redesign'] },
  ['client']
)
note(
  'Studio North Kickoff',
  `Met Jonas and Lea.

- They want fewer pages, not more
- Case studies are the main sales tool
- Current site feels "heavy" on mobile

Next: moodboard and a sitemap draft.`,
  { project: ['Website Redesign'] },
  ['meeting']
)
const packing = note(
  'Lisbon Packing List',
  `- Passport
- Travel adapter
- Comfortable shoes (hills!)
- Light jacket for the evenings
- Camera + charger`,
  { project: ['Lisbon Trip'] }
)
note(
  'Lisbon Ideas',
  `## Eat
- Time Out Market
- Pastéis de Belém

## See
- Alfama at sunset
- Day trip to Sintra
- LX Factory on Sunday`,
  { project: ['Lisbon Trip'] }
)
// The demo film: notes linked to each other, so the graph has a shape, and one to write in.
note(
  'Homepage Ideas',
  `Lead with one calm line, then the work.

Pulled from [[Studio North Kickoff]] and [[Design Principles]].

Next steps`,
  { project: ['Website Redesign'] }
)
note(
  'Design Principles',
  `- Fewer pages, more clarity
- Mobile first, see [[Homepage Ideas]]
- Borrow from [[Reading List]]`
)
note(
  'Lisbon Itinerary',
  `Day 1 in Alfama, day 2 in Sintra. Ideas in [[Lisbon Ideas]], bags per [[Lisbon Packing List]].`,
  { project: ['Lisbon Trip'] }
)
note(
  'Reading List',
  `- Refactoring UI
- The Design of Everyday Things
- Shape Up`
)

// ---------------------------------------------------------------- tasks
const task = (title, o = {}) =>
  cli(
    'tasks',
    'create',
    title,
    ...(o.project ? ['--project', o.project.id] : []),
    ...(o.status ? ['--status', o.project.status[o.status]] : []),
    ...(o.parent ? ['--parent', o.parent] : []),
    ...(o.due !== undefined ? ['--due', day(o.due)] : []),
    ...(o.time ? ['--due-time', o.time] : []),
    ...(o.start !== undefined ? ['--start', day(o.start)] : []),
    ...(o.repeat ? ['--repeat', o.repeat, '--repeat-from', 'due'] : []),
    '--priority',
    String(PRIORITY[o.priority ?? 'none']),
    ...(o.description ? ['--description', o.description] : []),
    ...(o.tags ?? []).flatMap((t) => ['--tag', t]),
    ...(o.notes ?? []).flatMap((n) => ['--link-note', n])
  )
// `tasks complete` sets completedAt without moving the status (CLI parity gap), and the app reads
// the status, so a finished task is created in its project's done status and then completed.
const done = (t) => cli('tasks', 'complete', t.id)
const finished = (title, o) => done(task(title, { ...o, status: o.project.doneStatus }))

// Website Redesign (the board scene)
const hero = task('Finalize homepage hero', {
  project: web,
  status: 'Design',
  start: -2,
  due: 1,
  priority: 'high',
  tags: ['client'],
  notes: [brief.id],
  description: 'Two headline options, one photo, one button. Keep it calm.'
})
finished('Pick hero photo', { project: web, parent: hero.id })
task('Write headline options', { project: web, parent: hero.id })
task('Export assets for dev', { project: web, parent: hero.id })
task('Client review call', {
  project: web,
  status: 'Review',
  due: 0,
  time: '15:00',
  priority: 'medium',
  tags: ['client']
})
task('Send invoice #2', { project: web, status: 'Backlog', due: -1, priority: 'urgent' })
task('Mobile navigation', { project: web, status: 'Design', due: 2, priority: 'high' })
task('Draft sitemap', { project: web, status: 'Review', due: 3, priority: 'medium' })
task('Build style guide page', { project: web, status: 'Backlog', due: 5, priority: 'medium' })
task('Case study template', { project: web, status: 'Backlog', due: 8, priority: 'low' })
task('Accessibility pass', { project: web, status: 'Backlog', due: 10, priority: 'medium' })
finished('Kickoff with Studio North', { project: web, due: -6 })
finished('Moodboard', { project: web, due: -3 })

// Lisbon Trip (the hub scene)
finished('Book flights', { project: lisbon, due: -5, priority: 'high' })
task('Renew passport', { project: lisbon, due: -2, priority: 'high' })
task('Book apartment in Alfama', { project: lisbon, due: 0, priority: 'high' })
task('Buy a travel adapter', { project: lisbon, due: 3, priority: 'low', notes: [packing.id] })
task('Reserve dinner at Time Out Market', { project: lisbon, due: 4 })
task('Plan the Sintra day trip', { project: lisbon, due: 6, priority: 'medium' })

// Home (repeats)
const dom = new Date()
dom.setDate(dom.getDate() + 2)
task('Pay rent', {
  project: home,
  due: 2,
  priority: 'high',
  repeat: repeat('monthly', { monthlyType: 'dayOfMonth', dayOfMonth: dom.getDate() })
})
const sat = new Date()
sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7))
task('Take out the recycling', {
  project: home,
  due: Math.round((sat - new Date()) / 864e5),
  repeat: repeat('weekly', { daysOfWeek: [6] })
})
task('Call Mom', { project: home, due: 1 })
task('Fix the bathroom tap', { project: home, due: 5, priority: 'low' })

// Inbox
task('Reply to Jonas about the workshop', { due: 0, priority: 'medium' })
task('Renew the portfolio domain', { due: 4 })
task('Read Refactoring UI, chapter 3', { due: 7, priority: 'low' })
task('Back up the laptop', {})

// ---------------------------------------------------------------- inbox
// One waiting capture, so the Home inbox widget is not empty on a fresh vault.
cli('inbox', 'capture', 'Look up Sintra day trip tickets')

// ---------------------------------------------------------------- journal
cli(
  'journal',
  'write',
  day(-1),
  'Long design day. The hero finally feels right: one photo, one line, one button.\n\nLisbon flights are booked.'
)
cli('journal', 'write', day(0), 'Client call at 3. Want the sitemap in their hands before then.')

const tasks = cli('tasks', 'list', '--completed')
console.log(
  `Seeded ${VAULT}: ${cli('projects', 'list').length} projects, ${tasks.length ?? tasks.tasks?.length} tasks`
)
