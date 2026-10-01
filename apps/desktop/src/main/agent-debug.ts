/**
 * Inspection handles for agent-driven sessions (`scripts/agent-app.mjs eval`).
 *
 * The agent drives the renderer over CDP and reads main-process state over the
 * Node inspector. Bundled main code hides every module-level singleton, so an
 * inspector expression cannot reach the database or sync runtime without a
 * named entry point; this is that entry point.
 *
 * Gated exactly like the E2E test hooks: only `NODE_ENV=test` registers it,
 * which packaged builds never set. SQL is read-only on purpose: a raw write
 * bypasses vector clocks, sync enqueueing and renderer broadcasts, leaving the
 * DB and the UI disagreeing. Mutations go through the UI or `__memryTestHooks`.
 */

import type { Database, Statement } from 'better-sqlite3'
import { getRawDataDatabase, getRawIndexDatabase } from './database'
import { store } from './store'
import { getCrdtProvider, type CrdtProvider } from './sync/crdt-provider'
import { getSyncEngine } from './sync/runtime'
import type { SyncEngine } from './sync/engine'

export interface MemryAgentDebug {
  /** Read-only SQL against data.db (notes metadata, tasks, projects, sync state). */
  query(sql: string, ...params: unknown[]): unknown[]
  /** Read-only SQL against index.db (search, graph, embeddings). */
  indexQuery(sql: string, ...params: unknown[]): unknown[]
  syncEngine(): SyncEngine | null
  crdt(): CrdtProvider
  store: typeof store
}

declare global {
  var __memryDebug: MemryAgentDebug | undefined
}

function readOnlyAll(db: Database, sql: string, params: unknown[]): unknown[] {
  const statement: Statement<unknown[]> = db.prepare(sql)
  if (!statement.readonly) {
    throw new Error('__memryDebug runs read-only SQL; mutate through the UI or test hooks')
  }
  return statement.all(...params)
}

export function registerAgentDebugHandles(): void {
  if (process.env.NODE_ENV !== 'test') return

  globalThis.__memryDebug = {
    query: (sql, ...params) => readOnlyAll(getRawDataDatabase(), sql, params),
    indexQuery: (sql, ...params) => readOnlyAll(getRawIndexDatabase(), sql, params),
    syncEngine: getSyncEngine,
    crdt: getCrdtProvider,
    store
  }
}
