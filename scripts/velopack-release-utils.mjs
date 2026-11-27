import { TARGETS } from './release/vpk-args.mjs'

export const releaseStepOrder = [
  'dispatch',
  'build',
  'download',
  'pack-windows',
  'bridge',
  'verify',
  'upload',
  'publish'
]

// Marks a state file written by the Tauri pipeline. A state without it was written by the Electron
// `pnpm release` (steps `sign-nsis` and `pack`, Electron artifacts), which this one cannot resume.
const releasePipeline = 'tauri'

const releaseMetadataStringFields = ['appVersion', 'tag', 'releaseName', 'draftTag', 'commitSha']

const inactiveTokenPattern =
  /CKR_USER_NOT_LOGGED_IN|CKR_TOKEN_NOT_PRESENT|no token present|CKR_DEVICE_ERROR/i

export function createReleaseState({ draftCreatedAt = null, draftTag }) {
  requireField(draftTag, 'draftTag')

  return {
    appVersion: null,
    completed: [],
    draftCreatedAt,
    draftTag,
    pipeline: releasePipeline,
    runId: null,
    tag: null
  }
}

export function parseReleaseState(raw, { draftCreatedAt = null, draftTag }) {
  const fresh = createReleaseState({ draftCreatedAt, draftTag })

  if (!isPlainObject(raw) || raw.draftTag !== draftTag) {
    return fresh
  }

  // Draft tags like `vnext` are reused for every release cycle. When a live
  // draft exists but was created at a different time than the one recorded in
  // the persisted state, the state belongs to a previous (already published)
  // cycle and must not block a same-day follow-up release (v…-…-… .2, .3, …).
  if (draftCreatedAt && toStringOrNull(raw.draftCreatedAt) !== draftCreatedAt) {
    return fresh
  }

  if (!Array.isArray(raw.completed)) {
    return fresh
  }

  if (
    raw.pipeline !== releasePipeline ||
    !raw.completed.every((step) => releaseStepOrder.includes(step))
  ) {
    const dir = `.release-state/${draftTag.replaceAll('/', '-')}`
    throw new Error(
      `${dir}/state.json was written by an older pnpm release (steps: ${raw.completed.join(', ') || 'none'}). ` +
        `Remove ${dir} and rerun pnpm release.`
    )
  }

  return {
    appVersion: toStringOrNull(raw.appVersion),
    completed: releaseStepOrder.filter((step) => raw.completed.includes(step)),
    draftCreatedAt: draftCreatedAt ?? toStringOrNull(raw.draftCreatedAt),
    draftTag,
    pipeline: releasePipeline,
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

// The steps after `download`. A finished pack or bridge is kept on resume; verify, upload and
// publish always run, since they check the staged bytes and the remote draft as they are now.
const finishSteps = ['pack-windows', 'bridge', 'verify', 'upload', 'publish']
const alwaysRun = new Set(['verify', 'upload', 'publish'])

/**
 * What `pnpm release` does after the download step, in order, and the state to continue from. A
 * fresh download replaced the assets, so the packs and the feeds staged into them are redone. A
 * release already published (a run that stopped after the publish call) is only marked done.
 */
export function planFinishSteps(state, { downloaded, published }) {
  const next = markStepDone(downloaded ? clearStepsFrom(state, 'download') : state, 'download')
  if (published) return { state: markStepDone(next, 'publish'), steps: [] }
  return {
    state: next,
    steps: finishSteps.filter((step) => alwaysRun.has(step) || !isStepDone(next, step))
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

  const windowsPayloads = parseWindowsPayloads(raw, problems)

  if (problems.length > 0) {
    throw new Error(`release-metadata.json is invalid: ${problems.join(', ')}`)
  }

  return {
    appVersion: raw.appVersion,
    commitSha: raw.commitSha,
    draftTag: raw.draftTag,
    releaseId: String(raw.releaseId).trim(),
    releaseName: raw.releaseName,
    tag: raw.tag,
    windowsPayloads
  }
}

/**
 * The sha256 `build-windows` recorded for each payload zip it uploaded, by pack target, from
 * `windowsPayloads: [{ name, sha256 }]`. The Mac packs only those bytes.
 */
function parseWindowsPayloads(raw, problems) {
  if (!Array.isArray(raw.windowsPayloads)) {
    problems.push(`${raw.windowsPayloads === undefined ? 'missing' : 'invalid'} windowsPayloads`)
    return {}
  }

  const digests = {}

  // The zip names need the version; a bad appVersion is already reported.
  if (isAbsent(raw.appVersion) || typeof raw.appVersion !== 'string') {
    return digests
  }

  for (const target of windowsTargets()) {
    const name = payloadZipName(target, raw.appVersion)
    const sha256 = raw.windowsPayloads.find((entry) => entry?.name === name)?.sha256

    if (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)) {
      digests[target] = sha256
    } else {
      problems.push(`no sha256 for ${name} in windowsPayloads`)
    }
  }

  return digests
}

/** The name `build-windows` in publish-release.yml zips the unsigned pack dir of `target` under. */
export function payloadZipName(target, version) {
  return `MemryNote-${version}-${target}-payload.zip`
}

const metadataArtifactPrefix = 'release-metadata-'

/**
 * The artifacts of a `publish-release.yml` run that `pnpm release` downloads: the staged macOS and
 * Linux assets, the metadata, the release inputs (`release-notes.md`, `delta.json`) and the
 * unsigned Windows payload zip of each Windows pack target.
 */
export function selectRunArtifacts(names) {
  const metadataArtifact = names.find((name) => name.startsWith(metadataArtifactPrefix))

  if (!metadataArtifact) {
    throw new Error(`The workflow run uploaded no ${metadataArtifactPrefix}* artifact`)
  }

  const appVersion = metadataArtifact.slice(metadataArtifactPrefix.length)
  const assetsArtifact = `memry-release-${appVersion}`
  const inputsArtifact = `release-inputs-${appVersion}`
  const payloadArtifacts = Object.fromEntries(
    windowsTargets().map((target) => [target, `memry-windows-payload-${target}-${appVersion}`])
  )

  for (const name of [assetsArtifact, inputsArtifact, ...Object.values(payloadArtifacts)]) {
    if (!names.includes(name)) {
      throw new Error(`The workflow run uploaded no ${name} artifact`)
    }
  }

  return { appVersion, assetsArtifact, inputsArtifact, metadataArtifact, payloadArtifacts }
}

/** The Windows pack targets, which the Mac packs and signs. */
export function windowsTargets() {
  return Object.keys(TARGETS).filter((target) => TARGETS[target].os === 'win')
}

/**
 * The full nupkg of `target`'s channel among a release's assets, and its version. Each channel
 * has its own: `MemryNote-<V>-full.nupkg` for `win` (x64), `MemryNote-<V>-<channel>-full.nupkg`
 * for the others. Versions (`YYYY.MDD.n`) hold no dash.
 */
export function selectPreviousFullNupkgAsset(assetNames, target) {
  const { channel } = TARGETS[target] ?? {}

  if (!channel) {
    throw new Error(`Unknown pack target "${target}"`)
  }

  const suffix = channel === 'win' ? '' : `-${channel}`
  const pattern = new RegExp(`^MemryNote-([^-/]+)${suffix}-full\\.nupkg$`)

  for (const name of assetNames) {
    const match = pattern.exec(name)

    if (match) {
      return { name, version: match[1] }
    }
  }

  return null
}

// Prereleases such as `ort-pod-*` hold CI build inputs, not app releases, and carry no nupkg.
export function selectPreviousPublishedRelease(releases, { excludeTag } = {}) {
  const published = releases
    .filter(
      (release) => !release.isDraft && !release.isPrerelease && release.tagName !== excludeTag
    )
    .toSorted((left, right) => createdAtTime(right) - createdAtTime(left))

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
