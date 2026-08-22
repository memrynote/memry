/**
 * BenchDriver adapter for the R2 threshold validation (T009).
 *
 * Driver DECIDED 2026-08-23: expo-sqlite (research.md §R2 — owner decision).
 * The rig now validates the §R2 workload thresholds against expo-sqlite only;
 * the comparative op-sqlite run was dropped with the decision.
 */
import * as ExpoSQLite from 'expo-sqlite'

import type { BenchConnection, BenchDriver } from './driver-bench'

export const expoSqliteDriver: BenchDriver = {
  name: 'expo-sqlite',
  async open(dbName) {
    const db = await ExpoSQLite.openDatabaseAsync(dbName)
    const conn: BenchConnection = {
      exec: (sql) => db.execAsync(sql),
      run: async (sql, params) => {
        await db.runAsync(sql, [...params])
      },
      runBatch: async (sql, rows) => {
        const statement = await db.prepareAsync(sql)
        try {
          for (const row of rows) {
            await statement.executeAsync([...row])
          }
        } finally {
          await statement.finalizeAsync()
        }
      },
      queryAll: (sql, params = []) => db.getAllAsync(sql, [...params]),
      transaction: (fn) => db.withTransactionAsync(() => fn(conn)),
      close: () => db.closeAsync()
    }
    return conn
  },
  async remove(dbName) {
    try {
      await ExpoSQLite.deleteDatabaseAsync(dbName)
    } catch {
      // first run — nothing to delete
    }
  }
}

export const benchDrivers: BenchDriver[] = [expoSqliteDriver]
