import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseReleaseTag,
  resolveDraftReleaseMetadata,
  resolveReleaseMetadataFromTag,
  validateAppVersion
} from './desktop-release-metadata.mjs'

describe('desktop release metadata', () => {
  it('allocates the first date draft tag for a day', () => {
    assert.deepEqual(
      resolveDraftReleaseMetadata({
        date: '2026-06-07',
        existingTags: []
      }),
      {
        appVersion: '2026.607.1',
        displayVersion: 'v2026-06-07',
        releaseAssetVersion: '2026-06-07',
        releaseDate: '2026.6.7',
        releaseIndex: 1,
        releaseName: 'Memry v2026-06-07',
        releaseTag: 'v2026-06-07'
      }
    )
  })

  it('allocates a same-day suffix when the base date tag already exists', () => {
    const metadata = resolveDraftReleaseMetadata({
      date: '2026-06-07',
      existingTags: ['v2026-06-07']
    })

    assert.equal(metadata.releaseTag, 'v2026-06-07.2')
    assert.equal(metadata.appVersion, '2026.607.2')
    assert.equal(metadata.releaseIndex, 2)
  })

  it('reuses an existing draft tag so the draft date stays stable', () => {
    const metadata = resolveDraftReleaseMetadata({
      date: '2026-06-08',
      draftTags: ['v2026-06-07'],
      existingTags: ['v2026-06-07']
    })

    assert.equal(metadata.releaseTag, 'v2026-06-07')
    assert.equal(metadata.appVersion, '2026.607.1')
  })

  it('derives desktop app metadata from a date tag', () => {
    assert.deepEqual(resolveReleaseMetadataFromTag('v2026-06-07.3'), {
      appVersion: '2026.607.3',
      displayVersion: 'v2026-06-07.3',
      releaseAssetVersion: '2026-06-07.3',
      releaseDate: '2026.6.7',
      releaseIndex: 3,
      releaseName: 'Memry v2026-06-07.3',
      releaseTag: 'v2026-06-07.3'
    })
  })

  it('rejects invalid release tags and app versions', () => {
    assert.throws(() => parseReleaseTag('v1.2.3'), /release tag/)
    assert.throws(() => parseReleaseTag('v2026.06.07'), /release tag/)
    assert.throws(() => parseReleaseTag('v2026-06-07.1'), /release tag/)
    assert.throws(() => parseReleaseTag('v2026-06-07.02'), /release tag/)
    assert.throws(() => validateAppVersion('2026.6.7'), /app version/)
    assert.throws(() => validateAppVersion('2026.607.0'), /release index/)
  })
})
