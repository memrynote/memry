#!/usr/bin/env node
// Update-bridge rehearsal driver. Runs on Kaan's Mac (Windows packs are signed with the Certum key).
//
//   node scripts/rehearsal/rehearse.mjs build <version> [--previous-tag <tag>]
//   node scripts/rehearsal/rehearse.mjs assemble <version> [--run <id>] [--previous-tag <tag>] [--no-windows]
//   node scripts/rehearsal/rehearse.mjs publish <version> --confirm-repo memrynote/memry-update-rehearsal
//   node scripts/rehearsal/rehearse.mjs electron-baseline <tag> [--run <id>]
//
// `build` dispatches .github/workflows/update-bridge-rehearsal.yml and waits. `assemble` downloads
// the artifacts, packs and signs both Windows packs, writes the bridge feeds and leaves the final
// asset set in `.rehearsal-state/<version>/assets`. `--no-windows` skips the Certum-signed Windows
// packs and `latest.yml`, for a macOS and Linux feed that needs no SimplySign session. `publish` creates the release and uploads it.
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
import {
  buildLatestLinuxYml,
  buildLatestMacYml,
  buildLatestYml,
  describeFile,
  setupExeName
} from '../release/bridge-feeds.mjs'
import { assetNames, buildPackArgs } from '../release/vpk-args.mjs'

export const FEED_REPO = 'memrynote/memry-update-rehearsal'
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

function latestRunId(startedAfter) {
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
    'databaseId,createdAt'
  ])
  const runs = JSON.parse(out).filter((r) => r.createdAt >= startedAfter)
  if (runs.length === 0) throw new Error('The dispatched run did not appear')
  return runs[0].databaseId
}

function cmdBuild(version, argv) {
  const previous = flag(argv, '--previous-tag') ?? ''
  const startedAfter = new Date(Date.now() - 5000).toISOString()
  run('gh', [
    'workflow',
    'run',
    WORKFLOW,
    '-R',
    FEED_REPO,
    '-f',
    `version=${version}`,
    '-f',
    `feed_repo=${FEED_REPO}`,
    '-f',
    `previous_tag=${previous}`
  ])
  const deadline = Date.now() + 120_000
  let id
  while (!id && Date.now() < deadline) {
    try {
      id = latestRunId(startedAfter)
    } catch {
      spawnSync('sleep', ['5'])
    }
  }
  if (!id) throw new Error('The dispatched run did not appear')
  run('gh', ['run', 'watch', '-R', FEED_REPO, String(id), '--exit-status'])
  console.log(`build run: ${id}`)
  writeFileSync(path.join(stateDir(version), 'run-id'), String(id))
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

function packWindows(target, version, artifactDir, workDir, previousTag) {
  const outputDir = path.join(workDir, `vpk-${target}`)
  const packDir = path.join(workDir, `pack-${target}`)
  rmSync(outputDir, { force: true, recursive: true })
  rmSync(packDir, { force: true, recursive: true })
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(packDir, { recursive: true })
  const payload = path.join(artifactDir, `rehearsal-${target}-payload`)
  const zip = readdirSync(payload).find((name) => name.endsWith('.zip'))
  run('unzip', ['-q', path.join(payload, zip), '-d', packDir])
  previousFulls(previousTag, outputDir, target)
  const args = buildPackArgs(target, {
    version,
    packDir,
    outputDir,
    iconPath,
    delta: previousTag ? 'BestSpeed' : 'None',
    signTemplate: `${signScript} {{file}}`
  })
  vpk(args, { MEMRY_SIGN_PIN: readSigningPin() })
  return outputDir
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

function cmdAssemble(version, argv) {
  const previousTag = flag(argv, '--previous-tag') ?? ''
  const workDir = stateDir(version)
  const artifactDir = downloadArtifacts(version, flag(argv, '--run'))
  const assets = path.join(workDir, 'assets')
  rmSync(assets, { force: true, recursive: true })
  mkdirSync(assets, { recursive: true })
  const releaseDate = new Date().toISOString()

  const withWindows = !argv.includes('--no-windows')
  for (const target of withWindows ? ['win-x64', 'win-arm64'] : []) {
    const outputDir = packWindows(target, version, artifactDir, workDir, previousTag)
    verifySignatures(outputDir, target, version, workDir)
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
  if (withWindows) {
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
    ...(withWindows && {
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
  verifySignatures(outputDir, 'win-x64', version, workDir)
  console.log(`Baseline installer: ${path.join(outputDir, assetNames('win-x64', version).setup)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
