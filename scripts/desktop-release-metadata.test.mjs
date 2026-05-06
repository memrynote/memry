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
      displayVersion: 'v2026-04-27',
      releaseDate: '2026.4.27',
      releaseIndex: 1,
      releaseName: 'Memry v2026-04-27',
      releaseTag: 'v2026-04-27'
    })
  })

  it('keeps the stable date tag stable even when older same-day releases exist', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.27',
      existingTags: ['v2026-04-27']
    })

    assert.equal(metadata.releaseTag, 'v2026-04-27')
    assert.equal(metadata.appVersion, '2026.427.1')
    assert.equal(metadata.releaseIndex, 1)
  })

  it('ignores unrelated tags when resolving date metadata', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.27',
      existingTags: ['stable-v2026.4.26', 'v2026-04-26', 'not-a-release']
    })

    assert.equal(metadata.releaseTag, 'v2026-04-27')
    assert.equal(metadata.appVersion, '2026.427.1')
    assert.equal(metadata.releaseIndex, 1)
  })

  it('derives app metadata from a published release tag', () => {
    assert.deepEqual(resolveReleaseMetadataFromTag('v2026-04-27'), {
      appVersion: '2026.427.1',
      displayVersion: 'v2026-04-27',
      releaseDate: '2026.4.27',
      releaseIndex: 1,
      releaseName: 'Memry v2026-04-27',
      releaseTag: 'v2026-04-27'
    })
  })

  it('parses supported release tag formats', () => {
    assert.deepEqual(parseReleaseTag('v2026-04-27'), {
      date: '2026.4.27',
      displayVersion: 'v2026-04-27',
      index: 1,
      tag: 'v2026-04-27'
    })
    assert.deepEqual(parseReleaseTag('stable-v2026.4.27'), {
      date: '2026.4.27',
      displayVersion: '2026.4.27',
      index: 1,
      tag: 'stable-v2026.4.27'
    })
  })

  it('rejects invalid release dates and tag suffixes', () => {
    assert.throws(() => validateReleaseDate('2026.04.27'), /zero-padded/)
    assert.throws(() => validateReleaseDate('2026.2.31'), /valid/)
    assert.throws(() => parseReleaseTag('v2026.4.27'), /release tag/)
    assert.throws(() => parseReleaseTag('2026-04-27'), /release tag/)
  })

  it('validates semver-safe app versions derived from release metadata', () => {
    assert.equal(validateAppVersion('2026.427.1'), '2026.427.1')
    assert.throws(() => validateAppVersion('2026.4.27'), /app version/)
    assert.throws(() => validateAppVersion('2026.427.0'), /release index/)
  })
})
