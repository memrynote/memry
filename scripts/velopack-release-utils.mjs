export const releaseStepOrder = [
  'dispatch',
  'build',
  'download',
  'pack',
  'verify',
  'upload',
  'publish'
]

// vpk's own default --exclude drops .pdb files; any value we pass replaces that default, so the
// first alternative re-adds it. The second drops non-win32 prebuilds, which are ELF/Mach-O
// binaries that Authenticode cannot sign.
const vpkExcludePattern = '(\\.pdb$)|(prebuilds[\\\\/](?!win32-x64[\\\\/]))'

const requiredCiAssets = [
  { description: 'macOS arm64 DMG', matches: (name) => name.endsWith('-arm64.dmg') },
  {
    description: 'macOS x64 DMG',
    matches: (name) => name.endsWith('.dmg') && !name.includes('arm64')
  },
  {
    description: 'macOS ZIP',
    matches: (name) => name.endsWith('.zip') && !name.endsWith('-win.zip')
  },
  { description: 'latest-mac.yml', matches: (name) => name === 'latest-mac.yml' },
  {
    description: 'Windows NSIS setup.exe',
    matches: (name) => name.toLowerCase().endsWith('-setup.exe')
  },
  { description: 'Windows ZIP', matches: (name) => name.endsWith('-win.zip') },
  { description: 'latest.yml', matches: (name) => name === 'latest.yml' },
  { description: 'Linux AppImage', matches: (name) => name.endsWith('.AppImage') },
  { description: 'Linux deb', matches: (name) => name.endsWith('.deb') }
]

const velopackAssetRoles = [
  { key: 'setup', required: true },
  { key: 'full', required: true },
  { key: 'delta', required: false },
  { key: 'releasesJson', required: true },
  { key: 'releases', required: true }
]

const releaseMetadataStringFields = ['appVersion', 'tag', 'releaseName', 'draftTag', 'commitSha']

const fullNupkgPattern = /^MemryNote-([^/]+)-full\.nupkg$/

const inactiveTokenPattern =
  /CKR_USER_NOT_LOGGED_IN|CKR_TOKEN_NOT_PRESENT|no token present|CKR_DEVICE_ERROR/i

export function createReleaseState({ draftTag }) {
  requireField(draftTag, 'draftTag')

  return {
    appVersion: null,
    completed: [],
    draftTag,
    runId: null,
    tag: null
  }
}

export function parseReleaseState(raw, { draftTag }) {
  const fresh = createReleaseState({ draftTag })

  if (!isPlainObject(raw) || raw.draftTag !== draftTag) {
    return fresh
  }

  if (!Array.isArray(raw.completed)) {
    return fresh
  }

  if (!raw.completed.every((step) => releaseStepOrder.includes(step))) {
    return fresh
  }

  return {
    appVersion: toStringOrNull(raw.appVersion),
    completed: releaseStepOrder.filter((step) => raw.completed.includes(step)),
    draftTag,
    runId: toStringOrNull(raw.runId),
    tag: toStringOrNull(raw.tag)
  }
}

export function isStepDone(state, step) {
  assertKnownStep(step)

  return state.completed.includes(step)
}

export function markStepDone(state, step, patch = {}) {
  assertKnownStep(step)

  const completed = releaseStepOrder.filter(
    (candidate) => candidate === step || state.completed.includes(candidate)
  )

  return { ...state, ...patch, completed }
}

export function clearStepsFrom(state, step) {
  assertKnownStep(step)

  const cutoff = releaseStepOrder.indexOf(step)

  return {
    ...state,
    completed: state.completed.filter((candidate) => releaseStepOrder.indexOf(candidate) < cutoff)
  }
}

export function decideWorkflowAction({ state, run }) {
  if (!state.runId) {
    return { action: 'dispatch', reason: 'no recorded workflow run' }
  }

  if (!run) {
    return { action: 'dispatch', reason: `workflow run ${state.runId} is gone` }
  }

  if (run.status !== 'completed') {
    return { action: 'watch', reason: `workflow run ${state.runId} is ${run.status}` }
  }

  if (run.conclusion === 'success') {
    return { action: 'reuse', reason: `workflow run ${state.runId} already succeeded` }
  }

  return { action: 'dispatch', reason: `workflow run ${state.runId} concluded ${run.conclusion}` }
}

export function parseReleaseMetadata(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('release-metadata.json is invalid: expected an object')
  }

  const problems = []

  for (const field of releaseMetadataStringFields) {
    const value = raw[field]

    if (isAbsent(value)) {
      problems.push(`missing ${field}`)
      continue
    }

    if (typeof value !== 'string') {
      problems.push(`invalid ${field}`)
    }
  }

  if (isAbsent(raw.releaseId)) {
    problems.push('missing releaseId')
  } else if (!isNumeric(raw.releaseId)) {
    problems.push('invalid releaseId')
  }

  if (problems.length > 0) {
    throw new Error(`release-metadata.json is invalid: ${problems.join(', ')}`)
  }

  return {
    appVersion: raw.appVersion,
    commitSha: raw.commitSha,
    draftTag: raw.draftTag,
    releaseId: String(raw.releaseId).trim(),
    releaseName: raw.releaseName,
    tag: raw.tag
  }
}

export function resolveUnpackedDir(archivePaths, { mainExe = 'Memrynote.exe' } = {}) {
  const target = mainExe.toLowerCase()
  const matches = archivePaths.filter((entry) => basename(entry).toLowerCase() === target)

  if (matches.length === 0) {
    throw new Error(`Archive contains no ${mainExe}`)
  }

  const shallowest = Math.min(...matches.map(entryDepth))
  const dirs = matches.filter((entry) => entryDepth(entry) === shallowest).map(dirname)

  if (dirs.length > 1) {
    const listed = [...dirs].sort().join(', ')
    throw new Error(
      `Archive contains ${dirs.length} ${mainExe} entries at the same depth: ${listed}`
    )
  }

  return dirs[0]
}

export function buildVpkPackArgs({
  packVersion,
  packDir,
  outputDir,
  iconPath,
  mainExe = 'Memrynote.exe',
  packId = 'MemryNote',
  packTitle = 'MemryNote',
  packAuthors = 'memrynote',
  runtime = 'win-x64',
  signTemplate,
  releaseNotesPath,
  skipVeloAppCheck = false
}) {
  requireField(packVersion, 'packVersion')
  requireField(packDir, 'packDir')
  requireField(outputDir, 'outputDir')
  requireField(iconPath, 'iconPath')

  const args = [
    '[win]',
    'pack',
    '--runtime',
    runtime,
    '--packId',
    packId,
    '--packVersion',
    packVersion,
    '--packDir',
    packDir,
    '--mainExe',
    mainExe,
    '--packTitle',
    packTitle,
    '--packAuthors',
    packAuthors,
    '--icon',
    iconPath,
    '--outputDir',
    outputDir,
    '--noPortable',
    '--exclude',
    vpkExcludePattern
  ]

  if (signTemplate) {
    args.push('--signTemplate', signTemplate)
  }

  if (releaseNotesPath) {
    args.push('--releaseNotes', releaseNotesPath)
  }

  if (skipVeloAppCheck) {
    args.push('--skipVeloAppCheck')
  }

  return args
}

const metadataArtifactPrefix = 'release-metadata-'

export function selectRunArtifacts(names) {
  const metadataArtifact = names.find((name) => name.startsWith(metadataArtifactPrefix))

  if (!metadataArtifact) {
    throw new Error(`The workflow run uploaded no ${metadataArtifactPrefix}* artifact`)
  }

  const appVersion = metadataArtifact.slice(metadataArtifactPrefix.length)
  const assetsArtifact = `memry-release-${appVersion}`

  if (!names.includes(assetsArtifact)) {
    throw new Error(`The workflow run uploaded no ${assetsArtifact} artifact`)
  }

  return { appVersion, assetsArtifact, metadataArtifact }
}

export function buildVelopackAssetNames(appVersion) {
  requireField(appVersion, 'appVersion')

  return {
    delta: `MemryNote-${appVersion}-delta.nupkg`,
    full: `MemryNote-${appVersion}-full.nupkg`,
    releases: 'RELEASES',
    releasesJson: 'releases.win.json',
    setup: 'MemryNote-win-Setup.exe'
  }
}

export function collectUploadAssets({ appVersion, ciAssetNames, velopackAssetNames }) {
  const names = buildVelopackAssetNames(appVersion)
  const assets = ciAssetNames.map((name) => ({ name, source: 'ci' }))
  const missing = requiredCiAssets
    .filter((required) => !ciAssetNames.some((name) => required.matches(name)))
    .map((required) => required.description)

  for (const role of velopackAssetRoles) {
    const name = names[role.key]

    if (velopackAssetNames.includes(name)) {
      assets.push({ name, source: 'velopack' })
      continue
    }

    if (role.required) {
      missing.push(name)
    }
  }

  return { assets, missing }
}

export function selectPreviousFullNupkgAsset(assetNames) {
  for (const name of assetNames) {
    const match = fullNupkgPattern.exec(name)

    if (match) {
      return { name, version: match[1] }
    }
  }

  return null
}

export function selectPreviousPublishedRelease(releases, { excludeTag } = {}) {
  const published = releases
    .filter((release) => !release.isDraft && release.tagName !== excludeTag)
    .sort((left, right) => createdAtTime(right) - createdAtTime(left))

  return published[0]?.tagName ?? null
}

// The PIN is deliberately absent: it goes to keytool's stdin so it never reaches the process list.
export function buildKeytoolListArgs({ configPath }) {
  requireField(configPath, 'configPath')

  return [
    '-list',
    '-keystore',
    'NONE',
    '-storetype',
    'PKCS11',
    '-providerClass',
    'sun.security.pkcs11.SunPKCS11',
    '-providerArg',
    configPath
  ]
}

export function decideSigningSession({ status, stdout = '', stderr = '', alias }) {
  requireField(alias, 'alias')

  if (status === 0) {
    if (stdout.toLowerCase().includes(alias.toLowerCase())) {
      return { ready: true, reason: `signing key ${alias} is available` }
    }

    return { ready: false, reason: `SimplySign keystore listed no alias ${alias}` }
  }

  if (inactiveTokenPattern.test(`${stdout}\n${stderr}`)) {
    return { ready: false, reason: 'SimplySign Desktop has no active session' }
  }

  const detail = firstNonEmptyLine(stderr) ?? firstNonEmptyLine(stdout) ?? 'unknown error'

  return { ready: false, reason: `keytool failed: ${detail}` }
}

export function buildOsslsigncodeVerifyArgs({ caFile, filePath }) {
  requireField(caFile, 'caFile')
  requireField(filePath, 'filePath')

  return ['verify', '-CAfile', caFile, '-TSA-CAfile', caFile, filePath]
}

export function isSignatureVerified(stdout) {
  return (stdout ?? '').split('\n').some((line) => line.trim() === 'Signature verification: ok')
}

export function buildSmokeDispatchArgs({ tag, fromVersion, toVersion, updateTag, ref = 'main' }) {
  requireField(tag, 'tag')
  requireField(fromVersion, 'fromVersion')
  requireField(toVersion, 'toVersion')

  const args = [
    'workflow',
    'run',
    'velopack-smoke.yml',
    '--ref',
    ref,
    '-f',
    `release_tag=${tag}`,
    '-f',
    `from_version=${fromVersion}`,
    '-f',
    `to_version=${toVersion}`
  ]

  if (updateTag) {
    args.push('-f', `update_tag=${updateTag}`)
  }

  return args
}

function requireField(value, name) {
  if (!value) {
    throw new Error(`${name} is required`)
  }
}

function assertKnownStep(step) {
  if (!releaseStepOrder.includes(step)) {
    throw new Error(`Unknown release step: ${step}`)
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStringOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  return String(value)
}

function isAbsent(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function isNumeric(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }

  return typeof value === 'string' && Number.isFinite(Number(value.trim()))
}

function basename(entry) {
  return entry.slice(entry.lastIndexOf('/') + 1)
}

function dirname(entry) {
  const index = entry.lastIndexOf('/')

  return index === -1 ? '' : entry.slice(0, index)
}

function entryDepth(entry) {
  return entry.split('/').length - 1
}

function createdAtTime(release) {
  const time = Date.parse(release.createdAt ?? '')

  return Number.isNaN(time) ? Number.MIN_SAFE_INTEGER : time
}

function firstNonEmptyLine(value) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
}
