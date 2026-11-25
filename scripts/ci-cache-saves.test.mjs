import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'

// The repo's Actions cache holds 10 GB in total. Every per-ref save (a PR's merge ref, a branch push,
// a tag) adds an entry and evicts the oldest ones, which were feat/tauri-v2's cargo caches the merge
// queue restores (#5221). So every cache step of every workflow and local action saves only on main
// (feat/tauri-v2 names its own ref in its copy of these files) and restores everywhere else.
const repo = new URL('..', import.meta.url).pathname
const main = /github\.ref == 'refs\/heads\/main'/

const dirs = [
  '.github/workflows',
  ...readdirSync(join(repo, '.github/actions')).map((a) => `.github/actions/${a}`)
]
const files = dirs.flatMap((dir) =>
  readdirSync(join(repo, dir))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
)

// The step around line i: from its `- ` line to the next line at or left of that indent.
function step(lines, i) {
  let start = i
  while (!/^\s*- /.test(lines[start])) start--
  const indent = lines[start].search(/-/)
  let end = start + 1
  while (end < lines.length && !(lines[end].search(/\S/) <= indent && lines[end].trim())) end++
  return lines.slice(start, end).join('\n')
}

it('saves every workflow cache only on main', () => {
  let checked = 0
  for (const file of files) {
    const lines = readFileSync(join(repo, file), 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      if (/^\s*#/.test(line)) continue
      const where = `${file}:${i + 1}`
      if (/uses: Swatinem\/rust-cache@/.test(line)) {
        const save = step(lines, i).match(/save-if: (.*)/)?.[1] ?? ''
        assert.ok(main.test(save) || save === 'false', `${where} save-if: ${save}`)
      } else if (/uses: actions\/cache(\/save)?@/.test(line)) {
        const cond = step(lines, i).match(/^\s*(?:- )?if: (.*)$/m)?.[1] ?? ''
        assert.match(cond, main, `${where} if: ${cond}`)
      } else if (/uses: actions\/setup-node@/.test(line)) {
        // setup-node's `cache:` saves on every ref and has no save switch: the pnpm-store-cache
        // action restores and saves the store instead.
        const cache = step(lines, i).match(/^\s*cache: (.*)$/m)?.[1]
        assert.equal(cache, undefined, `${where} cache: ${cache}`)
      } else continue
      checked++
    }
  }
  assert.ok(checked > 30, `only ${checked} cache steps found`)
})
