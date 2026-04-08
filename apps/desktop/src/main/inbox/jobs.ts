import { BrowserWindow } from 'electron'
import { and, asc, eq, inArray, lte, or } from 'drizzle-orm'
import { inboxJobs, inboxItems } from '@memry/db-schema/schema/inbox'
import type {
  InboxJob as InboxJobContract,
  InboxJobStatus,
  InboxJobType
} from '@memry/contracts/inbox-api'
import { InboxChannels } from '@memry/contracts/ipc-channels'

import { getDatabase, type DrizzleDb } from '../database'
import { createLogger } from '../lib/logger'
import { generateId } from '../lib/id'
import { getItemAttachmentsDir } from './attachments'
import { downloadImage, fetchUrlMetadata, isBotPageTitle, titleFromUrl } from './metadata'
import { transcribeAudio } from './transcription'

const log = createLogger('Inbox:Jobs')

const METADATA_RETRY_DELAY_MS = 5000

const scheduledJobTimers = new Map<string, ReturnType<typeof setTimeout>>()
const activeJobs = new Set<string>()
let didResumeJobs = false

type JobRow = typeof inboxJobs.$inferSelect

interface QueueInboxJobInput {
  itemId: string
  type: InboxJobType
  payload: Record<string, unknown> | null
  maxAttempts?: number
  runAt?: string
}

function requireDatabase(): DrizzleDb {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

function emitInboxEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

function toInboxJob(row: JobRow): InboxJobContract {
  return {
    id: row.id,
    itemId: row.itemId,
    type: row.type as InboxJobType,
    status: row.status as InboxJobStatus,
    runAt: new Date(row.runAt),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    result: (row.result ?? null) as Record<string, unknown> | null,
    lastError: row.lastError,
    startedAt: row.startedAt ? new Date(row.startedAt) : null,
    completedAt: row.completedAt ? new Date(row.completedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  }
}

function getExistingJob(db: DrizzleDb, itemId: string, type: InboxJobType): JobRow | undefined {
  return db
    .select()
    .from(inboxJobs)
    .where(and(eq(inboxJobs.itemId, itemId), eq(inboxJobs.type, type)))
    .get()
}

function upsertJob(
  db: DrizzleDb,
  input: QueueInboxJobInput & {
    status: InboxJobStatus
    attempts?: number
    lastError?: string | null
    startedAt?: string | null
    completedAt?: string | null
    result?: Record<string, unknown> | null
  }
): string {
  const now = new Date().toISOString()
  const existing = getExistingJob(db, input.itemId, input.type)

  if (existing) {
    db.update(inboxJobs)
      .set({
        status: input.status,
        runAt: input.runAt ?? existing.runAt,
        attempts: input.attempts ?? existing.attempts,
        maxAttempts: input.maxAttempts ?? existing.maxAttempts,
        payload: input.payload ?? existing.payload,
        result: input.result ?? null,
        lastError: input.lastError ?? null,
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        updatedAt: now
      })
      .where(eq(inboxJobs.id, existing.id))
      .run()
    return existing.id
  }

  const id = generateId()
  db.insert(inboxJobs)
    .values({
      id,
      itemId: input.itemId,
      type: input.type,
      status: input.status,
      runAt: input.runAt ?? now,
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 1,
      payload: input.payload,
      result: input.result ?? null,
      lastError: input.lastError ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run()

  return id
}

function clearScheduledJob(jobId: string): void {
  const existing = scheduledJobTimers.get(jobId)
  if (existing) {
    clearTimeout(existing)
    scheduledJobTimers.delete(jobId)
  }
}

function scheduleJob(jobId: string, runAt: string): void {
  clearScheduledJob(jobId)

  const delay = Math.max(0, new Date(runAt).getTime() - Date.now())
  const timer = setTimeout(() => {
    scheduledJobTimers.delete(jobId)
    void processInboxJob(jobId)
  }, delay)

  scheduledJobTimers.set(jobId, timer)
}

function emitUpdated(itemId: string, changes: Record<string, unknown>): void {
  emitInboxEvent(InboxChannels.events.UPDATED, { id: itemId, changes })
}

function completeJob(
  db: DrizzleDb,
  jobId: string,
  result: Record<string, unknown> | null = null
): void {
  const now = new Date().toISOString()
  db.update(inboxJobs)
    .set({
      status: 'complete',
      result,
      lastError: null,
      completedAt: now,
      updatedAt: now
    })
    .where(eq(inboxJobs.id, jobId))
    .run()
}

function failJob(db: DrizzleDb, jobId: string, error: string): void {
  const now = new Date().toISOString()
  db.update(inboxJobs)
    .set({
      status: 'failed',
      lastError: error,
      completedAt: now,
      updatedAt: now
    })
    .where(eq(inboxJobs.id, jobId))
    .run()
}

function rescheduleJob(db: DrizzleDb, job: JobRow, error: string, delayMs: number): void {
  const runAt = new Date(Date.now() + delayMs).toISOString()
  db.update(inboxJobs)
    .set({
      status: 'pending',
      runAt,
      lastError: error,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString()
    })
    .where(eq(inboxJobs.id, job.id))
    .run()

  scheduleJob(job.id, runAt)
}

async function processMetadataJob(db: DrizzleDb, job: JobRow): Promise<void> {
  const item = db.select().from(inboxItems).where(eq(inboxItems.id, job.itemId)).get()
  const sourceUrl = item?.sourceUrl || (job.payload?.url as string | undefined)

  if (!item || !sourceUrl) {
    failJob(db, job.id, 'Link item not found or missing source URL.')
    return
  }

  const startedAt = new Date().toISOString()
  db.update(inboxItems)
    .set({
      processingStatus: 'processing',
      modifiedAt: startedAt
    })
    .where(eq(inboxItems.id, job.itemId))
    .run()
  emitUpdated(job.itemId, { processingStatus: 'processing' })

  try {
    const metadata = await fetchUrlMetadata(sourceUrl)

    let thumbnailPath: string | null = null
    if (metadata.image) {
      const attachmentsDir = getItemAttachmentsDir(job.itemId)
      const imageName = await downloadImage(metadata.image, attachmentsDir)
      if (imageName) {
        thumbnailPath = `attachments/inbox/${job.itemId}/${imageName}`
      }
    }

    const now = new Date().toISOString()
    db.update(inboxItems)
      .set({
        title:
          metadata.title && !isBotPageTitle(metadata.title)
            ? metadata.title
            : titleFromUrl(sourceUrl),
        content: metadata.description || null,
        thumbnailPath,
        processingStatus: 'complete',
        processingError: null,
        modifiedAt: now,
        metadata: {
          url: sourceUrl,
          fetchStatus: 'complete',
          siteName: metadata.publisher || undefined,
          description: metadata.description || undefined,
          heroImage: metadata.image || undefined,
          favicon: metadata.logo || undefined,
          author: metadata.author || undefined,
          publishedDate: metadata.date || undefined
        }
      })
      .where(eq(inboxItems.id, job.itemId))
      .run()

    emitUpdated(job.itemId, { processingStatus: 'complete', processingError: null, thumbnailPath })
    emitInboxEvent(InboxChannels.events.METADATA_COMPLETE, {
      id: job.itemId,
      metadata: {
        title: metadata.title,
        description: metadata.description,
        image: metadata.image,
        thumbnailPath
      }
    })

    completeJob(db, job.id, {
      title: metadata.title || titleFromUrl(sourceUrl),
      hasThumbnail: Boolean(thumbnailPath)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown metadata error'

    if (job.attempts < job.maxAttempts) {
      rescheduleJob(db, job, message, METADATA_RETRY_DELAY_MS)
      return
    }

    const now = new Date().toISOString()
    db.update(inboxItems)
      .set({
        title: titleFromUrl(sourceUrl),
        processingStatus: 'failed',
        processingError: message,
        modifiedAt: now,
        metadata: {
          url: sourceUrl,
          fetchStatus: 'failed',
          error: message
        }
      })
      .where(eq(inboxItems.id, job.itemId))
      .run()

    emitUpdated(job.itemId, { processingStatus: 'failed', processingError: message })
    emitInboxEvent(InboxChannels.events.PROCESSING_ERROR, {
      id: job.itemId,
      operation: 'metadata',
      error: message
    })

    failJob(db, job.id, message)
  }
}

async function processTranscriptionJob(db: DrizzleDb, job: JobRow): Promise<void> {
  const item = db.select().from(inboxItems).where(eq(inboxItems.id, job.itemId)).get()
  const attachmentPath = item?.attachmentPath || (job.payload?.attachmentPath as string | undefined)

  if (!item || !attachmentPath) {
    failJob(db, job.id, 'Voice item not found or missing attachment path.')
    return
  }

  const result = await transcribeAudio(job.itemId, attachmentPath)
  if (result.success) {
    completeJob(db, job.id, {
      transcriptionLength: result.transcription?.length ?? 0
    })
    return
  }

  failJob(db, job.id, result.error ?? 'Unknown transcription error')
}

async function processInboxJob(jobId: string): Promise<void> {
  if (activeJobs.has(jobId)) return
  activeJobs.add(jobId)

  try {
    const db = requireDatabase()
    const job = db.select().from(inboxJobs).where(eq(inboxJobs.id, jobId)).get()
    if (!job) return

    if (job.status === 'complete') return

    if (new Date(job.runAt).getTime() > Date.now()) {
      scheduleJob(job.id, job.runAt)
      return
    }

    const now = new Date().toISOString()
    db.update(inboxJobs)
      .set({
        status: 'running',
        attempts: job.attempts + 1,
        startedAt: now,
        updatedAt: now,
        lastError: null,
        completedAt: null
      })
      .where(eq(inboxJobs.id, job.id))
      .run()

    const runningJob = db.select().from(inboxJobs).where(eq(inboxJobs.id, job.id)).get()
    if (!runningJob) return

    switch (runningJob.type) {
      case 'metadata-scrape':
        await processMetadataJob(db, runningJob)
        break
      case 'transcription':
        await processTranscriptionJob(db, runningJob)
        break
      default:
        failJob(db, runningJob.id, `No processor registered for job type "${runningJob.type}".`)
        break
    }
  } catch (error) {
    log.error('Inbox job processor crashed', error)
  } finally {
    activeJobs.delete(jobId)
  }
}

export function queueInboxMetadataJob(
  itemId: string,
  url: string,
  options: { maxAttempts?: number; runAt?: string } = {}
): string {
  const db = requireDatabase()
  const runAt = options.runAt ?? new Date().toISOString()
  const jobId = upsertJob(db, {
    itemId,
    type: 'metadata-scrape',
    status: 'pending',
    payload: { url },
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 2,
    runAt,
    lastError: null,
    startedAt: null,
    completedAt: null,
    result: null
  })

  scheduleJob(jobId, runAt)
  return jobId
}

export function queueInboxTranscriptionJob(
  itemId: string,
  attachmentPath: string,
  options: { maxAttempts?: number; runAt?: string } = {}
): string {
  const db = requireDatabase()
  const runAt = options.runAt ?? new Date().toISOString()
  const jobId = upsertJob(db, {
    itemId,
    type: 'transcription',
    status: 'pending',
    payload: { attachmentPath },
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 1,
    runAt,
    lastError: null,
    startedAt: null,
    completedAt: null,
    result: null
  })

  scheduleJob(jobId, runAt)
  return jobId
}

export function markInboxJobFailed(
  itemId: string,
  type: InboxJobType,
  payload: Record<string, unknown> | null,
  error: string
): string {
  const db = requireDatabase()
  return upsertJob(db, {
    itemId,
    type,
    status: 'failed',
    payload,
    lastError: error,
    attempts: 1,
    maxAttempts: 1,
    startedAt: null,
    completedAt: new Date().toISOString(),
    result: null
  })
}

export function listInboxJobs(options: {
  itemIds?: string[]
  statuses?: InboxJobStatus[]
} = {}): InboxJobContract[] {
  const db = requireDatabase()
  const conditions = []

  if (options.itemIds?.length) {
    conditions.push(inArray(inboxJobs.itemId, options.itemIds))
  }

  if (options.statuses?.length) {
    conditions.push(inArray(inboxJobs.status, options.statuses))
  }

  const rows = db
    .select()
    .from(inboxJobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(inboxJobs.runAt))
    .all()

  return rows.map(toInboxJob)
}

export function resumeInboxJobs(): void {
  if (didResumeJobs) return
  didResumeJobs = true

  let db: DrizzleDb
  try {
    db = requireDatabase()
  } catch {
    return
  }

  const now = new Date().toISOString()
  const resumable = db
    .select()
    .from(inboxJobs)
    .where(or(eq(inboxJobs.status, 'pending'), eq(inboxJobs.status, 'running')))
    .all()

  for (const job of resumable) {
    if (job.status === 'running') {
      db.update(inboxJobs)
        .set({
          status: 'pending',
          startedAt: null,
          updatedAt: now
        })
        .where(eq(inboxJobs.id, job.id))
        .run()
    }

    scheduleJob(job.id, job.runAt)
  }
}

export function teardownInboxJobScheduler(): void {
  for (const timer of scheduledJobTimers.values()) {
    clearTimeout(timer)
  }

  scheduledJobTimers.clear()
  activeJobs.clear()
  didResumeJobs = false
}

export function hasPendingInboxJobs(): boolean {
  const db = requireDatabase()
  const pending = db
    .select()
    .from(inboxJobs)
    .where(
      and(
        or(eq(inboxJobs.status, 'pending'), eq(inboxJobs.status, 'running')),
        lte(inboxJobs.runAt, new Date().toISOString())
      )
    )
    .all()

  return pending.length > 0
}
