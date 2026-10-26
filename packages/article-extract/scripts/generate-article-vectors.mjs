// Generates the article-extraction conformance vectors from the TypeScript oracle (linkedom
// 0.18.12 and Defuddle 0.19.0, through `@memry/article-extract`). `crates/memry-desktop` reproduces
// them exactly (`tests/article_*.rs`).
//
//   pnpm --filter @memry/article-extract vectors           # rewrite the committed files
//   pnpm --filter @memry/article-extract vectors --check   # fail if a committed file is stale
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseHTML } from 'linkedom'
import { articleVector } from './vectors/article.mjs'
import { articleFuzzVectors } from './vectors/article-fuzz.mjs'
import { domVector, fuzzVectors } from './vectors/dom.mjs'
import { mapVector } from './vectors/map.mjs'
import { markdownCases } from './vectors/markdown-cases.mjs'
import { markdownFuzzVectors } from './vectors/markdown-fuzz.mjs'
import { frontmatterProbes, markdownVector } from './vectors/markdown.mjs'
import { metadataCases } from './vectors/metadata-cases.mjs'
import { metadataVector } from './vectors/metadata.mjs'
import { removalCases } from './vectors/removal-cases.mjs'
import { removalsVectors, scoreVector } from './vectors/removals.mjs'
import { standardizeCases } from './vectors/standardize-cases.mjs'
import { elementCases } from './vectors/element-cases.mjs'
import { elementsFuzzVectors } from './vectors/elements-fuzz.mjs'
import { standardizeFuzzVectors } from './vectors/standardize-fuzz.mjs'
import { standardizeUrl, standardizeVectors, standardizedContent } from './vectors/standardize.mjs'
import { pipelineCases } from './vectors/pipeline-cases.mjs'
import { pipelineVector } from './vectors/pipeline.mjs'
import { playScenario, scenarios } from './vectors/mutations.mjs'
import { loadFixtures, vectorsDir } from './vectors/paths.mjs'
import {
  cleanAuthorProbes,
  cleanTitleProbes,
  constantsVector,
  dateTextProbes,
  jsonProbes,
  partialProbes,
  schemaPropertyProbes,
  tailwindProbes,
  textProbes,
  urlProbes
} from './vectors/probes.mjs'
import { buildSelectors } from './vectors/selectors.mjs'
import { mathmlCases, mathmlFuzzVectors, mathmlVector } from './vectors/mathml.mjs'
import { mathmlTablesText, tablesTarget } from './vectors/mathml-tables.mjs'
import { temmlTablesText, temmlTablesTarget } from './vectors/temml-tables.mjs'
import { temmlCases, temmlFuzzVectors, temmlVector } from './vectors/temml.mjs'
import { temmlEnvCases, temmlEnvFuzzVectors } from './vectors/temml-envs.mjs'

// JS `new Date(text)` reads a date without a zone as local time. Pin the zone so vectors do not
// depend on the machine that generates them; the Rust port reads such dates as UTC.
process.env.TZ = 'UTC'

/** Every class, id and test attribute value of a page: what the partial selectors run on. */
function attributeValues(html) {
  const { document } = parseHTML(html)
  const values = new Set()
  for (const el of document.querySelectorAll('*')) {
    for (const name of ['class', 'id', 'data-component', 'data-test', 'data-testid', 'data-qa']) {
      const value = el.getAttribute(name)
      if (value) values.add(value.toWellFormed())
    }
  }
  return [...values]
}

/** One line per top-level key: reviewable diffs without indenting every node of a tree. */
function format(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const lines = Object.entries(value).map(
      ([key, v]) => `  ${JSON.stringify(key)}: ${JSON.stringify(v)}`
    )
    return `{\n${lines.join(',\n')}\n}\n`
  }
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n]\n`
  }
  return `${JSON.stringify(value)}\n`
}

async function buildFiles() {
  const fixtures = loadFixtures()
  const selectors = buildSelectors()
  const files = new Map()
  files.set('selectors.json', format(selectors))
  files.set(
    'index.json',
    format(fixtures.map(({ name, covers, htmlSha256 }) => ({ name, covers, htmlSha256 })))
  )
  for (const fixture of fixtures) {
    files.set(`dom/${fixture.name}.json`, format(domVector(fixture, selectors)))
  }
  files.set(
    'dom-mutations.json',
    format(scenarios.map((scenario) => ({ ...scenario, expected: playScenario(scenario) })))
  )
  files.set('map.json', format(mapVector()))
  files.set('constants.json', format(constantsVector()))
  for (const fixture of fixtures) {
    files.set(`metadata/${fixture.name}.json`, format(metadataVector(fixture.html)))
  }
  files.set(
    'metadata-cases.json',
    format(metadataCases.map(({ name, html }) => ({ name, html, expected: metadataVector(html) })))
  )
  for (const fixture of fixtures) {
    files.set(
      `removals/${fixture.name}.json`,
      format({ url: fixture.url, variants: removalsVectors(fixture.html, fixture.url) })
    )
  }
  files.set(
    'removal-cases.json',
    format(
      removalCases.map(({ name, html, url }) => ({
        name,
        html,
        url,
        variants: removalsVectors(html, url)
      }))
    )
  )
  for (const fixture of fixtures) {
    files.set(
      `standardize/${fixture.name}.json`,
      format({ url: fixture.url, variants: standardizeVectors(fixture.html, fixture.url) })
    )
  }
  files.set(
    'standardize-cases.json',
    format(
      [...standardizeCases, ...elementCases].map(({ name, html, url }) => ({
        name,
        html,
        url: url ?? standardizeUrl,
        variants: standardizeVectors(html, url ?? standardizeUrl)
      }))
    )
  )
  for (const fixture of fixtures) {
    const content = standardizedContent(fixture.html, fixture.url)
    files.set(
      `markdown/${fixture.name}.json`,
      format(content === null ? { html: null } : markdownVector(content))
    )
  }
  files.set(
    'markdown-cases.json',
    format(markdownCases.map(({ name, html }) => ({ name, ...markdownVector(html) })))
  )
  files.set('markdown-fuzz.json', format(markdownFuzzVectors(400)))
  files.set('frontmatter.json', format(frontmatterProbes()))
  for (const fixture of fixtures) {
    files.set(
      `pipeline/${fixture.name}.json`,
      format(pipelineVector(fixture.html, fixture.url, fixture.now))
    )
  }
  for (const fixture of fixtures) {
    files.set(`article/${fixture.name}.json`, format(await articleVector(fixture)))
  }
  files.set('article-fuzz.json', format(await articleFuzzVectors(200)))
  files.set(
    'pipeline-cases.json',
    format(
      [
        ...pipelineCases,
        ...elementCases.map((c) => ({ ...c, url: 'https://example.com/blog/2024/post' }))
      ].map(({ name, html, url }) => ({
        name,
        html,
        ...pipelineVector(html, url, '2025-01-02T03:04:05.000Z')
      }))
    )
  )
  files.set(
    'scores.json',
    format(
      Object.fromEntries([
        ...fixtures.map((f) => [f.name, scoreVector(f.html)]),
        ...removalCases.map((c) => [c.name, scoreVector(c.html)])
      ])
    )
  )
  files.set(
    'probes.json',
    format({
      json: jsonProbes(),
      schemaProperty: schemaPropertyProbes(),
      cleanTitle: cleanTitleProbes(),
      cleanAuthor: cleanAuthorProbes(),
      dateText: dateTextProbes(),
      text: textProbes(),
      tailwind: tailwindProbes(),
      url: urlProbes(),
      partial: partialProbes(fixtures.flatMap(({ html }) => attributeValues(html)))
    })
  )
  files.set('mathml-cases.json', format(mathmlCases.map(mathmlVector)))
  files.set('mathml-fuzz.json', format(mathmlFuzzVectors(1000)))
  files.set('temml-cases.json', format(temmlCases.map(temmlVector)))
  files.set('temml-fuzz.json', format(temmlFuzzVectors(2000)))
  files.set('temml-env-cases.json', format(temmlEnvCases.map(temmlVector)))
  files.set('temml-env-fuzz.json', format(temmlEnvFuzzVectors(2000)))
  files.set('dom-fuzz.json', format(fuzzVectors(600)))
  files.set(
    'standardize-fuzz.json',
    format([...standardizeFuzzVectors(400), ...elementsFuzzVectors(800)])
  )
  return files
}

function committedFiles() {
  const out = new Set()
  const visit = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name.endsWith('.json')) out.add(relative(vectorsDir, path))
    }
  }
  visit(vectorsDir)
  return out
}

// Defuddle reports unparsable JSON-LD and the like through console.error and console.warn, and a
// failed markdown conversion through console.log; the probes feed it such input on purpose.
const { error, warn, log } = console
console.error = console.warn = console.log = () => {}
const files = await buildFiles()
Object.assign(console, { error, warn, log })
const committed = committedFiles()

if (process.argv.includes('--check')) {
  const stale = []
  for (const [name, content] of files) {
    const path = join(vectorsDir, name)
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) stale.push(name)
  }
  for (const name of committed) if (!files.has(name)) stale.push(`${name} (no longer generated)`)
  if (stale.length) {
    console.error(`article-extract vectors are stale:\n  ${stale.join('\n  ')}`)
    console.error('run: pnpm --filter @memry/article-extract vectors')
    process.exit(1)
  }
  const tables = mathmlTablesText()
  if (!existsSync(tablesTarget) || readFileSync(tablesTarget, 'utf8') !== tables) {
    console.error(
      'mathml/tables.json differs from mathml-to-latex; run pnpm --filter @memry/article-extract vectors'
    )
    process.exit(1)
  }
  const temmlTables = await temmlTablesText()
  if (!existsSync(temmlTablesTarget) || readFileSync(temmlTablesTarget, 'utf8') !== temmlTables) {
    console.error(
      'temml/tables.json differs from temml; run pnpm --filter @memry/article-extract vectors'
    )
    process.exit(1)
  }
  console.log(`article-extract vectors are current (${files.size} files)`)
} else {
  for (const name of committed) if (!files.has(name)) rmSync(join(vectorsDir, name))
  for (const [name, content] of files) {
    const path = join(vectorsDir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  writeFileSync(tablesTarget, mathmlTablesText())
  mkdirSync(dirname(temmlTablesTarget), { recursive: true })
  writeFileSync(temmlTablesTarget, await temmlTablesText())
  console.log(`wrote ${files.size} files to ${vectorsDir}`)
}
