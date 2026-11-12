// Screenshots of the layout verification matrix (#4339). Runs
// MemryUITests/TabletLayoutUITests on each simulator, which attaches every
// main screen in portrait and landscape, and extracts the attachments into
// <out>/<simulator>/<variant>/<screen>-<orientation>.png.
//
//   node apps/ios/scripts/screenshot-matrix.mjs [options] [simulator name ...]
//
//   simulators  default: 'iPad Air 13-inch (M4)' 'iPad mini (A17 Pro)' 'iPhone 17'
//   --out DIR   default: apps/ios/build/screenshots/<timestamp>
//   --test NAME one test method only, such as testNote (repeatable)
//
// Every simulator gets the light pass at the default text size. The first one
// also gets a dark pass and a pass at the largest Dynamic Type size; the
// simulator's own appearance and text size are put back afterwards. Each
// simulator must be signed in to the staging test account: a signed-out run
// skips every test and the script fails. Resizing a window (Split View, Stage
// Manager) is out of reach of XCUITest and stays a manual check. A simulator
// the script had to boot is shut down when its runs end.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    test: { type: 'string', multiple: true, default: [] }
  }
})
const simulators = positionals.length
  ? positionals
  : ['iPad Air 13-inch (M4)', 'iPad mini (A17 Pro)', 'iPhone 17']
// `iPhone 17 Pro` runs Kaan's `pnpm dev:mobile` (apps/ios/AGENTS.md).
if (simulators.includes('iPhone 17 Pro')) fail("never run on 'iPhone 17 Pro'")
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = path.resolve(values.out ?? path.join(root, 'apps/ios/build/screenshots', stamp))
const derivedData = path.join(root, 'apps/ios/build/dd')
const project = path.join(root, 'apps/ios/Memry.xcodeproj')
const tests = values.test.length
  ? values.test.map((name) => `MemryUITests/TabletLayoutUITests/${name}`)
  : ['MemryUITests/TabletLayoutUITests']
const variants = [
  { name: 'light', appearance: 'light', size: 'large' },
  { name: 'dark', appearance: 'dark', size: 'large' },
  { name: 'largest-type', appearance: 'light', size: 'accessibility-extra-extra-extra-large' }
]

function fail(message) {
  console.error(`screenshot-matrix: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options })
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
/// run's counts from the result bundle.
function extract(bundle, folder) {
  const raw = path.join(folder, 'raw')
  run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', bundle, '--output-path', raw])
  let files = 0
  const manifest = JSON.parse(readFileSync(path.join(raw, 'manifest.json'), 'utf8'))
  for (const test of manifest) {
    for (const attachment of test.attachments) {
      // The human readable name is the attachment's name plus a suffix. A
      // failure's own attachments (hierarchy, recording) stay in the bundle.
      const match = /^(.+-(?:portrait|landscape))_\d+_[0-9A-F-]+\.png$/i.exec(
        attachment.suggestedHumanReadableName
      )
      if (!match) continue
      const name = `${match[1]}.png`
      renameSync(path.join(raw, attachment.exportedFileName), path.join(folder, name))
      files += 1
    }
  }
  rmSync(raw, { recursive: true, force: true })
  const summary = run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle])
  const { passedTests = 0, failedTests = 0, skippedTests = 0 } = JSON.parse(summary.stdout || '{}')
  return { files, passedTests, failedTests, skippedTests }
}

const first = device(simulators[0]).udid
console.log(`building for testing (log: ${out}/build.log)`)
if (!xcodebuild('build-for-testing', `id=${first}`, path.join(out, 'build.log'))) {
  fail(`build failed, see ${out}/build.log`)
}

let healthy = true
for (const [index, name] of simulators.entries()) {
  const { udid: id, state } = device(name)
  // A simulator this script boots is shut down again when its runs end.
  if (state !== 'Booted') simctl('boot', id)
  simctl('bootstatus', id, '-b')
  const original = {
    appearance: simctl('ui', id, 'appearance'),
    size: simctl('ui', id, 'content_size')
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  for (const variant of index === 0 ? variants : variants.slice(0, 1)) {
    const folder = path.join(out, slug, variant.name)
    const bundle = path.join(folder, 'result.xcresult')
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    simctl('ui', id, 'appearance', variant.appearance)
    simctl('ui', id, 'content_size', variant.size)
    const ok = xcodebuild(
      'test-without-building',
      `id=${id}`,
      path.join(folder, 'xcodebuild.log'),
      ['-resultBundlePath', bundle, ...tests.map((test) => `-only-testing:${test}`)]
    )
    const counts = extract(bundle, folder)
    console.log(
      `${name} ${variant.name}: ${counts.files} screenshots, ${counts.passedTests} passed, ` +
        `${counts.failedTests} failed, ${counts.skippedTests} skipped -> ${folder}`
    )
    if (!ok || counts.failedTests > 0 || counts.skippedTests > 0 || counts.files === 0)
      healthy = false
  }
  simctl('ui', id, 'appearance', original.appearance)
  simctl('ui', id, 'content_size', original.size)
  if (state !== 'Booted') simctl('shutdown', id)
}
if (!healthy) fail('a run failed or skipped: read its xcodebuild.log or open its result.xcresult')
console.log(`done: ${out}`)
