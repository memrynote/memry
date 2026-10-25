/**
 * Generates the `markdown-convert` conformance class by running the Electron
 * converter code in place as the oracle (`oracle-serve.oracle.ts`).
 *
 *   pnpm --filter @memry/desktop vectors:markdown-convert          # write the class
 *   pnpm --filter @memry/desktop vectors:markdown-convert:check    # regenerate to a temp dir, diff, write nothing
 *
 * The class lives in `packages/contracts/test-vectors/markdown-convert/`. This
 * generator sits in `apps/desktop` because it imports the Electron converter,
 * and `packages/` never imports an app. The Rust core reproduces every file
 * byte for byte (`crates/memry-core/tests/markdown_*_vectors.rs`).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bnParseCases, htmlToBlocksCases, mdToHtmlCases, type MarkdownSource } from './cases-bn'
import { pmSchemaCases, yxmlCases } from './cases-pm'
import { frontmatterCases, markdownClassCases, type OracleCase } from './cases-frontmatter'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMMITTED_DIR = resolve(appRoot, '../../packages/contracts/test-vectors/markdown-convert')

interface OracleResult {
  id: string
  ok: boolean
  output?: unknown
  error?: string
}

interface VectorFile {
  path: string
  note: string
  cases: OracleCase[]
}

function vectorFiles(external: MarkdownSource[]): VectorFile[] {
  return [
    {
      path: 'frontmatter.json',
      note: 'split, parse, serialize, dump, load and write of the note frontmatter (protocol 12.4): gray-matter 4.0.3 over js-yaml 3.15.1 and @memry/app-core/markdown. status "error" means the oracle threw; the message is not part of the contract.',
      cases: frontmatterCases()
    },
    {
      path: 'markdown-class.json',
      note: 'classifyMarkdownContent of @memry/shared/markdown-class: the note and large-file classes. Thresholds are per case so the bounds are testable on small inputs.',
      cases: markdownClassCases()
    },
    {
      path: 'pm-schema.json',
      note: 'The memry ProseMirror schema as BlockNote builds it (nodes in schema.spec.nodes order, marks, derived facts), and prosemirror-model ContentMatch behaviour per node type: matchFragment, fillBefore, defaultType and findWrapping over sequences of generated children.',
      cases: pmSchemaCases()
    },
    {
      path: 'yxml.json',
      note: 'y-prosemirror 1.3.7 reading a Yjs fragment into a ProseMirror document (yXmlFragmentToProseMirrorRootNode: unbuildable elements are removed) and writing that document back (prosemirrorToYXmlFragment), as canonical fragment text. Updates are authored under client id 0x6d656d72.',
      cases: yxmlCases()
    },
    {
      path: 'md-to-html.json',
      note: 'BlockNote 0.54.2 markdownToHtml (the hand-written parser that replaced remark): markdown in, HTML string out, byte for byte. Sources: a hand-written grammar covering every branch, the 275 markdown-roundtrip cases and the 288 expanded fuzz cases.',
      cases: mdToHtmlCases(external)
    },
    {
      path: 'html-to-blocks.json',
      note: 'BlockNote HTMLToBlocks on the memry schema: nestedListsToBlockNoteStructure, whitespace normalisation, the ProseMirror DOMParser with the rules of all 39 node types and 8 marks, and nodeToBlock. Blocks are canonical JSON: ids dropped, props sorted, null and undefined props omitted.',
      cases: htmlToBlocksCases()
    },
    {
      path: 'parse.json',
      note: 'BlockNote markdown parse (markdownToHtml then HTMLToBlocks) as canonical block JSON, without the memry layers. memryLayerNoop says whether blocknote-converter.ts markdownToBlocks returns the same blocks; where it is false, the memry layers of a later stage change the result.',
      cases: bnParseCases(external)
    }
  ]
}

function runOracle(cases: OracleCase[]): Map<string, OracleResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'memry-oracle-'))
  try {
    const jobs = join(scratch, 'jobs.jsonl')
    const out = join(scratch, 'out.jsonl')
    writeFileSync(jobs, `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8')
    const run = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'config/vitest.config.ts',
        '--project',
        'markdown-oracle'
      ],
      {
        cwd: appRoot,
        encoding: 'utf8',
        // UTC: js-yaml stringifies a Date mapping key through Date#toString.
        env: { ...process.env, TZ: 'UTC', MEMRY_ORACLE_IN: jobs, MEMRY_ORACLE_OUT: out },
        maxBuffer: 64 * 1024 * 1024
      }
    )
    if (run.status !== 0) {
      throw new Error(`oracle run failed (${run.status})\n${run.stdout}\n${run.stderr}`)
    }
    const results = new Map<string, OracleResult>()
    for (const line of readFileSync(out, 'utf8').split('\n')) {
      if (line.length === 0) continue
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the line was written by oracle-serve.oracle.ts
      const result = JSON.parse(line) as OracleResult
      results.set(result.id, result)
    }
    return results
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function render(file: VectorFile, results: Map<string, OracleResult>): string {
  const cases = file.cases.map((c) => {
    const result = results.get(c.id)
    if (!result) throw new Error(`oracle returned no result for ${c.id}`)
    const expected = result.ok ? { status: 'ok', output: result.output } : { status: 'error' }
    return { id: c.id, op: c.op, input: c.input, expected }
  })
  const document = {
    meta: {
      spec: 'tauri-v2-3522-markdown-convert',
      oracle:
        'apps/desktop/scripts/markdown-oracle (Electron converter run in place; gray-matter 4.0.3, js-yaml 3.15.1)',
      note: file.note,
      yamlJsonEncoding:
        'Numbers that JSON cannot carry are {"$num": "NaN"|"Infinity"|"-Infinity"|"-0"}, a Date is {"$date": ISO}, a Buffer is {"$bin": base64}, a map with a "$"-prefixed key is wrapped as {"$map": {...}}. Key order is Object.keys order.',
      caseCount: cases.length
    },
    cases
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function main(): void {
  const check = process.argv.includes('--check')
  const sources = runOracle([
    { id: 'sources/markdown-sources/all', op: 'markdown-sources', input: {} }
  ])
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by oracle-serve.oracle.ts
  const external = sources.get('sources/markdown-sources/all')?.output as MarkdownSource[]
  const files = vectorFiles(external)
  const results = runOracle(files.flatMap((f) => f.cases))
  const target = check ? mkdtempSync(join(tmpdir(), 'memry-markdown-convert-')) : COMMITTED_DIR
  const drifted: string[] = []
  try {
    for (const file of files) {
      const fresh = render(file, results)
      if (check) {
        let committed = ''
        try {
          committed = readFileSync(join(COMMITTED_DIR, file.path), 'utf8')
        } catch {
          drifted.push(`${file.path}: missing`)
          continue
        }
        if (committed !== fresh) drifted.push(`${file.path}: regenerates differently`)
        continue
      }
      mkdirSync(dirname(join(target, file.path)), { recursive: true })
      writeFileSync(join(target, file.path), fresh, 'utf8')
      process.stdout.write(`wrote ${join(target, file.path)}\n`)
    }
  } finally {
    if (check) rmSync(target, { recursive: true, force: true })
  }
  if (drifted.length > 0) {
    process.stderr.write(
      `vectors:markdown-convert:check failed:\n${drifted.map((d) => `  ${d}\n`).join('')}` +
        'Regenerate with `pnpm --filter @memry/desktop vectors:markdown-convert`.\n'
    )
    process.exit(1)
  }
  if (check) process.stdout.write(`vectors:markdown-convert:check passed (${files.length} files)\n`)
}

main()
