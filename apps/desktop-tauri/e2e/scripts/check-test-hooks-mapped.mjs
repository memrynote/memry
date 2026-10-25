#!/usr/bin/env node
// Every function of the Electron `__memryTestHooks` object must map to an e2e command in
// HOOKS.md, so no domain step can drop a hook unnoticed. Exits 1 and lists the unmapped names.
//
//   node e2e/scripts/check-test-hooks-mapped.mjs [--hooks-md <path>]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mainDir = join(here, '../../../desktop/src/main')

/** The members of the object literal that starts at `marker`, found by 4- or 2-space indent. */
function membersAfter(source, marker, indent) {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  const names = []
  const member = new RegExp(`^${indent}(?:async\\s+)?([A-Za-z0-9_]+)\\(`)
  for (const line of source.slice(start).split('\n').slice(1)) {
    // The object ends at the first line that closes it at the marker's own indent.
    if (line.startsWith(`${indent.slice(2)}}`)) break
    const match = member.exec(line)
    if (match) names.push(match[1])
  }
  return names
}

/** Optional hooks are declared in the interface only: `name?(...)`. */
function interfaceMembers(source) {
  const start = source.indexOf('interface MemryTestHooks')
  if (start < 0) return []
  const end = source.indexOf('\n}\n', start)
  return [...source.slice(start, end).matchAll(/^  ([A-Za-z0-9_]+)\??\(/gm)].map(
    (match) => match[1]
  )
}

export function electronHookNames(dir = mainDir) {
  const hooks = readFileSync(join(dir, 'test-hooks.ts'), 'utf8')
  const sync = readFileSync(join(dir, 'sync/sync-test-hooks.ts'), 'utf8')
  return [
    ...new Set([
      ...membersAfter(hooks, 'globalThis.__memryTestHooks = {', '    '),
      ...membersAfter(sync, 'export const syncStateTestHooks', '  '),
      ...interfaceMembers(hooks)
    ])
  ]
}

/** Names that HOOKS.md does not mention in backticks. */
export function unmapped(names, hooksMd) {
  return names.filter((name) => !hooksMd.includes(`\`${name}\``))
}

function main() {
  const flag = process.argv.indexOf('--hooks-md')
  const hooksPath = flag > 0 ? process.argv[flag + 1] : join(here, '../HOOKS.md')
  const names = electronHookNames()
  if (names.length < 30) {
    console.error(
      `check-test-hooks-mapped: found only ${names.length} hooks; the extractor is stale`
    )
    process.exit(2)
  }
  const missing = unmapped(names, readFileSync(hooksPath, 'utf8'))
  if (missing.length > 0) {
    console.error(`HOOKS.md does not map: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log(`check-test-hooks-mapped: ${names.length} hooks mapped`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
