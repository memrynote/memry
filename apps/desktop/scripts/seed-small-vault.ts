#!/usr/bin/env npx tsx
/**
 * Small themed seeds — two tiny vaults, each distinct from the demo, rich and
 * bench vaults. Handy for multi-vault switching and sync testing.
 *
 *   --variant=1  "Home & Garden"   → ~/MemrySmallVault1
 *   --variant=2  "Language Study"  → ~/MemrySmallVault2
 *
 * Override the path with --vault=<path>. Always wipes and re-seeds.
 */

import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

import { wipeVault } from './seed-vault/wipe'
import { writeNoteFiles } from './seed-vault/file-writer'
import type { NoteFile } from './seed-vault/file-writer'
import {
  insertFolderConfigs,
  insertNoteMetadata,
  insertProjects,
  insertStatuses,
  insertTagDefinitions,
  insertTaskNotes,
  insertTasks,
  openDataDb
} from './seed-vault/db-writer'
import type { SeedStatus, SeedTask } from './seed-vault/db-writer'
import { generateId } from '../src/main/lib/id'
import { seedDateOnly, seedISOAt } from './seed-data/date'

interface SmallNote {
  path: string
  title: string
  emoji: string
  tags: string[]
  body: string
  daysAgo: number
}

interface SmallTask {
  title: string
  status: 'todo' | 'doing' | 'done'
  priority: number
  dueInDays?: number
  notePath?: string
}

interface SmallVault {
  title: string
  dirName: string
  project: { name: string; color: string; icon: string; description: string }
  folders: { path: string; icon: string }[]
  tags: { name: string; color: string }[]
  notes: SmallNote[]
  tasks: SmallTask[]
}

const VAULTS: Record<'1' | '2', SmallVault> = {
  '1': {
    title: 'Home & Garden',
    dirName: 'MemrySmallVault1',
    project: {
      name: 'Balcony Garden',
      color: '#22c55e',
      icon: 'sprout',
      description: 'Spring planting on the south balcony.'
    },
    folders: [
      { path: 'garden', icon: 'sprout' },
      { path: 'home', icon: 'house' }
    ],
    tags: [
      { name: 'plants', color: '#22c55e' },
      { name: 'repairs', color: '#f97316' },
      { name: 'recipes', color: '#ec4899' }
    ],
    notes: [
      {
        path: 'garden/Tomato Plan.md',
        title: 'Tomato Plan',
        emoji: '🍅',
        tags: ['plants'],
        daysAgo: 6,
        body: `# Tomato Plan

Three pots of cherry tomatoes along the railing.

- Variety: Sungold, Black Cherry
- Soil: 60% compost, 40% perlite
- Water every morning once fruit sets

See also [[Watering Schedule]].`
      },
      {
        path: 'garden/Watering Schedule.md',
        title: 'Watering Schedule',
        emoji: '💧',
        tags: ['plants'],
        daysAgo: 3,
        body: `# Watering Schedule

| Plant | Frequency | Notes |
| --- | --- | --- |
| Tomatoes | Daily | Morning only |
| Basil | Every 2 days | Keep leaves dry |
| Lavender | Weekly | Likes it dry |`
      },
      {
        path: 'home/Leaky Faucet.md',
        title: 'Leaky Faucet',
        emoji: '🔧',
        tags: ['repairs'],
        daysAgo: 10,
        body: `# Leaky Faucet

Kitchen tap drips from the base.

- [x] Shut off valve under sink
- [ ] Buy 18mm O-ring
- [ ] Replace cartridge if the ring does not fix it`
      },
      {
        path: 'home/Pesto.md',
        title: 'Pesto',
        emoji: '🌿',
        tags: ['recipes', 'plants'],
        daysAgo: 1,
        body: `# Pesto

Uses the balcony basil.

1. 2 cups basil, 1/3 cup pine nuts, 2 garlic cloves
2. Pulse, then stream in 1/2 cup olive oil
3. Stir in parmesan by hand`
      }
    ],
    tasks: [
      {
        title: 'Buy tomato cages',
        status: 'todo',
        priority: 2,
        dueInDays: 2,
        notePath: 'garden/Tomato Plan.md'
      },
      { title: 'Repot the lavender', status: 'doing', priority: 1 },
      {
        title: 'Order O-ring for faucet',
        status: 'todo',
        priority: 3,
        dueInDays: 1,
        notePath: 'home/Leaky Faucet.md'
      },
      { title: 'Sow basil seeds', status: 'done', priority: 1 }
    ]
  },
  '2': {
    title: 'Language Study',
    dirName: 'MemrySmallVault2',
    project: {
      name: 'Japanese N5',
      color: '#6366f1',
      icon: 'languages',
      description: 'Pass JLPT N5 in December.'
    },
    folders: [
      { path: 'grammar', icon: 'book-open' },
      { path: 'vocab', icon: 'list' }
    ],
    tags: [
      { name: 'grammar', color: '#6366f1' },
      { name: 'vocab', color: '#0ea5e9' },
      { name: 'review', color: '#f59e0b' }
    ],
    notes: [
      {
        path: 'grammar/Particles wa vs ga.md',
        title: 'Particles wa vs ga',
        emoji: '🈁',
        tags: ['grammar'],
        daysAgo: 8,
        body: `# は vs が

- **は** marks the topic: 私は学生です。
- **が** marks the subject, often new info: 誰が来ましたか？

Practice sentences live in [[Daily Phrases]].`
      },
      {
        path: 'grammar/Te-form.md',
        title: 'Te-form',
        emoji: '🔗',
        tags: ['grammar', 'review'],
        daysAgo: 4,
        body: `# て-form

| Ending | Te-form | Example |
| --- | --- | --- |
| う/つ/る | って | 待つ → 待って |
| む/ぶ/ぬ | んで | 読む → 読んで |
| く | いて | 書く → 書いて |

Exception: 行く → 行って`
      },
      {
        path: 'vocab/Daily Phrases.md',
        title: 'Daily Phrases',
        emoji: '💬',
        tags: ['vocab'],
        daysAgo: 2,
        body: `# Daily Phrases

- おはようございます — good morning
- いただきます — before eating
- お疲れ様です — thanks for your hard work
- すみません — excuse me / sorry`
      }
    ],
    tasks: [
      {
        title: 'Review te-form flashcards',
        status: 'doing',
        priority: 2,
        notePath: 'grammar/Te-form.md'
      },
      { title: 'Finish Genki chapter 4', status: 'todo', priority: 3, dueInDays: 3 },
      { title: 'Register for JLPT', status: 'todo', priority: 4, dueInDays: 7 },
      { title: 'Learn hiragana', status: 'done', priority: 1 }
    ]
  }
}

function parseArgs(argv: string[]): { vault: SmallVault; vaultPath: string } {
  let variant = '1'
  let vaultPath: string | undefined
  for (const raw of argv) {
    if (raw.startsWith('--variant=')) variant = raw.slice('--variant='.length)
    if (raw.startsWith('--vault=')) vaultPath = resolve(raw.slice('--vault='.length))
  }
  if (variant !== '1' && variant !== '2') {
    throw new Error(`--variant must be 1 or 2, got: ${variant}`)
  }
  const vault = VAULTS[variant]
  return { vault, vaultPath: vaultPath ?? resolve(homedir(), vault.dirName) }
}

function writeConfig(vaultPath: string, title: string): void {
  writeFileSync(
    resolve(vaultPath, '.memry', 'config.json'),
    JSON.stringify(
      { version: 1, title, excludePatterns: ['.git', 'node_modules', '.DS_Store'] },
      null,
      2
    ),
    'utf8'
  )
}

async function main(): Promise<void> {
  const { vault, vaultPath } = parseArgs(process.argv.slice(2))

  console.log(`Seeding "${vault.title}" vault at: ${vaultPath}`)
  wipeVault(vaultPath)
  writeConfig(vaultPath, vault.title)

  const noteIds = new Map(vault.notes.map((n) => [n.path, generateId()]))
  const inboxId = generateId()
  const projectId = generateId()
  const statusIds = {
    inbox: generateId(),
    todo: generateId(),
    doing: generateId(),
    done: generateId()
  }

  const statuses: SeedStatus[] = [
    {
      id: statusIds.inbox,
      projectId: inboxId,
      name: 'To Do',
      color: '#6b7280',
      position: 0,
      isDefault: true
    },
    {
      id: statusIds.todo,
      projectId,
      name: 'To Do',
      color: '#94a3b8',
      position: 0,
      isDefault: true
    },
    { id: statusIds.doing, projectId, name: 'In Progress', color: '#0ea5e9', position: 1 },
    { id: statusIds.done, projectId, name: 'Done', color: '#22c55e', position: 2, isDone: true }
  ]

  const tasks: (SeedTask & { notePath?: string })[] = vault.tasks.map((t, i) => ({
    id: generateId(),
    projectId,
    statusId: statusIds[t.status],
    title: t.title,
    priority: t.priority,
    position: i,
    dueDate: t.dueInDays === undefined ? null : seedDateOnly(t.dueInDays),
    completedAt: t.status === 'done' ? seedISOAt(-1, 18) : null,
    notePath: t.notePath
  }))

  const { db, raw, close } = openDataDb(resolve(vaultPath, '.memry', 'data.db'))
  try {
    raw.transaction(() => {
      insertFolderConfigs(db, vault.folders)
      insertTagDefinitions(db, vault.tags)
      insertNoteMetadata(
        db,
        vault.notes.map((n) => ({
          id: noteIds.get(n.path)!,
          path: n.path,
          title: n.title,
          emoji: n.emoji,
          createdAt: seedISOAt(-n.daysAgo - 2, 9),
          modifiedAt: seedISOAt(-n.daysAgo, 17)
        }))
      )
      insertProjects(db, [
        { id: inboxId, name: 'Inbox', color: '#6b7280', icon: 'inbox', position: 0, isInbox: true },
        { id: projectId, ...vault.project, position: 1 }
      ])
      insertStatuses(db, statuses)
      insertTasks(db, tasks)
      insertTaskNotes(
        db,
        tasks.flatMap((t) =>
          t.notePath ? [{ taskId: t.id, noteId: noteIds.get(t.notePath)! }] : []
        )
      )
    })()
  } finally {
    close()
  }

  const files: NoteFile[] = vault.notes.map((n) => ({
    relativePath: n.path,
    frontmatter: { tags: n.tags },
    body: n.body,
    modified: seedISOAt(-n.daysAgo, 17)
  }))
  writeNoteFiles(vaultPath, files)

  console.log(
    `Done: ${vault.notes.length} notes, ${tasks.length} tasks, ${vault.tags.length} tags.`
  )
  console.log(`Vault path: ${vaultPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
