#!/usr/bin/env node
// A remote cache hit replays a task without running it, so a file the task reads but turbo does
// not hash lets a change land unchecked. This proves, for every cached typecheck task the CI runs,
// that each source file its TypeScript programs load is hashed: by the task itself, by a task it
// depends on, or by turbo.json's globalDependencies. Files under node_modules are external
// packages, which the lockfile (a global dependency) pins.
//
// usage: node tools/turbo-cache/check-task-inputs.mjs [--filter=<package>...]
// With no filter it checks the packages the root `pnpm typecheck` runs, a superset of every CI set.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../../..')
const rootTypecheck = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.typecheck
const filters =
  process.argv.length > 2 ? process.argv.slice(2) : rootTypecheck.match(/--filter=\S+/g)
const toRepo = (absolute) => relative(root, realpathSync(absolute)).split(sep).join('/')

const dry = JSON.parse(
  execFileSync(
    process.execPath,
    [join(root, 'scripts/run-turbo.js'), 'run', 'typecheck', ...filters, '--dry=json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
)

const global = new Set(Object.keys(dry.globalCacheInputs.files))
const tasks = new Map(dry.tasks.map((task) => [task.taskId, task]))
const ownInputs = (task) =>
  Object.keys(task.inputs).map((file) => posix.normalize(posix.join(task.directory, file)))

function hashedFor(task) {
  const hashed = new Set(global)
  const pending = [task.taskId]
  const seen = new Set()
  while (pending.length > 0) {
    const id = pending.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const current = tasks.get(id)
    for (const file of ownInputs(current)) hashed.add(file)
    pending.push(...current.dependencies)
  }
  return hashed
}

const tsc = join(root, 'node_modules/.bin/tsc')
let failures = 0
for (const task of dry.tasks) {
  if (task.command === '<NONEXISTENT>') continue
  const dir = join(root, task.directory)
  const configs = readdirSync(dir).filter((name) => /^tsconfig.*\.json$/.test(name))
  const hashed = hashedFor(task)
  const missing = new Set()
  for (const config of configs) {
    const listing = execFileSync(tsc, ['-p', config, '--listFilesOnly'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    for (const line of listing.split('\n')) {
      const file = line.trim()
      if (!file || !existsSync(file)) continue
      const repoPath = toRepo(file)
      if (repoPath.startsWith('..') || repoPath.split('/').includes('node_modules')) continue
      if (!hashed.has(repoPath)) missing.add(`${config}: ${repoPath}`)
    }
  }
  if (missing.size > 0) {
    failures += missing.size
    console.error(`${task.taskId} loads files turbo does not hash for it:`)
    for (const entry of [...missing].toSorted((a, b) => a.localeCompare(b)))
      console.error(`  ${entry}`)
  } else {
    console.log(`${task.taskId}: ${configs.length} tsconfig(s), every loaded file is hashed`)
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} unhashed file(s). Declare the package as a dependency in package.json or add the path to the task's inputs (turbo.json).`
  )
  process.exit(1)
}
