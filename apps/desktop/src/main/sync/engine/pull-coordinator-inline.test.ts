import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine } from '../engine'
import { SYNC_STATE_KEYS } from './sync-context'
import { ItemApplier } from '../apply-item'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-pull-inline-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2292: `GET /sync/changes?inline=1` carries the first page's payloads, so a
 * wake that delivers a small change costs one round trip instead of two.
 */

const ref = (id: string, type: 'task' | 'project' = 'task') => ({
  id,
  type,
  version: 1,
  modifiedAt: 1000,
  size: 10
})

const pullItem = (id: string, type: 'task' | 'project' = 'task') => ({
  id,
  type,
  operation: 'update',
  cryptoVersion: 1,
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
  signature: 'sig',
  signerDeviceId: 'device-2',
  clock: { 'device-2': 1 }
})

const mockDecrypt = async (): Promise<void> => {
  vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockReturnValue({
    content: new TextEncoder().encode(JSON.stringify({ title: 'from B' })),
    verified: true
  })
}

describe('PullCoordinator with inline changes pages (#2292)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // #2292
  it('asks for inline on the first page and applies a fully inline page with no /sync/pull', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const http = await import('../http-client')
    const getSpy = vi.spyOn(http, 'getFromServer').mockResolvedValue({
      items: [ref('task-1')],
      deleted: [],
      hasMore: false,
      nextCursor: 7,
      inline: [pullItem('task-1')]
    })
    // Answers like the server would, so a client that still pulls fails the assertion, not a timeout.
    const postSpy = vi
      .spyOn(http, 'postToServer')
      .mockResolvedValue({ items: [pullItem('task-1')] })
    await mockDecrypt()
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '3')

    await expect(engine.pull()).resolves.toBe(true)

    expect(getSpy).toHaveBeenCalledWith(
      '/sync/changes?limit=500&cursor=3&inline=1',
      expect.any(String),
      undefined,
      expect.anything()
    )
    expect(postSpy).not.toHaveBeenCalledWith('/sync/pull', expect.anything(), expect.anything())
    expect(applySpy.mock.calls.map(([input]) => input.itemId)).toEqual(['task-1'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
  })

  // #2292
  it('pulls only the ids the page did not inline, and applies both sources in rank order', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const http = await import('../http-client')
    vi.spyOn(http, 'getFromServer').mockResolvedValue({
      items: [ref('task-child'), ref('project-big', 'project')],
      deleted: [],
      hasMore: false,
      nextCursor: 9,
      inline: [pullItem('task-child')]
    })
    const postSpy = vi
      .spyOn(http, 'postToServer')
      .mockResolvedValue({ items: [pullItem('project-big', 'project')] })
    await mockDecrypt()
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await engine.pull()

    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(postSpy).toHaveBeenCalledWith(
      '/sync/pull',
      { itemIds: ['project-big'] },
      expect.any(String)
    )
    // One slice, one sort: the pulled parent project applies before its inline task.
    expect(applySpy.mock.calls.map(([input]) => input.itemId)).toEqual([
      'project-big',
      'task-child'
    ])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9')
  })

  // #2292: the continuation pages keep 500 refs and the pull bucket.
  it('does not ask for inline on a prefetched continuation page', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const http = await import('../http-client')
    const getSpy = vi
      .spyOn(http, 'getFromServer')
      .mockResolvedValueOnce({ items: [], deleted: [], hasMore: true, nextCursor: 2 })
      .mockResolvedValueOnce({ items: [], deleted: [], hasMore: false, nextCursor: 3 })

    await engine.pull()

    expect(getSpy.mock.calls.map(([path]) => path)).toEqual([
      '/sync/changes?limit=500&inline=1',
      '/sync/changes?limit=500&cursor=2'
    ])
  })

  // #2292: bootstrap keeps its measured page arithmetic.
  it('does not ask for inline during a full sync', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const getSpy = vi
      .spyOn(await import('../http-client'), 'getFromServer')
      .mockResolvedValue({ items: [], deleted: [], hasMore: false, nextCursor: 1 })
    engine['ctx'].fullSyncActive = true
    try {
      await engine.pull()
    } finally {
      engine['ctx'].fullSyncActive = false
    }

    expect(getSpy).toHaveBeenCalledWith(
      '/sync/changes?limit=500',
      expect.any(String),
      undefined,
      expect.anything()
    )
  })

  // #2292 with #2285: inline items do not make a broken /sync/pull body acceptable.
  it('holds the cursor and applies nothing when the remainder pull is not an envelope', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const http = await import('../http-client')
    vi.spyOn(http, 'getFromServer').mockResolvedValue({
      items: [ref('task-small'), ref('task-big')],
      deleted: [],
      hasMore: false,
      nextCursor: 11,
      inline: [pullItem('task-small')]
    })
    vi.spyOn(http, 'postToServer').mockResolvedValue({ error: 'not a pull envelope' })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '4')

    await expect(engine.pull()).resolves.toBe(false)

    expect(applySpy).not.toHaveBeenCalled()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')
  })
})
