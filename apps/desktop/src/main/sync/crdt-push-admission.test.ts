import { createServer, type Server, type ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeadLetterError, withRetry } from '@memry/sync-client/retry'
import type * as HttpClient from './http-client'

const transport = vi.hoisted(() => ({ starts: [] as number[], active: 0, peak: 0 }))

vi.mock('electron', () => ({
  net: {
    fetch: async (...args: Parameters<typeof fetch>) => {
      transport.starts.push(Date.now())
      transport.active++
      transport.peak = Math.max(transport.peak, transport.active)
      try {
        return await fetch(...args)
      } finally {
        transport.active--
      }
    }
  }
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../database', () => ({ getDatabase: () => null }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'test-vault' }))
vi.mock('../lib/main-i18n', () => ({ getMainI18n: () => ({ t: (key: string) => key }) }))

describe('CRDT push admission over loopback HTTP', () => {
  let server: Server
  let http: typeof HttpClient
  let rateLimitNext: boolean
  let holdResponses: boolean
  let paths: string[]
  let held: ServerResponse[]

  const reply = (response: ServerResponse): void => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ sequenceNum: 1, revision: 'r1', results: [], notes: {} }))
  }

  beforeEach(async () => {
    vi.resetModules()
    transport.starts = []
    transport.active = 0
    transport.peak = 0
    rateLimitNext = false
    holdResponses = false
    paths = []
    held = []
    server = createServer((request, response) => {
      request.resume()
      paths.push(request.url ?? '')
      if (rateLimitNext) {
        rateLimitNext = false
        response.writeHead(429, { 'Retry-After': '1' })
        response.end()
      } else if (holdResponses) {
        held.push(response)
      } else {
        reply(response)
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback listener')
    vi.stubEnv('SYNC_SERVER_URL', `http://127.0.0.1:${address.port}`)
    // Each test gets a fresh transport session, including its admission state.
    http = await import('./http-client')
  })

  afterEach(async () => {
    for (const response of held) reply(response)
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    vi.unstubAllEnvs()
  })

  const push = (route: string): Promise<unknown> => {
    switch (route) {
      case 'incremental':
        return http.postToServer('/sync/crdt/updates', { noteId: 'n', updates: ['AA=='] }, 't')
      case 'full':
        return http.pushCrdtFullUpdate('n', new Uint8Array([0]), 't')
      case 'snapshot':
        return http.pushCrdtSnapshot('n', new Uint8Array([0]), 't')
      case 'batch':
        return http.pushCrdtSnapshotBatch([{ noteId: 'n', snapshot: new Uint8Array([0]) }], 't')
      default:
        throw new Error(`Unknown test route: ${route}`)
    }
  }

  it.each(['incremental', 'full', 'snapshot', 'batch'])(
    'shares a %s 429 cooldown before retry wrapping, without blocking batch pulls',
    async (route) => {
      rateLimitNext = true
      // The actual adapter creates the RateLimitError, and actual retry wraps it.
      const failure = await withRetry(() => push(route), { maxRetries: 0 }).catch(
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(DeadLetterError)
      expect(paths).toHaveLength(1)

      const siblings = await Promise.allSettled(
        ['incremental', 'full', 'snapshot', 'batch'].map(push)
      )
      expect(siblings.map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
        'rejected'
      ])
      // This POST is a pull, not a fourth push endpoint.
      await http.postToServer('/sync/crdt/updates/batch', { notes: [] }, 't')
      expect(paths).toHaveLength(2)
      expect(paths[1]).toBe('/sync/crdt/updates/batch')

      await delay(1100)
      await expect(push('incremental')).resolves.toBeDefined()
      expect(paths).toHaveLength(3)
    }
  )

  it('fails excess mixed push attempts fast instead of admitting or queuing the whole burst', async () => {
    holdResponses = true
    const attempts = Array.from({ length: 24 }, (_, index) =>
      push(['incremental', 'full', 'snapshot', 'batch'][index % 4]).then(
        () => 'stored',
        () => 'deferred'
      )
    )
    try {
      await vi.waitFor(() => expect(transport.starts.length).toBeGreaterThan(0))
      await delay(50)
      expect(transport.peak).toBeLessThanOrEqual(4)
      expect(transport.starts.length).toBeLessThanOrEqual(4)
    } finally {
      holdResponses = false
      for (const response of held) reply(response)
      held = []
      const outcomes = await Promise.all(attempts)
      // Releasing occupied slots must not dispatch hidden transport-queued work.
      expect(outcomes.filter((outcome) => outcome === 'deferred').length).toBeGreaterThanOrEqual(20)
      expect(transport.starts.length).toBeLessThanOrEqual(4)
    }
  })

  it('paces starts even when successful requests finish immediately', async () => {
    const failures: unknown[] = []
    for (let index = 0; index < 12; index++) {
      await push('incremental').catch((error: unknown) => failures.push(error))
    }
    for (const error of failures) expect(error).toBeInstanceOf(http.RateLimitError)
    expect(transport.starts.length).toBeGreaterThan(0)
    // 300 requests per minute leaves at least 200 ms between admitted starts.
    for (let index = 1; index < transport.starts.length; index++) {
      expect(transport.starts[index] - transport.starts[index - 1]).toBeGreaterThanOrEqual(200)
    }
  })
})
