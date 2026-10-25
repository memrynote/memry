// Paths and package lookups shared by the vector generators.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const packageRoot = join(here, '../..')
export const repoRoot = join(packageRoot, '../..')
export const fixturesDir = join(repoRoot, 'crates/memry-desktop/tests/fixtures/article-extract')
export const vectorsDir = join(repoRoot, 'packages/contracts/test-vectors/article-extract')

/** Finds `name` in the nearest node_modules above `fromDir`, following the pnpm symlink. */
export function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) throw new Error(`${name} not found from ${fromDir}`)
  }
}

/** `Array#sort`'s default order, which `Array#toSorted` needs spelled out. */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** The corpus: every folder under fixtures/article-extract with its files. */
export function loadFixtures() {
  const index = JSON.parse(readFileSync(join(fixturesDir, 'index.json'), 'utf8'))
  const names = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted(byCodeUnit)
  const listed = index.map((entry) => entry.name).toSorted(byCodeUnit)
  if (JSON.stringify(names) !== JSON.stringify(listed)) {
    throw new Error(
      `fixtures/article-extract/index.json and the folders disagree: ${JSON.stringify({ names, listed })}`
    )
  }
  return index.map((entry) => {
    const dir = join(fixturesDir, entry.name)
    const page = readFileSync(join(dir, 'page.html'))
    return {
      name: entry.name,
      covers: entry.covers,
      html: page.toString('utf8'),
      htmlSha256: sha256(page),
      url: readFileSync(join(dir, 'url.txt'), 'utf8').trim(),
      now: readFileSync(join(dir, 'now.txt'), 'utf8').trim()
    }
  })
}
