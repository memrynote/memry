#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  buildHumanizeReleaseArgs,
  buildDateReleaseVersion,
  extractWorkflowRunId,
  getReleaseListFields,
  parseReleaseArgs,
  selectDispatchedWorkflowRun,
  selectDraftRelease
} from './release-utils.mjs'
import { assertHumanizedReleaseNotesForPublish } from './release-notes-utils.mjs'
import {
  buildKeytoolListArgs,
  buildOsslsigncodeVerifyArgs,
  buildSmokeDispatchArgs,
  buildVelopackAssetNames,
  buildVpkPackArgs,
  clearStepsFrom,
  collectUploadAssets,
  decideSigningSession,
  decideWorkflowAction,
  isSignatureVerified,
  isStepDone,
  markStepDone,
  parseReleaseMetadata,
  parseReleaseState,
  resolveUnpackedDir,
  selectPreviousFullNupkgAsset,
  selectPreviousPublishedRelease,
  selectRunArtifacts
} from './velopack-release-utils.mjs'

const workflowFile = 'publish-release.yml'
const workflowName = 'Publish Desktop Release'
const homebrewWorkflowFile = 'publish-homebrew-cask.yml'
const releaseTimeZone = process.env.RELEASE_TIME_ZONE || 'Europe/Istanbul'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateRoot = path.join(repoRoot, '.release-state')
const iconPath = path.join(repoRoot, 'apps/desktop/build/icon.ico')
const signTemplateScript = path.join(repoRoot, 'scripts/sign-windows-binary.sh')
const certumCaPaths = [
  path.join(repoRoot, 'scripts/certum/ccsca2021.pem'),
  path.join(repoRoot, 'scripts/certum/ctnca2.pem')
]
const pkcs11ConfigPath = path.join(os.homedir(), '.config/memrynote/simplysign-pkcs11.cfg')
const certumChainPath = path.join(os.homedir(), '.config/memrynote/certum-chain.pem')
const simplySignLibraryPath = '/usr/local/lib/libSimplySignPKCS.dylib'
const signingAlias = '57D2B94F4B6C4356BD26F757F3855C1F'
const keychainService = 'memry-sign-pin'

// Velopack refuses to pack an app that never calls VelopackApp.build().run().
// The app-side updater ships in its own change; flip this to false in the same
// release that ships it.
const skipVeloAppCheck = false

async function runCli() {
  const options = parseReleaseArgs(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  runGh(['auth', 'status'], { stdio: 'inherit' })

  if (!options.dryRun) {
    assertSigningPrerequisites()
    await requireSigningSession()
  }

  const releases = readGhJson([
    'release',
    'list',
    '--limit',
    '100',
    '--json',
    getReleaseListFields().join(',')
  ])
  const draftTag = resolveDraftTag(releases, options)
  const workDir = path.join(stateRoot, draftTag.replaceAll('/', '-'))

  if (options.restart) {
    rmSync(workDir, { force: true, recursive: true })
    console.log(`Cleared ${path.relative(repoRoot, workDir)}`)
  }

  let state = readState(workDir, draftTag)

  if (isStepDone(state, 'publish')) {
    console.log(`Release ${state.tag} is already published. Nothing to do.`)
    return
  }

  if (!isStepDone(state, 'dispatch')) {
    await prepareDraft({ draftTag, options, releases })
  }

  const runId = await ensureWorkflowRun({ draftTag, options, state, workDir })

  if (!runId) {
    return
  }

  state = readState(workDir, draftTag)

  const { assetDir, metadata } = downloadRunArtifacts({ runId, state, workDir })
  state = markStepDone(readState(workDir, draftTag), 'download', {
    appVersion: metadata.appVersion,
    tag: metadata.tag
  })
  writeState(workDir, state)

  if (options.dryRun) {
    console.log('')
    console.log(`Dry run: artifacts are in ${path.relative(repoRoot, assetDir)}`)
    console.log('Nothing was signed, uploaded or published.')
    return
  }

  const velopackDir = await packVelopack({ assetDir, metadata, releases, state, workDir })
  state = markStepDone(readState(workDir, draftTag), 'pack')
  writeState(workDir, state)
  verifyVelopackSignatures({ metadata, velopackDir, workDir })
  state = markStepDone(readState(workDir, draftTag), 'verify')
  writeState(workDir, state)

  uploadReleaseAssets({ assetDir, draftTag, metadata, velopackDir })
  state = markStepDone(readState(workDir, draftTag), 'upload')
  writeState(workDir, state)

  publishRelease(metadata)
  state = markStepDone(readState(workDir, draftTag), 'publish')
  writeState(workDir, state)

  dispatchHomebrewCask(metadata)

  if (options.smoke) {
    dispatchSmokeTest({ metadata, releases })
  }

  console.log('')
  console.log(`Published ${metadata.releaseName}`)
  console.log(`  Next: pnpm release:reddit -- --tag ${metadata.tag}`)
  console.log(`  Working files: ${path.relative(repoRoot, workDir)} (safe to delete)`)
}

function resolveDraftTag(releases, options) {
  if (options.tag) {
    return options.tag
  }

  const resumable = findResumableDraftTag()
  if (resumable) {
    console.log(`Resuming release ${resumable}`)
    return resumable
  }

  return selectDraftRelease(releases).tagName
}

function findResumableDraftTag() {
  if (!existsSync(stateRoot)) {
    return null
  }

  const candidates = readdirSync(stateRoot)
    .map((entry) => path.join(stateRoot, entry, 'state.json'))
    .filter((file) => existsSync(file))
    .map((file) => readJsonOrNull(file))
    .filter((state) => state?.draftTag && !state.completed?.includes('publish'))

  if (candidates.length !== 1) {
    return null
  }

  return candidates[0].draftTag
}

async function prepareDraft({ draftTag, options, releases }) {
  let draftDetails = readGhJson([
    'release',
    'view',
    draftTag,
    '--json',
    'tagName,name,isDraft,targetCommitish,body,assets,url'
  ])
  const preview = buildDateReleaseVersion({
    date: new Date(),
    existingTags: releases.map((release) => release.tagName),
    ignoreTag: draftDetails.tagName,
    timeZone: releaseTimeZone
  })

  if (options.humanize) {
    runHumanizeReleaseNotes({
      dryRun: options.dryRun,
      tag: draftDetails.tagName,
      yes: options.yes
    })

    if (!options.dryRun) {
      draftDetails = readGhJson([
        'release',
        'view',
        draftDetails.tagName,
        '--json',
        'tagName,name,isDraft,targetCommitish,body,assets,url'
      ])
    }
  }

  if (!options.dryRun) {
    assertHumanizedReleaseNotesForPublish({
      body: draftDetails.body ?? '',
      draftTag: draftDetails.tagName,
      expectedTag: preview.tag
    })
  }

  printPlan({ draft: draftDetails, dryRun: options.dryRun, preview })

  if (!options.yes) {
    const confirmed = await confirmDispatch()
    if (!confirmed) {
      throw new Error('Release dispatch cancelled')
    }
  }
}

async function ensureWorkflowRun({ draftTag, options, state, workDir }) {
  const run = state.runId ? readWorkflowRun(state.runId) : null
  const decision = decideWorkflowAction({ state, run })
  console.log(`Workflow: ${decision.reason}`)

  if (decision.action === 'reuse') {
    return state.runId
  }

  if (decision.action === 'watch') {
    watchWorkflowRun(state.runId)
    writeState(workDir, markStepDone(state, 'build'))
    return state.runId
  }

  const dispatchedAfter = new Date(Date.now() - 5000)
  const dispatchOutput = runGh(
    ['workflow', 'run', workflowFile, '--ref', 'main', '-f', `draft_tag=${draftTag}`],
    { encoding: 'utf8' }
  )

  if (dispatchOutput) {
    console.log(dispatchOutput)
  }

  const runId = extractWorkflowRunId(dispatchOutput) ?? (await findDispatchedRun(dispatchedAfter))

  if (!runId) {
    throw new Error(`Could not find the dispatched ${workflowName} run. Re-run pnpm release.`)
  }

  console.log(`Workflow: ${workflowRunUrl(runId)}`)
  const dispatched = markStepDone(clearStepsFrom(state, 'build'), 'dispatch', { runId })
  writeState(workDir, dispatched)

  if (!options.watch) {
    console.log('Re-run pnpm release when the build finishes to pack, sign and publish.')
    return null
  }

  watchWorkflowRun(runId)
  writeState(workDir, markStepDone(dispatched, 'build'))
  return runId
}

function downloadRunArtifacts({ runId, state, workDir }) {
  const assetDir = path.join(workDir, 'assets')
  const metadataDir = path.join(workDir, 'metadata')
  const metadataFile = path.join(metadataDir, 'release-metadata.json')

  if (!isStepDone(state, 'download') || !existsSync(metadataFile)) {
    const artifactNames = readGhJson([
      'api',
      `repos/${repoSlug()}/actions/runs/${runId}/artifacts`,
      '--jq',
      '[.artifacts[].name]'
    ])
    const artifacts = selectRunArtifacts(artifactNames)

    rmSync(assetDir, { force: true, recursive: true })
    rmSync(metadataDir, { force: true, recursive: true })
    mkdirSync(assetDir, { recursive: true })
    mkdirSync(metadataDir, { recursive: true })

    console.log(`Downloading ${artifacts.assetsArtifact}`)
    runGh(['run', 'download', String(runId), '-n', artifacts.assetsArtifact, '-D', assetDir], {
      stdio: 'inherit'
    })
    runGh(['run', 'download', String(runId), '-n', artifacts.metadataArtifact, '-D', metadataDir], {
      stdio: 'inherit'
    })
  }

  const metadata = parseReleaseMetadata(readJsonOrNull(metadataFile))
  console.log(`Build: ${metadata.releaseName} (${metadata.appVersion}) at ${metadata.commitSha}`)

  return { assetDir, metadata }
}

async function packVelopack({ assetDir, metadata, releases, state, workDir }) {
  const velopackDir = path.join(workDir, 'velopack')
  const names = buildVelopackAssetNames(metadata.appVersion)

  if (isStepDone(state, 'pack') && existsSync(path.join(velopackDir, names.full))) {
    console.log(`Velopack: reusing ${path.relative(repoRoot, velopackDir)}`)
    return velopackDir
  }

  const packDir = extractWindowsPayload({ assetDir, workDir })
  const previousDir = downloadPreviousFullPackage({ metadata, releases, workDir })

  rmSync(velopackDir, { force: true, recursive: true })
  mkdirSync(velopackDir, { recursive: true })

  if (previousDir) {
    for (const name of readdirSync(previousDir)) {
      cpSync(path.join(previousDir, name), path.join(velopackDir, name))
    }
  }

  // Sessions last about two hours and the CI build can outlive one.
  await requireSigningSession()

  const args = buildVpkPackArgs({
    iconPath,
    outputDir: velopackDir,
    packDir,
    packVersion: metadata.appVersion,
    releaseNotesPath: findReleaseNotesFile(metadata.appVersion),
    signTemplate: `${signTemplateScript} {{file}}`,
    skipVeloAppCheck
  })

  console.log(`vpk ${args.join(' ')}`)
  const result = spawnSync(resolveVpkBinary(), args, {
    env: { ...process.env, MEMRY_SIGN_PIN: readSigningPin() },
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`vpk pack failed with exit code ${result.status}`)
  }

  return velopackDir
}

function extractWindowsPayload({ assetDir, workDir }) {
  const zipName = readdirSync(assetDir).find((name) => name.endsWith('-win.zip'))

  if (!zipName) {
    throw new Error(`No *-win.zip in ${assetDir}. The Windows build job did not stage its payload.`)
  }

  const zipPath = path.join(assetDir, zipName)
  const extractDir = path.join(workDir, 'win-unpacked')
  const archivePaths = capture('unzip', ['-Z1', zipPath]).stdout.split('\n').filter(Boolean)
  const unpackedDir = resolveUnpackedDir(archivePaths)

  rmSync(extractDir, { force: true, recursive: true })
  mkdirSync(extractDir, { recursive: true })
  console.log(`Extracting ${zipName}`)
  run('unzip', ['-q', zipPath, '-d', extractDir])

  return path.join(extractDir, unpackedDir)
}

function downloadPreviousFullPackage({ metadata, releases, workDir }) {
  const previousTag = selectPreviousPublishedRelease(releases, { excludeTag: metadata.tag })

  if (!previousTag) {
    console.log('Velopack: no previous release, packing without a delta')
    return null
  }

  const previousAssets = readGhJson([
    'release',
    'view',
    previousTag,
    '--json',
    'assets'
  ]).assets.map((asset) => asset.name)
  const previous = selectPreviousFullNupkgAsset(previousAssets)

  if (!previous) {
    console.log(`Velopack: ${previousTag} has no full nupkg, packing without a delta`)
    return null
  }

  const previousDir = path.join(workDir, 'previous')
  mkdirSync(previousDir, { recursive: true })

  if (!existsSync(path.join(previousDir, previous.name))) {
    console.log(`Velopack: downloading ${previous.name} from ${previousTag} for the delta`)
    runGh(
      [
        'release',
        'download',
        previousTag,
        '--pattern',
        previous.name,
        '--dir',
        previousDir,
        '--clobber'
      ],
      { stdio: 'inherit' }
    )
  }

  return previousDir
}

function verifyVelopackSignatures({ metadata, velopackDir, workDir }) {
  const names = buildVelopackAssetNames(metadata.appVersion)
  const caFile = path.join(workDir, 'certum-ca-bundle.pem')
  writeFileSync(caFile, certumCaPaths.map((file) => readFileSync(file, 'utf8')).join(''))

  const inspectDir = path.join(workDir, 'verify')
  rmSync(inspectDir, { force: true, recursive: true })
  mkdirSync(inspectDir, { recursive: true })
  run('unzip', [
    '-q',
    '-o',
    path.join(velopackDir, names.full),
    'lib/app/Memrynote.exe',
    '-d',
    inspectDir
  ])

  for (const file of [
    path.join(velopackDir, names.setup),
    path.join(inspectDir, 'lib/app/Memrynote.exe')
  ]) {
    const result = capture('osslsigncode', buildOsslsigncodeVerifyArgs({ caFile, filePath: file }))

    if (!isSignatureVerified(result.stdout)) {
      console.error(result.stdout)
      console.error(result.stderr)
      throw new Error(
        `Authenticode verification failed for ${path.basename(file)}. Nothing was uploaded.`
      )
    }

    console.log(`Signature verification: ok  ${path.basename(file)}`)
  }
}

function uploadReleaseAssets({ assetDir, draftTag, metadata, velopackDir }) {
  const names = buildVelopackAssetNames(metadata.appVersion)
  const { assets, missing } = collectUploadAssets({
    appVersion: metadata.appVersion,
    ciAssetNames: readdirSync(assetDir),
    velopackAssetNames: readdirSync(velopackDir)
  })

  if (missing.length > 0) {
    throw new Error(`Release assets are incomplete: ${missing.join(', ')}`)
  }

  if (!assets.some((asset) => asset.name === names.delta)) {
    console.log('Upload: no delta package in this release')
  }

  const files = assets.map((asset) =>
    path.join(asset.source === 'ci' ? assetDir : velopackDir, asset.name)
  )

  console.log(`Uploading ${files.length} assets to ${draftTag}`)
  runGh(['release', 'upload', draftTag, ...files, '--repo', repoSlug(), '--clobber'], {
    stdio: 'inherit'
  })
}

function publishRelease(metadata) {
  runGh(
    [
      'api',
      '--method',
      'PATCH',
      `repos/${repoSlug()}/releases/${metadata.releaseId}`,
      '-f',
      `tag_name=${metadata.tag}`,
      '-f',
      `target_commitish=${metadata.commitSha}`,
      '-f',
      `name=${metadata.releaseName}`,
      '-F',
      'draft=true',
      '-F',
      'prerelease=false'
    ],
    { stdio: 'ignore' }
  )

  const release = readGhJson(['api', `repos/${repoSlug()}/releases/${metadata.releaseId}`])

  if (release.assets.length === 0) {
    throw new Error(`Release ${metadata.tag} has no assets. Refusing to publish.`)
  }

  runGh(
    [
      'api',
      '--method',
      'PATCH',
      `repos/${repoSlug()}/releases/${metadata.releaseId}`,
      '-F',
      'draft=false',
      '-F',
      'prerelease=false',
      '-f',
      'make_latest=true'
    ],
    { stdio: 'ignore' }
  )

  console.log(`Published ${metadata.tag} with ${release.assets.length} assets`)
}

function dispatchHomebrewCask(metadata) {
  try {
    runGh([
      'workflow',
      'run',
      homebrewWorkflowFile,
      '--ref',
      'main',
      '-f',
      `tag=${metadata.tag}`,
      '-f',
      `app_version=${metadata.appVersion}`
    ])
    console.log('Dispatched the Homebrew cask bump')
  } catch (error) {
    console.log(`Homebrew cask bump was not dispatched: ${errorMessage(error)}`)
    console.log(
      `  Run: gh workflow run ${homebrewWorkflowFile} -f tag=${metadata.tag} -f app_version=${metadata.appVersion}`
    )
  }
}

function dispatchSmokeTest({ metadata, releases }) {
  const previousTag = selectPreviousPublishedRelease(releases, { excludeTag: metadata.tag })

  if (!previousTag) {
    console.log('Smoke test needs a previous release to update from; skipped')
    return
  }

  const previousAssets = readGhJson([
    'release',
    'view',
    previousTag,
    '--json',
    'assets'
  ]).assets.map((asset) => asset.name)
  const previous = selectPreviousFullNupkgAsset(previousAssets)
  const names = buildVelopackAssetNames(metadata.appVersion)

  // The runner installs the previous release's Setup.exe and applies this
  // release's package on top, which is the upgrade the migration exists to fix.
  if (!previous || !previousAssets.includes(names.setup)) {
    console.log(`Smoke test needs Velopack assets on ${previousTag}; skipped`)
    return
  }

  runGh(
    buildSmokeDispatchArgs({
      fromVersion: previous.version,
      tag: previousTag,
      toVersion: metadata.appVersion,
      updateTag: metadata.tag
    })
  )
  console.log(
    `Dispatched the Velopack Windows smoke test: ${previous.version} to ${metadata.appVersion}`
  )
}

function assertSigningPrerequisites() {
  const requirements = [
    {
      hint: 'brew install --cask dotnet-sdk && dotnet tool install -g vpk',
      name: 'vpk',
      present: () => resolveVpkBinary() !== null
    },
    { hint: 'brew install jsign', name: 'jsign', present: () => hasCommand('jsign') },
    {
      hint: 'brew install osslsigncode',
      name: 'osslsigncode',
      present: () => hasCommand('osslsigncode')
    },
    { hint: 'brew install openjdk', name: 'keytool', present: () => hasCommand('keytool') },
    {
      hint: 'install SimplySign Desktop from https://simplysign.certum.eu',
      name: simplySignLibraryPath,
      present: () => existsSync(simplySignLibraryPath)
    },
    {
      hint: `write ${pkcs11ConfigPath} with name, library and slotListIndex`,
      name: pkcs11ConfigPath,
      present: () => existsSync(pkcs11ConfigPath)
    },
    {
      hint: `export the leaf with keytool and append the CAs from ${path.relative(repoRoot, certumCaPaths[0])}`,
      name: certumChainPath,
      present: () => existsSync(certumChainPath)
    },
    {
      hint: `security add-generic-password -s ${keychainService} -a "$USER" -w`,
      name: `Keychain item ${keychainService}`,
      present: () => readSigningPin() !== null
    },
    {
      hint: 'this file ships with the repo',
      name: signTemplateScript,
      present: () => existsSync(signTemplateScript)
    },
    { hint: 'this file ships with the repo', name: iconPath, present: () => existsSync(iconPath) }
  ]

  const missing = requirements.filter((requirement) => !requirement.present())

  if (missing.length > 0) {
    const lines = missing.map(
      (requirement) => `  ${requirement.name}\n    fix: ${requirement.hint}`
    )
    throw new Error(`Windows signing prerequisites are missing:\n${lines.join('\n')}`)
  }
}

async function requireSigningSession() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const decision = decideSigningSession({
      alias: signingAlias,
      ...runKeytoolList()
    })

    if (decision.ready) {
      console.log(`SimplySign: ${decision.reason}`)
      return
    }

    console.log(`SimplySign: ${decision.reason}`)

    if (!input.isTTY) {
      throw new Error(
        'SimplySign Desktop has no active session and this shell cannot prompt. Log in with the OTP and re-run pnpm release.'
      )
    }

    spawnSync('open', ['-a', 'SimplySign Desktop'], { stdio: 'ignore' })
    const reader = createInterface({ input, output })
    try {
      await reader.question(
        'Log in to SimplySign Desktop with the OTP from your phone, then press Enter'
      )
    } finally {
      reader.close()
    }
  }

  throw new Error(
    `SimplySign still does not expose alias ${signingAlias}. Check SimplySign Desktop.`
  )
}

function runKeytoolList() {
  const result = spawnSync('keytool', buildKeytoolListArgs({ configPath: pkcs11ConfigPath }), {
    encoding: 'utf8',
    input: `${readSigningPin() ?? ''}\n`
  })

  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? ''
  }
}

function readSigningPin() {
  try {
    return execFileSync('security', ['find-generic-password', '-s', keychainService, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

function resolveVpkBinary() {
  if (process.env.VPK_BIN) {
    return existsSync(process.env.VPK_BIN) ? process.env.VPK_BIN : null
  }

  if (hasCommand('vpk')) {
    return 'vpk'
  }

  const toolPath = path.join(os.homedir(), '.dotnet/tools/vpk')
  return existsSync(toolPath) ? toolPath : null
}

function findReleaseNotesFile(appVersion) {
  const file = path.join(repoRoot, 'release-notes', `${appVersion}.md`)
  return existsSync(file) ? file : undefined
}

function hasCommand(command) {
  return spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' }).status === 0
}

function readState(workDir, draftTag) {
  return parseReleaseState(readJsonOrNull(path.join(workDir, 'state.json')), { draftTag })
}

function writeState(workDir, state) {
  mkdirSync(workDir, { recursive: true })
  writeFileSync(path.join(workDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function runHumanizeReleaseNotes(options) {
  const args = buildHumanizeReleaseArgs(options)
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`node ${args.join(' ')} failed`)
  }
}

function printPlan({ draft, dryRun, preview }) {
  console.log('')
  console.log('Release draft')
  console.log(`  Tag: ${draft.tagName}`)
  console.log(`  Name: ${draft.name}`)
  console.log(`  URL: ${draft.url}`)
  console.log(`  Target: ${draft.targetCommitish}`)
  console.log(`  Existing assets: ${draft.assets?.length ?? 0}`)
  console.log('')
  console.log('Publish workflow')
  console.log(`  Mode: ${dryRun ? 'build and download only' : 'build, sign on this Mac, publish'}`)
  console.log(`  Final tag: ${preview.tag}`)
  console.log(`  App version: ${preview.appVersion}`)
  console.log(`  Release name: ${preview.releaseName}`)
  console.log(`  Windows: NSIS setup.exe plus signed Velopack packages`)
  console.log('')
}

async function confirmDispatch() {
  if (!input.isTTY) {
    throw new Error('Use --yes to dispatch from a non-interactive shell')
  }

  const reader = createInterface({ input, output })
  try {
    const answer = await reader.question('Dispatch publish workflow? [y/N] ')
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    reader.close()
  }
}

async function findDispatchedRun(dispatchedAfter) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await sleep(3000)
    }

    const runs = readGhJson([
      'run',
      'list',
      '--workflow',
      workflowFile,
      '--branch',
      'main',
      '--limit',
      '5',
      '--json',
      'databaseId,url,status,event,createdAt'
    ])
    const run = selectDispatchedWorkflowRun(runs, dispatchedAfter)
    if (run) {
      return String(run.databaseId)
    }
  }

  return null
}

function readWorkflowRun(runId) {
  try {
    return readGhJson(['run', 'view', String(runId), '--json', 'databaseId,status,conclusion'])
  } catch {
    return null
  }
}

function watchWorkflowRun(runId) {
  console.log(`Watching ${workflowRunUrl(runId)}`)
  runGh(['run', 'watch', String(runId), '--exit-status'], { stdio: 'inherit' })
}

function repoSlug() {
  return process.env.GH_REPO || 'memrynote/memry'
}

function readGhJson(args) {
  return JSON.parse(runGh(args, { encoding: 'utf8' }))
}

function runGh(args, options = {}) {
  if (options.stdio) {
    const result = spawnSync('gh', args, { stdio: options.stdio })
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error(`gh ${args.join(' ')} failed`)
    }
    return ''
  }

  return execFileSync('gh', args, { encoding: options.encoding ?? 'utf8' }).trim()
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  if (result.error) {
    throw result.error
  }

  return { status: result.status ?? 1, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workflowRunUrl(runId) {
  return `https://github.com/${repoSlug()}/actions/runs/${runId}`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function printHelp() {
  console.log(`Usage: pnpm release -- [options]

Builds every platform in GitHub Actions, packs and signs the Windows Velopack
packages on this Mac with the Certum SimplySign key, uploads everything to the
draft release and publishes it.

Logging in to SimplySign Desktop with the OTP from your phone is the only manual
step. --yes does not skip it.

Options:
  --tag <tag>    Draft release tag to publish. Defaults to the newest draft.
  --dry-run      Build in GitHub Actions and download the artifacts. No signing,
                 no upload, no publish.
  --humanize     Humanize draft release notes before dispatching publish.
  --no-watch     Dispatch the workflow and stop. Re-run to finish the release.
  --restart      Discard saved progress for this draft and start over.
  --smoke        Dispatch the Velopack Windows smoke test after publishing.
  --yes, -y      Skip the interactive confirmation prompt.
  --help, -h     Show this help.

Progress is saved under .release-state/<draft-tag>/. Re-running resumes it.
`)
}

runCli().catch((error) => {
  console.error(errorMessage(error))
  process.exit(1)
})
