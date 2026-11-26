import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { SimulatedServer } from '../src/simulated-server.js'
import { createTestDevice } from '../src/test-auth.js'
import { deriveVaultKey, initCrypto } from '../src/crypto.js'
import { BUILD_CORE_COMMAND, CoreDevice, coreBinaryExists } from '../src/core-device.js'
import type { FetchFn } from '../src/types.js'
import { checkStructural, fetchServerTruth, formatFindings } from '../src/zero-loss-oracle/index.js'

// #5351: a core device deletes a journal day and writes it again. The server
// purged the deleted body (protocol 07 §7.15), so a fresh device bootstraps
// only what was pushed after the delete. That must integrate on its own: the
// oracle's `body_pending` finding is the red signal, and the fresh device
// reads the new text.

const server = new SimulatedServer()
const serverFetch: FetchFn = (input, init) => server.fetch(input, init)

const DAY = '2026-01-11'
const DAY_ID = `j${DAY}`

const coreRuns = coreBinaryExists() || Boolean(process.env.CI)
if (!coreRuns) {
  process.stderr.write(
    `\nWARNING: the core device (memry-cli) is not built, so the core revive scenario (#5351) SKIPS. Run ${BUILD_CORE_COMMAND}.\n\n`
  )
}

;(coreRuns ? describe : describe.skip)(
  'Sync Harness — a core journal day re-created after its delete (#5351)',
  { timeout: 300_000 },
  () => {
    beforeAll(async () => {
      await initCrypto()
      await server.start()
    })

    afterAll(async () => {
      await server.stop()
    })

    beforeEach(async () => {
      await server.truncateTables()
    })

    it('a fresh device reads the re-created day, and every update it applied integrates', async () => {
      const masterKey = crypto.getRandomValues(new Uint8Array(32))
      const vaultKey = deriveVaultKey(masterKey)
      const writerIdentity = await createTestDevice(server, { deviceName: 'writer', vaultKey })
      const freshIdentity = await createTestDevice(server, {
        userId: writerIdentity.userId,
        deviceName: 'fresh',
        vaultKey
      })
      const writer = new CoreDevice(server, writerIdentity, masterKey)
      const fresh = new CoreDevice(server, freshIdentity, masterKey)
      await writer.start()
      await fresh.start()
      try {
        await writer.bootstrap()
        const vault = ['--vault', writer.vaultId]
        await writer.cli(['journal', 'append', DAY, 'deleted words', ...vault])
        await writer.cli(['push', ...vault])
        await writer.cli(['journal', 'delete', DAY, ...vault])
        await writer.cli(['push', ...vault])
        await writer.cli(['journal', 'append', DAY, 'written again', ...vault])
        await writer.cli(['push', ...vault])

        await fresh.bootstrap()
        const truth = await fetchServerTruth({
          baseUrl: 'http://localhost',
          accessToken: writerIdentity.accessToken,
          fetch: serverFetch
        })
        const report = checkStructural(truth, await fresh.oracleState())
        expect(formatFindings(report.findings)).toBe('zero-loss oracle GREEN: 0 findings')

        const text = await fresh.cli(['notes', 'text', DAY_ID, ...vault])
        expect(text).toContain('written again')
        expect(text).not.toContain('deleted words')
        expect(await writer.cli(['notes', 'text', DAY_ID, ...vault])).toBe(text)
      } finally {
        await writer.stop()
        await fresh.stop()
      }
    })
  }
)
