// Unit tests for the macOS auto-update manifest validator.
// Dependency-free (node:test + node:assert), matching the validator itself, so
// it runs with `node --test scripts/validate-mac-update-manifest.test.mjs` and
// needs no install. The validator gates the E43 (and every future major) macOS
// release, so a parser/validator regression here would silently strand one arch
// on auto-update — see scripts/validate-mac-update-manifest.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest, validateManifest } from './validate-mac-update-manifest.mjs'

// Real electron-updater sha512 values are base64-encoded SHA-512 (88 chars).
// Two distinct values so the duplicate-arch guard has something to compare.
const SHA_ARM = `${'A'.repeat(86)}==`
const SHA_X64 = `${'B'.repeat(86)}==`

/** Build a merged latest-mac.yml the way electron-updater + the release merge emit it. */
function buildManifest({
  includeVersion = true,
  arm = true,
  x64 = true,
  armSha = SHA_ARM,
  x64Sha = SHA_X64
} = {}) {
  const lines = []
  if (includeVersion) lines.push('version: 2026.717.1')
  lines.push('files:')
  if (arm) {
    lines.push(
      '  - url: MemryNote-2026.717.1-arm64-mac.zip',
      `    sha512: ${armSha}`,
      '    size: 104857600'
    )
  }
  if (x64) {
    lines.push(
      '  - url: MemryNote-2026.717.1-mac.zip',
      `    sha512: ${x64Sha}`,
      '    size: 110100480'
    )
  }
  // Top-level path/sha512/releaseDate follow files[] in the real format — the
  // parser must not fold these into files[].
  lines.push(
    'path: MemryNote-2026.717.1-arm64-mac.zip',
    `sha512: ${armSha}`,
    "releaseDate: '2026-07-17T00:00:00.000Z'"
  )
  return `${lines.join('\n')}\n`
}

test('parseManifest reads version and both arch files without folding top-level keys into files[]', () => {
  const m = parseManifest(buildManifest())
  assert.equal(m.version, '2026.717.1')
  assert.equal(m.files.length, 2, 'top-level path/sha512 must not create phantom file entries')
  assert.ok(m.files.some((f) => f.url.includes('arm64') && f.sha512 === SHA_ARM))
  assert.ok(m.files.some((f) => !f.url.includes('arm64') && f.sha512 === SHA_X64))
})

test('validateManifest accepts a well-formed dual-arch manifest', () => {
  const { errors, armZip, x64Zip } = validateManifest(parseManifest(buildManifest()))
  assert.deepEqual(errors, [])
  assert.ok(armZip && x64Zip)
})

test('validateManifest rejects a missing arm64 zip', () => {
  const { errors } = validateManifest(parseManifest(buildManifest({ arm: false })))
  assert.ok(
    errors.some((e) => /arm64/.test(e)),
    `expected an arm64 error, got: ${errors.join('; ')}`
  )
})

test('validateManifest rejects a missing x64 zip', () => {
  const { errors } = validateManifest(parseManifest(buildManifest({ x64: false })))
  assert.ok(
    errors.some((e) => /x64/.test(e)),
    `expected an x64 error, got: ${errors.join('; ')}`
  )
})

test('validateManifest rejects a malformed sha512', () => {
  const { errors } = validateManifest(parseManifest(buildManifest({ x64Sha: 'too-short' })))
  assert.ok(
    errors.some((e) => /sha512/.test(e)),
    `expected a sha512 error, got: ${errors.join('; ')}`
  )
})

test('validateManifest rejects duplicated arch (identical sha512)', () => {
  const { errors } = validateManifest(parseManifest(buildManifest({ x64Sha: SHA_ARM })))
  assert.ok(
    errors.some((e) => /same sha512|duplicated/.test(e)),
    `expected a duplicate error, got: ${errors.join('; ')}`
  )
})

test('validateManifest rejects a manifest with no version', () => {
  const { errors } = validateManifest(parseManifest(buildManifest({ includeVersion: false })))
  assert.ok(
    errors.some((e) => /version/.test(e)),
    `expected a version error, got: ${errors.join('; ')}`
  )
})
