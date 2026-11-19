// Port of apps/desktop/tests/e2e/sync-adoption-store-restart.e2e.ts (#2424). Electron keeps the
// CRDT store in a directory named after the vault uuid, and adoption renames it. Here the store is
// the vault's `data.db`, and adoption binds it to the account's vault (`meta`
// `sync.server_vault_id`). The first sync runtime restart after linking must keep that store: the
// same database identity (`vault.id`, Electron's `crdtStoreEpoch`), the finished legacy body pull
// (`sync.note_body_legacy_pull`, Electron's `noteBodyLegacySweep`) and the adopted vault id.
import { expect, test } from '../../fixtures/sync-auth-fixtures'
import { invokeTest } from '../../harness/invoke-test'
import { normalizeBodyText } from '../../harness/note-sync-helpers'
import { createNote } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import type { TauriApp } from '../../harness/tauri-lifecycle'

const TIMEOUT = 60_000

async function metaValue(app: TauriApp, key: string): Promise<string | null> {
  const rows = await invokeTest<{ value: string }[]>(app, 'e2e_debug_query', {
    sql: `SELECT value FROM meta WHERE key = '${key}'`
  })
  return rows[0]?.value ?? null
}

// `idle` alone also means no supervisor runs (`sync::status::idle`). A supervisor sets
// `lastSyncAt` only when its first pass ends, so `idle` with it means one is bound and has synced.
async function supervisorIdle(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const status = (await window.__TAURI__.core.invoke('sync_get_status')) as {
      status: string
      lastSyncAt?: number
    }
    return status.status === 'idle' && status.lastSyncAt !== undefined
  })
}

// A pass already running answers `busy`; the polls below run Sync Now again until they see
// what they wait for.
async function syncNow(page: Page): Promise<{ success: boolean; reason?: string; error?: string }> {
  return page.evaluate(
    () =>
      window.__TAURI__.core.invoke('sync_trigger') as Promise<{
        success: boolean
        reason?: string
        error?: string
      }>
  )
}

test.describe('CRDT store after vault adoption (#2424)', () => {
  test('the first runtime restart after linking reopens the merged store', async ({
    appB,
    page,
    pageB,
    bootstrappedSyncPair: _bootstrappedSyncPair,
    syncBootstrap
  }) => {
    test.setTimeout(180_000)
    const body = 'merged before the restart'

    await expect.poll(() => supervisorIdle(page), { timeout: TIMEOUT }).toBe(true)
    await expect.poll(() => supervisorIdle(pageB), { timeout: TIMEOUT }).toBe(true)
    const note = await createNote(page, { title: `Adoption Store ${Date.now()}`, content: body })
    await expect
      .poll(
        async () => {
          await syncNow(page)
          await syncNow(pageB)
          return invokeTest<string>(appB, 'e2e_note_body', { noteId: note.id }).catch(() => null)
        },
        { timeout: TIMEOUT, intervals: [2_000, 5_000] }
      )
      .toBe(normalizeBodyText(body))

    // B's store was unmarked, so it owes one legacy body pull; let it finish.
    await expect
      .poll(
        async () => {
          await syncNow(pageB)
          return metaValue(appB, 'sync.note_body_legacy_pull')
        },
        { timeout: TIMEOUT, intervals: [2_000, 5_000] }
      )
      .toBe('done')
    const epoch = await metaValue(appB, 'vault.id')
    expect(epoch).toBeTruthy()

    const adopted = syncBootstrap.deviceB.vaultId.toLowerCase()
    // The same database identity, still bound to the adopted vault, not to a new one.
    const expectStoreKept = async (): Promise<void> => {
      expect(await metaValue(appB, 'vault.id')).toBe(epoch)
      expect(await metaValue(appB, 'sync.server_vault_id')).toBe(adopted)
    }

    // Closes B's vault and opens it again as a launch does; the reopen has read both keys when
    // it answers.
    await invokeTest(appB, 'e2e_restart_sync_runtime')
    // Read before the new supervisor's first pass: a pass sets a missing key back to `done` (the
    // server sends `noteBodies` on every page), so only this read sees a restart that dropped it.
    expect(await metaValue(appB, 'sync.note_body_legacy_pull')).toBe('done')
    await expectStoreKept()
    // The new supervisor binds and runs its first pass after the hook answers; a rearm of the
    // legacy pull or a new binding lands by then.
    await expect.poll(() => supervisorIdle(pageB), { timeout: TIMEOUT }).toBe(true)
    expect(await syncNow(pageB)).toEqual({ success: true })

    expect(await metaValue(appB, 'sync.note_body_legacy_pull')).toBe('done')
    await expectStoreKept()
  })
})
