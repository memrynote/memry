// Screenshots of the layout verification matrix (#4339). Runs
// MemryUITests/TabletLayoutUITests on each simulator, which attaches every
// main screen in portrait and landscape, and extracts the attachments into
// <out>/<simulator slug>/<variant>/<screen>-<orientation>.png. The slug is the
// simulator's name in lower case with each run of other characters as a dash.
//
//   node apps/ios/scripts/screenshot-matrix.mjs [options] [simulator name ...]
//
//   simulators  default: 'iPad Air 13-inch (M4)' 'iPad mini (A17 Pro)' 'iPhone 17'
//   --out DIR   default: apps/ios/build/screenshots/<timestamp>
//   --test NAME one test method only, such as testNote (repeatable)
//   --boot      boot a simulator that is shut down, and shut it down again
//   --help      this text
//
// Every simulator must already be booted, or the script fails: another agent
// may be using a shared one, so pass --boot only for a simulator you own.
// Every simulator gets the light pass at the default text size. The first one
// also gets a dark pass and a pass at the largest Dynamic Type size; each
// simulator's own appearance and text size are put back when its runs end,
// including after a failed or killed xcodebuild. Each simulator must be signed in to
// the staging test account: a signed-out run skips every test and the script
// fails. A run fails too when xcodebuild fails, the attachments cannot be
// exported, or the result bundle holds fewer tests than the class declares.
// Resizing a window (Split View, Stage Manager) is out of reach of XCUITest
// and stays a manual check.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const testSource = path.join(root, 'apps/ios/MemryUITests/TabletLayoutUITests.swift')
const usage = head()

function head() {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
  return lines
    .slice(
      0,
      lines.findIndex((line) => !line.startsWith('//'))
    )
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join('\n')
}

class MatrixError extends Error {}

function fail(message) {
  throw new MatrixError(message)
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (result.error) fail(`${command}: ${result.error.message}`)
  return result
}

function simctl(...args) {
  const result = run('xcrun', ['simctl', ...args])
  if (result.status !== 0) fail(`simctl ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function device(name) {
  const { devices } = JSON.parse(simctl('list', 'devices', 'available', '-j'))
  const matches = Object.values(devices)
    .flat()
    .filter((entry) => entry.name === name)
  if (matches.length !== 1) fail(`expected one simulator named '${name}', found ${matches.length}`)
  return matches[0]
}

function xcodebuild(action, destination, log, extra = []) {
  const args = [action, '-project', project, '-scheme', 'Memry', '-testPlan', 'UI']
  args.push('-destination', destination, '-derivedDataPath', derivedData, ...extra)
  const result = run('xcodebuild', args)
  mkdirSync(path.dirname(log), { recursive: true })
  writeFileSync(log, result.stdout + result.stderr)
  return result.status === 0
}

/// Extracts the attachments as <screen>-<orientation>.png and returns the
/// run's counts from the result bundle. Throws when the bundle cannot be read.
function extract(bundle, folder) {
  const raw = path.join(folder, 'raw')
  const exported = run('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    raw
  ])
  const manifestPath = path.join(raw, 'manifest.json')
  if (exported.status !== 0 || !existsSync(manifestPath)) {
    fail(`could not export the attachments of ${bundle}: ${exported.stderr.trim()}`)
  }
  let files = 0
  for (const test of JSON.parse(readFileSync(manifestPath, 'utf8'))) {
    for (const attachment of test.attachments) {
      // The human readable name is the attachment's name plus a suffix. A
      // failure's own attachments (hierarchy, recording) stay in the bundle.
      const match = /^(.+-(?:portrait|landscape))_\d+_[0-9A-F-]+\.png$/i.exec(
        attachment.suggestedHumanReadableName
      )
      if (!match) continue
      renameSync(path.join(raw, attachment.exportedFileName), path.join(folder, `${match[1]}.png`))
      files += 1
    }
  }
  rmSync(raw, { recursive: true, force: true })
  const summary = run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle])
  if (summary.status !== 0)
    fail(`could not read the results of ${bundle}: ${summary.stderr.trim()}`)
  const { passedTests = 0, failedTests = 0, skippedTests = 0 } = JSON.parse(summary.stdout)
  return { files, passedTests, failedTests, skippedTests }
}

/// One simulator's runs. The simulator's own appearance and text size are put
/// back, and a simulator this call booted is shut down, however the runs end.
function runSimulator(name, index) {
  const { udid: id, state } = device(name)
  const booted = state !== 'Booted'
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  let healthy = true
  let original
  try {
    if (booted) simctl('boot', id)
    simctl('bootstatus', id, '-b')
    original = {
      appearance: simctl('ui', id, 'appearance'),
      size: simctl('ui', id, 'content_size')
    }
    for (const variant of index === 0 ? variants : variants.slice(0, 1)) {
      const folder = path.join(out, slug, variant.name)
      const bundle = path.join(folder, 'result.xcresult')
      rmSync(folder, { recursive: true, force: true })
      mkdirSync(folder, { recursive: true })
      try {
        simctl('ui', id, 'appearance', variant.appearance)
        simctl('ui', id, 'content_size', variant.size)
        const ok = xcodebuild(
          'test-without-building',
          `id=${id}`,
          path.join(folder, 'xcodebuild.log'),
          ['-resultBundlePath', bundle, ...tests.map((test) => `-only-testing:${test}`)]
        )
        const counts = extract(bundle, folder)
        const ran = counts.passedTests + counts.failedTests + counts.skippedTests
        console.log(
          `${name} ${variant.name}: ${counts.files} screenshots, ${counts.passedTests} passed, ` +
            `${counts.failedTests} failed, ${counts.skippedTests} skipped -> ${folder}`
        )
        if (ran !== expectedTests) {
          console.error(
            `${name} ${variant.name}: expected ${expectedTests} tests, the bundle has ${ran}`
          )
        }
        if (
          !ok ||
          counts.failedTests > 0 ||
          counts.skippedTests > 0 ||
          counts.files === 0 ||
          ran !== expectedTests
        ) {
          healthy = false
        }
      } catch (error) {
        console.error(`${name} ${variant.name}: ${error.message}`)
        healthy = false
      }
    }
  } finally {
    if (original) {
      for (const [setting, key] of [
        ['appearance', 'appearance'],
        ['content_size', 'size']
      ]) {
        const put = run('xcrun', ['simctl', 'ui', id, setting, original[key]])
        if (put.status !== 0) {
          console.error(
            `${name}: could not restore ${setting} to ${original[key]}: ${put.stderr.trim()}`
          )
          healthy = false
        }
      }
    }
    if (booted) run('xcrun', ['simctl', 'shutdown', id])
  }
  return healthy
}

let options
try {
  options = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      test: { type: 'string', multiple: true, default: [] },
      boot: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
} catch (error) {
  console.error(`screenshot-matrix: ${error.message}\n\n${usage}`)
  process.exit(1)
}
if (options.values.help) {
  console.log(usage)
  process.exit(0)
}
const { values, positionals } = options
const simulators = positionals.length
  ? positionals
  : ['iPad Air 13-inch (M4)', 'iPad mini (A17 Pro)', 'iPhone 17']
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = path.resolve(values.out ?? path.join(root, 'apps/ios/build/screenshots', stamp))
const derivedData = path.join(root, 'apps/ios/build/dd')
const project = path.join(root, 'apps/ios/Memry.xcodeproj')
const declared = [...readFileSync(testSource, 'utf8').matchAll(/^\s*func (test\w+)\(/gm)].map(
  (match) => match[1]
)
const tests = values.test.length
  ? values.test.map((name) => `MemryUITests/TabletLayoutUITests/${name}`)
  : ['MemryUITests/TabletLayoutUITests']
const expectedTests = values.test.length ? new Set(values.test).size : declared.length
const variants = [
  { name: 'light', appearance: 'light', size: 'large' },
  { name: 'dark', appearance: 'dark', size: 'large' },
  { name: 'largest-type', appearance: 'light', size: 'accessibility-extra-extra-extra-large' }
]

try {
  // `iPhone 17 Pro` runs Kaan's `pnpm dev:mobile` (apps/ios/AGENTS.md).
  if (simulators.includes('iPhone 17 Pro')) fail("never run on 'iPhone 17 Pro'")
  const unknown = values.test.filter((name) => !declared.includes(name))
  if (unknown.length) fail(`no such test in TabletLayoutUITests: ${unknown.join(', ')}`)
  for (const name of simulators) {
    if (device(name).state !== 'Booted' && !values.boot) {
      fail(
        `'${name}' is not booted: boot it, or pass --boot to let the script boot and shut it down`
      )
    }
  }
  const first = device(simulators[0]).udid
  console.log(`building for testing (log: ${out}/build.log)`)
  if (!xcodebuild('build-for-testing', `id=${first}`, path.join(out, 'build.log'))) {
    fail(`build failed, see ${out}/build.log`)
  }
  const results = simulators.map((name, index) => runSimulator(name, index))
  if (results.includes(false)) {
    fail('a run failed or skipped: read its xcodebuild.log or open its result.xcresult')
  }
  console.log(`done: ${out}`)
} catch (error) {
  if (!(error instanceof MatrixError)) throw error
  console.error(`screenshot-matrix: ${error.message}`)
  process.exitCode = 1
}
