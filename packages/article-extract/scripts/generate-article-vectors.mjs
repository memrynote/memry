// Generates the article-extraction conformance vectors from the TypeScript oracle (linkedom
// 0.18.12 and Defuddle 0.19.0, through `@memry/article-extract`). `crates/memry-desktop` reproduces
// them exactly (`tests/article_*.rs`).
//
//   pnpm --filter @memry/article-extract vectors           # rewrite the committed files
//   pnpm --filter @memry/article-extract vectors --check   # fail if a committed file is stale
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseHTML } from 'linkedom'
import { domVector, fuzzVectors } from './vectors/dom.mjs'
import { mapVector } from './vectors/map.mjs'
import { metadataCases } from './vectors/metadata-cases.mjs'
import { metadataVector } from './vectors/metadata.mjs'
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

function buildFiles() {
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
  files.set('dom-fuzz.json', format(fuzzVectors(600)))
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

// Defuddle reports unparsable JSON-LD and the like through console.error and console.warn; the
// probes feed it such input on purpose.
const { error, warn } = console
console.error = console.warn = () => {}
const files = buildFiles()
Object.assign(console, { error, warn })
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
  console.log(`article-extract vectors are current (${files.size} files)`)
} else {
  for (const name of committed) if (!files.has(name)) rmSync(join(vectorsDir, name))
  for (const [name, content] of files) {
    const path = join(vectorsDir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  console.log(`wrote ${files.size} files to ${vectorsDir}`)
}
