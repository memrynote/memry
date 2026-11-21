import { describe, expect, it } from 'vitest'

import type { CrdtManifestResponse } from '@memry/contracts/sync-api'

import { RateLimitError, SyncServerError } from '../http-client'
import { readBodyManifest } from './body-manifest'

const page = (ids: string[], nextCursor: string | null): CrdtManifestResponse => ({
  documents: ids.map((noteId) => ({ noteId, floor: 0, snapshot: null, maxSequenceNum: 1 })),
  nextCursor
})

/** A fake clock that `sleep` advances, so retry windows run in no wall time. */
const clock = () => {
  let at = 0
  return { now: () => at, sleep: async (ms: number) => void (at += ms), slept: () => at }
}

describe('readBodyManifest', () => {
  it('walks every page with its cursor and keys documents by id', async () => {
    const cursors: Array<string | null> = []
    const pages: Record<string, CrdtManifestResponse> = {
      first: page(['a', 'b'], 'c1'),
      c1: page(['c'], null)
    }

    const manifest = await readBodyManifest('jwt', {
      fetchPage: async (_token, cursor) => {
        cursors.push(cursor)
        return pages[cursor ?? 'first']
      }
    })

    expect(cursors).toEqual([null, 'c1'])
    expect([...(manifest?.keys() ?? [])]).toEqual(['a', 'b', 'c'])
  })

  it.each([
    ['a server without the route answers 404', new SyncServerError('Not found', 404)],
    ['a transport failure', new Error('socket hang up')]
  ])('answers nothing when %s mid-read', async (_label, failure) => {
    let calls = 0
    const manifest = await readBodyManifest('jwt', {
      fetchPage: async () => {
        if (calls++ === 0) return page(['a'], 'c1')
        throw failure
      }
    })

    // A read that stopped short confirms nothing, even the pages it did read.
    expect(manifest).toBeNull()
  })

  it('answers nothing for a malformed page', async () => {
    await expect(
      readBodyManifest('jwt', { fetchPage: async () => ({ documents: [{ noteId: '' }] }) })
    ).resolves.toBeNull()
  })

  it('asks a 429 page again after retry-after and keeps the pages already read', async () => {
    const fake = clock()
    const cursors: Array<string | null> = []
    let limited = 2
    const manifest = await readBodyManifest('jwt', {
      ...fake,
      fetchPage: async (_token, cursor) => {
        cursors.push(cursor)
        if (cursor === null) return page(['a'], 'c1')
        if (limited-- > 0) throw new RateLimitError(20)
        return page(['b'], null)
      }
    })

    expect([...(manifest?.keys() ?? [])]).toEqual(['a', 'b'])
    expect(cursors).toEqual([null, 'c1', 'c1', 'c1'])
    expect(fake.slept()).toBe(40_000)
  })

  it('gives up once a page stays rate limited past one 60 s window', async () => {
    const fake = clock()
    const manifest = await readBodyManifest('jwt', {
      ...fake,
      fetchPage: async () => {
        throw new RateLimitError(25)
      }
    })

    expect(manifest).toBeNull()
    expect(fake.slept()).toBeLessThanOrEqual(60_000)
  })

  it('answers nothing once aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      readBodyManifest('jwt', {
        signal: controller.signal,
        fetchPage: async () => page(['a'], null)
      })
    ).resolves.toBeNull()
  })
})
