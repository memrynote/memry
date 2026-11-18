#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  assertDraftReadyForDispatch,
  buildHumanizeReleaseArgs,
  buildDateReleaseVersion,
  extractWorkflowRunId,
  getReleaseListFields,
  parseReleaseArgs,
  selectDispatchedWorkflowRun,
  selectDraftRelease
} from './release-utils.mjs'
import {
  bridgeRelease,
  feedProblems,
  isReleasePublished,
  listPortableExecutables,
  publishVerifiedRelease,
  releaseSetProblems,
  signaturePlan,
  stagePackOutputs,
  unpackPayload,
  uploadVerifiedAssets
} from './release/finish-release.mjs'
import { setupExeName } from './release/bridge-feeds.mjs'
import {
  assertPublishable,
  assetNames,
  buildPackArgs,
  RETIRED_SETUP_NAME
} from './release/vpk-args.mjs'
import { assertPackable, renameToPublished } from './release/vpk-pack.mjs'
import {
  checkPinned,
  fetchBootstrapper,
  verifyBootstrapper
} from './release/webview2-bootstrapper.mjs'
import {
  buildKeytoolListArgs,
  buildOsslsigncodeVerifyArgs,
  buildSmokeDispatchArgs,
  clearStepsFrom,
  decideSigningSession,
  decideWorkflowAction,
  isSignatureVerified,
  isStepDone,
  markStepDone,
  parseReleaseMetadata,
  parseReleaseState,
  payloadZipName,
  planFinishSteps,
  selectPreviousFullNupkgAsset,
  selectPreviousPublishedRelease,
  selectRunArtifacts,
  windowsTargets
} from './velopack-release-utils.mjs'

const workflowFile = 'publish-release.yml'
const workflowName = 'Publish Desktop Release'
const homebrewWorkflowFile = 'publish-homebrew-cask.yml'
const releaseTimeZone = process.env.RELEASE_TIME_ZONE || 'Europe/Istanbul'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateRoot = path.join(repoRoot, '.release-state')
const iconPath = path.join(repoRoot, 'apps/desktop-tauri/src-tauri/icons/icon.ico')
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
  const draftCreatedAt =
    releases.find((release) => release.isDraft && release.tagName === draftTag)?.createdAt ?? null
  const workDir = path.join(stateRoot, draftTag.replaceAll('/', '-'))

  if (options.restart) {
    rmSync(workDir, { force: true, recursive: true })
    console.log(`Cleared ${path.relative(repoRoot, workDir)}`)
  }

  let state = readState(workDir, draftTag, draftCreatedAt)

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

  state = readState(workDir, draftTag, draftCreatedAt)

  const { assetDir, downloaded, inputsDir, metadata, payloadDir } = downloadRunArtifacts({
    runId,
    state,
    workDir
  })
  const draft = { gh: ghRunner, releaseId: metadata.releaseId, repo: repoSlug() }
  const published = isReleasePublished(draft)
  const plan = planFinishSteps(readState(workDir, draftTag, draftCreatedAt), {
    downloaded,
    published
  })
  state = { ...plan.state, appVersion: metadata.appVersion, tag: metadata.tag }
  writeState(workDir, state)

  if (options.dryRun) {
    console.log('')
    console.log(`Dry run: artifacts are in ${path.relative(repoRoot, workDir)}`)
    console.log('Nothing was signed, uploaded or published.')
    return
  }

  if (published) {
    console.log(`Release ${metadata.tag} was already published; marked done.`)
  }

  const runStep = {
    'pack-windows': () => packWindows({ assetDir, inputsDir, metadata, payloadDir, workDir }),
    bridge: () =>
      console.log(`Bridge feeds: ${bridgeRelease(assetDir, metadata.appVersion).join(', ')}`),
    verify: () => verifyRelease({ assetDir, metadata, workDir }),
    upload: () => uploadVerifiedAssets({ assetDir, ...draft }),
    publish: () => {
      publishVerifiedRelease({ assetDir, gh: ghRunner, metadata, repo: repoSlug() })
      console.log(
        `Published ${metadata.tag} with the ${readdirSync(assetDir).length} verified assets`
      )
    }
  }

  for (const step of plan.steps) {
    await runStep[step]()
    state = markStepDone(state, step)
    writeState(workDir, state)
  }

  dispatchHomebrewCask(metadata)
  stampAgentApiReference(metadata)

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

  assertDraftReadyForDispatch({
    body: draftDetails.body ?? '',
    draftTag: draftDetails.tagName,
    dryRun: options.dryRun,
    expectedTag: preview.tag
  })

  printPlan({ draft: draftDetails, dryRun: options.dryRun, preview })

  if (!options.yes) {
    const confirmed = await confirmDispatch()
    if (!confirmed) {
      throw new Error('Release dispatch cancelled')
    }
  }
}

async function ensureWorkflowRun({ draftTag, options, state, workDir }) {
  const existingRun = state.runId ? readWorkflowRun(state.runId) : null
  const decision = decideWorkflowAction({ state, run: existingRun })
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
  const inputsDir = path.join(workDir, 'inputs')
  const payloadDir = path.join(workDir, 'payloads')
  const metadataFile = path.join(metadataDir, 'release-metadata.json')
  const downloaded = !isStepDone(state, 'download') || !existsSync(metadataFile)

  if (downloaded) {
    const artifactNames = readGhJson([
      'api',
      `repos/${repoSlug()}/actions/runs/${runId}/artifacts`,
      '--jq',
      '[.artifacts[].name]'
    ])
    const artifacts = selectRunArtifacts(artifactNames)
    const downloads = [
      [artifacts.assetsArtifact, assetDir],
      [artifacts.metadataArtifact, metadataDir],
      [artifacts.inputsArtifact, inputsDir],
      ...Object.entries(artifacts.payloadArtifacts).map(([target, artifact]) => [
        artifact,
        path.join(payloadDir, target)
      ])
    ]

    for (const dir of [assetDir, metadataDir, inputsDir, payloadDir]) {
      rmSync(dir, { force: true, recursive: true })
    }

    for (const [artifact, dir] of downloads) {
      mkdirSync(dir, { recursive: true })
      console.log(`Downloading ${artifact}`)
      runGh(['run', 'download', String(runId), '-n', artifact, '-D', dir], { stdio: 'inherit' })
    }
  }

  const metadata = parseReleaseMetadata(readJsonOrNull(metadataFile))
  console.log(`Build: ${metadata.releaseName} (${metadata.appVersion}) at ${metadata.commitSha}`)

  return { assetDir, downloaded, inputsDir, metadata, payloadDir }
}

/**
 * Packs and signs both Windows targets from the CI payload zips with the notes and the `--delta`
 * the CI run used for macOS and Linux (`release-inputs-<version>`), then stages their release
 * assets next to the CI ones.
 */
async function packWindows({ assetDir, inputsDir, metadata, payloadDir, workDir }) {
  const version = metadata.appVersion
  const releaseNotes = path.join(inputsDir, 'release-notes.md')
  const { delta, previousTag } = readJsonOrNull(path.join(inputsDir, 'delta.json')) ?? {}
  const previousAssets = previousTag ? listReleaseAssets(previousTag) : []

  if (!existsSync(releaseNotes) || !delta) {
    throw new Error(`${path.relative(repoRoot, inputsDir)} lacks release-notes.md or delta.json`)
  }

  // Every payload is checked and prepared before the first pack signs anything.
  for (const target of windowsTargets()) {
    if (!delta[target]) {
      throw new Error(`delta.json has no --delta for ${target}`)
    }

    for (const dir of [packDirOf(workDir, target), outputDirOf(workDir, target)]) {
      rmSync(dir, { force: true, recursive: true })
      mkdirSync(dir, { recursive: true })
    }

    const zip = path.join(payloadDir, target, payloadZipName(target, version))
    console.log(`Extracting ${path.basename(zip)}`)
    unpackPayload(zip, packDirOf(workDir, target), metadata.windowsPayloads[target])
    fetchBootstrapper(packDirOf(workDir, target))
    assertPackable(target, packDirOf(workDir, target))

    if (delta[target] !== 'None') {
      downloadPreviousFull({
        outputDir: outputDirOf(workDir, target),
        previousAssets,
        previousTag,
        target
      })
    }
  }

  for (const target of windowsTargets()) {
    const outputDir = outputDirOf(workDir, target)

    // Sessions last about two hours and each pack signs every PE file it holds.
    await requireSigningSession()

    const args = buildPackArgs(target, {
      delta: delta[target],
      iconPath,
      outputDir,
      packDir: packDirOf(workDir, target),
      releaseNotes,
      signTemplate: `${signTemplateScript} {{file}}`,
      version
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
      throw new Error(`vpk pack ${target} failed with exit code ${result.status}`)
    }

    renameToPublished(outputDir)
    const staged = stagePackOutputs(target, version, outputDir, assetDir)
    console.log(`Velopack ${target}: staged ${staged.join(', ')}`)
  }
}

const packDirOf = (workDir, target) => path.join(workDir, `pack-${target}`)
const outputDirOf = (workDir, target) => path.join(workDir, `vpk-${target}`)

// vpk builds the delta against the previous full package of the channel in its output dir. Only
// that channel's full goes there: a foreign one would be listed in this channel's feed.
function downloadPreviousFull({ outputDir, previousAssets, previousTag, target }) {
  const previous = selectPreviousFullNupkgAsset(previousAssets, target)

  if (!previous) {
    throw new Error(
      `delta.json asks for a ${target} delta, but ${previousTag || 'no previous release'} has no full package of its channel`
    )
  }

  console.log(`Velopack: downloading ${previous.name} from ${previousTag} for the ${target} delta`)
  runGh(
    [
      'release',
      'download',
      previousTag,
      '--pattern',
      previous.name,
      '--dir',
      outputDir,
      '--clobber'
    ],
    { stdio: 'inherit' }
  )
}

/**
 * The last gate before upload: the exact release asset set, every bridge feed entry against the
 * staged bytes, and Authenticode on both Setups, the bridge Setup copy and every PE file of both
 * full packages. Our files must verify against the Certum chain; the third-party-signed ones keep
 * their vendor's signature and the pinned bytes.
 */
function verifyRelease({ assetDir, metadata, workDir }) {
  const version = metadata.appVersion
  const problems = [...releaseSetProblems(assetDir, version), ...feedProblems(assetDir, version)]

  if (problems.length > 0) {
    throw new Error(`The release is not ready. Nothing was uploaded.\n${problems.join('\n')}`)
  }

  assertPublishable(readdirSync(assetDir))

  const caFile = path.join(workDir, 'certum-ca-bundle.pem')
  writeFileSync(caFile, certumCaPaths.map((file) => readFileSync(file, 'utf8')).join(''))

  const setups = windowsTargets().map((target) => assetNames(target, version).setup)
  for (const name of [...setups, setupExeName(version)]) {
    const file = path.join(assetDir, name)
    if (existsSync(file)) {
      verifyCertumSignature(caFile, file, name)
    }
  }

  for (const target of windowsTargets()) {
    const inspectDir = path.join(workDir, `verify-${target}`)
    rmSync(inspectDir, { force: true, recursive: true })
    mkdirSync(inspectDir, { recursive: true })
    const full = assetNames(target, version).full
    run('unzip', ['-q', '-o', path.join(assetDir, full), 'lib/app/*', '-d', inspectDir])
    const appDir = path.join(inspectDir, 'lib/app')

    for (const { file, signer } of signaturePlan(listPortableExecutables(appDir))) {
      const label = `${full}:${file}`

      if (signer === 'certum') {
        verifyCertumSignature(caFile, path.join(appDir, file), label)
        continue
      }

      checkPinned(path.join(appDir, file))
      verifyBootstrapper(path.join(appDir, file))
      console.log(`Signature verification: ok  ${label} (pinned, ${signer})`)
    }
  }
}

function verifyCertumSignature(caFile, file, label) {
  const result = capture('osslsigncode', buildOsslsigncodeVerifyArgs({ caFile, filePath: file }))

  if (!isSignatureVerified(result.stdout)) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`Authenticode verification failed for ${label}. Nothing was uploaded.`)
  }

  console.log(`Signature verification: ok  ${label}`)
}

// What finish-release.mjs drives the draft with.
const ghRunner = { json: readGhJson, run: (args) => runGh(args, { stdio: 'inherit' }) }

function listReleaseAssets(tag) {
  return readGhJson(['release', 'view', tag, '--json', 'assets']).assets.map((asset) => asset.name)
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

  const previousAssets = listReleaseAssets(previousTag)
  const previous = selectPreviousFullNupkgAsset(previousAssets, 'win-x64')
  const names = assetNames('win-x64', metadata.appVersion)

  // The runner installs the previous release's Setup.exe and applies this
  // release's package on top, which is the upgrade the migration exists to fix.
  // Releases up to v2026-10-25 carry the Setup under RETIRED_SETUP_NAME.
  if (
    !previous ||
    ![names.setup, RETIRED_SETUP_NAME].some((name) => previousAssets.includes(name))
  ) {
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

function hasCommand(command) {
  return spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' }).status === 0
}

function readState(workDir, draftTag, draftCreatedAt = null) {
  return parseReleaseState(readJsonOrNull(path.join(workDir, 'state.json')), {
    draftCreatedAt,
    draftTag
  })
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
  console.log('  Windows: x64 and arm64 Velopack packs, packed and signed on this Mac')
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
    const dispatchedRun = selectDispatchedWorkflowRun(runs, dispatchedAfter)
    if (dispatchedRun) {
      return String(dispatchedRun.databaseId)
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
  const ghOutput = runGh(args, { encoding: 'utf8' })

  try {
    return JSON.parse(ghOutput)
  } catch (error) {
    throw new Error(
      `gh ${args.join(' ')} did not return JSON: ${error.message}\n${ghOutput.slice(0, 500)}`,
      { cause: error }
    )
  }
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

const AGENT_API_REFERENCE_FILES = [
  'apps/docs/src/user-guide/ai/agent-api-reference.md',
  'apps/docs/src/public/agent-api/memry-agent-api.schema.json'
]

/**
 * Stamps the agent API reference with the version just published. Never fails the
 * release: it commits and pushes only from a clean main that matches origin/main,
 * and otherwise prints the command to run by hand.
 */
function stampAgentApiReference(metadata) {
  const manual = `pnpm --filter @memry/desktop agent-api:generate --app-version ${metadata.appVersion}`
  try {
    const git = (...args) => capture('git', ['-C', repoRoot, ...args])
    git('fetch', 'origin', 'main')
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()
    const head = git('rev-parse', 'HEAD').stdout.trim()
    const remote = git('rev-parse', 'origin/main').stdout.trim()
    const dirty = git('status', '--porcelain', '--', ...AGENT_API_REFERENCE_FILES).stdout.trim()
    if (branch !== 'main' || head !== remote || dirty) {
      console.log(
        `Agent API reference not stamped (needs a clean main at origin/main). Run: ${manual}`
      )
      return
    }
    run('pnpm', [
      '--dir',
      repoRoot,
      '--filter',
      '@memry/desktop',
      'agent-api:generate',
      '--app-version',
      metadata.appVersion
    ])
    if (!git('status', '--porcelain', '--', ...AGENT_API_REFERENCE_FILES).stdout.trim()) return
    run('git', ['-C', repoRoot, 'add', '--', ...AGENT_API_REFERENCE_FILES])
    run('git', [
      '-C',
      repoRoot,
      'commit',
      '-m',
      `docs(docs): stamp agent API reference ${metadata.appVersion}`,
      '--',
      ...AGENT_API_REFERENCE_FILES
    ])
    run('git', ['-C', repoRoot, 'push', 'origin', 'HEAD:main'])
  } catch (error) {
    console.log(`Agent API reference not stamped: ${errorMessage(error)}. Run: ${manual}`)
  }
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

Builds every platform in GitHub Actions, then on this Mac packs and signs the
Windows x64 and arm64 Velopack packages with the Certum SimplySign key, writes
latest.yml for the signed Setup, verifies every asset and signature, uploads
everything to the draft release and publishes it.

Logging in to SimplySign Desktop with the OTP from your phone is the only manual
step. --yes does not skip it.

Options:
  --tag <tag>    Draft release tag to publish. Defaults to the newest draft.
  --dry-run      Build in GitHub Actions and download the artifacts. No signing,
                 no upload, no publish. The draft must already be humanized
                 (pnpm release:humanize -- --tag <draft>): the workflow packs its notes.
  --humanize     Humanize draft release notes before dispatching publish. Not with --dry-run.
  --no-watch     Dispatch the workflow and stop. Re-run to finish the release.
  --restart      Discard saved progress for this draft and start over.
  --smoke        Dispatch the Velopack Windows smoke test after publishing.
  --yes, -y      Skip the interactive confirmation prompt.
  --help, -h     Show this help.

Progress is saved under .release-state/<draft-tag>/. Re-running resumes it.
`)
}

runCli().catch((/** @type {unknown} */ error) => {
  console.error(errorMessage(error))
  process.exit(1)
})
