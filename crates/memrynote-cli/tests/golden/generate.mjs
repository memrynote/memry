#!/usr/bin/env node
// Writes the golden files of crates/memrynote-cli from the TypeScript CLI (apps/cli), the oracle
// until Step 43 (#3560) freezes them. This is the only code that runs the TypeScript CLI.
//
//   node crates/memrynote-cli/tests/golden/generate.mjs              scenarios -> expected/
//   node crates/memrynote-cli/tests/golden/generate.mjs --manifest   case labels -> manifest.json
//   ... --check                                                      writes nothing, fails on a stale file
//
// better-sqlite3 must be built for Node: `pnpm --filter @memry/desktop rebuild:node`.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { expandTokens, normalize, NORMALIZE_CASES } from './normalize.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const args = new Set(process.argv.slice(2))
const check = args.has('--check')
let stale = 0

function emit(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (current === text) return
  if (check) {
    console.error(`stale: ${path.relative(repo, file)}`)
    stale += 1
    return
  }
  fs.writeFileSync(file, text)
  console.log(`wrote ${path.relative(repo, file)}`)
}

// --- manifest ---------------------------------------------------------------------------------

// The argv prefix each switch dispatches on, keyed `<function>#<nth switch in it>`. A switch that
// is not listed fails the scan, so a new one gets a prefix before it can go uncovered.
const PREFIX = {
  'runSettings#0': 'settings',
  'runLocale#0': 'locale',
  'runReminders#0': 'reminders',
  'runTemplates#0': 'templates',
  'runBookmarks#0': 'bookmarks',
  'runSavedFilters#0': 'saved-filters',
  'runCalendar#0': 'calendar external',
  'runCalendar#1': 'calendar bindings',
  'runCalendar#2': 'calendar events',
  'runSync#0': 'sync',
  'runAgent#0': 'agent',
  'runGraph#0': 'graph',
  'runSearch#0': 'search',
  'runVault#0': 'vault',
  'runVaultRegistryCommand#0': 'vault',
  'runNotes#0': 'notes',
  'runFolders#0': 'folders',
  'runProperties#0': 'properties',
  'runFolderView#0': 'folder-view',
  'runTasks#0': 'tasks',
  'runProjects#0': 'projects',
  'runInbox#0': 'inbox',
  'runJournal#0': 'journal',
  'runTags#0': 'tags',
  'runAgentExtras#0': 'agent',
  'runIcs#0': 'calendar ics',
  'runCalendarExtras#0': 'calendar',
  'runCanvas#0': 'canvas',
  'runHomePages#0': 'home-pages',
  'runIcons#0': 'icons',
  'runImport#0': 'import',
  'runInboxExtras#0': 'inbox',
  'runNoteTools#0': 'notes',
  'runPropertyTools#0': 'properties',
  'runProjectLinks#0': 'projects',
  'runReadwise#0': 'readwise',
  'runSyncExtras#0': 'sync',
  'runSchema#0': 'tags schema',
  'runImpact#0': 'tags impact',
  'runCategories#0': 'tags categories',
  'runTagFields#0': 'tags',
  'runVaultAdmin#0': 'vault'
}

function manifest() {
  const dir = path.join(repo, 'apps/cli/src')
  const files = [
    ...fs
      .readdirSync(dir)
      .filter((name) => /^cli-commands-.*\.ts$/.test(name))
      .map((name) => path.join(dir, name)),
    ...fs
      .readdirSync(path.join(dir, 'commands'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join(dir, 'commands', name))
  ].toSorted()
  const entries = []
  for (const file of files) {
    let fn = null
    const switches = new Map()
    let current = null
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const start = /^(?:export )?(?:async )?function (\w+)/.exec(line)
        if (start) {
          fn = start[1]
          current = null
        }
        if (/\bswitch \(/.test(line)) {
          const nth = switches.get(fn) ?? 0
          switches.set(fn, nth + 1)
          current = `${fn}#${nth}`
          if (!(current in PREFIX))
            throw new Error(`no prefix for ${current} (${file}:${index + 1})`)
        }
        for (const match of line.matchAll(/case '([^']+)'/g)) {
          if (!current) throw new Error(`case outside a switch at ${file}:${index + 1}`)
          entries.push({
            key: `${PREFIX[current]} ${match[1]}`,
            file: path.relative(repo, file).split(path.sep).join('/'),
            line: index + 1
          })
        }
      })
  }
  return entries
}

// --- scenarios --------------------------------------------------------------------------------

/** The TypeScript CLI in its own process, with HOME, the working directory and the registry of
 *  the scenario's temp folder. */
function runScenario(scenario) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memrynote-golden-')))
  try {
    const dirs = { tmp, vault: path.join(tmp, 'vault'), home: path.join(tmp, 'home') }
    fs.mkdirSync(dirs.vault)
    fs.mkdirSync(dirs.home)
    fs.mkdirSync(path.join(tmp, 'appdata'))
    const config = path.join(tmp, 'appdata', 'memry-config.json')
    if (scenario.registry !== null) {
      fs.writeFileSync(config, JSON.stringify(expandTokens(scenario.registry, dirs, {}), null, 2))
    }
    const input = path.join(tmp, 'scenario.json')
    fs.writeFileSync(input, JSON.stringify({ scenario, dirs }))
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        '--experimental-transform-types',
        '--import',
        pathToFileURL(path.join(here, 'oracle/register.mjs')).href,
        path.join(here, 'oracle/runner.ts'),
        input
      ],
      {
        cwd: tmp,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: dirs.home,
          USERPROFILE: dirs.home,
          MEMRY_GOLDEN_CONFIG: config
        },
        maxBuffer: 64 * 1024 * 1024
      }
    )
    if (result.status !== 0) {
      throw new Error(`oracle failed for ${scenario.name}:\n${result.stderr}`)
    }
    const steps = JSON.parse(fs.readFileSync(`${input}.out`, 'utf8'))
    const ids = new Map()
    return {
      name: scenario.name,
      steps: steps.map((step, index) => ({
        argv: scenario.steps[index].argv,
        exit: step.exit,
        stdout: normalize(step.stdout, dirs, ids),
        stderr: normalize(step.stderr, dirs, ids)
      }))
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (args.has('--manifest')) {
  const entries = manifest()
  emit(path.join(here, 'manifest.json'), entries)
  console.log(`${entries.length} entries`)
} else {
  const scenarios = path.join(here, 'scenarios')
  for (const name of fs
    .readdirSync(scenarios)
    .filter((n) => n.endsWith('.json'))
    .toSorted()) {
    const scenario = JSON.parse(fs.readFileSync(path.join(scenarios, name), 'utf8'))
    emit(path.join(here, 'expected', name), runScenario(scenario))
  }
  const dirs = { tmp: '/tmp/x', vault: '/tmp/x/vault', home: '/tmp/x/home' }
  emit(
    path.join(here, 'normalize-cases.json'),
    NORMALIZE_CASES.map((input) => ({ input, dirs, output: normalize(input, dirs) }))
  )
}
if (stale > 0) process.exit(1)
