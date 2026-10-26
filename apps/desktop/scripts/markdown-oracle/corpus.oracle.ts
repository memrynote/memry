/**
 * The corpus oracle: runs the Electron converter over every `.md` file of the
 * named vaults and writes what it answers, as hashes. Rust reproduces it in
 * `crates/memry-core/tests/markdown_corpus.rs` (ignored; see that file).
 *
 *   MEMRY_CORPUS_OUT=/tmp/corpus.jsonl MEMRY_CORPUS_DIRS=/path/a:/path/b \
 *   [MEMRY_CORPUS_SYNTHETIC=/tmp/synthetic-vault] [MEMRY_CORPUS_WITH_CONTENT=1] \
 *     pnpm --filter @memry/desktop exec vitest run \
 *       --config config/vitest.config.ts --project markdown-oracle
 *
 * One line per file: `{pathHash, sha256, markdownBytes, expectedSha256,
 * canonicalSha256, outcome}`. `pathHash` is the first 12 hex characters of the
 * SHA-256 of the vault-relative path. The converter sees the body after the
 * frontmatter split, as the vault file tier does. Nothing of a real vault is
 * written into the repository: with `MEMRY_CORPUS_WITH_CONTENT=1` the expected
 * markdown goes to the OUT file too, which is for synthetic vaults only.
 *
 * `MEMRY_CORPUS_SYNTHETIC=<dir>` first writes the synthetic vault (the bulk
 * generator of `seed-bench-vault.ts` and the demo notes, journal, portals and
 * writing drafts of `seed-data/`, all authored in this repository) into that
 * empty directory and adds it to the walked directories.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { expect, it, vi } from 'vitest'

import { parseMarkdownNote, writeMarkdownNote } from '@memry/app-core/markdown'

import { docSerialize } from './doc-oracle'

vi.mock('../../src/main/lib/logger', () => {
  const silent = {
    debug: (): undefined => undefined,
    info: (): undefined => undefined,
    warn: (): undefined => undefined,
    error: (): undefined => undefined,
    scope: () => silent
  }
  return { log: silent, createLogger: () => silent }
})
vi.mock('../../src/main/vault/resolve-embed', () => ({ resolveVaultEmbeds: () => ({}) }))

const out = process.env.MEMRY_CORPUS_OUT
const dirs = (process.env.MEMRY_CORPUS_DIRS ?? '').split(':').filter((d) => d.length > 0)
const synthetic = process.env.MEMRY_CORPUS_SYNTHETIC
const withContent = process.env.MEMRY_CORPUS_WITH_CONTENT === '1'

const sha = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex')

function markdownFiles(root: string, dir = root): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.memry' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...markdownFiles(root, path))
    else if (entry.name.endsWith('.md')) found.push(path)
  }
  return found.toSorted()
}

async function writeSynthetic(root: string): Promise<void> {
  const { generateBulkVault } = await import('../seed-data/bulk-notes')
  const { NOTES } = await import('../seed-data/notes')
  const { JOURNAL_NOTES } = await import('../seed-data/journal')
  const { PORTAL_NOTES } = await import('../seed-data/portals')
  const { WRITING_DRAFTS_NOTE } = await import('../seed-data/writing-drafts')
  const files = [
    ...generateBulkVault(1000, 0x1848).notes.map((n) => n.file),
    ...NOTES,
    ...JOURNAL_NOTES,
    ...PORTAL_NOTES,
    WRITING_DRAFTS_NOTE
  ]
  for (const file of files) {
    const target = join(root, file.relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, writeMarkdownNote(file.frontmatter, file.body), 'utf8')
  }
}

it.skipIf(!out || (dirs.length === 0 && !synthetic))(
  'walks the corpus',
  async () => {
    if (!out) return
    const roots = [...dirs]
    if (synthetic) {
      await writeSynthetic(synthetic)
      roots.push(synthetic)
    }
    const lines: string[] = []
    for (const root of roots) {
      for (const path of markdownFiles(root)) {
        const raw = readFileSync(path, 'utf8')
        const body = parseMarkdownNote(raw).content
        const record: Record<string, unknown> = {
          pathHash: sha(relative(root, path)).slice(0, 12),
          sha256: sha(raw),
          markdownBytes: Buffer.byteLength(body, 'utf8')
        }
        try {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- docSerialize answers the shape of its own return
          const result = (await docSerialize({ markdown: body })) as {
            seeded: boolean
            markdown?: string | null
            canonical?: string | null
            outcome?: string | null
          }
          record.seeded = result.seeded
          record.outcome = result.outcome ?? null
          record.expectedSha256 = result.markdown == null ? null : sha(result.markdown)
          record.canonicalSha256 = result.canonical == null ? null : sha(result.canonical)
          if (withContent) {
            record.expected = result.markdown ?? null
            record.canonical = result.canonical ?? null
            record.body = body
          }
        } catch (error) {
          record.seeded = false
          record.error = error instanceof Error ? error.name : 'error'
        }
        lines.push(JSON.stringify(record))
      }
    }
    writeFileSync(out, `${lines.join('\n')}\n`, 'utf8')
    expect(lines.length).toBeGreaterThan(0)
  },
  3_600_000
)
