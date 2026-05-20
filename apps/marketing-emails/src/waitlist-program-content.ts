import type { WaitlistProgramEmailContent } from './waitlist-program-email'
import { WAITLIST_CAMPAIGNS } from './tracking-links'

export const scatteredWorkflowContent = {
  subject: 'Your notes, tasks, calendar, and journal should not live in four places',
  preview: 'The problem MemryNote is built around.',
  intro: [
    'Second email from me before launch.',
    'The thing I kept running into: notes in one app, tasks in another, calendar somewhere else, journal in a different place. Then I would spend half my day remembering where I put the work.',
    'MemryNote is built around a simpler idea: capture the thing once, then keep it connected.'
  ],
  listTitle: 'The first version focuses on a few pieces:',
  bullets: [
    'Inbox for quick capture',
    'Notes that can hold real tasks',
    'Daily journal pages for what happened today',
    'Calendar so dates do not disappear'
  ],
  outro: [
    'That is the product shipping end of June. Simple surface, local-first foundation, fewer places to check.',
    'Hit reply and tell me which part of your current workflow breaks most often. I read every reply.'
  ],
  campaign: WAITLIST_CAMPAIGNS.scatteredWorkflow
} as const satisfies WaitlistProgramEmailContent

export const workflowContent = {
  subject: 'How tasks, journal, and calendar connect in MemryNote',
  preview: 'A practical look at the daily workflow.',
  intro: [
    'This week I want to show the daily loop.',
    'In MemryNote, tasks can live inside notes. Daily journal entries can point back to real work. Calendar dates stay visible without becoming another app you have to maintain.'
  ],
  listTitle: 'The flow I care about:',
  bullets: [
    'Write something down',
    'Turn part of it into a task if needed',
    'See it again from today or from the calendar',
    'Search later and find the note, task, or journal entry from the same vault'
  ],
  outro: [
    'That is it. No big productivity system, just fewer places to check before you start working.',
    'If your day starts differently, reply and tell me. I want the launch defaults to match real workflows.'
  ],
  campaign: WAITLIST_CAMPAIGNS.workflow
} as const satisfies WaitlistProgramEmailContent

export const localFirstAiContent = {
  subject: 'Local-first, private by default, AI when useful',
  preview: 'How MemryNote handles privacy, offline work, and the agent.',
  intro: [
    'A lot of people on the waitlist asked the same privacy question, so I want to answer it clearly.',
    'MemryNote is local-first. Your vault starts on your machine. It works offline. Sync is optional and end-to-end encrypted when you turn it on.'
  ],
  listTitle: 'The shape is:',
  bullets: [
    'Local by default',
    'Encrypted before sync leaves the device',
    'Server does not need plaintext notes',
    'AI agent only when you ask for it'
  ],
  outro: [
    'I want MemryNote to feel boring in the right ways: fast, private, offline, no cloud lock-in.',
    'Next week I will send launch-week details for waitlist folks.'
  ],
  campaign: WAITLIST_CAMPAIGNS.localFirstAi
} as const satisfies WaitlistProgramEmailContent

export const launchWeekContent = {
  subject: 'MemryNote launches next week',
  preview: 'What waitlist members get on launch day.',
  intro: [
    'MemryNote launches next week.',
    'The desktop app is free to download. The paid plan is for encrypted sync across devices. Waitlist members get 25% off your first year on an annual plan.'
  ],
  listTitle: 'On launch day I will send:',
  bullets: [
    'Download link',
    'Waitlist discount code',
    'Sync checkout link',
    'Short getting-started path'
  ],
  outro: [
    'No code to save today. I will send it when checkout opens.',
    'If you already know what you want to test first, reply with it.',
    'See you next week.'
  ],
  campaign: WAITLIST_CAMPAIGNS.launchWeek
} as const satisfies WaitlistProgramEmailContent

export const gettingStartedContent = {
  subject: 'First 10 minutes in MemryNote',
  preview: 'What to do after download.',
  intro: [
    'If you downloaded MemryNote, start small.',
    'The app gets useful fastest when you bring one real workflow into it instead of trying to migrate everything.',
    'Here is the path I recommend for the first 10 minutes.'
  ],
  listTitle: 'Start here:',
  bullets: [
    'create one note for something active',
    'drop three tasks into that note',
    'open today in the journal and write what matters',
    'add one date so the calendar has something real to show',
    'search for the note and make sure it feels fast'
  ],
  outro: [
    'That is enough. You will learn more from one real day in the app than from a big import.',
    'Hit reply if the first-run flow feels confusing. Those fixes are high priority.'
  ],
  campaign: WAITLIST_CAMPAIGNS.gettingStarted
} as const satisfies WaitlistProgramEmailContent

export const useCasesContent = {
  subject: 'Four ways to use MemryNote',
  preview: 'Builders, founders, researchers, and students use the same core loop.',
  intro: [
    'A few people asked what MemryNote is best for after the first day.',
    'The honest answer: it is strongest when notes and action keep touching each other.',
    'Here are four good starting patterns.'
  ],
  listTitle: 'Use it for:',
  bullets: [
    'builders tracking decisions, bugs, and product notes in one vault',
    'founders keeping customer calls, tasks, and launch ideas connected',
    'researchers linking reading notes to projects and follow-up questions',
    'students keeping lecture notes, assignments, and exam prep searchable offline'
  ],
  outro: [
    'You do not need a perfect system. Pick one active project and let the structure grow from real work.',
    'Reply with your use case if it is different. I want the examples on the site to match how people actually use it.'
  ],
  campaign: WAITLIST_CAMPAIGNS.useCases
} as const satisfies WaitlistProgramEmailContent

export const feedbackContent = {
  subject: 'What should I fix next?',
  preview: 'Reply with bugs, sharp edges, or the thing you wanted most.',
  intro: [
    "Now that MemryNote is in people's hands, direct feedback is the most useful thing.",
    'I am especially interested in anything that made you hesitate: confusing setup, missing import path, rough sync flow, unclear pricing, or a feature you expected to find but did not.'
  ],
  listTitle: 'Send me:',
  bullets: [
    'one bug that blocked you',
    'one workflow that felt slower than your current app',
    'one feature that would make MemryNote easier to recommend',
    'one sentence I should use to explain the product better'
  ],
  outro: [
    'Short replies are perfect. Screenshots are even better.',
    'I will use this batch to decide what gets fixed before the next public update.'
  ],
  campaign: WAITLIST_CAMPAIGNS.feedback
} as const satisfies WaitlistProgramEmailContent
