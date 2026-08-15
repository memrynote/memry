/**
 * The 2 GB claim, measured rather than reasoned about.
 *
 * Off by default: it writes a real 2 GB file and reads every byte of it, which
 * is no business of CI. Run it by hand when the reader or the index changes:
 *
 *   MEMRY_LARGE_FILE_STRESS=1 npx vitest run --config config/vitest.config.ts \
 *     --project main src/main/vault/large-file-index.stress.test.ts
 *
 * The fixture is written, not sparsed. A sparse file of NUL bytes holds no
 * newlines, so it would be one 2 GB line — which exercises the truncation path
 * and nothing else. Real 64-byte lines are what a log dump looks like and what
 * the checkpoint stride has to survive.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, open, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileHandleReader, readLines, scanLineIndex } from './large-file-index'

const ENABLED = process.env.MEMRY_LARGE_FILE_STRESS === '1'

const TWO_GB = 2 * 1024 * 1024 * 1024
const LINE = 'x'.repeat(63)
const LINE_BYTES = 64
const WRITE_CHUNK_BYTES = 4 * 1024 * 1024
const EXPECTED_LINES = TWO_GB / LINE_BYTES

describe.runIf(ENABLED)('2 GB file', () => {
  it('indexes and reads without ever holding the file', { timeout: 1_800_000 }, async () => {
    // #given a real 2 GB file of 64-byte lines
    const dir = await mkdtemp(join(tmpdir(), 'memry-large-file-stress-'))
    const path = join(dir, 'huge.md')

    try {
      const chunk = Buffer.from(`${LINE}\n`.repeat(WRITE_CHUNK_BYTES / LINE_BYTES), 'utf8')
      // One handle for the write and every read: reopening by path would be a
      // second resolve of a name that is only guaranteed by this test's own
      // `mkdtemp`, and the reader under test is handle-based anyway.
      const handle = await open(path, 'w+')
      try {
        for (let written = 0; written < TWO_GB; written += chunk.length) {
          await handle.write(chunk, 0, chunk.length)
        }

        const read = fileHandleReader(handle)
        const progress: number[] = []
        const startedAt = Date.now()

        // #when the whole file is crossed once
        const index = await scanLineIndex(read, {
          fileBytes: TWO_GB,
          onProgress: (bytesScanned) => progress.push(bytesScanned)
        })
        const scanMs = Date.now() - startedAt

        // #then — every line was counted, and the offset table stayed inside its
        // cap by widening the stride instead of growing
        expect(index.fileBytes).toBe(TWO_GB)
        expect(index.lineCount).toBe(EXPECTED_LINES)
        expect(index.checkpoints.length).toBeLessThanOrEqual(65_536)
        expect(progress.length).toBeGreaterThan(1)
        expect(progress.at(-1)).toBe(TWO_GB)

        // #then — reading is a seek, not a scan: the middle of a 2 GB file costs
        // a checkpoint lookup plus a short forward walk
        const seekStartedAt = Date.now()
        const middle = await readLines(read, index, Math.floor(EXPECTED_LINES / 2), 50)
        const seekMs = Date.now() - seekStartedAt
        expect(middle.lines).toHaveLength(50)
        expect(middle.lines[0]).toBe(LINE)
        expect(seekMs).toBeLessThan(scanMs / 10)

        const last = await readLines(read, index, EXPECTED_LINES - 2, 2)
        expect(last.lines).toEqual([LINE, LINE])

        // eslint-disable-next-line no-console
        console.log(`2 GB: scan ${scanMs} ms, mid-file seek ${seekMs} ms`)
      } finally {
        await handle.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
