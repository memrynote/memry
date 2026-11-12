/**
 * Generates `embedding-input.json` by running Electron's input shaping
 * (`src/main/lib/embedding-input.ts`) in place as the oracle.
 *
 *   pnpm --filter @memry/desktop vectors:embedding-input          # write the file
 *   pnpm --filter @memry/desktop vectors:embedding-input:check    # regenerate in memory, diff, write nothing
 *
 * The file lives in `packages/contracts/test-vectors/`; this generator sits in
 * `apps/desktop` because it imports the Electron module, and `packages/` never
 * imports an app. The Rust port (`crates/memry-core/src/domain/embedding_input.rs`)
 * reproduces every case.
 *
 * Lengths and cuts are UTF-16 code units, so a cut can split a surrogate pair
 * and leave a lone surrogate in the JavaScript string. JSON written with lone
 * surrogates is not UTF-8, and the Rust port builds its strings with
 * `String::from_utf16_lossy`, so every expected string is written through
 * `toWellFormed()` (a lone surrogate becomes U+FFFD in both) and the case says
 * `loneSurrogate: true`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EMBEDDING_INPUT_VERSION,
  IMAGE_EMBEDDING_INPUT_VERSION,
  MAX_EMBEDDABLE_CONTENT_LENGTH,
  MAX_EMBEDDING_CHUNKS,
  MAX_EMBEDDING_INPUT_LENGTH,
  MAX_INTERLEAVED_TEXT_LENGTH,
  buildEmbeddingChunks,
  buildEmbeddingInput,
  buildInterleavedInput,
  buildQueryEmbeddingInput
} from '../../src/main/lib/embedding-input'
import { CASES, type Case } from './cases'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATH = join(resolve(appRoot, '../../packages/contracts/test-vectors'), 'embedding-input.json')

let lone = false
const wellFormed = (text: string): string => {
  if (!text.isWellFormed()) lone = true
  return text.toWellFormed()
}

function expected(item: Case): Record<string, unknown> {
  if (item.kind === 'query') return { query: wellFormed(buildQueryEmbeddingInput(item.query)) }
  if (item.kind === 'interleaved') {
    const built = buildInterleavedInput(item.text)
    return { interleaved: built === null ? null : wellFormed(built) }
  }
  const parts = { title: item.title, content: item.content }
  return {
    document: wellFormed(buildEmbeddingInput(parts, 'document')),
    similarity: wellFormed(buildEmbeddingInput(parts, 'similarity')),
    chunks: buildEmbeddingChunks(parts).map(wellFormed)
  }
}

function render(): string {
  const cases = CASES.map((item) => {
    lone = false
    const out = expected(item)
    return { ...item, expected: out, ...(lone ? { loneSurrogate: true } : {}) }
  })
  const document = {
    meta: {
      spec: 'tauri-v2-3540-embedding-input',
      oracle:
        'apps/desktop/scripts/embedding-input-oracle (Electron src/main/lib/embedding-input.ts run in place)',
      note: 'Lengths are UTF-16 code units. Expected strings are toWellFormed(): a lone surrogate left by a cut is U+FFFD.',
      caseCount: cases.length
    },
    constants: {
      maxEmbeddingInputLength: MAX_EMBEDDING_INPUT_LENGTH,
      maxEmbeddingChunks: MAX_EMBEDDING_CHUNKS,
      maxEmbeddableContentLength: MAX_EMBEDDABLE_CONTENT_LENGTH,
      maxInterleavedTextLength: MAX_INTERLEAVED_TEXT_LENGTH,
      embeddingInputVersion: EMBEDDING_INPUT_VERSION,
      imageEmbeddingInputVersion: IMAGE_EMBEDDING_INPUT_VERSION
    },
    cases
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function main(): void {
  const fresh = render()
  if (!process.argv.includes('--check')) {
    writeFileSync(PATH, fresh, 'utf8')
    process.stdout.write(`wrote ${PATH}\n`)
    return
  }
  let committed = ''
  try {
    committed = readFileSync(PATH, 'utf8')
  } catch {
    committed = ''
  }
  if (committed !== fresh) {
    process.stderr.write(
      'vectors:embedding-input:check failed: embedding-input.json is missing or regenerates differently.\n' +
        'Regenerate with `pnpm --filter @memry/desktop vectors:embedding-input`.\n'
    )
    process.exit(1)
  }
  process.stdout.write('vectors:embedding-input:check passed\n')
}

main()
