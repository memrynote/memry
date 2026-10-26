/**
 * The batch oracle: runs the Electron converter code in place on the jobs of a
 * JSONL file and writes one JSON result line per job. It is a Vitest entry
 * (project `markdown-oracle`) so it resolves the workspace packages exactly as
 * the desktop suites do. `generate.ts` is its only caller today; the
 * differential and corpus runs of later stages use the same entry.
 *
 *   MEMRY_ORACLE_IN=jobs.jsonl MEMRY_ORACLE_OUT=out.jsonl \
 *     pnpm --filter @memry/desktop exec vitest run \
 *       --config config/vitest.config.ts --project markdown-oracle
 *
 * The process time zone must be UTC: js-yaml renders a `Date` used as a mapping
 * key through `Date#toString`.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import matter from 'gray-matter'
import { expect, it, vi } from 'vitest'

import {
  parseMarkdownNote,
  serializeParsedMarkdownNote,
  splitFrontmatterBlock,
  stringifyFrontmatterBlock,
  writeMarkdownNote,
  type Eol
} from '@memry/app-core/markdown'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'

import { FNS } from './fns'
import { memryParse, type MemryParseInput } from './memry-oracle'
import { serializeBlocks, serializeSeed } from './serialize-oracle'
import { bnParse, htmlToBlocks, markdownSources, mdToHtml } from './bn-oracle'
import {
  contentMatchSweep,
  findWrappingSweep,
  schemaDump,
  yxmlRead,
  yxmlRoundtrip
} from './pm-oracle'
import {
  docBlocks,
  docCorpusNote,
  docRepairIds,
  docReplace,
  docSeed,
  docSerialize,
  type DocInput
} from './doc-oracle'
import { decodeYaml, encodeYaml, type YamlJson } from './yaml-json'

// The converter imports two Electron-coupled modules. The oracle runs it
// without a vault, a database or a log file: a silent logger, and an embed
// resolver driven by the `embedFiles` of the job (none yet: stage 3 parses no
// `![[embed]]`; the map is where later cases state theirs).
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
vi.mock('../../src/main/vault/resolve-embed', () => ({
  resolveVaultEmbeds: (refs: string[]): Record<string, string> =>
    Object.fromEntries(refs.filter((ref) => ref in embedFiles).map((ref) => [ref, embedFiles[ref]]))
}))
const embedFiles: Record<string, string> = {}

// Block ids are `crypto.randomUUID()` (blocknote-converter.ts:501-509): a
// counter makes every run reproducible. Vectors never compare ids anyway.
let uuidCounter = 0
vi.spyOn(crypto, 'randomUUID').mockImplementation(
  () => `00000000-0000-4000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}`
)

function memryParseInput(input: Record<string, unknown>): MemryParseInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- job inputs are written by cases-parse.ts
  return input as MemryParseInput
}

interface Job {
  id: string
  op: string
  input: Record<string, unknown>
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new TypeError(`input.${key} must be a string`)
  return value
}

function eolOf(input: Record<string, unknown>): Eol {
  return input.eol === '\r\n' ? '\r\n' : '\n'
}

function frontmatterOf(input: Record<string, unknown>): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- job inputs are JSON this repo wrote
  const decoded = decodeYaml(input.value as YamlJson)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dump and write jobs always carry a mapping
  return decoded as Record<string, unknown>
}

async function run(job: Job): Promise<unknown> {
  const { input } = job
  switch (job.op) {
    case 'split':
      return splitFrontmatterBlock(text(input, 'raw'))
    case 'parse': {
      const parsed = parseMarkdownNote(text(input, 'raw'))
      return {
        // gray-matter yields `undefined` for a block with no YAML document.
        frontmatter: encodeYaml(parsed.frontmatter ?? null),
        content: parsed.content,
        rawFrontmatterBlock: parsed.rawFrontmatterBlock,
        eol: parsed.eol,
        hadTrailingNewline: parsed.hadTrailingNewline
      }
    }
    case 'serialize': {
      const parsed = parseMarkdownNote(text(input, 'raw'))
      const content = typeof input.content === 'string' ? input.content : parsed.content
      return serializeParsedMarkdownNote(parsed, content, {
        frontmatterEdited: input.frontmatterEdited === true
      })
    }
    case 'dump':
      return stringifyFrontmatterBlock(frontmatterOf(input), eolOf(input))
    case 'write':
      return writeMarkdownNote(frontmatterOf(input), text(input, 'content'))
    case 'load':
      // gray-matter's engine: js-yaml 3.15.1 `safeLoad`.
      return encodeYaml(matter.engines.yaml.parse(text(input, 'text')))
    case 'classify':
      return classifyMarkdownContent(text(input, 'markdown'), {
        maxFileBytes: typeof input.maxFileBytes === 'number' ? input.maxFileBytes : undefined,
        maxBlockBytes: typeof input.maxBlockBytes === 'number' ? input.maxBlockBytes : undefined
      })
    case 'schema':
      return schemaDump()
    case 'match-sweep':
      return contentMatchSweep(text(input, 'node'))
    case 'find-wrapping':
      return findWrappingSweep(text(input, 'node'))
    case 'yxml-read':
      return yxmlRead(text(input, 'updateHex'), text(input, 'fragment'))
    case 'yxml-roundtrip':
      return yxmlRoundtrip(text(input, 'updateHex'), text(input, 'fragment'))
    case 'markdown-sources':
      return markdownSources()
    case 'md-to-html':
      return mdToHtml(text(input, 'markdown'))
    case 'html-to-blocks':
      return htmlToBlocks(text(input, 'html'))
    case 'bn-parse':
      return bnParse(text(input, 'markdown'))
    case 'memry-parse': {
      for (const key of Object.keys(embedFiles)) delete embedFiles[key]
      const files = input.embedFiles
      if (files && typeof files === 'object') Object.assign(embedFiles, files)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- job inputs are written by cases-parse.ts
      return memryParse(memryParseInput(input))
    }
    case 'serialize-seed': {
      for (const key of Object.keys(embedFiles)) delete embedFiles[key]
      const files = input.embedFiles
      if (files && typeof files === 'object') Object.assign(embedFiles, files)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- job inputs are written by cases-serialize.ts
      return serializeSeed(memryParseInput(input))
    }
    case 'serialize-blocks': {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- job inputs are written by cases-serialize.ts
      const blocks = input.blocks as Parameters<typeof serializeBlocks>[0]
      return { markdown: await serializeBlocks(blocks) }
    }
    case 'corpus-note':
      return docCorpusNote({ markdown: text(input, 'markdown') })
    case 'doc-seed':
    case 'doc-serialize':
    case 'doc-blocks':
    case 'doc-replace':
    case 'doc-repair-ids': {
      for (const key of Object.keys(embedFiles)) delete embedFiles[key]
      const files = input.embedFiles
      if (files && typeof files === 'object') Object.assign(embedFiles, files)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- job inputs are written by cases-doc.ts
      const doc = input as DocInput
      if (job.op === 'doc-seed') return docSeed(doc)
      if (job.op === 'doc-serialize') return docSerialize(doc)
      if (job.op === 'doc-blocks') return docBlocks(doc)
      if (job.op === 'doc-replace') return docReplace(doc)
      return docRepairIds(doc)
    }
    case 'fn': {
      const name = text(input, 'fn')
      const fn = FNS[name]
      if (!fn) throw new Error(`unknown oracle function: ${name}`)
      const args = Array.isArray(input.args) ? input.args : []
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table is untyped by design: every function takes the JSON arguments of its case
      return await (fn as (...a: unknown[]) => unknown)(...args)
    }
    default:
      throw new Error(`unknown oracle op: ${job.op}`)
  }
}

const inPath = process.env.MEMRY_ORACLE_IN
const outPath = process.env.MEMRY_ORACLE_OUT

it.skipIf(!inPath || !outPath)('serves one oracle batch', async () => {
  if (!inPath || !outPath) return
  const jobs = readFileSync(inPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the job file is written by generate.ts
    .map((line) => JSON.parse(line) as Job)
  const lines: string[] = []
  for (const job of jobs) {
    try {
      lines.push(JSON.stringify({ id: job.id, ok: true, output: await run(job) }))
    } catch (error) {
      lines.push(JSON.stringify({ id: job.id, ok: false, error: String(error) }))
    }
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
  expect(lines).toHaveLength(jobs.length)
})
