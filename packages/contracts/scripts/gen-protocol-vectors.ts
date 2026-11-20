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
 * becomes a red build rather than a code-review note. Desktop CI's static job
 * runs `--check` (`pnpm --filter @memry/contracts vectors:check`); CI never runs
 * the writing form.
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

import { ready } from 'libsodium-wrappers-sumo'

import { CLASSES } from './vector-classes'
import { VECTORS_DIR, writeVectorFile } from './vectors/shared'

function usage(): never {
  const names = CLASSES.map((c) => c.name).join(', ')
  process.stderr.write(`usage: gen-protocol-vectors [--check] [class ...]\n  classes: ${names}\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  await ready

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
