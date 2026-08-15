/**
 * Opt-in parse-budget measurement behind the note-class thresholds (#1463).
 *
 * NOT part of `pnpm test`: the whole suite is skipped unless
 * `MEMRY_PARSE_BUDGET=1`, so the default run collects one skipped file and pays
 * nothing. Re-run it with:
 *
 *   pnpm --filter @memry/desktop measure:parse-budget
 *
 * It measures `markdownToBlocks` — the real seeding entry point, the one
 * `CrdtDocStore.seedFromMarkdown` calls — end to end: the embed rewrite, the
 * colour masking, the blank-line split and `tryParseMarkdownToBlocks`, not the
 * parser in isolation.
 *
 * The corpus is generated here rather than committed: it is megabytes of
 * synthetic markdown, and the shapes matter more than the exact bytes. Every
 * generator is deterministic (fixed-seed PRNG) so two runs on the same machine
 * are comparable.
 *
 * Results, budget and derivation live in
 * docs/superpowers/specs/2026-08-15-note-class-threshold-calibration.md.
 */

import { describe, expect, it } from 'vitest'
import { classifyMarkdownContent, largestBlockByteLength } from '@memry/shared/markdown-class'
import { markdownToBlocks } from './blocknote-converter'

const ENABLED = process.env.MEMRY_PARSE_BUDGET === '1'

const KB = 1024
const MB = 1024 * 1024

// Generous: the pathological shapes are measured deliberately far past the
// thresholds, and one of them takes tens of seconds on purpose.
const MEASURE_TIMEOUT_MS = 900_000

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

// ---------------------------------------------------------------------------
// Corpus generation
// ---------------------------------------------------------------------------

/** mulberry32 — deterministic, so a re-run measures the same bytes. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'note vault sync editor block parse budget markdown corpus threshold latency device journal task project index search render main renderer memory ingest'.split(
    ' '
  )

function makeWords(rand: () => number, count: number): string {
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)])
  return out.join(' ')
}

/** Repeat `next()` until the joined text reaches `bytes`, then trim to size. */
function fill(bytes: number, sep: string, next: () => string): string {
  const parts: string[] = []
  let size = 0
  while (size < bytes) {
    const part = next()
    parts.push(part)
    size += part.length + sep.length
  }
  return parts.join(sep).slice(0, bytes)
}

/**
 * The shapes worth measuring, each as a generator for ONE blank-line-separated
 * block of a requested size. `blocksOf` then tiles a block into a whole file, so
 * per-block cost and whole-file cost are measured with the same bytes.
 */
type BlockShape = (bytes: number, seed: number) => string

/** Ordinary prose: words and spaces, one paragraph. */
const paragraph: BlockShape = (bytes, seed) =>
  makeWords(makeRandom(seed), Math.ceil(bytes / 6)).slice(0, bytes)

/** Log dump: timestamped lines, no blank line anywhere — the #1468 file. */
const logDump: BlockShape = (bytes, seed) => {
  const rand = makeRandom(seed)
  let n = 0
  return fill(bytes, '\n', () => {
    n++
    return `2026-08-15 09:${String(n % 60).padStart(2, '0')}:12.${String(n % 1000).padStart(3, '0')} [info] [Sync] ${makeWords(rand, 10)} id=${n}`
  })
}

/**
 * Roam/Bear export shape: a tight, nested bullet list with no blank lines, so
 * a whole page reads as one block. `convertBlocks` in packages/importers/src/roam
 * joins with `\n`, which is exactly this.
 */
const tightOutline: BlockShape = (bytes, seed) => {
  const rand = makeRandom(seed)
  let n = 0
  return fill(bytes, '\n', () => {
    n++
    return `${'  '.repeat(n % 4)}- ${makeWords(rand, 10)}`
  })
}

/** A markdown table: one block, many rows. */
const table: BlockShape = (bytes, seed) => {
  const rand = makeRandom(seed)
  const head = '| a | b | c |\n| --- | --- | --- |\n'
  return (
    head +
    fill(
      Math.max(bytes - head.length, 0),
      '\n',
      () => `| ${makeWords(rand, 3)} | ${makeWords(rand, 3)} | ${Math.floor(rand() * 1e6)} |`
    )
  )
}

/** Minified JSON: one line, opening `[`, dense punctuation. */
const minifiedJson: BlockShape = (bytes, seed) => {
  const rand = makeRandom(seed)
  const items: string[] = []
  let size = 2
  while (size < bytes) {
    const item = `{"id":${items.length},"name":"${makeWords(rand, 3).replace(/ /g, '-')}","ok":true}`
    items.push(item)
    size += item.length + 1
  }
  return `[${items.join(',')}]`.slice(0, bytes)
}

/** Tile one shape into a `fileBytes` file made of `blockBytes` blocks. */
function blocksOf(shape: BlockShape, fileBytes: number, blockBytes: number): string {
  const count = Math.max(1, Math.round(fileBytes / blockBytes))
  return Array.from({ length: count }, (_, i) => shape(blockBytes, 100 + i)).join('\n\n')
}

/** Well-formed prose: `paragraphBytes` paragraphs, a heading every eighth. */
function prose(bytes: number, paragraphBytes: number): string {
  const rand = makeRandom(1)
  let n = 0
  return fill(bytes, '\n\n', () => {
    n++
    const body = makeWords(rand, Math.ceil(paragraphBytes / 6)).slice(0, paragraphBytes)
    return n % 8 === 1 ? `## Section ${n}\n\n${body}` : body
  })
}

/** Headings, nested lists, tables, code fences, links — a written-up document. */
function structured(bytes: number): string {
  const rand = makeRandom(2)
  let n = 0
  return fill(bytes, '\n\n', () => {
    n++
    switch (n % 5) {
      case 0:
        return `### Heading ${n}\n\n${makeWords(rand, 60)}.`
      case 1:
        return [
          `- ${makeWords(rand, 12)}`,
          `  - ${makeWords(rand, 12)} \`inline code\``,
          `  - [${makeWords(rand, 3)}](https://example.com/${n})`,
          `- **${makeWords(rand, 4)}** and *${makeWords(rand, 4)}*`
        ].join('\n')
      case 2:
        return table(400, n)
      case 3:
        return [
          '```ts',
          ...Array.from(
            { length: 8 },
            (_, i) => `const value${i} = ${makeWords(rand, 3).replace(/ /g, '_')}`
          ),
          '```'
        ].join('\n')
      default:
        return `${makeWords(rand, 90)}.`
    }
  })
}

/**
 * Obsidian-shaped vault note: frontmatter, wikilinks, tags, task checkboxes.
 * Deliberately no `![[embeds]]` — those reach `resolveVaultEmbeds`, whose cost
 * is a vault-index lookup and not the parse this is measuring.
 */
function obsidianVault(bytes: number): string {
  const rand = makeRandom(3)
  let n = 0
  const head = '---\ntitle: Imported note\ntags: [import, vault]\n---\n\n'
  return (
    head +
    fill(Math.max(bytes - head.length, 0), '\n\n', () => {
      n++
      switch (n % 4) {
        case 0:
          return `## ${makeWords(rand, 4)}\n\n${makeWords(rand, 70)} [[Another Note]] #topic/${n}.`
        case 1:
          return [
            `- [ ] ${makeWords(rand, 8)}`,
            `- [x] ${makeWords(rand, 8)}`,
            `- [ ] ${makeWords(rand, 8)} [[Linked Page]]`
          ].join('\n')
        case 2:
          return `> ${makeWords(rand, 30)}\n> ${makeWords(rand, 30)}`
        default:
          return `${makeWords(rand, 80)} [[${makeWords(rand, 2)}]].`
      }
    })
  )
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

interface Sample {
  name: string
  fileBytes: number
  blockBytes: number
  ms: number
  blocks: number
  sizeClass: string
}

async function timeParse(name: string, markdown: string, reps = 3): Promise<Sample> {
  const timings: number[] = []
  let blocks = 0
  for (let i = 0; i < reps; i++) {
    const started = performance.now()
    const parsed = await markdownToBlocks(markdown)
    timings.push(performance.now() - started)
    blocks = parsed?.length ?? 0
  }
  timings.sort((x, y) => x - y)
  return {
    name,
    fileBytes: Buffer.byteLength(markdown, 'utf8'),
    blockBytes: largestBlockByteLength(markdown),
    ms: timings[Math.floor(timings.length / 2)],
    blocks,
    sizeClass: classifyMarkdownContent(markdown).sizeClass
  }
}

function row(s: Sample): string {
  return `| ${s.name} | ${(s.fileBytes / MB).toFixed(3)} | ${(s.blockBytes / KB).toFixed(1)} | ${s.blocks} | ${s.ms.toFixed(0)} | ${s.sizeClass} |`
}

const HEADER = [
  '| shape | file MB | largest block KB | blocks | median ms | class |',
  '| --- | --- | --- | --- | --- | --- |'
].join('\n')

/** Least-squares slope of `ms = a * fileMB` through the origin. */
function fitLinear(samples: Sample[]): number {
  let num = 0
  let den = 0
  for (const s of samples) {
    const x = s.fileBytes / MB
    num += x * s.ms
    den += x * x
  }
  return num / den
}

/** Log-log fit of `ms = k * (blockKB ^ p)`; returns the exponent and k. */
function fitPower(samples: Sample[]): { p: number; k: number } {
  const xs = samples.map((s) => Math.log(s.blockBytes / KB))
  const ys = samples.map((s) => Math.log(Math.max(s.ms, 0.5)))
  const n = xs.length
  const mx = xs.reduce((t, v) => t + v, 0) / n
  const my = ys.reduce((t, v) => t + v, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  const p = num / den
  return { p, k: Math.exp(my - p * mx) }
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('markdown parse budget (#1463)', () => {
  it(
    'measures the corpus and derives both thresholds',
    async () => {
      // Warm-up: the first call builds the server editor and its schema, which
      // would otherwise be charged to the first sample.
      await markdownToBlocks(prose(32 * KB, 600))

      // -- Sweep A: file size, well-formed prose (small blocks) -------------
      const fileSweep: Sample[] = []
      for (const bytes of [64 * KB, 256 * KB, 512 * KB, 1 * MB, 2 * MB, 3 * MB]) {
        fileSweep.push(
          await timeParse(`prose ${(bytes / MB).toFixed(3)} MB, 600 B blocks`, prose(bytes, 600))
        )
      }
      const a = fitLinear(fileSweep)

      // -- Sweep B: one block, growing, per shape ---------------------------
      // Each sample is a single block, so `ms` is the per-block cost g(B).
      const shapeSweeps: Array<{ name: string; shape: BlockShape; sizes: number[] }> = [
        { name: 'paragraph', shape: paragraph, sizes: [8, 16, 32, 64, 128, 256, 512] },
        { name: 'log dump', shape: logDump, sizes: [8, 16, 32, 64, 128, 256, 512] },
        { name: 'tight outline', shape: tightOutline, sizes: [8, 16, 32, 64, 128, 256, 512] },
        { name: 'table', shape: table, sizes: [8, 16, 32, 64, 128, 256] },
        { name: 'minified json', shape: minifiedJson, sizes: [8, 16, 32, 64, 128, 256] }
      ]

      const blockSweeps: Array<{ name: string; samples: Sample[]; p: number; k: number }> = []
      for (const { name, shape, sizes } of shapeSweeps) {
        const samples: Sample[] = []
        for (const kb of sizes) {
          samples.push(await timeParse(`${name} ${kb} KB`, shape(kb * KB, 42), kb >= 128 ? 1 : 3))
        }
        blockSweeps.push({ name, samples, ...fitPower(samples) })
      }

      // -- Additivity: does a file of N blocks cost N x one block? -----------
      const additivity: Sample[] = []
      for (const { name, shape } of shapeSweeps) {
        additivity.push(
          await timeParse(
            `${name}: 512 KB as 8 x 64 KB blocks`,
            blocksOf(shape, 512 * KB, 64 * KB),
            1
          )
        )
      }

      // -- Shape corpus, comparable sizes -----------------------------------
      const shapes: Sample[] = []
      shapes.push(await timeParse('small prose note (4 KB)', prose(4 * KB, 600)))
      shapes.push(await timeParse('long prose (512 KB)', prose(512 * KB, 600)))
      shapes.push(await timeParse('structured doc (512 KB)', structured(512 * KB)))
      shapes.push(await timeParse('obsidian vault note (512 KB)', obsidianVault(512 * KB)))
      shapes.push(await timeParse('structured doc (2 MB)', structured(2 * MB), 1))
      shapes.push(await timeParse('obsidian vault note (2 MB)', obsidianVault(2 * MB), 1))

      // -- Worst case admitted by a candidate pair of thresholds -------------
      const worst: Sample[] = []
      for (const { name, shape } of shapeSweeps) {
        worst.push(
          await timeParse(
            `${name}: 2 MB as 16 x 128 KB blocks (current bounds)`,
            blocksOf(shape, 2 * MB, 128 * KB),
            1
          )
        )
      }

      // -- Report -----------------------------------------------------------
      write('')
      write('## Sweep A - file size, well-formed prose')
      write(HEADER)
      for (const s of fileSweep) write(row(s))
      write('')
      write(`fitted linear rate a = ${a.toFixed(0)} ms/MB`)

      for (const sweep of blockSweeps) {
        write('')
        write(`## Sweep B - one ${sweep.name} block, growing`)
        write(HEADER)
        for (const s of sweep.samples) write(row(s))
        write(
          `fit: ms = ${sweep.k.toFixed(3)} * (blockKB ^ ${sweep.p.toFixed(2)})   [exponent 1 = linear, 2 = quadratic]`
        )
      }

      write('')
      write('## Additivity - 512 KB tiled as 8 x 64 KB blocks')
      write(HEADER)
      for (const s of additivity) write(row(s))

      write('')
      write('## Realistic shapes')
      write(HEADER)
      for (const s of shapes) write(row(s))

      write('')
      write('## Worst case admitted by the shipped 2 MB / 128 KB bounds')
      write(HEADER)
      for (const s of worst) write(row(s))

      write('')
      write('## Predicted worst-case cost of candidate bounds (worst shape)')
      const worstShape = blockSweeps.reduce((acc, s) =>
        s.k * 128 ** s.p > acc.k * 128 ** acc.p ? s : acc
      )
      write(`worst shape by fit at 128 KB: ${worstShape.name}`)
      write('| maxFileBytes | maxBlockBytes | blocks | predicted ms |')
      write('| --- | --- | --- | --- |')
      for (const fileMB of [1, 2, 4]) {
        for (const blockKB of [8, 16, 32, 64, 128]) {
          const count = (fileMB * 1024) / blockKB
          const ms = a * fileMB + count * worstShape.k * blockKB ** worstShape.p
          write(`| ${fileMB} MB | ${blockKB} KB | ${count} | ${ms.toFixed(0)} |`)
        }
      }
      write('')

      // The measurement is the deliverable; the assertions only guard against a
      // run that produced nothing usable.
      expect(fileSweep).toHaveLength(6)
      expect(a).toBeGreaterThan(0)
      expect(blockSweeps.every((s) => Number.isFinite(s.p))).toBe(true)
    },
    MEASURE_TIMEOUT_MS
  )
})
