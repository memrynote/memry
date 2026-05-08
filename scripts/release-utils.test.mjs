import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildDateReleaseVersion, parseReleaseArgs, selectDraftRelease } from './release-utils.mjs'

describe('release helpers', () => {
  it('builds publish-day date tags and semver-safe app versions', () => {
    const result = buildDateReleaseVersion({
      date: new Date('2026-05-08T10:00:00Z'),
      existingTags: [],
      timeZone: 'Europe/Istanbul'
    })

    assert.deepEqual(result, {
      appVersion: '2026.508.1',
      releaseIndex: 1,
      releaseName: 'Memry v2026-05-08',
      tag: 'v2026-05-08'
    })
  })

  it('uses the next same-day suffix when a publish-date tag already exists', () => {
    const result = buildDateReleaseVersion({
      date: new Date('2026-05-08T10:00:00Z'),
      existingTags: ['v2026-05-08', 'v2026-05-08.2', 'v2026-05-07'],
      timeZone: 'Europe/Istanbul'
    })

    assert.deepEqual(result, {
      appVersion: '2026.508.3',
      releaseIndex: 3,
      releaseName: 'Memry v2026-05-08.3',
      tag: 'v2026-05-08.3'
    })
  })

  it('ignores the current draft tag when resolving the final publish tag', () => {
    const result = buildDateReleaseVersion({
      date: new Date('2026-05-08T10:00:00Z'),
      existingTags: ['v2026-05-08'],
      ignoreTag: 'v2026-05-08',
      timeZone: 'Europe/Istanbul'
    })

    assert.equal(result.tag, 'v2026-05-08')
    assert.equal(result.appVersion, '2026.508.1')
  })

  it('selects the newest draft release by default', () => {
    const draft = selectDraftRelease([
      {
        createdAt: '2026-05-07T10:00:00Z',
        isDraft: true,
        tagName: 'old-draft'
      },
      {
        createdAt: '2026-05-08T10:00:00Z',
        isDraft: true,
        tagName: 'vnext'
      },
      {
        createdAt: '2026-05-09T10:00:00Z',
        isDraft: false,
        tagName: 'v2026-05-09'
      }
    ])

    assert.equal(draft.tagName, 'vnext')
  })

  it('requires an explicitly selected tag to be a draft', () => {
    assert.throws(
      () =>
        selectDraftRelease(
          [
            {
              createdAt: '2026-05-08T10:00:00Z',
              isDraft: false,
              tagName: 'v2026-05-08'
            }
          ],
          'v2026-05-08'
        ),
      /not a draft/
    )
  })

  it('parses release launcher flags', () => {
    assert.deepEqual(
      parseReleaseArgs(['--', '--tag', 'vnext', '--dry-run', '--no-watch', '--yes']),
      {
        dryRun: true,
        help: false,
        tag: 'vnext',
        watch: false,
        yes: true
      }
    )
  })
})
