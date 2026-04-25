#!/usr/bin/env tsx
/**
 * Compare Electron's applied schema against Tauri's applied schema.
 *
 * Run Tauri once (in any MEMRY_DEVICE profile) so it produces a freshly
 * migrated DB, then point this script at both DBs. Reports any differences
 * in table set, column set per table, or index set per table.
 *
 * Usage:
 *   pnpm db:schema-diff <path-to-electron.db> <path-to-tauri.db>
 */
import Database from 'better-sqlite3'

type TableInfo = {
  name: string
  columns: Set<string>
  indexes: Set<string>
}

function introspect(path: string): Map<string, TableInfo> {
  const db = new Database(path, { readonly: true })
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>

  const out = new Map<string, TableInfo>()
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>
    const idx = db.prepare(`PRAGMA index_list(${name})`).all() as Array<{ name: string }>
    out.set(name, {
      name,
      columns: new Set(cols.map((c) => c.name)),
      indexes: new Set(idx.map((i) => i.name)),
    })
  }
  db.close()
  return out
}

function diffSet<T>(a: Set<T>, b: Set<T>): { onlyA: T[]; onlyB: T[] } {
  return {
    onlyA: [...a].filter((x) => !b.has(x)),
    onlyB: [...b].filter((x) => !a.has(x)),
  }
}

function main() {
  const [electronPath, tauriPath] = process.argv.slice(2)
  if (!electronPath || !tauriPath) {
    console.error('Usage: pnpm db:schema-diff <electron.db> <tauri.db>')
    process.exit(1)
  }

  const electron = introspect(electronPath)
  const tauri = introspect(tauriPath)

  const tableDiff = diffSet(new Set(electron.keys()), new Set(tauri.keys()))

  let failed = false
  if (tableDiff.onlyA.length > 0) {
    console.log(`Tables only in Electron: ${tableDiff.onlyA.join(', ')}`)
    failed = true
  }
  if (tableDiff.onlyB.length > 0) {
    console.log(`Tables only in Tauri: ${tableDiff.onlyB.join(', ')}`)
    failed = true
  }

  for (const [name, tInfo] of tauri) {
    const eInfo = electron.get(name)
    if (!eInfo) continue
    const colDiff = diffSet(eInfo.columns, tInfo.columns)
    if (colDiff.onlyA.length || colDiff.onlyB.length) {
      console.log(`\nTable ${name} column diff:`)
      if (colDiff.onlyA.length) console.log(`  only in Electron: ${colDiff.onlyA.join(', ')}`)
      if (colDiff.onlyB.length) console.log(`  only in Tauri: ${colDiff.onlyB.join(', ')}`)
      failed = true
    }
    const idxDiff = diffSet(eInfo.indexes, tInfo.indexes)
    if (idxDiff.onlyA.length || idxDiff.onlyB.length) {
      console.log(`\nTable ${name} index diff:`)
      if (idxDiff.onlyA.length) console.log(`  only in Electron: ${idxDiff.onlyA.join(', ')}`)
      if (idxDiff.onlyB.length) console.log(`  only in Tauri: ${idxDiff.onlyB.join(', ')}`)
      failed = true
    }
  }

  if (failed) {
    console.log('\nFAIL: schemas diverge.')
    process.exit(1)
  }
  console.log('OK: schemas identical.')
}

main()
