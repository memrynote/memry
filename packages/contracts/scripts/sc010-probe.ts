import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { extractText } from './extract-text'

const [NOTE, DB] = [process.argv[2], process.argv[3]]
if (!NOTE || !DB) {
  console.error(
    'usage: tsx scripts/sc010-probe.ts <noteId> <path/to/vault/data.db>\n' +
      '\n' +
      "SC-010's other half: runs THIS package's extractor — the one that generates\n" +
      'the `text-extract` vector class — over a real document, and prints chapter 12\n' +
      "§12.11's digest. Compare with `memry notes digest <noteId>`; they must match.\n" +
      '\n' +
      'The database is a memry-cli vault, e.g.\n' +
      '  ~/.memry-cli/staging/vault/<vaultId>/data.db'
  )
  process.exit(2)
}

const db = new Database(DB, { readonly: true })
const title = db.prepare('SELECT title FROM notes WHERE id = ?').get(NOTE) as
  { title: string } | undefined
if (!title) {
  // Never digest an absent title as "": it would produce a plausible hash that
  // silently disagrees with every other shell.
  console.error(`no note \`${NOTE}\` in ${DB}`)
  process.exit(2)
}
// `load_plan`: each namespace starts from its snapshot, then the updates
// ABOVE that snapshot's `last_seq`. Applying the log alone yields an empty
// document, because the base state lives in the snapshot.
const doc = new Y.Doc()
let applied = 0
for (const ns of [NOTE, `local.${NOTE}`]) {
  const snap = db
    .prepare('SELECT snapshot, last_seq FROM yjs_snapshots WHERE doc_id = ?')
    .get(ns) as { snapshot: Buffer; last_seq: number } | undefined
  if (snap) {
    Y.applyUpdate(doc, new Uint8Array(snap.snapshot))
    applied++
  }
  const since = snap?.last_seq ?? 0
  const rows = db
    .prepare('SELECT update_blob FROM yjs_updates WHERE doc_id = ? AND seq > ? ORDER BY seq')
    .all(ns, since) as Array<{ update_blob: Buffer }>
  for (const r of rows) {
    Y.applyUpdate(doc, new Uint8Array(r.update_blob))
    applied++
  }
}
const rows = { length: applied }

const text = extractText(doc)
const digest = createHash('sha256')
  .update(title.title, 'utf8')
  .update('\n', 'utf8')
  .update(text, 'utf8')
  .digest('hex')

console.log(`note      ${NOTE}`)
console.log(`title     ${title.title}`)
console.log(`updates   ${rows.length}`)
console.log(`textBytes ${Buffer.byteLength(text, 'utf8')}`)
console.log(`DIGEST    ${digest}`)
