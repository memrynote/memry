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
import { urlCases } from './cases-url'
import { writeGrammarCorpus } from './gen-grammar-corpus'
import { grammarCorpusCases, seedCorpusCases } from './cases-corpus'
import { memryParseCases } from './cases-parse'
import { serializeCases } from './cases-serialize'
import { blocksCases } from './fns/blocks'
import { criticCases } from './fns/critic'
import { markersCases } from './fns/markers'
import { textCases } from './fns/text'
import {
  blocksCases as docBlocksCases,
  replaceBodyCases,
  roundtripCases,
  seedDocCases,
  serializeDocCases
} from './cases-doc'
import { pmSchemaCases, yxmlCases } from './cases-pm'
import { frontmatterCases, markdownClassCases, type OracleCase } from './cases-frontmatter'
import { noteStatsCases } from './note-stats-oracle'

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
      path: 'note-stats.json',
      note: 'What syncNoteToCache measures in a vault file (extractNoteMetadata of note-sync.ts and the task id scan of note-derived-state-projector.ts): calculateWordCount, the body length in UTF-16 code units, createSnippet at its default 200, the cover when isCoverValue, scanTaskCheckboxStates ids and extractTags, over the parseNote body and frontmatter.',
      cases: noteStatsCases()
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
      cases: [...htmlToBlocksCases(), ...urlCases()]
    },
    {
      path: 'parse.json',
      note: 'BlockNote markdown parse (markdownToHtml then HTMLToBlocks) as canonical block JSON, without the memry layers. memryLayerNoop says whether blocknote-converter.ts markdownToBlocks returns the same blocks; where it is false, the memry layers of a later stage change the result.',
      cases: bnParseCases(external)
    },
    {
      path: 'memry-parse.json',
      note: 'prepareFragmentSeed of blocknote-converter.ts: markdown to blocks plus CriticMarkup marks, link reference definitions and usages, plain text and writing sentinels, as canonical JSON (block ids dropped).',
      cases: memryParseCases(external)
    },
    {
      path: 'serialize.json',
      note: 'serializeBlocks of blocknote-converter.ts (extractInlineColorRuns, HTML comment and emphasis tokens, BlockNote blocksToMarkdownLossy, normalizeSerializedMarkdown): hand-written blocks of every type, and the blocks prepareFragmentSeed builds from the memry-parse inputs, to markdown byte for byte. status "error" means the oracle threw (the converter answers null).',
      cases: serializeCases(external)
    },
    {
      path: 'seed-doc.json',
      note: 'The Y.Doc a markdown seed writes (markdownToYFragment): the fragment as canonical text with block ids removed, and the side roots as JSON (markdownSource, criticMarkupMarks, link reference definitions and usages, writing tools records). A writing tools anchor is stated as the text run and index it resolves to, since Yjs ids are free.',
      cases: seedDocCases(external)
    },
    {
      path: 'roundtrip.json',
      note: 'Markdown seeded into a Y.Doc and read back: yDocToMarkdown (bytes and SourceRestoreOutcome), yDocToCanonicalMarkdown, serializeNoteBody (body and writing frontmatter) and findUnrepresentableNodes. markdown is compared byte for byte; it is the contract for what lands in users vault files.',
      cases: roundtripCases(external)
    },
    {
      path: 'serialize-doc.json',
      note: 'yDocToMarkdown over documents authored from Yjs trees (note-blocks documents, hand cases, fail-closed shapes) and over seeded documents edited before they are read: the three way source merge, record states, file spelling and the empty-conversion guard. status "error" means the oracle threw. doc-repair-ids is repairEmptyBlockIds.',
      cases: serializeDocCases(external)
    },
    {
      path: 'blocks.json',
      note: 'yFragmentToBlocks (y-prosemirror read, then nodeToBlock) as canonical block JSON, ids dropped, over seeded documents and Yjs-authored ones.',
      cases: docBlocksCases(external)
    },
    {
      path: 'replace-body.json',
      note: 'replaceDocBody of crdt-feed.ts (re-implemented over the exported converter functions because the original is coupled to the CRDT provider): large-file refusal, the unlessChangedFrom guard, the empty-body paragraph, and the side roots after the replace.',
      cases: replaceBodyCases()
    },
    {
      path: 'grammar-corpus.json',
      note: 'One positive and one negative note per rule of protocol 12.6 to 12.8 (grammar-rules.ts; the same bytes are the corpus/*.md files and corpus/manifest.json), seeded and read back as seed-corpus.json does.',
      cases: grammarCorpusCases()
    },
    {
      path: 'seed-corpus.json',
      note: 'The synthetic vault of seed-bench-vault.ts (generateBulkVault, seed 0x1848, every fourth note of 1000) seeded and read back as roundtrip.json does. expected.output holds the outcome, and markdown and canonical only where they differ from the input; an absent field means the converter answers the input unchanged.',
      cases: seedCorpusCases()
    },
    {
      path: 'layer-text.json',
      note: 'Function-level cases of the shared text layers (empty-lines, html-comments, hard-breaks, block-nesting, link-references) and the inline masks of editor-schema (token-masking, link-destinations, link-code-spans, cell-code-spaces).',
      cases: textCases(external)
    },
    {
      path: 'layer-markers.json',
      note: 'Function-level cases of the marker layers of packages/shared (block-markers, block-colors, inline-colors, task-block, plain-checkbox, obsidian-tasks, link-card-marker).',
      cases: markersCases(external)
    },
    {
      path: 'layer-blocks.json',
      note: 'Function-level cases of the editor-schema block layers (callout types, blocks/markdown.ts, quote, columns) and shared youtube.',
      cases: blocksCases(external)
    },
    {
      path: 'layer-critic.json',
      note: 'Function-level cases of CriticMarkup parsing and writing tools marker decoding (packages/shared critic-markup and writing-tools).',
      cases: criticCases(external)
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
  if (!check) writeGrammarCorpus()
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
