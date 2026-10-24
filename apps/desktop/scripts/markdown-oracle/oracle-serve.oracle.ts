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
import { expect, it } from 'vitest'

import {
  parseMarkdownNote,
  serializeParsedMarkdownNote,
  splitFrontmatterBlock,
  stringifyFrontmatterBlock,
  writeMarkdownNote,
  type Eol
} from '@memry/app-core/markdown'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'

import { decodeYaml, encodeYaml, type YamlJson } from './yaml-json'

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

function run(job: Job): unknown {
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
    default:
      throw new Error(`unknown oracle op: ${job.op}`)
  }
}

const inPath = process.env.MEMRY_ORACLE_IN
const outPath = process.env.MEMRY_ORACLE_OUT

it.skipIf(!inPath || !outPath)('serves one oracle batch', () => {
  if (!inPath || !outPath) return
  const jobs = readFileSync(inPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the job file is written by generate.ts
    .map((line) => JSON.parse(line) as Job)
  const lines = jobs.map((job) => {
    try {
      return JSON.stringify({ id: job.id, ok: true, output: run(job) })
    } catch (error) {
      return JSON.stringify({ id: job.id, ok: false, error: String(error) })
    }
  })
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
  expect(lines).toHaveLength(jobs.length)
})
