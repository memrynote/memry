import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  createNoteWithBody,
  getNoteFileBodyById,
  normalizeBodyText
} from './utils/note-sync-helpers'
import {
  syncAndWait,
  syncBothAndWait,
  waitForCrdtQueueIdle,
  waitForSyncOnline
} from './utils/network-control'

/**
 * #2424: a device opens its vault under a locally minted uuid, then adopts the
 * account vault's uuid when it joins sync. The first sync runtime restart after
 * that must reopen the store the device already merged into, moved to the
 * adopted name, not a new empty one that reads as "no sync marker" and resets
 * the legacy sweep and the unmerged-body debt.
 */

const TIMEOUT = 60_000

interface AdoptionStoreTestHooks {
  restartSyncRuntimeForTests(): Promise<void>
  getSyncStateValueForTests(key: string): Promise<string | null>
  listCrdtStoreDirsForTests(): Promise<string[]>
}

async function callHook<K extends keyof AdoptionStoreTestHooks>(
  electronApp: ElectronApplication,
  name: K,
  ...args: Parameters<AdoptionStoreTestHooks[K]>
): Promise<Awaited<ReturnType<AdoptionStoreTestHooks[K]>>> {
  return electronApp.evaluate(
    async (_context, { hookName, hookArgs }) => {
      const hooks = (
        globalThis as typeof globalThis & { __memryTestHooks?: AdoptionStoreTestHooks }
      ).__memryTestHooks
      if (!hooks) throw new Error('Memry test hooks are not registered')
      const hook = hooks[hookName as keyof AdoptionStoreTestHooks] as (...a: unknown[]) => unknown
      return hook(...hookArgs)
    },
    { hookName: name, hookArgs: args as unknown[] }
  ) as Promise<Awaited<ReturnType<AdoptionStoreTestHooks[K]>>>
}

test.describe('CRDT store after vault adoption (#2424)', () => {
  test.setTimeout(180_000)

  test('the first runtime restart after linking reopens the merged store', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair,
    syncBootstrap
  }) => {
    void bootstrappedSyncPair
    const body = 'merged before the restart'

    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    const note = await createNoteWithBody(pageA, `Adoption Store ${Date.now()}`, body)
    await waitForCrdtQueueIdle(electronAppA)
    await syncBothAndWait(pageA, pageB)
    await expect
      .poll(() => getNoteFileBodyById(pageB, note.id), { timeout: TIMEOUT })
      .toBe(normalizeBodyText(body))

    // B's first store was unmarked, so it owes one sweep; let it finish.
    await expect
      .poll(
        async () => {
          await syncAndWait(pageB)
          return [
            await callHook(electronAppB, 'getSyncStateValueForTests', 'noteBodyLegacySweep'),
            await callHook(electronAppB, 'getSyncStateValueForTests', 'crdtUnmergedDebt')
          ]
        },
        { timeout: TIMEOUT, intervals: [2_000, 5_000] }
      )
      .toEqual(['done', expect.not.stringMatching(/^1$/)])

    await callHook(electronAppB, 'restartSyncRuntimeForTests')

    // An unmarked store deletes the sweep key and raises the debt as it opens,
    // before the restart returns.
    expect(await callHook(electronAppB, 'getSyncStateValueForTests', 'noteBodyLegacySweep')).toBe(
      'done'
    )
    expect(await callHook(electronAppB, 'getSyncStateValueForTests', 'crdtUnmergedDebt')).not.toBe(
      '1'
    )
    // The pre-adoption store moved to the adopted name; none is left behind.
    expect(await callHook(electronAppB, 'listCrdtStoreDirsForTests')).toEqual([
      syncBootstrap.deviceB.vaultId.toLowerCase()
    ])
  })
})
