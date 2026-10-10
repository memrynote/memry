import type { Clock } from '../clock.ts'
import type { TaskSpec } from '../specs.ts'
import { launchDay } from './dates.ts'

/** Offset of the next Friday after today (1-7). */
const nextFriday = (clock: Clock): number => (5 - clock.weekday(0) + 7) % 7 || 7

export function taskSpecs(clock: Clock): TaskSpec[] {
  const friday = nextFriday(clock)
  return [
    // Aurora launch: one task per board column, plus a three-level tree.
    {
      key: 'a-reading-view',
      title: 'Finalize reading view typography',
      project: 'aurora',
      status: 'Design',
      priority: 3,
      due: 1,
      start: -4,
      tags: ['design'],
      notes: ['typography-spec', 'reading-critique'],
      canvases: ['aurora-map'],
      created: 12
    },
    {
      key: 'a-onboarding',
      title: 'Design onboarding: three screens max',
      project: 'aurora',
      status: 'Design',
      priority: 2,
      due: 4,
      start: -3,
      tags: ['design'],
      notes: ['aurora-prd'],
      created: 9
    },
    {
      key: 'a-empty-copy',
      title: 'Write empty-state copy',
      project: 'aurora',
      status: 'Design',
      priority: 1,
      due: 3,
      source: 'aurora-prd',
      created: 8
    },
    {
      key: 'a-reading-speed',
      title: 'Measure reading speed in beta',
      project: 'aurora',
      status: 'Build',
      priority: 2,
      due: 11,
      source: 'aurora-prd',
      created: 8
    },
    {
      key: 'a-highlight-export',
      title: 'Highlight export to Markdown',
      project: 'aurora',
      status: 'Build',
      priority: 2,
      start: 2,
      due: 9,
      description: 'One file per article. Front matter: title, author, source URL, date read.',
      notes: ['decision-log'],
      created: 20
    },
    {
      key: 'a-offline',
      title: 'Fix offline queue race for highlights',
      project: 'aurora',
      status: 'Build',
      priority: 3,
      due: -2,
      tags: ['aurora/beta'],
      source: 'weekly-1',
      created: 6
    },
    {
      key: 'a-contrast',
      title: 'Contrast audit for night theme',
      project: 'aurora',
      status: 'Review',
      priority: 3,
      due: 0,
      dueTime: '14:00',
      tags: ['design'],
      source: 'weekly-1',
      created: 6
    },
    {
      key: 'a-font-fallback',
      title: 'Fix serif fallback on Android',
      project: 'aurora',
      status: 'Review',
      priority: 3,
      due: -1,
      tags: ['aurora/beta'],
      created: 15
    },
    {
      key: 'a-beta-invites',
      title: 'Send beta wave 2 invites',
      project: 'aurora',
      status: 'Backlog',
      priority: 1,
      due: 7,
      tags: ['aurora/beta'],
      created: 10
    },
    {
      key: 'a-screenshots',
      title: 'App Store screenshots',
      project: 'aurora',
      status: 'Backlog',
      priority: 2,
      due: 21,
      created: 18
    },
    {
      key: 'a-press',
      title: 'Draft press kit',
      project: 'aurora',
      status: 'Backlog',
      priority: 1,
      created: 18
    },
    {
      key: 'a-launch',
      title: 'Ship Aurora 1.0',
      project: 'aurora',
      status: 'Backlog',
      priority: 4,
      due: launchDay(clock),
      notes: ['aurora-brief'],
      canvases: ['aurora-map'],
      created: 40
    },
    {
      key: 'a-freeze-copy',
      title: 'Freeze all UI copy',
      project: 'aurora',
      status: 'Backlog',
      parent: 'a-launch',
      priority: 2,
      due: 28,
      created: 40
    },
    {
      key: 'a-release-notes',
      title: 'Write release notes',
      project: 'aurora',
      status: 'Backlog',
      parent: 'a-launch',
      priority: 2,
      due: 33,
      created: 40
    },
    {
      key: 'a-beta-quotes',
      title: 'Collect quotes from beta readers',
      project: 'aurora',
      status: 'Backlog',
      parent: 'a-release-notes',
      priority: 1,
      due: 30,
      notes: ['beta-retro'],
      created: 9
    },
    {
      key: 'a-critique',
      title: 'Run reading view critique',
      project: 'aurora',
      status: 'Done',
      priority: 2,
      completed: 6,
      notes: ['reading-critique'],
      created: 16
    },
    {
      key: 'a-sync-decision',
      title: 'Decide how highlights sync',
      project: 'aurora',
      status: 'Done',
      priority: 3,
      completed: 12,
      notes: ['decision-log'],
      created: 26
    },
    {
      key: 'a-retro',
      title: 'Write up beta retro',
      project: 'aurora',
      status: 'Done',
      priority: 1,
      completed: 9,
      notes: ['beta-retro'],
      created: 13
    },
    {
      key: 'a-icons',
      title: 'Icon set v2',
      project: 'aurora',
      status: 'Done',
      priority: 2,
      completed: 18,
      tags: ['design'],
      created: 34
    },
    {
      key: 'a-interviews',
      title: 'Synthesize reader interviews',
      project: 'aurora',
      status: 'Done',
      priority: 2,
      completed: 47,
      notes: ['aurora-brief'],
      created: 57
    },

    // Studio ops: recurring work.
    {
      key: 's-standup',
      title: 'Post standup notes',
      project: 'studio',
      priority: 1,
      due: 0,
      dueTime: '09:25',
      repeat: { frequency: 'weekly', interval: 1, daysOfWeek: [1, 2, 3, 4, 5] },
      created: 70
    },
    {
      key: 's-weekly-review',
      title: 'Weekly review',
      project: 'studio',
      priority: 2,
      due: friday,
      dueTime: '16:00',
      tags: ['weekly-review'],
      repeat: { frequency: 'weekly', interval: 1, daysOfWeek: [5] },
      notes: ['studio-rituals'],
      created: 70
    },
    {
      key: 's-rent',
      title: 'Pay coworking rent',
      project: 'studio',
      priority: 2,
      due: dayOfMonthOffset(clock, 1),
      repeat: { frequency: 'monthly', interval: 1, dayOfMonth: 1 },
      created: 65
    },
    {
      key: 's-invoices',
      title: 'Send client invoices',
      project: 'studio',
      priority: 3,
      due: -3,
      created: 8
    },
    {
      key: 's-portfolios',
      title: 'Review portfolio submissions',
      project: 'studio',
      status: 'In Progress',
      priority: 2,
      due: 2,
      notes: ['hiring'],
      created: 14
    },
    {
      key: 's-fonts',
      title: 'Renew font licenses',
      project: 'studio',
      priority: 2,
      due: 12,
      created: 11
    },
    {
      key: 's-offsite',
      title: 'Book a venue for the studio offsite',
      project: 'studio',
      priority: 1,
      created: 5
    },
    {
      key: 's-old-files',
      title: 'Archive old project files',
      project: 'studio',
      archived: true,
      completed: 30,
      created: 45
    },

    // Website v1 (archived project).
    {
      key: 'w-launch',
      title: 'Launch marketing site',
      project: 'website',
      priority: 3,
      completed: 82,
      notes: ['website-postmortem'],
      created: 89
    },
    {
      key: 'w-footer',
      title: 'Fix footer links',
      project: 'website',
      priority: 1,
      completed: 80,
      created: 84
    },

    // Personal, in the built-in Inbox project.
    {
      key: 'p-passport',
      title: 'Check passport expiry',
      priority: 2,
      due: 5,
      tags: ['travel'],
      source: 't-packing',
      created: 14
    },
    {
      key: 'p-permits',
      title: 'Reserve backcountry permit',
      priority: 3,
      due: 2,
      dueTime: '08:00',
      tags: ['travel'],
      source: 't-packing',
      notes: ['t-trip'],
      created: 14
    },
    {
      key: 'p-boots',
      title: 'Break in new hiking boots',
      priority: 1,
      start: -5,
      due: 14,
      tags: ['travel', 'hiking'],
      created: 7
    },
    {
      key: 'p-car',
      title: 'Confirm rental car',
      priority: 2,
      due: 10,
      tags: ['travel'],
      notes: ['t-trip'],
      created: 9
    },
    {
      key: 'p-call-mum',
      title: 'Call Mum',
      priority: 2,
      due: (7 - clock.weekday(0)) % 7,
      repeat: { frequency: 'weekly', interval: 1, daysOfWeek: [0] },
      created: 60
    },
    {
      key: 'p-fig',
      title: 'Water the fig tree',
      priority: 0,
      due: 1,
      repeat: { frequency: 'daily', interval: 3 },
      created: 50
    },
    {
      key: 'p-outline',
      title: 'Outline essay section on the loop',
      priority: 3,
      due: 0,
      tags: ['essay'],
      notes: ['x-draft', 'r-capcom'],
      source: 'journal:0',
      created: 0
    },
    {
      key: 'p-hidden-figures',
      title: 'Get Hidden Figures from the library',
      priority: 1,
      due: 1,
      tags: ['essay', 'reading'],
      source: 'journal:0',
      notes: ['b-shetterly'],
      created: 0
    },
    {
      key: 'p-safire-quote',
      title: 'Transcribe the Safire memo quote',
      priority: 2,
      tags: ['essay'],
      source: 'r-safire',
      completed: 2,
      created: 5
    },
    { key: 'p-library', title: 'Return library books', priority: 1, due: -4, created: 20 },
    {
      key: 'p-groceries',
      title: 'Buy groceries for risotto night',
      priority: 2,
      due: 0,
      dueTime: '18:00',
      source: 'k-grocery',
      notes: ['k-risotto'],
      created: 2
    },
    {
      key: 'p-editor',
      title: 'Send essay draft to the editor',
      priority: 4,
      due: 14,
      tags: ['essay'],
      notes: ['x-draft'],
      canvases: ['essay-board'],
      created: 21
    },
    { key: 'p-gym', title: 'Cancel old gym membership', priority: 0, archived: true, created: 40 },

    // Delegated work: the #waiting tag's "Waiting on" field points at a person.
    {
      key: 'w-priya-contrast',
      title: 'Night theme contrast numbers',
      project: 'aurora',
      status: 'Review',
      priority: 2,
      due: 1,
      tags: ['waiting', 'design'],
      waitingOn: 'pe-priya',
      notes: ['reading-critique'],
      created: 4
    },
    {
      key: 'w-northlight-export',
      title: 'Confirm which documents the data export covers',
      project: 'studio',
      priority: 3,
      due: 3,
      tags: ['waiting'],
      waitingOn: 'pe-anouk',
      notes: ['northlight-kickoff'],
      created: 11
    },
    {
      key: 'w-brightwater-quote',
      title: 'Signed pilot quote from Brightwater',
      project: 'studio',
      priority: 2,
      due: 7,
      tags: ['waiting'],
      waitingOn: 'pe-marcus',
      notes: ['brightwater-call'],
      created: 2
    },
    {
      key: 'w-editor-outline',
      title: "Harriet's notes on the essay outline",
      priority: 2,
      due: 10,
      tags: ['waiting', 'essay'],
      waitingOn: 'pe-harriet',
      notes: ['x-draft'],
      created: 6
    },
    {
      key: 'w-jonah-dates',
      title: 'Jonah to confirm his flight dates',
      priority: 1,
      due: 5,
      tags: ['waiting', 'travel'],
      waitingOn: 'pe-jonah',
      notes: ['t-trip'],
      created: 3
    },

    // The Notes 101 lists note's live task lines.
    {
      key: 'g-try',
      title: 'Tick me off, then find me on the Tasks page',
      priority: 1,
      tags: ['notes-101'],
      source: 'n-lists',
      created: 0
    },
    {
      key: 'g-try-sub',
      title: 'Subtasks nest under their task',
      parent: 'g-try',
      tags: ['notes-101'],
      source: 'n-lists',
      created: 0
    },
    {
      key: 'g-read',
      title: 'Open the welcome note',
      tags: ['notes-101'],
      source: 'n-lists',
      completed: 0,
      created: 0
    }
  ]
}

/** Offset of the next day-of-month `day` after today. */
function dayOfMonthOffset(clock: Clock, day: number): number {
  const now = clock.now
  const next = new Date(now.getFullYear(), now.getMonth() + 1, day)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((next.getTime() - today.getTime()) / 86_400_000)
}
