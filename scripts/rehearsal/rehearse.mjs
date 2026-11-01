#!/usr/bin/env node
// Update-bridge rehearsal driver. Runs on Kaan's Mac (Windows packs are signed with the Certum key).
//
//   node scripts/rehearsal/rehearse.mjs build <version> [--previous-tag <tag>] [--source-ref <ref>] [--workflow-ref <ref>]
//   node scripts/rehearsal/rehearse.mjs assemble <version> [--run <id>] [--previous-tag <tag>] [--no-windows | --unsigned-windows [--with-latest]]
//   node scripts/rehearsal/rehearse.mjs publish <version> --confirm-repo memrynote/memry-update-rehearsal
//   node scripts/rehearsal/rehearse.mjs electron-baseline <tag> [--run <id>]
//
// `build` dispatches .github/workflows/update-bridge-rehearsal.yml at `--workflow-ref` (default
// `main`) of the rehearsal repo to build memry's `--source-ref` (default: the workflow's own
// `source_ref` default) and waits. It pins both refs to commits first and refuses when the two
// copies of the workflow at those commits differ, and it stops on a run that started from another
// rehearsal commit, cancelling it when gh printed its id. `assemble` downloads the artifacts,
// packs and signs both Windows packs (each with the pinned WebView2 bootstrapper of
// `../release/webview2-bootstrapper.mjs`, checked again inside the package), writes the bridge
// feeds and leaves the final asset set in `.rehearsal-state/<version>/assets`. `--no-windows`
// skips the Certum-signed Windows packs and `latest.yml`, for a macOS and Linux feed that needs no
// SimplySign session.
// `--unsigned-windows` packs Windows without the Certum key and without `latest.yml`: a Tauri to
// Tauri update checks no Authenticode signature, while the fixed hand-off of Electron `v2026-10-28`
// does. `--with-latest` adds `latest.yml` with the unsigned Setup copy, for the NSIS decline path
// of the builds before it: their `app-update.yml` names no publisher, so electron-updater checks
// none (#3555 comment 6496117143). `publish` creates the release and uploads it.
// Creating the rehearsal repo and every publish need Kaan's explicit approval at that moment.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildOsslsigncodeVerifyArgs, isSignatureVerified } from '../velopack-release-utils.mjs'
import { isMain } from '../release/is-main.mjs'
import {
  buildLatestLinuxYml,
  buildLatestMacYml,
  buildLatestYml,
  describeFile,
  setupExeName
} from '../release/bridge-feeds.mjs'
import { assertPublishable, assetNames, buildPackArgs } from '../release/vpk-args.mjs'
import { assertPackable, renameToPublished } from '../release/vpk-pack.mjs'
import {
  checkPinned,
  fetchBootstrapper,
  PACKAGE_ENTRY,
  verifyBootstrapper
} from '../release/webview2-bootstrapper.mjs'

export const FEED_REPO = 'memrynote/memry-update-rehearsal'
const SOURCE_REPO = 'memrynote/memry'
const WORKFLOW = 'update-bridge-rehearsal.yml'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const iconPath = path.join(repoRoot, 'apps/desktop-tauri/src-tauri/icons/icon.ico')
const signScript = path.join(repoRoot, 'scripts/sign-windows-binary.sh')
const caPaths = ['ccsca2021.pem', 'ctnca2.pem'].map((name) =>
  path.join(repoRoot, 'scripts/certum', name)
)

export function parseRehearsalVersion(version) {
  if (!/^2099\.\d{3,4}\.\d+$/.test(version ?? '')) {
    throw new Error(`Rehearsal versions look like 2099.101.1, got "${version}"`)
  }
  return version
}

export const rehearsalTag = (version) => `rehearsal-${parseRehearsalVersion(version)}`

/** The gate: publish refuses to run without Kaan's confirmation of the exact repo. */
export function assertPublishConfirmed(argv) {
  const index = argv.indexOf('--confirm-repo')
  if (index < 0 || argv[index + 1] !== FEED_REPO) {
    throw new Error(
      `publish needs --confirm-repo ${FEED_REPO}, which Kaan supplies or authorizes in the issue thread`
    )
  }
}

export function flag(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

const capture = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', cwd: repoRoot }).trim()

function stateDir(version) {
  const dir = path.join(repoRoot, '.rehearsal-state', version)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readSigningPin() {
  if (process.env.MEMRY_SIGN_PIN) return process.env.MEMRY_SIGN_PIN
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'memry-sign-pin', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    throw new Error(
      'No signing PIN: set MEMRY_SIGN_PIN or store it as the keychain item memry-sign-pin'
    )
  }
}

/** The runs of the workflow created at or after `startedAfter`, newest first. */
function runsSince(startedAfter) {
  const out = capture('gh', [
    'run',
    'list',
    '-R',
    FEED_REPO,
    '--workflow',
    WORKFLOW,
    '--limit',
    '5',
    '--json',
    'databaseId,createdAt,headSha'
  ])
  return JSON.parse(out).filter((r) => r.createdAt >= startedAfter)
}

/** The run id in what `gh workflow run` printed: gh 2.101 prints the new run's URL. */
const runIdIn = (printed) => printed.match(/\/actions\/runs\/(\d+)/)?.[1]

/**
 * Calls `attempt` every 5 s for up to two minutes until it returns a value. A failed call, such as
 * a network error or a run GitHub does not list yet, is tried again.
 */
function poll(what, attempt, timeoutMessage) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const value = attempt()
      if (value !== undefined) return value
    } catch (error) {
      console.warn(`${what} failed, trying again: ${error.message}`)
    }
    spawnSync('sleep', ['5'])
  }
  throw new Error(timeoutMessage)
}

/** The run gh printed: certainly the one this build dispatched. */
const printedRun = (id) => ({
  id,
  printed: true,
  headSha: poll(
    `Reading run ${id}`,
    () =>
      capture('gh', ['run', 'view', id, '-R', FEED_REPO, '--json', 'headSha', '-q', '.headSha']),
    `${FEED_REPO} run ${id} could not be read`
  )
})

/**
 * The run a gh that prints no URL dispatched: the newest run created since the dispatch. An older
 * run, someone else's or a previous build's, is never it. Another dispatch in the same seconds can
 * still be newer, so this is a best guess.
 */
const listedRun = (startedAfter) =>
  poll(
    'Listing the runs',
    () => {
      const [newest] = runsSince(startedAfter)
      return newest && { id: String(newest.databaseId), printed: false, headSha: newest.headSha }
    },
    'The dispatched run did not appear'
  )

/**
 * The dispatched run must have started from the rehearsal commit whose workflow was checked: a
 * branch that moved in between runs a copy nobody compared. Only a run gh printed is certainly
 * this build's, so only that one is cancelled; a listed run may be someone else's.
 */
function assertStartedFrom(started, rehearsalSha) {
  if (started.headSha === rehearsalSha) return
  const mismatch =
    `${FEED_REPO} run ${started.id} started from ${started.headSha.slice(0, 10)}, not ` +
    `the checked ${rehearsalSha.slice(0, 10)}: its ${WORKFLOW} was not compared.`
  if (!started.printed) {
    throw new Error(
      `${mismatch} It is the newest run since the dispatch, not one gh named, so it was left running. Check it, cancel it if it is this build's, and build again.`
    )
  }
  const cancel = spawnSync('gh', ['run', 'cancel', '-R', FEED_REPO, started.id], {
    encoding: 'utf8',
    cwd: repoRoot
  })
  if (cancel.status !== 0) {
    const reason =
      cancel.error?.message ?? (cancel.stderr.trim() || `gh exited with ${cancel.status}`)
    throw new Error(
      `${mismatch} Cancelling it failed (${reason}): cancel it by hand and build again.`
    )
  }
  throw new Error(`${mismatch} Cancelled it; build again.`)
}

/** The `default:` of a `workflow_dispatch` input in a copy of the workflow. */
export function inputDefault(copy, input) {
  const block = copy.match(new RegExp(`^ {6}${input}:\\n((?: {8}.*\\n)+)`, 'm'))?.[1]
  const value = block
    ?.match(/^ {8}default: *(.*)$/m)?.[1]
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
  if (!value) throw new Error(`The ${WORKFLOW} copy has no default for its ${input} input`)
  return value
}

/** The commit `ref` (a branch, a tag or a commit) of `repo` names on GitHub. */
function commitSha(repo, ref) {
  const sha = capture('gh', [
    'api',
    '-H',
    'Accept: application/vnd.github.sha',
    `repos/${repo}/commits/${encodeURIComponent(ref)}`
  ])
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repo}@${ref} resolved to "${sha}"`)
  return sha
}

const workflowAt = (repo, sha) =>
  execFileSync(
    'gh',
    [
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${repo}/contents/.github/workflows/${WORKFLOW}?ref=${sha}`
    ],
    { encoding: 'utf8', cwd: repoRoot }
  )

/**
 * The rehearsal repo runs its own copy of the workflow, the one at the dispatched ref, while the
 * jobs check out memry at `source_ref`. A copy that differs from memry's at that commit skips or
 * breaks steps the source expects: `2099.101.17` and `.18` were built from a `main` without the
 * `pe-imports` step, so it never ran. This checkout's copy does not count, since the run never
 * reads it.
 */
function assertWorkflowMatches(rehearsal, source) {
  if (rehearsal.copy !== source.copy) {
    throw new Error(
      `${FEED_REPO}@${rehearsal.ref} (${rehearsal.sha.slice(0, 10)}) has a different ${WORKFLOW} ` +
        `than ${SOURCE_REPO}@${source.ref} (${source.sha.slice(0, 10)}), the commit it would build. ` +
        `Push memry's copy at that commit to a branch there and pass --workflow-ref <branch>, or sync ${rehearsal.ref}.`
    )
  }
}

/** `ref` of `repo`, the commit it names now and the workflow copy at that commit. */
function pinRef(repo, ref) {
  const sha = commitSha(repo, ref)
  return { ref, sha, copy: workflowAt(repo, sha) }
}

function cmdBuild(version, argv) {
  const rehearsal = pinRef(FEED_REPO, flag(argv, '--workflow-ref') ?? 'main')
  const source = pinRef(
    SOURCE_REPO,
    flag(argv, '--source-ref') ?? inputDefault(rehearsal.copy, 'source_ref')
  )
  assertWorkflowMatches(rehearsal, source)
  const startedAfter = new Date(Date.now() - 5000).toISOString()
  const dispatch = [
    'workflow',
    'run',
    WORKFLOW,
    '-R',
    FEED_REPO,
    '--ref',
    rehearsal.ref,
    ...[
      `version=${version}`,
      `feed_repo=${FEED_REPO}`,
      `previous_tag=${flag(argv, '--previous-tag') ?? ''}`,
      `source_ref=${source.sha}`
    ].flatMap((field) => ['-f', field])
  ]
  console.log(`$ gh ${dispatch.join(' ')}`)
  const dispatched = spawnSync('gh', dispatch, { encoding: 'utf8', cwd: repoRoot })
  process.stdout.write(dispatched.stdout ?? '')
  process.stderr.write(dispatched.stderr ?? '')
  if (dispatched.error) throw dispatched.error
  if (dispatched.status !== 0) throw new Error(`gh exited with ${dispatched.status}`)
  const printed = runIdIn(`${dispatched.stdout}\n${dispatched.stderr}`)
  const started = printed ? printedRun(printed) : listedRun(startedAfter)
  assertStartedFrom(started, rehearsal.sha)
  run('gh', ['run', 'watch', '-R', FEED_REPO, started.id, '--exit-status'])
  console.log(`build run: ${started.id}`)
  writeFileSync(path.join(stateDir(version), 'run-id'), started.id)
}

function downloadArtifacts(version, runId) {
  const dir = path.join(stateDir(version), 'artifacts')
  rmSync(dir, { force: true, recursive: true })
  const id = runId ?? readFileSync(path.join(stateDir(version), 'run-id'), 'utf8').trim()
  run('gh', ['run', 'download', '-R', FEED_REPO, id, '-D', dir, '-p', 'rehearsal-*'])
  return dir
}

/**
 * The previous release carries the fulls of every channel. A pack run only gets its own: a
 * foreign full makes vpk list it in this channel's `releases.<channel>.json`, and copying that
 * output into the assets then overwrites the right feed file.
 */
export function isPreviousFullOf(target, name) {
  const channel = target === 'win-x64' ? '' : `${target}-`
  return new RegExp(`^MemryNote-[^-]+-${channel}full\\.nupkg$`).test(name)
}

function previousFulls(previousTag, outDir, target) {
  if (!previousTag) return
  const downloads = path.join(outDir, '.previous')
  run('gh', [
    'release',
    'download',
    previousTag,
    '--repo',
    FEED_REPO,
    '-p',
    '*full.nupkg',
    '-D',
    downloads
  ])
  for (const name of readdirSync(downloads).filter((entry) => isPreviousFullOf(target, entry))) {
    copyFileSync(path.join(downloads, name), path.join(outDir, name))
  }
  rmSync(downloads, { force: true, recursive: true })
}

function vpk(args, env = {}) {
  run(process.env.VPK_BIN ?? 'vpk', args, { env: { ...process.env, ...env } })
}

function packWindows(target, version, artifactDir, workDir, previousTag, signed) {
  const outputDir = path.join(workDir, `vpk-${target}`)
  const packDir = path.join(workDir, `pack-${target}`)
  rmSync(outputDir, { force: true, recursive: true })
  rmSync(packDir, { force: true, recursive: true })
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(packDir, { recursive: true })
  const payload = path.join(artifactDir, `rehearsal-${target}-payload`)
  const zip = readdirSync(payload).find((name) => name.endsWith('.zip'))
  run('unzip', ['-q', path.join(payload, zip), '-d', packDir])
  fetchBootstrapper(packDir)
  assertPackable(target, packDir)
  previousFulls(previousTag, outputDir, target)
  const args = buildPackArgs(target, {
    version,
    packDir,
    outputDir,
    iconPath,
    delta: previousTag ? 'BestSpeed' : 'None',
    ...(signed && { signTemplate: `${signScript} {{file}}` })
  })
  vpk(args, signed ? { MEMRY_SIGN_PIN: readSigningPin() } : {})
  renameToPublished(outputDir)
  return outputDir
}

/**
 * The bootstrapper as the full package ships it, signed pack or not: the pinned bytes, still with
 * Microsoft's own signature (sign-windows-binary.sh must have left it alone).
 */
export function verifyPackedBootstrapper(outputDir, target, version, workDir) {
  const inspect = path.join(workDir, `verify-webview2-${target}`)
  rmSync(inspect, { force: true, recursive: true })
  mkdirSync(inspect, { recursive: true })
  const full = path.join(outputDir, assetNames(target, version).full)
  run('unzip', ['-q', '-o', full, PACKAGE_ENTRY, '-d', inspect])
  const file = path.join(inspect, PACKAGE_ENTRY)
  checkPinned(file)
  verifyBootstrapper(file)
  console.log(`WebView2 bootstrapper: pinned and signed by Microsoft  ${path.basename(full)}`)
}

function verifySignatures(outputDir, target, version, workDir) {
  const caFile = path.join(workDir, 'certum-ca-bundle.pem')
  writeFileSync(caFile, caPaths.map((file) => readFileSync(file, 'utf8')).join(''))
  const names = assetNames(target, version)
  const inspect = path.join(workDir, `verify-${target}`)
  rmSync(inspect, { force: true, recursive: true })
  mkdirSync(inspect, { recursive: true })
  run('unzip', [
    '-q',
    '-o',
    path.join(outputDir, names.full),
    'lib/app/Memrynote.exe',
    '-d',
    inspect
  ])
  for (const file of [
    path.join(outputDir, names.setup),
    path.join(inspect, 'lib/app/Memrynote.exe')
  ]) {
    const result = spawnSync(
      'osslsigncode',
      buildOsslsigncodeVerifyArgs({ caFile, filePath: file }),
      { encoding: 'utf8' }
    )
    if (!isSignatureVerified(result.stdout)) {
      console.error(result.stdout, result.stderr)
      throw new Error(
        `Authenticode verification failed for ${path.basename(file)}. Nothing was uploaded.`
      )
    }
    console.log(`Signature verification: ok  ${path.basename(file)}`)
  }
}

/** Which Windows packs `assemble` builds, whether it signs them and whether it writes `latest.yml`. */
export function windowsPlan(argv) {
  const packs = !argv.includes('--no-windows')
  const signed = packs && !argv.includes('--unsigned-windows')
  return { packs, signed, latestYml: signed || (packs && argv.includes('--with-latest')) }
}

function cmdAssemble(version, argv) {
  const previousTag = flag(argv, '--previous-tag') ?? ''
  const workDir = stateDir(version)
  const artifactDir = downloadArtifacts(version, flag(argv, '--run'))
  const assets = path.join(workDir, 'assets')
  rmSync(assets, { force: true, recursive: true })
  mkdirSync(assets, { recursive: true })
  const releaseDate = new Date().toISOString()

  const windows = windowsPlan(argv)
  for (const target of windows.packs ? ['win-x64', 'win-arm64'] : []) {
    const outputDir = packWindows(
      target,
      version,
      artifactDir,
      workDir,
      previousTag,
      windows.signed
    )
    verifyPackedBootstrapper(outputDir, target, version, workDir)
    if (windows.signed) verifySignatures(outputDir, target, version, workDir)
    copyPackOutputs(outputDir, assets)
  }

  const dirOf = (target) => path.join(artifactDir, `rehearsal-${target}`)
  for (const target of ['osx-arm64', 'osx-x64', 'linux-x64']) {
    copyPackOutputs(dirOf(target), assets)
  }

  const squirrel = (arch) => assetNames(`osx-${arch}`, version).squirrelZip
  const portable = (arch) => assetNames(`osx-${arch}`, version).portable
  for (const arch of ['arm64', 'x64']) {
    copyFileSync(path.join(dirOf(`osx-${arch}`), portable(arch)), path.join(assets, squirrel(arch)))
    rmSync(path.join(assets, portable(arch)), { force: true })
  }
  const linux = assetNames('linux-x64', version)
  copyFileSync(path.join(assets, linux.portable), path.join(assets, linux.appImage))

  // Feeds hash the exact bytes that get uploaded.
  if (windows.latestYml) {
    const winSetup = path.join(assets, assetNames('win-x64', version).setup)
    copyFileSync(winSetup, path.join(assets, setupExeName(version)))
  }
  const entry = (name) => describeFile(path.join(assets, name))
  const feeds = {
    'latest-mac.yml': buildLatestMacYml({
      version,
      releaseDate,
      arm64Zip: entry(squirrel('arm64')),
      x64Zip: entry(squirrel('x64'))
    }),
    'latest-linux.yml': buildLatestLinuxYml({
      version,
      releaseDate,
      files: [entry(linux.appImage)]
    }),
    ...(windows.latestYml && {
      'latest.yml': buildLatestYml({ version, releaseDate, setup: entry(setupExeName(version)) })
    })
  }
  for (const [name, text] of Object.entries(feeds)) writeFileSync(path.join(assets, name), text)

  run('node', [
    'scripts/validate-mac-update-manifest.mjs',
    path.join(assets, 'latest-mac.yml'),
    '--require-minimum-system-version'
  ])
  console.log(`Assets ready: ${assets}\n${readdirSync(assets).join('\n')}`)
}

function copyPackOutputs(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || /\.(log|pdb)$/.test(entry.name) || entry.name === 'assets.json') continue
    copyFileSync(path.join(from, entry.name), path.join(to, entry.name))
  }
}

function cmdPublish(version, argv) {
  assertPublishConfirmed(argv)
  const assets = path.join(stateDir(version), 'assets')
  if (!existsSync(assets)) throw new Error(`Run assemble first: ${assets} does not exist`)
  assertPublishable(readdirSync(assets))
  const files = readdirSync(assets).map((name) => path.join(assets, name))
  const tag = rehearsalTag(version)
  run('gh', [
    'release',
    'create',
    tag,
    '--repo',
    FEED_REPO,
    '--title',
    tag,
    '--notes',
    'Rehearsal feed for Step 07 (#3524). Not a product release.',
    '--latest',
    ...files
  ])
}

function cmdElectronBaseline(tag, argv) {
  const workDir = stateDir(`electron-${tag}`)
  const dir = path.join(workDir, 'artifacts')
  rmSync(dir, { force: true, recursive: true })
  const runId = flag(argv, '--run')
  run('gh', [
    'run',
    'download',
    '-R',
    FEED_REPO,
    ...(runId ? [runId] : []),
    '-D',
    dir,
    '-p',
    `MemryNote-${tag}-rehearsal-win*`
  ])
  const setup = capture('gh', [
    'release',
    'view',
    tag,
    '--repo',
    'memrynote/memry',
    '--json',
    'assets',
    '-q',
    '.assets[].name'
  ])
    .split('\n')
    .map((name) => name.match(/^MemryNote-(\d+\.\d+\.\d+)-setup\.exe$/))
    .find(Boolean)
  if (!setup) throw new Error(`No NSIS setup asset in ${tag}`)
  const version = setup[1]
  const packDir = path.join(workDir, 'pack')
  const outputDir = path.join(workDir, 'baseline')
  rmSync(outputDir, { force: true, recursive: true })
  mkdirSync(outputDir, { recursive: true })
  const unpacked = capture('find', [dir, '-name', 'win-unpacked', '-type', 'd']).split('\n')[0]
  if (!unpacked) throw new Error('The artifact holds no win-unpacked directory')
  rmSync(packDir, { force: true, recursive: true })
  run('cp', ['-R', unpacked, packDir])
  // The Electron payload keeps its production excludes; only the pack target is shared.
  const args = buildPackArgs('win-x64', {
    version,
    packDir,
    outputDir,
    iconPath,
    delta: 'None',
    signTemplate: `${signScript} {{file}}`
  })
  vpk(args, { MEMRY_SIGN_PIN: readSigningPin() })
  renameToPublished(outputDir)
  verifySignatures(outputDir, 'win-x64', version, workDir)
  console.log(`Baseline installer: ${path.join(outputDir, assetNames('win-x64', version).setup)}`)
}

if (isMain(import.meta)) {
  const [command, subject, ...rest] = process.argv.slice(2)
  try {
    if (command === 'build') cmdBuild(parseRehearsalVersion(subject), rest)
    else if (command === 'assemble') cmdAssemble(parseRehearsalVersion(subject), rest)
    else if (command === 'publish') cmdPublish(parseRehearsalVersion(subject), rest)
    else if (command === 'electron-baseline') cmdElectronBaseline(subject, rest)
    else
      throw new Error(
        'usage: rehearse.mjs build|assemble|publish <version> | electron-baseline <tag>'
      )
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
