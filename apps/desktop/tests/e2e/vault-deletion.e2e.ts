/**
 * E2E coverage for `window.api.vault.deleteFromAccount` — purging a vault
 * from the signed-in account (server data + local known-vaults entry) while
 * leaving whatever is on disk completely untouched.
 *
 * Uses the real `TestSyncServer` (a real D1-backed Cloudflare Worker) via
 * `startSharedSyncBootstrap()` and the real `__memryTestHooks.bootstrapSyncDevice`
 * test hook to reach signed-in state — the same mechanism used by
 * `account-sync.e2e.ts` / `shared-sync-bootstrap.e2e.ts`, adapted for a single
 * device instead of a device pair.
 */
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'
import {
  destroyLaunchedElectron,
  launchElectronWithWindow,
  type LaunchedElectron
} from './utils/electron-lifecycle'
import { startSharedSyncBootstrap, type SharedSyncBootstrap } from './utils/sync-backend'

function createTestVault(prefix: string): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(vaultPath, '.memry'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
  return vaultPath
}

async function bootstrapSyncDevice(
  electronApp: ElectronApplication,
  input: SharedSyncBootstrap['deviceA']
): Promise<void> {
  await electronApp.evaluate(async (_electron, bootstrapInput) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: {
          bootstrapSyncDevice(i: typeof bootstrapInput): Promise<{ deviceId: string }>
        }
      }
    ).__memryTestHooks
    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }
    await hooks.bootstrapSyncDevice(bootstrapInput)
  }, input)
}

const test = base.extend<{
  testVaultPath: string
  syncBootstrap: SharedSyncBootstrap
  electronApp: ElectronApplication
  page: Page
}>({
  testVaultPath: async ({}, use) => {
    const vaultPath = createTestVault('memry-e2e-vault-deletion-')
    await use(vaultPath)
    fs.rmSync(vaultPath, { recursive: true, force: true })
  },

  syncBootstrap: async ({}, use) => {
    const bootstrap = await startSharedSyncBootstrap()
    try {
      await use(bootstrap)
    } finally {
      await bootstrap.server.stop()
    }
  },

  electronApp: async ({ testVaultPath, syncBootstrap }, use) => {
    const launched = await launchElectronWithWindow({
      testVaultPath,
      // A unique per-run device id namespaces the OS keychain account keytar
      // uses for the access/refresh tokens (see crypto/keychain.ts) — without
      // it, this test shares the same unscoped keychain entry as every other
      // plain single-device e2e test, which is prone to stale-state timeouts.
      deviceId: `e2e-vault-deletion-${randomUUID()}`,
      syncServerUrl: syncBootstrap.serverUrl
    })
    ;(launched.app as unknown as { __launched?: LaunchedElectron }).__launched = launched
    await use(launched.app)
    await destroyLaunchedElectron(launched)
  },

  // Signs the single launched instance into the shared test account so
  // vault.deleteFromAccount has a real, authenticated session to act against.
  page: async ({ electronApp, syncBootstrap, testVaultPath }, use) => {
    const launched = (electronApp as unknown as { __launched?: LaunchedElectron }).__launched
    const page = launched?.page ?? (await electronApp.firstWindow({ timeout: 45_000 }))
    await waitForAppReady(page)
    await waitForVaultReady(page)

    await bootstrapSyncDevice(electronApp, syncBootstrap.deviceA)

    // bootstrapSyncDevice overwrites the active vault's own vault_uuid row
    // directly in its data.db (it's designed to bind a pre-existing empty
    // E2E vault to the shared sync identity). The known-vaults store entry
    // that vault.deleteFromAccount's active-vault guard reads was stamped at
    // first launch with a different, freshly-minted uuid, so re-select the
    // same path to force it to pick up the bootstrapped uuid.
    const resynced = await page.evaluate((p) => window.api.vault.switch(p), testVaultPath)
    if (!resynced.success) {
      throw new Error(resynced.error ?? 'failed to resync active vault after sync bootstrap')
    }
    await waitForVaultReady(page)

    await expect
      .poll(() => page.evaluate(() => window.api.account.getInfo()), { timeout: 30_000 })
      .toMatchObject({ email: syncBootstrap.email })

    // account.getInfo() only reflects local store state written directly by
    // the bootstrap hook; it doesn't prove the access token persisted to the
    // OS keychain is actually retrievable yet (keytar access to a brand-new
    // item can lag). getDevices() round-trips to the real server with that
    // token, so polling it is a real readiness gate, not a fixed sleep.
    await expect
      .poll(() => page.evaluate(() => window.api.syncDevices.getDevices()), { timeout: 30_000 })
      .toMatchObject({ email: syncBootstrap.email, devices: [expect.anything()] })

    await use(page)
  }
})

test.describe('vault deletion', () => {
  // THE guarantee this whole feature exists for: deleting a vault from the
  // account must never touch the files on disk. A second, non-active local
  // vault is required because the fixture's active vault can't be deleted
  // (see the "refuses to delete the active vault" test below).
  test('leaves a local, non-active vault untouched on disk after deleting it from the account', async ({
    page,
    testVaultPath
  }) => {
    const secondPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-vault-deletion-second-'))
    fs.mkdirSync(path.join(secondPath, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(secondPath, 'notes', 'keep-me.md'), '# keep me\n')

    try {
      const created = await page.evaluate(
        (p) => window.api.vault.create(p, 'Second Vault'),
        secondPath
      )
      expect(created.success, created.error).toBe(true)
      const secondUuid = created.vault?.vaultUuid
      expect(secondUuid).toBeTruthy()

      // Registers the newly-created vault with the sync server (self-registration
      // inside refreshVaultDirectory) so the delete route — which 404s on a vault
      // it has never heard of — has something real to purge.
      await page.evaluate(() => window.api.vault.listAccount())

      // vault.create() opens the new vault; switch back to the original so the
      // vault we're about to delete is not the active one.
      const switched = await page.evaluate((p) => window.api.vault.switch(p), testVaultPath)
      expect(switched.success, switched.error).toBe(true)
      await waitForVaultReady(page)

      await page.evaluate((id) => window.api.vault.deleteFromAccount(id), secondUuid!)

      expect(fs.existsSync(secondPath), 'vault folder must survive account deletion').toBe(true)
      expect(
        fs.readFileSync(path.join(secondPath, 'notes', 'keep-me.md'), 'utf8'),
        'note content must survive account deletion'
      ).toContain('keep me')

      const afterList = await page.evaluate(() => window.api.vault.listAccount())
      expect(afterList.some((v) => v.vaultUuid === secondUuid)).toBe(false)
    } finally {
      fs.rmSync(secondPath, { recursive: true, force: true })
    }
  })

  // The originally-reported case: a vault that exists only on the server
  // (never created or opened by this device) is purged and disappears from
  // the account vault list. Seeded directly into the real D1 database — the
  // same technique startSharedSyncBootstrap already uses to seed the user and
  // entitlement rows — rather than routing it through a second Electron
  // instance, since nothing about deleteFromAccount depends on which device
  // registered the vault.
  test('deletes a cloud-only vault (no local copy) from the account', async ({
    page,
    electronApp,
    syncBootstrap
  }) => {
    const cloudOnlyUuid = randomUUID()
    const db = await syncBootstrap.server.getD1()
    const user = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(syncBootstrap.email)
      .first<{ id: string }>()
    if (!user) throw new Error('seeded sync user not found')

    const now = Math.floor(Date.now() / 1000)
    await db
      .prepare(
        `INSERT INTO sync_vaults (id, user_id, vault_id, encrypted_name, name_nonce, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`
      )
      .bind(randomUUID(), user.id, cloudOnlyUuid, now, now)
      .run()

    // The sync runtime's startup refresh stamps the vault-directory throttle
    // before this row existed; reset it so the next listAccount() refreshes
    // for real instead of serving the pre-seed cache for up to 30 seconds.
    await electronApp.evaluate(async () => {
      const hooks = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: { resetVaultDirectoryThrottle(): Promise<void> }
        }
      ).__memryTestHooks
      if (!hooks) throw new Error('Memry test hooks are not registered')
      await hooks.resetVaultDirectoryThrottle()
    })

    // refreshVaultDirectory silently no-ops (by design — it's a best-effort
    // background refresh) if the nameKey derived from the local master key
    // isn't retrievable from the OS keychain on the first attempt right after
    // sign-in, so the very first listAccount() call can race a still-settling
    // keychain read. Poll instead of asserting on a single call.
    let entry: { vaultUuid: string; localPath: string | null } | undefined
    await expect
      .poll(
        async () => {
          const vaults = await page.evaluate(() => window.api.vault.listAccount())
          entry = vaults.find((v) => v.vaultUuid === cloudOnlyUuid)
          return entry ?? null
        },
        { timeout: 20_000 }
      )
      .not.toBeNull()
    expect(entry?.localPath, 'cloud-only vault must have no local copy').toBeNull()

    await page.evaluate((id) => window.api.vault.deleteFromAccount(id), cloudOnlyUuid)

    const after = await page.evaluate(() => window.api.vault.listAccount())
    expect(after.some((v) => v.vaultUuid === cloudOnlyUuid)).toBe(false)
  })

  test('refuses to delete the active vault', async ({ page, syncBootstrap }) => {
    const err = await page.evaluate(
      (id) =>
        window.api.vault.deleteFromAccount(id).then(
          () => null,
          (e) => String(e)
        ),
      syncBootstrap.vaultId
    )
    expect(err).toMatch(/active vault/i)
  })
})
