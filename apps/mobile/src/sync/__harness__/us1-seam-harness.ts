import { runAdapterConformance } from '@memry/sync-client/adapters/conformance'
import { createMobileAdapters } from '@/adapters/index'
import { createMobileNoteContentStore } from '@/db/note-content-store'
import { MobilePullStore } from '@/db/pull-store'
import { closeVaultDb, openVaultDb } from '@/db/index'
import { createLogger } from '@/lib/logger'
import { getSyncEngine } from '@/sync/engine'
import { loadCurrentVaultId } from '@/sync/auth-client'

const log = createLogger('Us1SeamHarness')

/**
 * T054 on-device seam tests — REAL adapters, real SQLite, and (for the pull
 * round-trip) the real staging/production server the build points at. This is
 * the mobile counterpart of desktop's vitest conformance run: the shared
 * suite takes an injected describe/it/expect, so a tiny runner collects
 * results on device.
 */

export interface HarnessResult {
  passed: number
  failed: number
  failures: string[]
}

interface Frame {
  name: string
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
      )
    )
  }
  return false
}

/** Run the shared adapter conformance suite against the real mobile adapters. */
export async function runMobileConformance(): Promise<HarnessResult> {
  const result: HarnessResult = { passed: 0, failed: 0, failures: [] }
  const stack: Frame[] = []
  const tests: { name: string; body: () => void | Promise<void> }[] = []

  const scratchVaultId = `conformance-scratch-${Date.now().toString(36)}`

  const expectFn = (actual: unknown) => ({
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) {
        throw new Error(`expected ${String(actual)} toBe ${String(expected)}`)
      }
    },
    toEqual(expected: unknown) {
      if (!deepEqual(actual, expected)) {
        throw new Error(`expected deep equality`)
      }
    }
  })

  runAdapterConformance(
    {
      create: async () => {
        const db = await openVaultDb(scratchVaultId)
        return createMobileAdapters(db)
      },
      destroy: async () => {
        await closeVaultDb(scratchVaultId)
      }
    },
    {
      describe(name, body) {
        stack.push({ name })
        body()
        stack.pop()
      },
      it(name, body) {
        tests.push({ name: [...stack.map((f) => f.name), name].join(' › '), body })
      },
      expect: expectFn as never
    }
  )

  for (const test of tests) {
    try {
      await test.body()
      result.passed++
    } catch (err) {
      result.failed++
      result.failures.push(`${test.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  log.info('Conformance run finished', { passed: result.passed, failed: result.failed })
  return result
}

/**
 * Pull-pipeline round-trip (T054): incremental pull against the real server
 * into the real vault DB, then a NoteContentStore round-trip on the same DB.
 * Requires a signed-in session and an unlocked vault.
 */
export async function runPullPipelineRoundTrip(): Promise<HarnessResult> {
  const result: HarnessResult = { passed: 0, failed: 0, failures: [] }
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) result.passed++
    else {
      result.failed++
      result.failures.push(detail ? `${name}: ${detail}` : name)
    }
  }

  const vaultId = await loadCurrentVaultId()
  if (!vaultId) {
    check('session', false, 'no current vault — sign in and unlock first')
    return result
  }

  const engine = getSyncEngine(vaultId)
  const summary = await engine.sync()
  check('pull ran without refusal', summary.ok, summary.reason ?? undefined)

  const db = await openVaultDb(vaultId)
  const itemCount = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM sync_items')
  check('sync_items has rows', (itemCount?.n ?? 0) > 0)

  const noteWithBody = await db.getFirstAsync<{ item_id: string; markdown: string }>(
    'SELECT item_id, markdown FROM note_bodies LIMIT 1'
  )
  check('at least one note body materialized', noteWithBody !== null)

  const store = createMobileNoteContentStore(db, { vaultId, journalFolder: 'Journal' })
  const probePath = `__harness__/roundtrip-${Date.now().toString(36)}.md`
  const probeContent = '# seam probe\n\nround-trip body\n'
  await store.write(probePath, probeContent)
  const readBack = await store.read(probePath)
  check('NoteContentStore write→read round-trip', readBack === probeContent)
  const removed = await store.remove(probePath)
  check('NoteContentStore remove', removed && (await store.read(probePath)) === null)

  const pullStore = new MobilePullStore(db, vaultId)
  const cursor = await pullStore.getRecordCursor()
  check('record cursor advanced', cursor !== null && cursor !== '0')

  log.info('Pull round-trip finished', { passed: result.passed, failed: result.failed })
  return result
}
