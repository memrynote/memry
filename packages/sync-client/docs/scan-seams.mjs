// Seam scanner for docs/seam-inventory.md (spec 001-mobile-app T015).
// Run from the repo root:  node packages/sync-client/docs/scan-seams.mjs
import fs from 'node:fs'
import path from 'node:path'

const roots = ['apps/desktop/src/main/sync', 'packages/app-core/src', 'packages/storage-vault/src']
const NODE_BUILTINS =
  /^(node:)?(fs|path|os|crypto|url|util|stream|zlib|http|https|net|tls|events|buffer|child_process|worker_threads|assert|timers|dns|perf_hooks)(\/|$)/
const PLATFORM_PKGS =
  /^(electron|electron-log|electron-store|better-sqlite3|classic-level|keytar|y-leveldb|undici|node-fetch|chokidar|drizzle-orm\/better-sqlite3)/

// file -> seam. Explicit wins; then the rules below.
const EXPLICIT = {
  'sync/http-client.ts': 'HttpClient',
  'sync/network.ts': 'HttpClient + Runtime',
  'sync/websocket.ts': 'HttpClient',
  'sync/certificate-pinning.ts': 'CertificatePinning',
  'sync/crdt-persistence.ts': 'CrdtPersistence',
  'sync/crdt-pending-notes.ts': 'CrdtPersistence',
  'sync/crdt-store-path.ts': 'CrdtStorePath',
  'sync/crdt-store-move.ts': 'CrdtStorePath',
  'sync/crdt-preflight.ts': 'CrdtPreflight',
  'sync/crdt-preflight-child.ts': 'CrdtPreflight (desktop-only impl)',
  'sync/crdt-provider.ts': 'CrdtProvider',
  'sync/device-registration.ts': 'DeviceRegistration',
  'sync/linking-service.ts': 'DeviceRegistration',
  'sync/runtime.ts': 'Runtime',
  'sync/content-sync-base.ts': 'Runtime (logger)',
  'sync/engine.ts': 'none — EventEmitter',
  'sync/attachment-events.ts': 'none — EventEmitter',
  'sync/attachments.ts': 'AttachmentStore',
  'sync/attachment-outbox.ts': 'AttachmentStore',
  'sync/attachment-backfill.ts': 'AttachmentStore + VaultFileSystem',
  'sync/worker.ts': 'none — desktop-only',
  'sync/worker-bridge.ts': 'none — desktop-only',
  'sync/blocknote-converter.ts': 'none — node:crypto',
  'sync/item-handlers/agent-message-handler.ts': 'none — node:crypto',
  'app-core/agent.ts': 'none — desktop-only',
  'app-core/database.ts': 'none — desktop-only',
  'app-core/paths.ts': 'none — desktop-only'
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const key = (f) =>
  f.replace('apps/desktop/src/main/', '').replace('packages/', '').replace('/src/', '/')
const rows = []
for (const r of roots) {
  for (const f of walk(r)) {
    if (/\.(test|spec)\.tsx?$/.test(f) || f.includes('__tests__')) continue
    const src = fs.readFileSync(f, 'utf8')
    const hits = new Map()
    for (const m of src.matchAll(/(?:from\s+|require\()\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (!NODE_BUILTINS.test(spec) && !PLATFORM_PKGS.test(spec)) continue
      const stmtStart = src.lastIndexOf('import', m.index)
      const typeOnly = stmtStart >= 0 && /^import\s+type\b/.test(src.slice(stmtStart, m.index))
      hits.set(spec, (hits.get(spec) ?? true) && typeOnly)
    }
    if (hits.size === 0) continue
    const k = key(f)
    const specs = [...hits.entries()]
    let seam = EXPLICIT[k]
    if (!seam) {
      if (specs.every(([s, t]) => s.startsWith('drizzle-orm/better-sqlite3') && t))
        seam = 'none — Drizzle type only'
      else seam = 'VaultFileSystem'
    }
    rows.push({ k, loc: src.split('\n').length, specs, seam })
  }
}
rows.sort((a, b) => (a.seam === b.seam ? a.k.localeCompare(b.k) : a.seam.localeCompare(b.seam)))
const groups = new Map()
for (const r of rows) {
  if (!groups.has(r.seam)) groups.set(r.seam, [])
  groups.get(r.seam).push(r)
}
const out = []
for (const [seam, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  out.push(`\n### ${seam} — ${list.length} file${list.length === 1 ? '' : 's'}\n`)
  out.push('| File | LOC | Platform imports |')
  out.push('| --- | ---: | --- |')
  for (const r of list) {
    out.push(
      `| \`${r.k}\` | ${r.loc} | ${r.specs.map(([s, t]) => '`' + s + '`' + (t ? ' *(type)*' : '')).join(', ')} |`
    )
  }
}
fs.writeFileSync(
  process.argv[2] ?? 'packages/sync-client/docs/seam-tables.md',
  out.join('\n') + '\n'
)
console.log('rows', rows.length)
