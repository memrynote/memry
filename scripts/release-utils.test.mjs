import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildDateReleaseVersion,
  buildHumanizeReleaseArgs,
  extractWorkflowRunId,
  getReleaseListFields,
  parseReleaseArgs,
  rewriteWindowsUpdateManifest,
  selectDispatchedWorkflowRun,
  selectDraftRelease
} from './release-utils.mjs'

// Shape of a real Windows latest.yml, taken from the v2026-09-14 release.
const WINDOWS_MANIFEST = [
  'version: 2026.914.1',
  'files:',
  '  - url: MemryNote-2026.914.1-setup.exe',
  '    sha512: biC2Ypa+4Vk1MbAQKrCSgS0COwGf9NCY8cFAngl7T4ZP9R6BQtaHQTc3Nxr3lMrOJdzlgjsoGZURVh45ax2guQ==',
  '    size: 335425051',
  'path: MemryNote-2026.914.1-setup.exe',
  'sha512: biC2Ypa+4Vk1MbAQKrCSgS0COwGf9NCY8cFAngl7T4ZP9R6BQtaHQTc3Nxr3lMrOJdzlgjsoGZURVh45ax2guQ==',
  "releaseDate: '2026-09-14T17:16:07.931Z'",
  ''
].join('\n')

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
      parseReleaseArgs(['--', '--tag', 'vnext', '--dry-run', '--humanize', '--no-watch', '--yes']),
      {
        dryRun: true,
        help: false,
        humanize: true,
        restart: false,
        smoke: false,
        tag: 'vnext',
        watch: false,
        yes: true
      }
    )
  })

  it('parses the local pipeline flags', () => {
    assert.deepEqual(parseReleaseArgs(['--restart', '--smoke']), {
      dryRun: false,
      help: false,
      humanize: false,
      restart: true,
      smoke: true,
      tag: undefined,
      watch: true,
      yes: false
    })
  })

  it('builds humanizer args from release flags', () => {
    assert.deepEqual(buildHumanizeReleaseArgs({ dryRun: false, tag: 'vnext', yes: true }), [
      'scripts/humanize-release-notes.mjs',
      '--tag',
      'vnext',
      '--yes'
    ])

    assert.deepEqual(buildHumanizeReleaseArgs({ dryRun: true, tag: 'vnext', yes: false }), [
      'scripts/humanize-release-notes.mjs',
      '--tag',
      'vnext',
      '--dry-run'
    ])
  })

  it('uses only gh release list fields supported by GitHub CLI', () => {
    assert.deepEqual(getReleaseListFields(), ['tagName', 'name', 'isDraft', 'createdAt'])
  })

  it('extracts the created workflow run id from gh workflow run output', () => {
    const output = [
      '✓ Created workflow_dispatch event for publish-release.yml at main',
      'https://github.com/memrynote/memry/actions/runs/25571212462',
      '',
      'To see the created workflow run, try: gh run view 25571212462'
    ].join('\n')

    assert.equal(extractWorkflowRunId(output), '25571212462')
  })

  it('selects only workflow runs created after dispatch started', () => {
    const run = selectDispatchedWorkflowRun(
      [
        {
          createdAt: '2026-05-08T17:50:00Z',
          databaseId: 25570944125,
          event: 'workflow_dispatch',
          url: 'https://github.com/memrynote/memry/actions/runs/25570944125'
        },
        {
          createdAt: '2026-05-08T17:55:10Z',
          databaseId: 25571212462,
          event: 'workflow_dispatch',
          url: 'https://github.com/memrynote/memry/actions/runs/25571212462'
        }
      ],
      new Date('2026-05-08T17:55:00Z')
    )

    assert.equal(run.databaseId, 25571212462)
  })
})

describe('rewriteWindowsUpdateManifest', () => {
  it('repoints both digests and the size at the signed installer', () => {
    const result = rewriteWindowsUpdateManifest(WINDOWS_MANIFEST, {
      sha512: 'NEWDIGEST==',
      size: 335430000
    })

    assert.equal(result.match(/sha512: NEWDIGEST==/g)?.length, 2)
    assert.match(result, /^ {4}size: 335430000$/m)
    assert.doesNotMatch(result, /biC2Ypa/)
  })

  it('leaves every other line alone', () => {
    const result = rewriteWindowsUpdateManifest(WINDOWS_MANIFEST, {
      sha512: 'NEWDIGEST==',
      size: 1
    })

    assert.match(result, /^version: 2026\.914\.1$/m)
    assert.match(result, /^ {2}- url: MemryNote-2026\.914\.1-setup\.exe$/m)
    assert.match(result, /^path: MemryNote-2026\.914\.1-setup\.exe$/m)
    assert.match(result, /^releaseDate: '2026-09-14T17:16:07\.931Z'$/m)
  })

  // A second file entry would mean the digest below it is no longer the installer's,
  // and a blind rewrite would point every install at the wrong bytes.
  it('refuses a manifest describing more than one file', () => {
    const twoFiles = WINDOWS_MANIFEST.replace(
      '  - url: MemryNote-2026.914.1-setup.exe',
      ['  - url: MemryNote-2026.914.1-setup.exe', '  - url: MemryNote-2026.914.1-win.zip'].join(
        '\n'
      )
    )

    assert.throws(
      () => rewriteWindowsUpdateManifest(twoFiles, { sha512: 'x', size: 1 }),
      /exactly one Windows file, found 2/
    )
  })

  it('refuses a manifest whose digest count changed', () => {
    const extraDigest = `${WINDOWS_MANIFEST}sha512: another==\n`

    assert.throws(
      () => rewriteWindowsUpdateManifest(extraDigest, { sha512: 'x', size: 1 }),
      /two sha512 lines and one size line, found 3 and 1/
    )
  })
})
