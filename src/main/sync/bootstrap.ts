/**
 * Sync Bootstrap
 *
 * Queues existing local data for initial sync on first device.
 *
 * @module sync/bootstrap
 */

import { eq } from 'drizzle-orm'
import { getDatabase, getIndexDatabase } from '../database'
import { tasks } from '@shared/db/schema/tasks'
import { inboxItems } from '@shared/db/schema/inbox'
import { noteCache } from '@shared/db/schema/notes-cache'
import { getSyncQueue } from './queue'
import { getSetting, setSetting } from '@shared/db/queries/settings'
import { retrieveDeviceKeyPair } from '../crypto/keychain'
import { emptyClock, incrementClock, type VectorClock } from './vector-clock'
import { getCrdtSyncBridge } from './crdt-sync-bridge'
import { getCrdtProvider } from './crdt-provider'
import { parseNote } from '../vault/frontmatter'
import { safeRead } from '../vault/file-ops'
import { toAbsolutePath } from '../vault/notes'
import { readJournalEntry } from '../vault/journal'
import { getNetworkMonitor } from './network'

const BOOTSTRAP_KEY = 'sync.bootstrap.v1'
const CRDT_SEED_KEY = 'sync.crdt.seed.v1'
const CRDT_BOOTSTRAP_KEY = 'sync.crdt.bootstrap.v1'

function parseClock(value: unknown): VectorClock | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as VectorClock
    } catch {
      return null
    }
  }
  if (typeof value === 'object') {
    return value as VectorClock
  }
  return null
}

interface CrdtSeedResult {
  attempted: boolean
  notes: number
  journals: number
}

async function seedCrdtDocsFromVault(): Promise<CrdtSeedResult> {
  let indexDb: ReturnType<typeof getIndexDatabase>
  try {
    indexDb = getIndexDatabase()
  } catch {
    console.info('[SyncBootstrap] CRDT seed skipped: index db not initialized')
    return { attempted: false, notes: 0, journals: 0 }
  }

  const crdtProvider = getCrdtProvider()
  if (!crdtProvider) {
    console.info('[SyncBootstrap] CRDT seed skipped: CRDT provider not initialized')
    return { attempted: false, notes: 0, journals: 0 }
  }

  const rows = indexDb
    .select({
      id: noteCache.id,
      path: noteCache.path,
      date: noteCache.date,
      fileType: noteCache.fileType
    })
    .from(noteCache)
    .where(eq(noteCache.fileType, 'markdown'))
    .all()

  if (rows.length === 0) {
    return { attempted: true, notes: 0, journals: 0 }
  }

  const existingDocs = new Set(await crdtProvider.getAllDocNames())

  let notesSeeded = 0
  let journalsSeeded = 0

  for (const row of rows) {
    const noteId = row.id
    const isJournal = !!row.date

    try {
      if (existingDocs.has(noteId)) {
        const doc = await crdtProvider.getOrCreateDoc(noteId)
        const existingContent = doc.getText('content').toString().trim()
        if (existingContent.length > 0) {
          continue
        }
      }

      if (isJournal && row.date) {
        const entry = await readJournalEntry(row.date)
        if (!entry) {
          continue
        }

        const frontmatter = {
          id: entry.id,
          date: entry.date,
          created: entry.createdAt,
          modified: entry.modifiedAt,
          tags: entry.tags,
          properties: entry.properties ?? {}
        }

        await crdtProvider.seedDocFromMarkdown(noteId, entry.content, frontmatter)
        journalsSeeded += 1
        continue
      }

      const absolutePath = toAbsolutePath(row.path)
      const fileContent = await safeRead(absolutePath)
      if (!fileContent) {
        continue
      }

      const parsed = parseNote(fileContent, row.path)
      const frontmatter = {
        ...parsed.frontmatter,
        id: noteId
      }

      await crdtProvider.seedDocFromMarkdown(noteId, parsed.content, frontmatter)
      notesSeeded += 1
    } catch (error) {
      console.warn('[SyncBootstrap] Failed to seed CRDT doc:', noteId, error)
    }
  }

  console.info('[SyncBootstrap] CRDT seed complete', {
    notes: notesSeeded,
    journals: journalsSeeded
  })

  return { attempted: true, notes: notesSeeded, journals: journalsSeeded }
}

export interface BootstrapResult {
  tasks: number
  inbox: number
  notes: number
  journals: number
  seededNotes: number
  seededJournals: number
}

export async function bootstrapSyncData(): Promise<BootstrapResult> {
  console.info('[SyncBootstrap] Starting bootstrap')
  let db: ReturnType<typeof getDatabase>
  try {
    db = getDatabase()
  } catch {
    console.info('[SyncBootstrap] Skipped: no open vault')
    return { tasks: 0, inbox: 0, notes: 0, journals: 0, seededNotes: 0, seededJournals: 0 }
  }

  const alreadyBootstrapped = getSetting(db, BOOTSTRAP_KEY)
  const crdtSeeded = getSetting(db, CRDT_SEED_KEY)
  const crdtBootstrapped = getSetting(db, CRDT_BOOTSTRAP_KEY)
  if (alreadyBootstrapped && crdtSeeded && crdtBootstrapped) {
    console.info('[SyncBootstrap] Skipped: already bootstrapped')
    return { tasks: 0, inbox: 0, notes: 0, journals: 0, seededNotes: 0, seededJournals: 0 }
  }

  const keyPair = await retrieveDeviceKeyPair().catch(() => null)
  if (!keyPair?.deviceId) {
    console.info('[SyncBootstrap] Skipped: no device keypair')
    return { tasks: 0, inbox: 0, notes: 0, journals: 0, seededNotes: 0, seededJournals: 0 }
  }

  const deviceId = keyPair.deviceId
  const queue = getSyncQueue()

  let tasksQueued = 0
  let inboxQueued = 0
  let didBootstrapTasks = false

  if (!alreadyBootstrapped) {
    const taskRows = db.select().from(tasks).all()
    for (const task of taskRows) {
      let clock = parseClock(task.clock)
      if (!clock) {
        clock = incrementClock(emptyClock(), deviceId)
        db.update(tasks)
          .set({ clock: JSON.stringify(clock) })
          .where(eq(tasks.id, task.id))
          .run()
      }

      const payload = { ...task, clock }
      await queue.add('task', task.id, 'create', JSON.stringify(payload), 0)
      tasksQueued++
    }

    const inboxRows = db.select().from(inboxItems).all()
    for (const item of inboxRows) {
      let clock = parseClock(item.clock)
      if (!clock) {
        clock = incrementClock(emptyClock(), deviceId)
        db.update(inboxItems).set({ clock }).where(eq(inboxItems.id, item.id)).run()
      }

      const payload = { ...item, clock }
      await queue.add('inbox', item.id, 'create', JSON.stringify(payload), 0)
      inboxQueued++
    }

    didBootstrapTasks = true
  }

  let seededNotes = 0
  let seededJournals = 0
  if (!crdtSeeded) {
    const seedResult = await seedCrdtDocsFromVault()
    seededNotes = seedResult.notes
    seededJournals = seedResult.journals
    if (seedResult.attempted) {
      setSetting(db, CRDT_SEED_KEY, new Date().toISOString())
    }
  }

  let notesBootstrapped = 0
  let journalsBootstrapped = 0
  let didBootstrapCrdt = false
  if (!crdtBootstrapped) {
    const crdtProvider = getCrdtProvider()
    if (!crdtProvider) {
      console.info('[SyncBootstrap] CRDT bootstrap skipped: CRDT provider not initialized')
    } else {
      const docNames = await crdtProvider.getAllDocNames()
      if (docNames.length === 0) {
        didBootstrapCrdt = true
      } else if (getNetworkMonitor().isOnline()) {
        const crdtBridge = getCrdtSyncBridge()
        if (crdtBridge) {
          const crdtResult = await crdtBridge.bootstrapLocalDocs()
          notesBootstrapped = crdtResult.notes
          journalsBootstrapped = crdtResult.journals
          didBootstrapCrdt = true
        } else {
          console.info('[SyncBootstrap] CRDT bootstrap skipped: sync bridge not ready')
        }
      } else {
        console.info('[SyncBootstrap] CRDT bootstrap deferred: offline')
      }
    }
  }

  if (didBootstrapTasks) {
    setSetting(db, BOOTSTRAP_KEY, new Date().toISOString())
  }
  if (didBootstrapCrdt) {
    setSetting(db, CRDT_BOOTSTRAP_KEY, new Date().toISOString())
  }

  console.info('[SyncBootstrap] Queued existing data', {
    tasks: tasksQueued,
    inbox: inboxQueued,
    notes: notesBootstrapped,
    journals: journalsBootstrapped,
    seededNotes,
    seededJournals
  })

  return {
    tasks: tasksQueued,
    inbox: inboxQueued,
    notes: notesBootstrapped,
    journals: journalsBootstrapped,
    seededNotes,
    seededJournals
  }
}
