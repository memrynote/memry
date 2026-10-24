import type { ZodType } from 'zod'

import type { FoldLastRun, FoldLayers } from '@memry/contracts/note-fold'

import type { IndexDb } from '../database/types'
import { createLogger } from '../lib/logger'
import {
  assemble,
  buildChunkPrompt,
  buildSections,
  chunkAiSchema,
  detectLanguage,
  isFoldable,
  type ChunkAi,
  type ParsedChunk
} from './engine'
import { expandInlineTokens, withoutInlineTokens } from './engine-tokens'
import {
  deleteChunkPayload,
  readChunkPayload,
  writeChunkPayload,
  type ChunkCacheKey
} from './fold-cache'

const logger = createLogger('NoteFold')

export const FOLD_CONCURRENCY = 4
export const FOLD_IDLE_MS = 30_000

export interface FoldAgent {
  /** "Written by <label>". */
  label: string
  /** Part of the cache key: a different model never reads another's chunks. */
  modelId: string
  run<T>(prompt: string, schema: ZodType<T>): Promise<T>
}

export interface FoldServiceDeps {
  /** A getter: the index DB is not open yet when the service starts, and a rebuild replaces the handle. */
  getDb: () => IndexDb
  /** Markdown body of a note or journal entry; null when it does not exist. */
  getSource(noteId: string): Promise<string | null>
  /** Null when no agent backend is detected. */
  getAgent(): Promise<FoldAgent | null>
  /** ai.enabled and the "Summarize long notes" setting. */
  isEnabled(): boolean
  onUpdated(noteId: string): void
  idleMs?: number
  now?: () => number
}

interface Job {
  key: string
  cacheKey: ChunkCacheKey
  chunk: ParsedChunk
  agent: FoldAgent
  noteIds: Set<string>
}

export interface FoldService {
  get(noteId: string): Promise<FoldLayers>
  /** No `noteId` retries the last failed note. */
  retry(noteId?: string): Promise<FoldLayers | null>
  getLastRun(): FoldLastRun
  /** A note's body changed: after the idle window, regenerate its changed chunks. */
  noteChanged(noteId: string): void
  /** The settings or the agent changed: every note the renderer has fetched refetches its snapshot. */
  refresh(): void
  dispose(): void
}

const jobKey = (k: ChunkCacheKey): string => `${k.chunkHash}|${k.language}|${k.modelId}`

export function createFoldService(deps: FoldServiceDeps): FoldService {
  const idleMs = deps.idleMs ?? FOLD_IDLE_MS
  const now = deps.now ?? Date.now

  /** Every note the renderer fetched; `opened` only holds those that are being summarized. */
  const seen = new Set<string>()
  /** Fetched before the index knew them (vault just opened, index still building); refetched once they are indexed. */
  const unindexed = new Set<string>()
  const jobs = new Map<string, Job>() // queued or running
  const queue: Job[] = []
  let running = 0
  /** Chunks whose last run failed -> the notes that asked; not retried until `retry()`. */
  const failed = new Map<string, Set<string>>()
  let lastFailure: string | null = null
  let lastNoteId: string | null = null
  /** Notes the renderer has opened this session; only these regenerate on edit. */
  const opened = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  const execute = async (job: Job): Promise<void> => {
    try {
      const value = await job.agent.run(
        buildChunkPrompt(job.chunk, job.cacheKey.language),
        chunkAiSchema(job.chunk)
      )
      writeChunkPayload(deps.getDb(), job.cacheKey, JSON.stringify(value), now())
      failed.delete(job.key)
      if (
        lastFailure &&
        job.noteIds.has(lastFailure) &&
        ![...failed.values()].some((s) => s.has(lastFailure!))
      ) {
        lastFailure = null
      }
    } catch (error) {
      // Invalid JSON, schema mismatch, non-zero exit: the chunk keeps its local
      // fallback and the note reports 'failed' until the user retries.
      logger.warn('Fold chunk failed', {
        chunkHash: job.cacheKey.chunkHash,
        modelId: job.cacheKey.modelId,
        language: job.cacheKey.language,
        noteIds: [...job.noteIds],
        error
      })
      failed.set(job.key, new Set(job.noteIds))
      lastFailure = [...job.noteIds].at(-1) ?? null
    }
  }

  const pump = (): void => {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `disposed` is set by dispose() and by job callbacks, which run in other call frames
    while (!disposed && running < FOLD_CONCURRENCY && queue.length > 0) {
      const job = queue.shift()!
      running++
      void execute(job).finally(() => {
        running--
        jobs.delete(job.key)
        if (disposed) return
        for (const id of job.noteIds) deps.onUpdated(id)
        pump()
      })
    }
  }

  const enqueue = (
    noteId: string,
    chunk: ParsedChunk,
    language: string,
    agent: FoldAgent
  ): void => {
    const cacheKey = { chunkHash: chunk.hash, language, modelId: agent.modelId }
    const key = jobKey(cacheKey)
    if (failed.has(key)) {
      failed.get(key)!.add(noteId)
      return
    }
    lastNoteId = noteId
    const existing = jobs.get(key)
    if (existing) {
      existing.noteIds.add(noteId)
      return
    }
    const job: Job = { key, cacheKey, chunk, agent, noteIds: new Set([noteId]) }
    jobs.set(key, job)
    queue.push(job)
  }

  const lookupFor =
    (language: string, agent: FoldAgent | null) =>
    (chunk: ParsedChunk): ChunkAi | undefined => {
      if (!agent) return undefined
      const cacheKey = { chunkHash: chunk.hash, language, modelId: agent.modelId }
      const payload = readChunkPayload(deps.getDb(), cacheKey)
      if (payload === null) return undefined
      try {
        return chunkAiSchema(chunk).parse(JSON.parse(payload))
      } catch (error) {
        logger.warn('Dropping unreadable fold cache row', { chunkHash: chunk.hash, error })
        deleteChunkPayload(deps.getDb(), cacheKey)
        return undefined
      }
    }

  const get = async (noteId: string): Promise<FoldLayers> => {
    seen.add(noteId)
    // An unknown note is not an error: the renderer restores tabs before the
    // background index build has reached every note. It reads as an empty
    // note ('short') until noteChanged() reports it indexed.
    const fetched = await deps.getSource(noteId)
    if (fetched === null) unindexed.add(noteId)
    else unindexed.delete(noteId)
    const raw = fetched ?? ''
    const language = detectLanguage(withoutInlineTokens(raw))
    const source = expandInlineTokens(raw, language)
    const sections = isFoldable(source, language) ? buildSections(source, language) : []
    const foldable = sections.length > 0
    const enabled = foldable && deps.isEnabled()
    const agent = enabled ? await deps.getAgent() : null

    const { layers, missing } = assemble({
      noteId,
      source,
      language,
      sections,
      lookup: lookupFor(language, agent)
    })

    let status: FoldLayers['status']
    if (!foldable) status = 'short'
    else if (!enabled) status = 'off'
    else if (!agent) status = 'no_agent'
    else if (missing.length === 0) status = 'ready'
    else {
      opened.add(noteId)
      for (const chunk of missing) enqueue(noteId, chunk, language, agent)
      const keys = missing.map((c) =>
        jobKey({ chunkHash: c.hash, language, modelId: agent.modelId })
      )
      const inFlight = keys.some((k) => jobs.has(k))
      status = !inFlight && keys.some((k) => failed.has(k)) ? 'failed' : 'writing'
      pump()
    }
    if (enabled && agent && missing.length === 0) opened.add(noteId)
    return { ...layers, status, agent: agent?.label ?? null }
  }

  return {
    get,

    async retry(noteId) {
      const target = noteId ?? lastFailure
      if (!target) return null
      for (const [key, ids] of failed) {
        if (ids.has(target)) failed.delete(key)
      }
      if (lastFailure === target) lastFailure = null
      return get(target)
    },

    getLastRun() {
      if (running > 0 || queue.length > 0) return { status: 'writing', noteId: lastNoteId }
      if (lastFailure) return { status: 'failed', noteId: lastFailure }
      return { status: 'idle', noteId: null }
    },

    noteChanged(noteId) {
      if (disposed) return
      if (unindexed.delete(noteId)) {
        deps.onUpdated(noteId)
        return
      }
      if (!opened.has(noteId)) return
      clearTimeout(timers.get(noteId))
      timers.set(
        noteId,
        setTimeout(() => {
          timers.delete(noteId)
          // get() hashes the new body and queues only chunks with no cached result.
          void get(noteId)
            .then(() => deps.onUpdated(noteId))
            .catch((error: unknown) => logger.warn('Fold regeneration failed', { noteId, error }))
        }, idleMs)
      )
    },

    refresh() {
      if (disposed) return
      for (const id of seen) deps.onUpdated(id)
    },

    dispose() {
      disposed = true
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      queue.length = 0
    }
  }
}
