/**
 * Protocol conformance vector generator (spec 002-native-foundation-ios, A2).
 *
 * One entry point for every composite vector class. The primitive classes stay
 * in `gen-crypto-vectors.ts`, whose committed output is frozen.
 *
 *   npx tsx packages/contracts/scripts/gen-protocol-vectors.ts
 *   npx tsx packages/contracts/scripts/gen-protocol-vectors.ts --check
 *   npx tsx packages/contracts/scripts/gen-protocol-vectors.ts cbor-canonical
 *
 * `--check` regenerates every class into a temporary directory and diffs
 * against the committed files WITHOUT writing. That is the FR-008 gate: a
 * constant change, a `pako` upgrade, a `cborg` upgrade or a field-order edit
 * becomes a red build rather than a code-review note. CI runs `--check`; it
 * never runs the writing form.
 *
 * A bare class name regenerates that class alone, which is what makes a
 * one-class change reviewable.
 *
 * Rules every class obeys (contracts/conformance-vectors.md):
 *  - vectors come out of production code paths; a generator that reimplements
 *    the algorithm proves the generator;
 *  - verification is a separate program, in `src/__tests__/`, and the committed
 *    JSON is its input;
 *  - a change to a covered format updates the chapter and the vectors in the
 *    same change.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sodium from 'libsodium-wrappers-sumo'

import { buildBip39Unlock } from './vectors/bip39-unlock'
import { buildCborCanonical } from './vectors/cbor-canonical'
import { buildCompression } from './vectors/compression'
import { buildCrdtUpdate } from './vectors/crdt-update'
import { buildDeviceLinking } from './vectors/device-linking'
import { buildFieldMerge } from './vectors/field-merge'
import { buildMarkdownRoundtrip } from './vectors/markdown-roundtrip'
import { buildBlockEdit } from './vectors/block-edit'
import { buildNoteBlocks } from './vectors/note-blocks'
import { buildPackContainer } from './vectors/pack-container'
import { buildPayloadSchemas } from './vectors/payload-schemas'
import { buildRecordEnvelope } from './vectors/record-envelope'
import { buildTextExtract } from './vectors/text-extract'
import { VECTORS_DIR, writeVectorFile } from './vectors/shared'

/** One class: its file, and the builder that produces its contents. */
interface VectorClass {
  readonly name: string
  /** Relative to `test-vectors/`. A class may own more than one file. */
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly build: () => Promise<unknown> | unknown
  }>
}

const CLASSES: readonly VectorClass[] = [
  { name: 'bip39-unlock', files: [{ path: 'bip39-unlock.json', build: buildBip39Unlock }] },
  {
    name: 'record-envelope',
    files: [{ path: 'record-envelope.json', build: buildRecordEnvelope }]
  },
  { name: 'crdt-update', files: [{ path: 'crdt-update.json', build: buildCrdtUpdate }] },
  { name: 'cbor-canonical', files: [{ path: 'cbor-canonical.json', build: buildCborCanonical }] },
  { name: 'compression', files: [{ path: 'compression.json', build: buildCompression }] },
  { name: 'field-merge', files: [{ path: 'field-merge.json', build: buildFieldMerge }] },
  { name: 'pack-container', files: [{ path: 'pack-container.json', build: buildPackContainer }] },
  {
    name: 'payload-schemas',
    files: [{ path: 'payload-schemas.json', build: buildPayloadSchemas }]
  },
  { name: 'device-linking', files: [{ path: 'device-linking.json', build: buildDeviceLinking }] },
  { name: 'text-extract', files: [{ path: 'text-extract.json', build: buildTextExtract }] },
  { name: 'note-blocks', files: [{ path: 'note-blocks.json', build: buildNoteBlocks }] },
  { name: 'block-edit', files: [{ path: 'block-edit.json', build: buildBlockEdit }] },
  {
    name: 'markdown-roundtrip',
    files: [
      { path: 'markdown-roundtrip/cases.json', build: () => buildMarkdownRoundtrip().cases },
      {
        path: 'markdown-roundtrip/fuzz-families.json',
        build: () => buildMarkdownRoundtrip().fuzzFamilies
      }
    ]
  }
]

function usage(): never {
  const names = CLASSES.map((c) => c.name).join(', ')
  process.stderr.write(`usage: gen-protocol-vectors [--check] [class ...]\n  classes: ${names}\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  await sodium.ready

  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const requested = args.filter((arg) => !arg.startsWith('--'))

  if (args.some((arg) => arg.startsWith('--') && arg !== '--check')) usage()

  const unknown = requested.filter((name) => !CLASSES.some((c) => c.name === name))
  if (unknown.length > 0) {
    process.stderr.write(`unknown class: ${unknown.join(', ')}\n`)
    usage()
  }

  const selected =
    requested.length === 0 ? CLASSES : CLASSES.filter((c) => requested.includes(c.name))

  if (!check) {
    for (const cls of selected) {
      for (const file of cls.files) {
        const written = writeVectorFile(VECTORS_DIR, file.path, await file.build())
        process.stdout.write(`wrote ${written}\n`)
      }
    }
    return
  }

  // --check: build into a temp dir, then diff. Nothing under test-vectors/ is
  // touched, so an accidental `--check` in a dirty tree cannot mask a drift by
  // overwriting the thing it was meant to compare against.
  const scratch = mkdtempSync(join(tmpdir(), 'memry-vectors-'))
  const drifted: string[] = []
  try {
    for (const cls of selected) {
      for (const file of cls.files) {
        const fresh = readFileSync(writeVectorFile(scratch, file.path, await file.build()), 'utf8')
        let committed: string
        try {
          committed = readFileSync(join(VECTORS_DIR, file.path), 'utf8')
        } catch {
          drifted.push(`${file.path}: missing from test-vectors/`)
          continue
        }
        if (fresh !== committed) {
          drifted.push(`${file.path}: regenerates differently from the committed file`)
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if (drifted.length > 0) {
    process.stderr.write(
      'vectors:check failed — the implementation and the committed vectors disagree:\n' +
        drifted.map((line) => `  ${line}\n`).join('') +
        '\nRegenerate with `pnpm --filter @memry/contracts vectors:generate`, then update the\n' +
        'protocol chapter the changed format belongs to in the SAME change (FR-008).\n'
    )
    process.exit(1)
  }

  process.stdout.write(`vectors:check passed (${selected.length} classes)\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
