import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseReleaseTag,
  resolveReleaseMetadata,
  resolveReleaseMetadataFromTag,
  validateAppVersion,
  validateReleaseDate
} from './desktop-release-metadata.mjs'

describe('desktop release metadata', () => {
  it('allocates the first release tag and semver-safe app version for a date', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.27',
      existingTags: []
    })

    assert.deepEqual(metadata, {
      appVersion: '2026.427.1',
      releaseDate: '2026.4.27',
      releaseIndex: 1,
      releaseName: 'Memry v2026.4.27',
      releaseTag: 'v2026.4.27'
    })
  })

  it('allocates zero-padded same-day release suffixes after the first release', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.27',
      existingTags: ['v2026.4.27']
    })

    assert.equal(metadata.releaseTag, 'v2026.4.27-002')
    assert.equal(metadata.appVersion, '2026.427.2')
    assert.equal(metadata.releaseIndex, 2)
  })

  it('increments from the highest same-day release tag or draft release', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.27',
      existingTags: ['v2026.4.27', 'v2026.4.27-002', 'v2026.4.26-004', 'not-a-release']
    })

    assert.equal(metadata.releaseTag, 'v2026.4.27-003')
    assert.equal(metadata.appVersion, '2026.427.3')
    assert.equal(metadata.releaseIndex, 3)
  })

  it('derives app metadata from a published release tag', () => {
    assert.deepEqual(resolveReleaseMetadataFromTag('v2026.4.27-002'), {
      appVersion: '2026.427.2',
      releaseDate: '2026.4.27',
      releaseIndex: 2,
      releaseName: 'Memry v2026.4.27-002',
      releaseTag: 'v2026.4.27-002'
    })
  })

  it('parses supported release tag formats', () => {
    assert.deepEqual(parseReleaseTag('v2026.4.27'), {
      date: '2026.4.27',
      index: 1,
      tag: 'v2026.4.27'
    })
    assert.deepEqual(parseReleaseTag('v2026.4.27-002'), {
      date: '2026.4.27',
      index: 2,
      tag: 'v2026.4.27-002'
    })
  })

  it('rejects invalid release dates and tag suffixes', () => {
    assert.throws(() => validateReleaseDate('2026.04.27'), /zero-padded/)
    assert.throws(() => validateReleaseDate('2026.2.31'), /valid/)
    assert.throws(() => parseReleaseTag('v2026.4.27-2'), /release tag/)
    assert.throws(() => parseReleaseTag('2026.4.27'), /release tag/)
  })

  it('validates semver-safe app versions derived from release metadata', () => {
    assert.equal(validateAppVersion('2026.427.1'), '2026.427.1')
    assert.throws(() => validateAppVersion('2026.4.27-002'), /app version/)
    assert.throws(() => validateAppVersion('2026.427.0'), /release index/)
  })
})
