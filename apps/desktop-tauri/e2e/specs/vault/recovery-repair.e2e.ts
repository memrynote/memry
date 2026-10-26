// The repair prompt answered Repair (MEMRY_TEST_DIALOG_RESULT=confirm): the damaged file is
// kept as a quarantine, a fresh database is rebuilt, the vault opens, and the rows the core
// could read survive.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { damageDatabase, dataDbPath } from '../../harness/damage'
import { gracefulClose, restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { vaultStatus } from '../../harness/vault-commands'
import { waitForMainLog } from '../../harness/wait'

test.use({ extraEnv: { MEMRY_TEST_DIALOG_RESULT: 'confirm' } })

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

test('Repair quarantines the damaged database, rebuilds it and opens the vault', async ({
  app,
  page,
  testVaultPath
}) => {
  const database = dataDbPath(testVaultPath)
  await gracefulClose(app)
  damageDatabase(database)
  const damaged = sha(database)

  await restart(app)

  expect(await waitForMainLog(app, 'data.db repaired')).toBe(true)
  await expect.poll(async () => (await vaultStatus(page)).isOpen, { timeout: 30_000 }).toBe(true)
  const quarantines = readdirSync(dirname(database)).filter((name) =>
    name.startsWith('data.db.corrupt-')
  )
  expect(quarantines).toHaveLength(1)
  // The damaged file is the backup, byte for byte.
  expect(sha(join(dirname(database), quarantines[0]))).toBe(damaged)
  // The rebuilt database is the core's own: migrated, with the recovery recorded in it.
  const log = await invokeTest<{ n: number; detail: string }[]>(app, 'e2e_debug_query', {
    sql: 'SELECT count(*) AS n, min(quarantine_name) AS detail FROM recovery_log'
  })
  expect(log[0].n).toBe(1)
  expect(log[0].detail).toBe(quarantines[0])
})
