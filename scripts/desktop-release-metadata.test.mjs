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
      releaseAssetVersion: '2026-04-27',
      releaseDate: '2026.4.27',
      releaseIndex: 1,
      releaseName: 'Memry v2026-04-27',
      releaseTag: 'v2026-04-27'
    })
  })

  it('allocates the second same-day release when the base date tag exists', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.27',
      existingTags: ['v2026-04-27']
    })

    assert.equal(metadata.releaseTag, 'v2026-04-27.2')
    assert.equal(metadata.appVersion, '2026.427.2')
    assert.equal(metadata.releaseIndex, 2)
  })

  it('allocates the next same-day release suffix after prior date releases', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.27',
      existingTags: ['v2026-04-27', 'v2026-04-27.2', 'v2026-04-27.4']
    })

    assert.deepEqual(metadata, {
      appVersion: '2026.427.5',
      displayVersion: 'v2026-04-27.5',
      releaseAssetVersion: '2026-04-27.5',
      releaseDate: '2026.4.27',
      releaseIndex: 5,
      releaseName: 'Memry v2026-04-27.5',
      releaseTag: 'v2026-04-27.5'
    })
  })

  it('reuses a valid release tag already pointing at the current commit', () => {
    const metadata = resolveReleaseMetadata({
      date: '2026.4.28',
      existingTags: ['v2026-04-27', 'v2026-04-27.2'],
      currentTags: ['v2026-04-27.2']
    })

    assert.equal(metadata.releaseTag, 'v2026-04-27.2')
    assert.equal(metadata.appVersion, '2026.427.2')
    assert.equal(metadata.releaseIndex, 2)
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
    assert.deepEqual(resolveReleaseMetadataFromTag('v2026-04-27.2'), {
      appVersion: '2026.427.2',
      displayVersion: 'v2026-04-27.2',
      releaseAssetVersion: '2026-04-27.2',
      releaseDate: '2026.4.27',
      releaseIndex: 2,
      releaseName: 'Memry v2026-04-27.2',
      releaseTag: 'v2026-04-27.2'
    })
  })

  it('parses supported release tag formats', () => {
    assert.deepEqual(parseReleaseTag('v2026-04-27'), {
      date: '2026.4.27',
      displayVersion: 'v2026-04-27',
      index: 1,
      tag: 'v2026-04-27'
    })
    assert.deepEqual(parseReleaseTag('v2026-04-27.2'), {
      date: '2026.4.27',
      displayVersion: 'v2026-04-27.2',
      index: 2,
      tag: 'v2026-04-27.2'
    })
    assert.deepEqual(parseReleaseTag('stable-v2026.4.27'), {
      date: '2026.4.27',
      displayVersion: '2026.4.27',
      index: 1,
      tag: 'stable-v2026.4.27'
    })
  })

  it('keeps legacy release asset versions compatible with legacy tags', () => {
    assert.deepEqual(resolveReleaseMetadataFromTag('stable-v2026.4.27'), {
      appVersion: '2026.427.1',
      displayVersion: '2026.4.27',
      releaseAssetVersion: '2026.4.27',
      releaseDate: '2026.4.27',
      releaseIndex: 1,
      releaseName: 'Memry 2026.4.27',
      releaseTag: 'stable-v2026.4.27'
    })
  })

  it('rejects invalid release dates and tag suffixes', () => {
    assert.throws(() => validateReleaseDate('2026.04.27'), /zero-padded/)
    assert.throws(() => validateReleaseDate('2026.2.31'), /valid/)
    assert.throws(() => parseReleaseTag('v2026.4.27'), /release tag/)
    assert.throws(() => parseReleaseTag('2026-04-27'), /release tag/)
    assert.throws(() => parseReleaseTag('v2026-04-27.1'), /release tag/)
    assert.throws(() => parseReleaseTag('v2026-04-27.02'), /release tag/)
  })

  it('validates semver-safe app versions derived from release metadata', () => {
    assert.equal(validateAppVersion('2026.427.1'), '2026.427.1')
    assert.throws(() => validateAppVersion('2026.4.27'), /app version/)
    assert.throws(() => validateAppVersion('2026.427.0'), /release index/)
  })
})
