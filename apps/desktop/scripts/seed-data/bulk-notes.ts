/**
 * Deterministic bulk note generator for benchmark vaults.
 *
 * The demo seed (`seed-data/notes.ts`) is hand-authored and stays small so the
 * screenshots read well. Benchmarks need the opposite: a lot of notes, each with
 * a realistic body (headings, lists, tables, checkboxes, code, wiki-links) so
 * indexing, search, and the graph all get real work to do.
 *
 * Everything here is driven by a seeded PRNG: the same `--seed` and `--count`
 * produce a byte-identical vault, so two benchmark runs compare like for like.
 */

import type { NoteFile } from '../seed-vault/file-writer'
import { seedPastISOAt } from './date'

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, and stable across Node versions. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length) % items.length]

/** Distinct picks, capped at the pool size. */
function pickMany<T>(rng: () => number, items: readonly T[], count: number): T[] {
  const wanted = Math.min(count, items.length)
  const chosen: T[] = []
  while (chosen.length < wanted) {
    const candidate = pick(rng, items)
    if (!chosen.includes(candidate)) chosen.push(candidate)
  }
  return chosen
}

const NOTE_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Same shape as `generateNoteId()` (12 lowercase alphanumerics), but seeded. */
function rngNoteId(rng: () => number): string {
  let id = ''
  for (let i = 0; i < 12; i++) id += NOTE_ID_ALPHABET[Math.floor(rng() * NOTE_ID_ALPHABET.length)]
  return id
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

interface Topic {
  folder: string
  icon: string
  tags: string[]
  subjects: string[]
  qualifiers: string[]
  systems: string[]
  actions: string[]
  artifacts: string[]
  metrics: string[]
  people: string[]
  questions: string[]
  /** Fenced code / config blocks that fit this topic. */
  snippets: string[]
}

const ENGINEERING_SNIPPETS = [
  `\`\`\`ts
export async function drainQueue(batchSize = 64): Promise<number> {
  let drained = 0
  for (;;) {
    const batch = await queue.take(batchSize)
    if (batch.length === 0) return drained
    await Promise.all(batch.map((job) => job.run()))
    drained += batch.length
  }
}
\`\`\``,
  `\`\`\`sql
SELECT path, count(*) AS revisions
FROM note_history
WHERE modified_at > date('now', '-30 day')
GROUP BY path
HAVING revisions > 5
ORDER BY revisions DESC
LIMIT 25;
\`\`\``,
  `\`\`\`bash
# reproduce the slow path locally
pnpm build
NODE_OPTIONS=--max-old-space-size=4096 node dist/bench.js --iterations 200
\`\`\``,
  `\`\`\`ts
const withRetry = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await sleep(2 ** i * 250)
    }
  }
  throw lastError
}
\`\`\``
]

const OPS_SNIPPETS = [
  `\`\`\`yaml
readiness:
  path: /healthz
  initialDelaySeconds: 15
  periodSeconds: 10
  failureThreshold: 3
\`\`\``,
  `\`\`\`bash
# 95th percentile latency for the last hour
curl -s "$METRICS/query?q=histogram_quantile(0.95, rate(request_ms_bucket[1h]))" | jq '.data.result'
\`\`\``,
  `\`\`\`json
{
  "retention_days": 30,
  "max_batch_bytes": 4194304,
  "backoff": { "initial_ms": 250, "max_ms": 30000 }
}
\`\`\``
]

const ANALYSIS_SNIPPETS = [
  `\`\`\`python
rolling = df.set_index("day")["value"].rolling("14d").mean()
print(rolling.describe())
\`\`\``,
  `\`\`\`text
baseline   p50 = 42ms   p95 = 180ms
candidate  p50 = 31ms   p95 = 96ms
delta      -26%         -47%
\`\`\``
]

const TOPICS: Topic[] = [
  {
    folder: 'engineering',
    icon: '💻',
    tags: ['engineering', 'backend', 'performance', 'refactor', 'review'],
    subjects: [
      'Streaming ingest',
      'Query planner',
      'Background worker pool',
      'Cache invalidation',
      'Schema migration',
      'Retry policy',
      'Connection pooling',
      'Serialization layer',
      'Feature flag rollout',
      'Error budget',
      'Batch writer',
      'Index rebuild',
      'Conflict resolution',
      'Startup path'
    ],
    qualifiers: [
      'design notes',
      'walkthrough',
      'post-mortem',
      'benchmark run',
      'refactor plan',
      'failure modes',
      'rollout checklist',
      'open questions',
      'second pass',
      'cleanup pass'
    ],
    systems: [
      'the ingest pipeline',
      'the local database',
      'the sync worker',
      'the indexer',
      'the renderer bridge',
      'the migration runner',
      'the scheduler'
    ],
    actions: [
      'batches writes instead of committing per row',
      'falls back to a linear scan once the index is cold',
      'holds the transaction open longer than it should',
      'retries with exponential backoff and full jitter',
      'drops the oldest entry when the buffer fills',
      'defers work until the first idle frame'
    ],
    artifacts: ['a benchmark harness', 'a migration script', 'a regression test', 'a design doc'],
    metrics: ['p95 latency', 'peak memory', 'rows per second', 'cold start time', 'queue depth'],
    people: ['Dana', 'Ravi', 'Marta', 'Sam', 'Elif'],
    questions: [
      'Do we need a feature flag, or is the rollback path fast enough on its own?',
      'What happens when the queue is drained while a write is still in flight?',
      'Is the slow path worth optimising, or is it rare enough to leave alone?',
      'Which of these numbers survive on a cold machine rather than a warm one?'
    ],
    snippets: ENGINEERING_SNIPPETS
  },
  {
    folder: 'research',
    icon: '🔬',
    tags: ['research', 'reading', 'analysis', 'notes'],
    subjects: [
      'Vector search tradeoffs',
      'Incremental indexing',
      'Consistency models',
      'Text chunking',
      'Ranking signals',
      'Embedding drift',
      'Compression formats',
      'Local-first storage',
      'Graph traversal',
      'Query expansion',
      'Snapshot isolation',
      'Approximate counting'
    ],
    qualifiers: [
      'literature notes',
      'summary',
      'experiment log',
      'comparison',
      'first read',
      'second read',
      'open threads',
      'annotated bibliography'
    ],
    systems: [
      'the paper',
      'the reference implementation',
      'the benchmark suite',
      'the sample dataset',
      'the follow-up study'
    ],
    actions: [
      'trades recall for a much smaller index',
      'assumes the working set fits in memory',
      'only holds when writes are single-writer',
      'degrades gracefully as the corpus grows',
      'needs a full rebuild whenever the schema changes'
    ],
    artifacts: ['a replication attempt', 'a summary table', 'a reading list', 'a short write-up'],
    metrics: ['recall@10', 'index size', 'build time', 'query latency', 'memory footprint'],
    people: ['the authors', 'the reviewers', 'a follow-up paper', 'the original team'],
    questions: [
      'Does the result hold at ten times the corpus size?',
      'How much of the win comes from the hardware rather than the method?',
      'Is the baseline they compare against actually tuned?'
    ],
    snippets: ANALYSIS_SNIPPETS
  },
  {
    folder: 'meetings',
    icon: '🗓️',
    tags: ['meetings', 'notes', 'decisions', 'follow-up'],
    subjects: [
      'Weekly sync',
      'Planning session',
      'Design review',
      'Incident review',
      'Roadmap check-in',
      'Vendor call',
      'Onboarding session',
      'Retro',
      'Budget review',
      'Support triage'
    ],
    qualifiers: [
      'notes',
      'decisions',
      'action items',
      'raw notes',
      'summary',
      'follow-ups',
      'recap'
    ],
    systems: ['the team', 'the working group', 'the wider org', 'the support rotation'],
    actions: [
      'agreed to revisit the scope before the next cycle',
      'pushed the deadline out by a week to absorb review time',
      'split the work into two tracks that can land independently',
      'asked for a written summary before committing'
    ],
    artifacts: ['an action list', 'a decision log', 'a follow-up thread', 'a shared doc'],
    metrics: ['open items', 'time to decision', 'attendance', 'carry-over count'],
    people: ['Dana', 'Ravi', 'Marta', 'Sam', 'Elif', 'Jonas'],
    questions: [
      'Who owns the follow-up if the original owner is out next week?',
      'Is this a decision, or a preference we can revisit later?',
      'Do we need everyone in the room, or is a written update enough?'
    ],
    snippets: []
  },
  {
    folder: 'product',
    icon: '📦',
    tags: ['product', 'planning', 'feedback', 'scope'],
    subjects: [
      'Onboarding flow',
      'Search experience',
      'Pricing page',
      'Empty states',
      'Quick capture',
      'Sharing model',
      'Import path',
      'Notification rules',
      'Trial conversion',
      'Mobile parity'
    ],
    qualifiers: [
      'brief',
      'scope cut',
      'user feedback',
      'success metrics',
      'open questions',
      'v2 notes',
      'launch checklist'
    ],
    systems: ['the first-run flow', 'the sidebar', 'the composer', 'the settings screen'],
    actions: [
      'asks for too much before showing any value',
      'hides the one action people came for',
      'reads well on a large screen and badly on a small one',
      'works, but only once you already know it exists'
    ],
    artifacts: ['a one-pager', 'a click-through prototype', 'a metrics plan', 'a scope cut list'],
    metrics: ['activation rate', 'time to first note', 'weekly retention', 'support volume'],
    people: ['early users', 'the beta group', 'support', 'the design review'],
    questions: [
      'What is the smallest version of this that still helps someone?',
      'Are we solving the reported problem or the one we find interesting?',
      'What do we cut first if the schedule slips?'
    ],
    snippets: []
  },
  {
    folder: 'design',
    icon: '🎨',
    tags: ['design', 'ui', 'typography', 'polish'],
    subjects: [
      'Spacing scale',
      'Type ramp',
      'Colour tokens',
      'Focus states',
      'Motion rules',
      'Dark mode pass',
      'Iconography',
      'Density options',
      'Empty state art',
      'Form patterns'
    ],
    qualifiers: [
      'audit',
      'proposal',
      'critique notes',
      'before and after',
      'token list',
      'accessibility pass'
    ],
    systems: ['the sidebar', 'the editor surface', 'the dialog stack', 'the settings panel'],
    actions: [
      'reads as noisy once three of them sit next to each other',
      'loses contrast against the paper background',
      'is fine at the default size and breaks at the largest one',
      'animates a property that forces a repaint'
    ],
    artifacts: ['a token table', 'a annotated screenshot set', 'a spec', 'a review checklist'],
    metrics: ['contrast ratio', 'tap target size', 'frame time', 'number of tokens'],
    people: ['the design review', 'the accessibility check', 'a fresh pair of eyes'],
    questions: [
      'Does this still hold up in the right-to-left layout?',
      'Is the restraint here reading as calm or as unfinished?',
      'Which of these tokens is actually used more than once?'
    ],
    snippets: [
      `\`\`\`css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --radius-card: 10px;
}
\`\`\``
    ]
  },
  {
    folder: 'ops',
    icon: '🛠️',
    tags: ['ops', 'infra', 'monitoring', 'release'],
    subjects: [
      'Release checklist',
      'Alert tuning',
      'Backup restore drill',
      'Certificate rotation',
      'Log retention',
      'Rate limit policy',
      'Deploy rollback',
      'Cost review',
      'Capacity plan',
      'On-call handover'
    ],
    qualifiers: ['runbook', 'drill notes', 'incident notes', 'checklist', 'review', 'follow-ups'],
    systems: ['the deploy pipeline', 'the metrics stack', 'the edge cache', 'the backup job'],
    actions: [
      'pages on a symptom rather than a cause',
      'retries hard enough to make the outage worse',
      'silently succeeds when the target is unreachable',
      'takes long enough that the timeout fires first'
    ],
    artifacts: ['a runbook entry', 'a dashboard', 'an alert rule', 'a rollback script'],
    metrics: ['error rate', 'time to detect', 'time to recover', 'monthly spend'],
    people: ['on-call', 'the platform team', 'the vendor', 'the incident channel'],
    questions: [
      'Would this alert have fired during the last real incident?',
      'Can a new on-call follow this runbook without asking anyone?',
      'How long does the restore actually take, measured rather than assumed?'
    ],
    snippets: OPS_SNIPPETS
  },
  {
    folder: 'writing',
    icon: '✍️',
    tags: ['writing', 'drafts', 'ideas', 'editing'],
    subjects: [
      'Essay draft',
      'Newsletter issue',
      'Talk outline',
      'Changelog voice',
      'Landing copy',
      'Interview write-up',
      'Book notes',
      'Opening paragraph',
      'Ending problem',
      'Structure pass'
    ],
    qualifiers: ['draft', 'outline', 'edit pass', 'notes to self', 'cut material', 'final read'],
    systems: ['the opening', 'the middle section', 'the argument', 'the closing line'],
    actions: [
      'explains the thing twice and neither time well',
      'buries the point three paragraphs down',
      'earns the ending but takes too long to get there',
      'sounds like a press release rather than a person'
    ],
    artifacts: ['a tighter draft', 'an outline', 'a list of cuts', 'a read-aloud pass'],
    metrics: ['word count', 'reading time', 'sections', 'cut lines'],
    people: ['a first reader', 'the editor', 'the audience', 'a friend who is not in the field'],
    questions: [
      'What is the one sentence this piece exists to deliver?',
      'Does the reader need the history, or just the result?',
      'Is this the essay or the notes for the essay?'
    ],
    snippets: []
  },
  {
    folder: 'reading',
    icon: '📚',
    tags: ['reading', 'books', 'notes', 'summary'],
    subjects: [
      'Chapter notes',
      'Reading log',
      'Highlights',
      'Author background',
      'Argument summary',
      'Counterpoints',
      'Quotes worth keeping',
      'Reading queue',
      'Reread notes',
      'Book club prep'
    ],
    qualifiers: ['part one', 'part two', 'summary', 'marginalia', 'second pass', 'closing notes'],
    systems: ['the book', 'the middle chapters', 'the closing argument', 'the appendix'],
    actions: [
      'makes its case early and then repeats it for two hundred pages',
      'is worth reading for one chapter alone',
      'gets better once the framing is out of the way',
      'assumes a reader who already agrees'
    ],
    artifacts: ['a summary', 'a quote list', 'a set of highlights', 'a short review'],
    metrics: ['pages', 'reading sessions', 'highlights', 'rating'],
    people: ['the author', 'the translator', 'the book club', 'a friend who recommended it'],
    questions: [
      'Would I recommend this, or just the summary of it?',
      'Which idea here actually changed something I do?',
      'Is the disagreement with the argument or with the tone?'
    ],
    snippets: []
  },
  {
    folder: 'travel',
    icon: '✈️',
    tags: ['travel', 'planning', 'food', 'city-break'],
    subjects: [
      'Trip plan',
      'Packing list',
      'Neighbourhood notes',
      'Food list',
      'Day plan',
      'Transit notes',
      'Budget',
      'Booking log',
      'Things to skip',
      'Return list'
    ],
    qualifiers: ['draft', 'final', 'day one', 'day two', 'notes', 'afterwards'],
    systems: ['the old town', 'the coastal route', 'the morning market', 'the ferry line'],
    actions: [
      'is worth an early start and nothing after noon',
      'costs half as much two streets away',
      'closes on the day everyone assumes it is open',
      'takes twice as long as the map suggests'
    ],
    artifacts: ['an offline map', 'a shortlist', 'a booking confirmation', 'a day plan'],
    metrics: ['walking distance', 'daily budget', 'transit time', 'nights'],
    people: ['the host', 'a local recommendation', 'the group', 'the guide'],
    questions: [
      'Do we book this ahead, or is turning up fine?',
      'Is one more stop worth losing the slow morning?',
      'What survives if it rains for two days?'
    ],
    snippets: []
  },
  {
    folder: 'personal',
    icon: '🌳',
    tags: ['personal', 'habits', 'reflection', 'health'],
    subjects: [
      'Weekly review',
      'Habit notes',
      'Training log',
      'Money check-in',
      'Energy patterns',
      'Sleep notes',
      'Home projects',
      'Learning plan',
      'Year themes',
      'Things to stop'
    ],
    qualifiers: ['notes', 'check-in', 'review', 'plan', 'honest version', 'follow-up'],
    systems: ['the morning block', 'the evening routine', 'the training week', 'the weekend'],
    actions: [
      'works when the week is calm and collapses when it is not',
      'takes less time than the resistance to starting it',
      'is easier to keep than to restart',
      'only holds if the night before goes well'
    ],
    artifacts: ['a simpler plan', 'a checklist', 'a weekly slot', 'a shorter list'],
    metrics: ['sessions per week', 'average sleep', 'weight', 'streak length'],
    people: ['future me', 'the training partner', 'the group chat', 'a coach'],
    questions: [
      'Is this a system problem or a tired week?',
      'What is the smallest version I would still do on a bad day?',
      'What am I keeping only out of habit?'
    ],
    snippets: []
  }
]

// ---------------------------------------------------------------------------
// Sentence composition
// ---------------------------------------------------------------------------

const LEAD_TEMPLATES = [
  'Picking this back up because {system} {action}.',
  'Notes from the pass over {subject_lower}: {system} {action}.',
  'Short version — {system} {action}, and the fix is smaller than it looked.',
  'This is the working set of notes on {subject_lower}. Nothing here is final yet.',
  'Wrote this down after the third time I had to re-explain why {system} {action}.'
]

const BODY_TEMPLATES = [
  'The part worth remembering is that {system} {action}.',
  'Measured {metric} before and after; the difference was large enough to keep the change.',
  'Left a note for {person} so the next pass does not start from scratch.',
  'The obvious approach fails here, which is why the first attempt was thrown away.',
  'Kept {artifact} alongside this so the claim is checkable rather than remembered.',
  'Most of the complexity is in the edges, not the common case.',
  'It held up under a second read, which is more than the previous version managed.',
  'Worth revisiting once {metric} stops moving week to week.',
  'The tradeoff is explicit: less flexibility now in exchange for a shape that can be explained.',
  'Everything below assumes the setup described above; it does not generalise cleanly.'
]

const BULLET_TEMPLATES = [
  '{system} {action}',
  'Track {metric} — it is the number that moved first',
  'Produce {artifact} before the next review',
  'Check with {person} before changing the default',
  'Keep the fallback path; it is cheap and it has already saved us once',
  'Write down the assumption instead of re-deriving it every time',
  'Prefer the boring option until there is a measurement that argues otherwise',
  'Revisit after two weeks of real use, not after one afternoon'
]

const CALLOUTS = [
  '> [!info]\n> The numbers here come from a single machine. Treat them as directional.',
  '> [!warning]\n> Do not change the default before the follow-up in this note is done.',
  '> [!tip]\n> The fast path is the one that does nothing. Check that first.',
  '> [!note]\n> Written mid-way through. Some of this will be wrong by the next pass.'
]

const LINK_HOSTS = [
  'https://example.com/reference',
  'https://example.org/notes',
  'https://docs.example.com/guide',
  'https://example.net/thread'
]

const STATUS_VALUES = ['draft', 'active', 'review', 'parked', 'done']
const PRIORITY_VALUES = ['low', 'medium', 'high']
const OWNERS = ['Kaan', 'Dana', 'Ravi', 'Marta', 'Sam', 'Elif']

function fill(template: string, rng: () => number, topic: Topic, subject: string): string {
  return template
    .replace('{system}', () => pick(rng, topic.systems))
    .replace('{action}', () => pick(rng, topic.actions))
    .replace('{metric}', () => pick(rng, topic.metrics))
    .replace('{artifact}', () => pick(rng, topic.artifacts))
    .replace('{person}', () => pick(rng, topic.people))
    .replace('{subject_lower}', subject.toLowerCase())
}

/** Bullet templates can start with a lowercase noun phrase; list items should not. */
const sentenceCase = (text: string): string => text.replace(/^./, (c) => c.toUpperCase())

function paragraph(
  rng: () => number,
  topic: Topic,
  subject: string,
  templates: readonly string[],
  sentences: number
): string {
  return pickMany(rng, templates, sentences)
    .map((template) => fill(template, rng, topic, subject))
    .join(' ')
}

function table(rng: () => number, topic: Topic, rows: number): string {
  const lines = ['| Item | Owner | State |', '| --- | --- | --- |']
  for (let i = 0; i < rows; i++) {
    lines.push(
      `| ${pick(rng, topic.artifacts)} | ${pick(rng, topic.people)} | ${pick(rng, STATUS_VALUES)} |`
    )
  }
  return lines.join('\n')
}

function checklist(rng: () => number, topic: Topic, subject: string, items: number): string {
  const lines: string[] = []
  for (let i = 0; i < items; i++) {
    // Pin the first item done and the last one open so every note carries both
    // states — a note with nothing left to do is not what a real vault looks like.
    const done = i === 0 ? 'x' : i === items - 1 ? ' ' : rng() < 0.4 ? 'x' : ' '
    lines.push(
      `- [${done}] ${sentenceCase(fill(pick(rng, BULLET_TEMPLATES), rng, topic, subject))}`
    )
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface BulkNote {
  id: string
  path: string
  title: string
  emoji: string | null
  createdAt: string
  modifiedAt: string
  tags: string[]
  file: NoteFile
}

export interface BulkVault {
  notes: BulkNote[]
  /** Folder rows for the sidebar, in the order the topics are defined. */
  folders: Array<{ path: string; icon: string }>
  /** Every tag used across the generated notes, deduplicated. */
  tags: string[]
}

function sanitizeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '-').trim()
}

/**
 * Generates `count` fully-populated notes spread evenly across the topics.
 *
 * Titles are unique per vault, ids are 12-char note ids, and every note links to
 * a few others so the graph and backlink panes have something to chew on.
 */
export function generateBulkVault(count: number, seed: number): BulkVault {
  const rng = createRng(seed)

  // Pass 1 — identities. Bodies need the titles of other notes to link to.
  const claimedPaths = new Set<string>()
  const skeletons = Array.from({ length: count }, (_, index) => {
    const topic = TOPICS[index % TOPICS.length]
    const subject = pick(rng, topic.subjects)
    const qualifier = pick(rng, topic.qualifiers)
    let title = `${subject} — ${qualifier}`
    let path = `${topic.folder}/${sanitizeFileName(title)}.md`
    let suffix = 2
    while (claimedPaths.has(path)) {
      title = `${subject} — ${qualifier} ${suffix}`
      path = `${topic.folder}/${sanitizeFileName(title)}.md`
      suffix += 1
    }
    claimedPaths.add(path)

    const daysAgoCreated = 30 + Math.floor(rng() * 700)
    const daysAgoModified = Math.floor(rng() * daysAgoCreated)

    return {
      id: rngNoteId(rng),
      topic,
      subject,
      title,
      path,
      daysAgoCreated,
      daysAgoModified
    }
  })

  // Pass 2 — bodies, with wiki-links into the rest of the vault.
  const notes: BulkNote[] = skeletons.map((skeleton, index) => {
    const { topic, subject, title } = skeleton
    const tags = pickMany(rng, topic.tags, 2 + Math.floor(rng() * 2))
    const linked = [
      skeletons[(index + 7) % count],
      skeletons[(index + 137) % count],
      skeletons[(index + count - 23) % count]
    ].filter((target) => target.title !== title)

    const sections: string[] = [
      fill(pick(rng, LEAD_TEMPLATES), rng, topic, subject),
      '',
      '## Context',
      '',
      paragraph(rng, topic, subject, BODY_TEMPLATES, 3),
      '',
      pickMany(rng, BULLET_TEMPLATES, 3 + Math.floor(rng() * 3))
        .map((template) => `- ${sentenceCase(fill(template, rng, topic, subject))}`)
        .join('\n'),
      '',
      `## ${sentenceCase(pick(rng, topic.qualifiers))}`,
      '',
      paragraph(rng, topic, subject, BODY_TEMPLATES, 3),
      '',
      pick(rng, CALLOUTS),
      '',
      table(rng, topic, 3 + Math.floor(rng() * 3))
    ]

    if (topic.snippets.length > 0 && rng() < 0.55) {
      sections.push('', '### Reference', '', pick(rng, topic.snippets))
    }

    sections.push(
      '',
      '## Open questions',
      '',
      pickMany(rng, topic.questions, Math.min(3, topic.questions.length))
        .map((question, i) => `${i + 1}. ${question}`)
        .join('\n'),
      '',
      '## Next',
      '',
      checklist(rng, topic, subject, 3 + Math.floor(rng() * 3)),
      '',
      '## Links',
      '',
      linked.map((target) => `- [[${target.title}]]`).join('\n'),
      `- ${pick(rng, LINK_HOSTS)}`,
      '',
      tags.map((tag) => `#${tag}`).join(' ')
    )

    const createdAt = seedPastISOAt(-skeleton.daysAgoCreated, 9, 15)
    const modifiedAt = seedPastISOAt(-skeleton.daysAgoModified, 16, 45)

    return {
      id: skeleton.id,
      path: skeleton.path,
      title,
      emoji: topic.icon,
      createdAt,
      modifiedAt,
      tags,
      file: {
        relativePath: skeleton.path,
        frontmatter: {
          tags,
          status: pick(rng, STATUS_VALUES),
          priority: pick(rng, PRIORITY_VALUES),
          owner: pick(rng, OWNERS),
          rating: 1 + Math.floor(rng() * 5)
        },
        body: sections.join('\n'),
        modified: modifiedAt
      }
    }
  })

  const usedFolders = new Set(notes.map((note) => note.path.split('/')[0]))

  return {
    notes,
    folders: TOPICS.filter((topic) => usedFolders.has(topic.folder)).map((topic) => ({
      path: topic.folder,
      icon: topic.icon
    })),
    tags: [...new Set(notes.flatMap((note) => note.tags))].sort()
  }
}
