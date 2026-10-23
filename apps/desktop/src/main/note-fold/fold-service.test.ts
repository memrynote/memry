import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as indexSchema from '@memry/db-schema/index-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'

import { runIndexMigrations } from '../database/migrate'
import type { IndexDb } from '../database/types'
import type { ChunkAi } from './engine'
import { pruneChunksOlderThan, writeChunkPayload } from './fold-cache'
import { createFoldService, type FoldAgent, type FoldService } from './fold-service'

const sentence = (n: number): string => `Sentence number ${n} covers subject ${n} in some detail.`
const paragraph = (start: number): string =>
  Array.from({ length: 6 }, (_, i) => sentence(start + i)).join(' ')
const section = (title: string, start: number): string =>
  `## ${title}\n${paragraph(start)}\n\n${paragraph(start + 10)}`
const noteOf = (...parts: string[]): string => parts.join('\n\n')

/** Model double that answers with well-formed output for the chunk in the prompt. */
function fakeAgent(onCall: (prompt: string) => void, reply?: () => unknown): FoldAgent {
  return {
    label: 'Test agent',
    modelId: 'test:model',
    async run<T>(prompt: string, schema: ZodType<T>): Promise<T> {
      onCall(prompt)
      const count = (prompt.match(/^Paragraph \d+:/gm) ?? []).length
      const value =
        reply?.() ??
        ({
          sectionTakeaway: 'Section takeaway.',
          paragraphs: Array.from({ length: count }, () => ({
            brief: [0],
            key: { takeaway: 'Key claim.', reason: 'Because.' },
            takeaway: 'Short line.',
            topic: 'Topic',
            evidence: [0]
          }))
        } satisfies ChunkAi)
      return schema.parse(value)
    }
  }
}

describe('note fold service (real index DB)', () => {
  let dir: string
  let sqlite: Database.Database
  let db: IndexDb
  let sources: Map<string, string>
  let service: FoldService
  let calls: string[]
  let updated: string[]
  let enabled: boolean
  let agent: FoldAgent | null

  const build = (): FoldService =>
    createFoldService({
      getDb: () => db,
      getSource: async (id) => sources.get(id) ?? null,
      getAgent: async () => agent,
      isEnabled: () => enabled,
      onUpdated: (id) => updated.push(id),
      idleMs: 30_000
    })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-fold-'))
    const file = path.join(dir, 'index.db')
    runIndexMigrations(file)
    sqlite = new Database(file)
    db = drizzle(sqlite, { schema: indexSchema })
    sources = new Map()
    calls = []
    updated = []
    enabled = true
    agent = fakeAgent((p) => calls.push(p))
    service = build()
  })

  afterEach(() => {
    service.dispose()
    sqlite.close()
    fs.rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('does not touch the index DB until a note is fetched (vault open starts it before the DB exists)', () => {
    const getDb = vi.fn(() => {
      throw new Error('Index database not initialized')
    })
    expect(() =>
      createFoldService({
        getDb,
        getSource: async () => null,
        getAgent: async () => null,
        isEnabled: () => false,
        onUpdated: () => {},
        idleMs: 30_000
      })
    ).not.toThrow()
    expect(getDb).not.toHaveBeenCalled()
  })

  it('never calls a model for a short note', async () => {
    sources.set('n', 'Just a few words.')
    const layers = await service.get('n')
    expect(layers.status).toBe('short')
    expect(calls).toHaveLength(0)
  })

  it('renders the local fallback at once, then the model output from the cache', async () => {
    sources.set('n', noteOf(section('One', 0), section('Two', 40)))
    const first = await service.get('n')
    expect(first.status).toBe('writing')
    expect(first.ready).toEqual([])
    expect(first.sections[0].paragraphs[0].key).toBeNull()
    await settle()
    expect(calls).toHaveLength(2)
    expect(updated).toContain('n')

    const second = await service.get('n')
    expect(second.status).toBe('ready')
    expect(second.agent).toBe('Test agent')
    expect(second.sections[0].paragraphs[0].key).toEqual({
      takeaway: 'Key claim.',
      reason: 'Because.'
    })
    expect(second.ready).toEqual(['key', 'takeaway', 'topic'])
    expect(calls).toHaveLength(2)
  })

  it('serves a second service instance from the DB cache without a model call', async () => {
    sources.set('n', noteOf(section('One', 0), section('Two', 40)))
    await service.get('n')
    await settle()
    const callsBefore = calls.length
    service.dispose()
    service = build()
    expect((await service.get('n')).status).toBe('ready')
    expect(calls).toHaveLength(callsBefore)
  })

  it('regenerates only the chunk that changed after the idle window', async () => {
    const original = noteOf(section('One', 0), section('Two', 40))
    sources.set('n', original)
    await service.get('n')
    await settle()
    expect(calls).toHaveLength(2)

    sources.set('n', noteOf(section('One', 0), section('Two', 80)))
    service.noteChanged('n')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain('Two')
    expect((await service.get('n')).status).toBe('ready')
  })

  it('does not regenerate a note the renderer never opened', async () => {
    sources.set('n', noteOf(section('One', 0), section('Two', 40)))
    service.noteChanged('n')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(0)
  })

  it('runs at most 4 chunks in parallel', async () => {
    const release: Array<() => void> = []
    let active = 0
    let peak = 0
    agent = {
      label: 'Slow',
      modelId: 'slow:model',
      async run<T>(prompt: string, schema: ZodType<T>): Promise<T> {
        active++
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => release.push(resolve))
        active--
        const count = (prompt.match(/^Paragraph \d+:/gm) ?? []).length
        return schema.parse({
          sectionTakeaway: 's',
          paragraphs: Array.from({ length: count }, () => ({
            brief: [0],
            key: { takeaway: 'k', reason: 'r' },
            takeaway: 't',
            topic: 'p',
            evidence: []
          }))
        })
      }
    }
    sources.set('n', noteOf(...Array.from({ length: 7 }, (_, i) => section(`S${i}`, i * 30))))
    await service.get('n')
    await settle()
    expect(peak).toBe(4)
    while (release.length > 0) {
      release.shift()!()
      await settle()
    }
    expect(peak).toBe(4)
    expect((await service.get('n')).status).toBe('ready')
  })

  it('reports invalid model JSON as failed, keeps the fallback, and retries on request', async () => {
    let bad = true
    agent = fakeAgent(
      (p) => calls.push(p),
      () => (bad ? { sectionTakeaway: '', paragraphs: [] } : undefined)
    )
    sources.set('n', noteOf(section('One', 0), section('Two', 40)))
    await service.get('n')
    await settle()

    expect(service.getLastRun()).toEqual({ status: 'failed', noteId: 'n' })
    const failed = await service.get('n')
    expect(failed.status).toBe('failed')
    expect(failed.sections[0].paragraphs[0].briefIdx.length).toBeGreaterThan(0)
    const failedCalls = calls.length
    await service.get('n')
    expect(calls).toHaveLength(failedCalls)

    bad = false
    const retried = await service.retry()
    expect(retried?.status).toBe('writing')
    await settle()
    expect((await service.get('n')).status).toBe('ready')
    expect(service.getLastRun()).toEqual({ status: 'idle', noteId: null })
  })

  it('makes no model call when the setting is off or no agent exists', async () => {
    sources.set('n', noteOf(section('One', 0), section('Two', 40)))
    enabled = false
    const off = await service.get('n')
    expect(off.status).toBe('off')
    expect(off.sections.length).toBeGreaterThan(0)
    enabled = true
    agent = null
    const none = await service.get('n')
    expect(none.status).toBe('no_agent')
    expect(none.sections[0].paragraphs[0].briefIdx).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })

  it('tells every fetched note to refetch when the settings change, so a toggled setting needs no reopen', async () => {
    sources.set('n', noteOf(section('One', 0), section('Two', 40)))
    enabled = false
    expect((await service.get('n')).status).toBe('off')
    updated.length = 0

    enabled = true
    service.refresh()
    expect(updated).toEqual(['n'])
    expect((await service.get('n')).status).toBe('writing')
  })

  it('reads a note the index does not know yet as short, then tells the renderer once it is indexed', async () => {
    const layers = await service.get('late')
    expect(layers.status).toBe('short')
    expect(calls).toHaveLength(0)

    sources.set('late', noteOf(section('One', 0), section('Two', 40)))
    updated.length = 0
    service.noteChanged('late')
    expect(updated).toEqual(['late'])
    expect((await service.get('late')).status).toBe('writing')
  })

  it('prunes only chunks older than the cutoff', () => {
    const key = (chunkHash: string) => ({ chunkHash, language: 'en', modelId: 'm' })
    writeChunkPayload(db, key('old'), '{}', 1_000)
    writeChunkPayload(db, key('new'), '{}', 9_000)
    expect(pruneChunksOlderThan(db, 5_000)).toBe(1)
    expect(sqlite.prepare('select chunk_hash from note_fold_chunks').all()).toEqual([
      { chunk_hash: 'new' }
    ])
  })
})
