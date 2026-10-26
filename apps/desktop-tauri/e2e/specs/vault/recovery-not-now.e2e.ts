// The repair prompt for a damaged data.db, answered "Not now" (MEMRY_TEST_DIALOG_RESULT=cancel).
// Recovery is never silent: nothing moves until the user says Repair, the vault stays
// registered, and the picker shows.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { damageDatabase, dataDbPath } from '../../harness/damage'
import { gracefulClose, restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { vaultList, vaultStatus } from '../../harness/vault-commands'
import { readMainLog, waitForMainLog } from '../../harness/wait'

test.use({ extraEnv: { MEMRY_TEST_DIALOG_RESULT: 'cancel' } })

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

test('Not now leaves the damaged database untouched, keeps the vault registered and shows the picker', async ({
  app,
  page,
  testVaultPath
}) => {
  const database = dataDbPath(testVaultPath)
  await gracefulClose(app)
  damageDatabase(database)
  const before = sha(database)

  await restart(app)

  expect(await waitForMainLog(app, 'the user postponed the data.db repair')).toBe(true)
  expect((await vaultStatus(page)).isOpen).toBe(false)
  expect(sha(database)).toBe(before)
  expect(
    readdirSync(dirname(database)).filter((name) => name.startsWith('data.db.corrupt-'))
  ).toEqual([])
  // The registry entry is intact, so the next launch asks again.
  const list = await vaultList(page)
  expect(list.currentVault).toBe(testVaultPath)
  expect(list.vaults.map((vault) => vault.path)).toEqual([testVaultPath])
  expect(readMainLog(app.dirs.logDir)).not.toContain('data.db repaired')
})
