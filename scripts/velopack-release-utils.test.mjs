import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildKeytoolListArgs,
  buildOsslsigncodeVerifyArgs,
  buildSmokeDispatchArgs,
  buildVelopackAssetNames,
  buildVpkPackArgs,
  clearStepsFrom,
  collectUploadAssets,
  createReleaseState,
  decideSigningSession,
  decideWorkflowAction,
  isSignatureVerified,
  isStepDone,
  markStepDone,
  parseReleaseMetadata,
  parseReleaseState,
  releaseStepOrder,
  resolveUnpackedDir,
  selectRunArtifacts,
  selectPreviousFullNupkgAsset,
  selectPreviousPublishedRelease
} from './velopack-release-utils.mjs'

const ciAssetNames = [
  'Memry-2026.508.1-arm64.dmg',
  'Memry-2026.508.1-arm64.dmg.blockmap',
  'Memry-2026.508.1.dmg',
  'Memry-2026.508.1-mac.zip',
  'latest-mac.yml',
  'Memry-2026.508.1-setup.exe',
  'Memry-2026.508.1-win.zip',
  'latest.yml',
  'Memry-2026.508.1.AppImage',
  'Memry-2026.508.1.deb'
]

const velopackAssetNames = [
  'MemryNote-win-Setup.exe',
  'MemryNote-2026.508.1-full.nupkg',
  'MemryNote-2026.508.1-delta.nupkg',
  'releases.win.json',
  'RELEASES',
  'assets.win.json'
]

const packOptions = {
  iconPath: 'build/icon.ico',
  outputDir: 'dist/velopack',
  packDir: 'dist/win-unpacked',
  packVersion: '2026.508.1'
}

const baseVpkArgs = [
  '[win]',
  'pack',
  '--runtime',
  'win-x64',
  '--packId',
  'MemryNote',
  '--packVersion',
  '2026.508.1',
  '--packDir',
  'dist/win-unpacked',
  '--mainExe',
  'Memrynote.exe',
  '--packTitle',
  'MemryNote',
  '--packAuthors',
  'memrynote',
  '--icon',
  'build/icon.ico',
  '--outputDir',
  'dist/velopack',
  '--noPortable',
  '--exclude',
  String.raw`(\.pdb$)|(prebuilds[\\/](?!win32-x64[\\/]))`
]

describe('release state', () => {
  it('lists the pipeline steps in execution order', () => {
    assert.deepEqual(releaseStepOrder, [
      'dispatch',
      'build',
      'download',
      'pack',
      'verify',
      'upload',
      'publish'
    ])
  })

  it('creates an empty state for a draft tag', () => {
    assert.deepEqual(createReleaseState({ draftTag: 'vnext' }), {
      appVersion: null,
      completed: [],
      draftTag: 'vnext',
      runId: null,
      tag: null
    })
  })

  it('requires a draft tag', () => {
    assert.throws(() => createReleaseState({}), /draftTag is required/)
    assert.throws(() => createReleaseState({ draftTag: '' }), /draftTag is required/)
  })

  it('normalizes a resumable state and coerces ids to strings', () => {
    const state = parseReleaseState(
      {
        appVersion: '2026.508.1',
        completed: ['build', 'dispatch', 'build'],
        draftTag: 'vnext',
        runId: 25571212462,
        tag: null
      },
      { draftTag: 'vnext' }
    )

    assert.deepEqual(state, {
      appVersion: '2026.508.1',
      completed: ['dispatch', 'build'],
      draftTag: 'vnext',
      runId: '25571212462',
      tag: null
    })
  })

  it('starts over when the persisted state belongs to another draft tag', () => {
    const state = parseReleaseState(
      {
        appVersion: '2026.507.1',
        completed: ['dispatch', 'build'],
        draftTag: 'vprevious',
        runId: '1',
        tag: 'v2026-05-07'
      },
      { draftTag: 'vnext' }
    )

    assert.deepEqual(state, createReleaseState({ draftTag: 'vnext' }))
  })

  it('starts over when completed is corrupt or absent', () => {
    const fresh = createReleaseState({ draftTag: 'vnext' })

    assert.deepEqual(
      parseReleaseState({ completed: 'dispatch', draftTag: 'vnext' }, { draftTag: 'vnext' }),
      fresh
    )
    assert.deepEqual(
      parseReleaseState(
        { completed: ['dispatch', 'teleport'], draftTag: 'vnext' },
        { draftTag: 'vnext' }
      ),
      fresh
    )
    assert.deepEqual(parseReleaseState({ draftTag: 'vnext' }, { draftTag: 'vnext' }), fresh)
    assert.deepEqual(parseReleaseState(null, { draftTag: 'vnext' }), fresh)
    assert.deepEqual(parseReleaseState(['dispatch'], { draftTag: 'vnext' }), fresh)
    assert.deepEqual(parseReleaseState('vnext', { draftTag: 'vnext' }), fresh)
  })

  it('reports completed steps', () => {
    const state = { ...createReleaseState({ draftTag: 'vnext' }), completed: ['dispatch'] }

    assert.equal(isStepDone(state, 'dispatch'), true)
    assert.equal(isStepDone(state, 'pack'), false)
    assert.throws(() => isStepDone(state, 'teleport'), /Unknown release step: teleport/)
  })

  it('marks a step done without mutating the input state', () => {
    const state = { ...createReleaseState({ draftTag: 'vnext' }), completed: ['build'] }
    const next = markStepDone(state, 'dispatch', { runId: '25571212462' })

    assert.deepEqual(next, {
      appVersion: null,
      completed: ['dispatch', 'build'],
      draftTag: 'vnext',
      runId: '25571212462',
      tag: null
    })
    assert.deepEqual(state.completed, ['build'])
    assert.equal(state.runId, null)
    assert.notEqual(next, state)
    assert.notEqual(next.completed, state.completed)
  })

  it('never records the same step twice', () => {
    const state = { ...createReleaseState({ draftTag: 'vnext' }), completed: ['dispatch'] }

    assert.deepEqual(markStepDone(state, 'dispatch').completed, ['dispatch'])
  })

  it('rejects an unknown step', () => {
    const state = createReleaseState({ draftTag: 'vnext' })

    assert.throws(() => markStepDone(state, 'teleport'), /Unknown release step/)
    assert.throws(() => clearStepsFrom(state, 'teleport'), /Unknown release step/)
  })

  it('clears the given step and everything downstream of it', () => {
    const state = {
      ...createReleaseState({ draftTag: 'vnext' }),
      completed: ['dispatch', 'build', 'download', 'pack', 'upload']
    }
    const next = clearStepsFrom(state, 'download')

    assert.deepEqual(next.completed, ['dispatch', 'build'])
    assert.deepEqual(state.completed, ['dispatch', 'build', 'download', 'pack', 'upload'])
    assert.deepEqual(clearStepsFrom(state, 'dispatch').completed, [])
  })
})

describe('workflow run resume', () => {
  it('dispatches when no run was recorded', () => {
    assert.deepEqual(
      decideWorkflowAction({ run: null, state: createReleaseState({ draftTag: 'vnext' }) }),
      { action: 'dispatch', reason: 'no recorded workflow run' }
    )
  })

  it('dispatches when the recorded run no longer exists', () => {
    assert.deepEqual(decideWorkflowAction({ run: null, state: { runId: '42' } }), {
      action: 'dispatch',
      reason: 'workflow run 42 is gone'
    })
  })

  it('watches a run that is still going', () => {
    assert.deepEqual(
      decideWorkflowAction({
        run: { conclusion: null, databaseId: 42, status: 'in_progress' },
        state: { runId: '42' }
      }),
      { action: 'watch', reason: 'workflow run 42 is in_progress' }
    )
  })

  it('reuses a run that already succeeded', () => {
    assert.deepEqual(
      decideWorkflowAction({
        run: { conclusion: 'success', databaseId: 42, status: 'completed' },
        state: { runId: '42' }
      }),
      { action: 'reuse', reason: 'workflow run 42 already succeeded' }
    )
  })

  it('dispatches again after a failed run', () => {
    assert.deepEqual(
      decideWorkflowAction({
        run: { conclusion: 'failure', databaseId: 42, status: 'completed' },
        state: { runId: '42' }
      }),
      { action: 'dispatch', reason: 'workflow run 42 concluded failure' }
    )
  })
})

describe('release metadata', () => {
  it('parses CI release metadata and normalizes the release id', () => {
    assert.deepEqual(
      parseReleaseMetadata({
        appVersion: '2026.508.1',
        commitSha: '61103d9739b1c0a3f1b4b2e7f0c9a1d2e3f4a5b6',
        draftTag: 'vnext',
        releaseId: 233871199,
        releaseName: 'Memry v2026-05-08',
        tag: 'v2026-05-08'
      }),
      {
        appVersion: '2026.508.1',
        commitSha: '61103d9739b1c0a3f1b4b2e7f0c9a1d2e3f4a5b6',
        draftTag: 'vnext',
        releaseId: '233871199',
        releaseName: 'Memry v2026-05-08',
        tag: 'v2026-05-08'
      }
    )
  })

  it('accepts a numeric string release id', () => {
    const metadata = parseReleaseMetadata({
      appVersion: '2026.508.1',
      commitSha: 'abc1234',
      draftTag: 'vnext',
      releaseId: '233871199',
      releaseName: 'Memry v2026-05-08',
      tag: 'v2026-05-08'
    })

    assert.equal(metadata.releaseId, '233871199')
  })

  it('names every missing or invalid field in one error', () => {
    assert.throws(
      () =>
        parseReleaseMetadata({
          appVersion: '  ',
          draftTag: 'vnext',
          releaseId: 'not-a-number',
          releaseName: 'Memry v2026-05-08',
          tag: 'v2026-05-08'
        }),
      (error) => {
        assert.equal(
          error.message,
          'release-metadata.json is invalid: missing appVersion, missing commitSha, invalid releaseId'
        )
        return true
      }
    )
  })

  it('reports the two-field case in the documented wording', () => {
    assert.throws(
      () =>
        parseReleaseMetadata({
          draftTag: 'vnext',
          releaseId: 1,
          releaseName: 'Memry v2026-05-08',
          tag: 'v2026-05-08'
        }),
      /^Error: release-metadata\.json is invalid: missing appVersion, missing commitSha$/
    )
  })

  it('rejects anything that is not an object', () => {
    assert.throws(() => parseReleaseMetadata(null), /invalid: expected an object/)
    assert.throws(() => parseReleaseMetadata('{}'), /invalid: expected an object/)
    assert.throws(() => parseReleaseMetadata([]), /invalid: expected an object/)
  })
})

describe('archive layout', () => {
  it('returns an empty dir when the exe sits at the archive root', () => {
    assert.equal(resolveUnpackedDir(['Memrynote.exe', 'resources/app.asar']), '')
  })

  it('returns the single nested dir that holds the exe', () => {
    assert.equal(
      resolveUnpackedDir([
        'memry-win32-x64/',
        'memry-win32-x64/Memrynote.exe',
        'memry-win32-x64/resources/app.asar'
      ]),
      'memry-win32-x64'
    )
  })

  it('prefers the shallowest exe over deeper copies', () => {
    assert.equal(resolveUnpackedDir(['top/Memrynote.exe', 'top/deep/nested/Memrynote.exe']), 'top')
  })

  it('refuses to guess between two exes at the same depth', () => {
    assert.throws(
      () => resolveUnpackedDir(['beta/Memrynote.exe', 'alpha/Memrynote.exe']),
      /Archive contains 2 Memrynote\.exe entries at the same depth: alpha, beta/
    )
  })

  it('fails when the archive holds no exe', () => {
    assert.throws(
      () => resolveUnpackedDir(['resources/app.asar']),
      /Archive contains no Memrynote\.exe/
    )
  })

  it('matches the exe name case-insensitively and honours an override', () => {
    assert.equal(resolveUnpackedDir(['app/memrynote.EXE']), 'app')
    assert.equal(resolveUnpackedDir(['app/Other.exe'], { mainExe: 'Other.exe' }), 'app')
  })
})

describe('vpk pack arguments', () => {
  it('builds the baseline argv without optional flags', () => {
    assert.deepEqual(buildVpkPackArgs(packOptions), baseVpkArgs)
  })

  it('appends the signing template, release notes and app check skip in order', () => {
    assert.deepEqual(
      buildVpkPackArgs({
        ...packOptions,
        releaseNotesPath: 'dist/notes.md',
        signTemplate: 'osslsigncode sign -pkcs11module x {{file}}',
        skipVeloAppCheck: true
      }),
      [
        ...baseVpkArgs,
        '--signTemplate',
        'osslsigncode sign -pkcs11module x {{file}}',
        '--releaseNotes',
        'dist/notes.md',
        '--skipVeloAppCheck'
      ]
    )
  })

  it('keeps the exclude regex byte for byte', () => {
    const args = buildVpkPackArgs(packOptions)

    assert.equal(
      args[args.indexOf('--exclude') + 1],
      String.raw`(\.pdb$)|(prebuilds[\\/](?!win32-x64[\\/]))`
    )
  })

  it('honours pack identity overrides', () => {
    const args = buildVpkPackArgs({
      ...packOptions,
      mainExe: 'Other.exe',
      packAuthors: 'someone',
      packId: 'Other',
      packTitle: 'Other Title',
      runtime: 'win-arm64'
    })

    assert.equal(args[args.indexOf('--runtime') + 1], 'win-arm64')
    assert.equal(args[args.indexOf('--packId') + 1], 'Other')
    assert.equal(args[args.indexOf('--mainExe') + 1], 'Other.exe')
    assert.equal(args[args.indexOf('--packTitle') + 1], 'Other Title')
    assert.equal(args[args.indexOf('--packAuthors') + 1], 'someone')
  })

  it('names the missing required field', () => {
    assert.throws(
      () => buildVpkPackArgs({ ...packOptions, packVersion: '' }),
      /packVersion is required/
    )
    assert.throws(
      () => buildVpkPackArgs({ ...packOptions, packDir: undefined }),
      /packDir is required/
    )
    assert.throws(
      () => buildVpkPackArgs({ ...packOptions, outputDir: '' }),
      /outputDir is required/
    )
    assert.throws(
      () => buildVpkPackArgs({ ...packOptions, iconPath: undefined }),
      /iconPath is required/
    )
  })
})

describe('upload assets', () => {
  it('names the Velopack outputs for an app version', () => {
    assert.deepEqual(buildVelopackAssetNames('2026.508.1'), {
      delta: 'MemryNote-2026.508.1-delta.nupkg',
      full: 'MemryNote-2026.508.1-full.nupkg',
      releases: 'RELEASES',
      releasesJson: 'releases.win.json',
      setup: 'MemryNote-win-Setup.exe'
    })
    assert.throws(() => buildVelopackAssetNames(''), /appVersion is required/)
  })

  it('collects a complete set with nothing missing', () => {
    const { assets, missing } = collectUploadAssets({
      appVersion: '2026.508.1',
      ciAssetNames,
      velopackAssetNames
    })

    assert.deepEqual(missing, [])
    assert.deepEqual(
      assets.map((asset) => asset.name),
      [...ciAssetNames, ...velopackAssetNames.filter((name) => name !== 'assets.win.json')]
    )
    assert.deepEqual(
      assets.slice(0, ciAssetNames.length).map((asset) => asset.source),
      ciAssetNames.map(() => 'ci')
    )
    assert.deepEqual(
      assets.slice(ciAssetNames.length).map((asset) => asset.source),
      ['velopack', 'velopack', 'velopack', 'velopack', 'velopack']
    )
  })

  it('never uploads the local assets.win.json manifest', () => {
    const { assets } = collectUploadAssets({
      appVersion: '2026.508.1',
      ciAssetNames,
      velopackAssetNames
    })

    assert.equal(
      assets.some((asset) => asset.name === 'assets.win.json'),
      false
    )
  })

  it('describes the CI assets that never arrived', () => {
    const { missing } = collectUploadAssets({
      appVersion: '2026.508.1',
      ciAssetNames: ciAssetNames.filter(
        (name) => name !== 'Memry-2026.508.1-win.zip' && name !== 'latest-mac.yml'
      ),
      velopackAssetNames
    })

    assert.deepEqual(missing, ['latest-mac.yml', 'Windows ZIP'])
  })

  it('carries the delta package when it exists and never demands it', () => {
    const withDelta = collectUploadAssets({
      appVersion: '2026.508.1',
      ciAssetNames,
      velopackAssetNames
    })
    const withoutDelta = collectUploadAssets({
      appVersion: '2026.508.1',
      ciAssetNames,
      velopackAssetNames: velopackAssetNames.filter(
        (name) => name !== 'MemryNote-2026.508.1-delta.nupkg'
      )
    })

    assert.equal(
      withDelta.assets.some((asset) => asset.name === 'MemryNote-2026.508.1-delta.nupkg'),
      true
    )
    assert.equal(
      withoutDelta.assets.some((asset) => asset.name === 'MemryNote-2026.508.1-delta.nupkg'),
      false
    )
    assert.deepEqual(withoutDelta.missing, [])
  })

  it('reports absent required Velopack outputs by file name', () => {
    const { missing } = collectUploadAssets({
      appVersion: '2026.508.1',
      ciAssetNames,
      velopackAssetNames: ['MemryNote-win-Setup.exe', 'releases.win.json']
    })

    assert.deepEqual(missing, ['MemryNote-2026.508.1-full.nupkg', 'RELEASES'])
  })

  it('ignores unknown files sitting in the Velopack output dir', () => {
    const { assets, missing } = collectUploadAssets({
      appVersion: '2026.508.1',
      ciAssetNames,
      velopackAssetNames: [...velopackAssetNames, 'Setup.log', 'MemryNote-2026.507.1-full.nupkg']
    })

    assert.deepEqual(missing, [])
    assert.equal(
      assets.some((asset) => asset.name === 'Setup.log'),
      false
    )
  })
})

describe('previous release lookup', () => {
  it('finds the previous full nupkg and its version', () => {
    assert.deepEqual(
      selectPreviousFullNupkgAsset([
        'RELEASES',
        'MemryNote-2026.507.1-full.nupkg',
        'MemryNote-2026.507.1-delta.nupkg'
      ]),
      { name: 'MemryNote-2026.507.1-full.nupkg', version: '2026.507.1' }
    )
  })

  it('returns null when no full nupkg is present', () => {
    assert.equal(
      selectPreviousFullNupkgAsset(['RELEASES', 'MemryNote-2026.507.1-delta.nupkg']),
      null
    )
  })

  it('picks the newest published release, skipping drafts and the excluded tag', () => {
    const releases = [
      { createdAt: '2026-05-06T10:00:00Z', isDraft: false, tagName: 'v2026-05-06' },
      { createdAt: '2026-05-07T10:00:00Z', isDraft: false, tagName: 'v2026-05-07' },
      { createdAt: '2026-05-08T10:00:00Z', isDraft: false, tagName: 'v2026-05-08' },
      { createdAt: '2026-05-09T10:00:00Z', isDraft: true, tagName: 'vnext' }
    ]

    assert.equal(selectPreviousPublishedRelease(releases), 'v2026-05-08')
    assert.equal(
      selectPreviousPublishedRelease(releases, { excludeTag: 'v2026-05-08' }),
      'v2026-05-07'
    )
  })

  it('sorts releases without a creation date last', () => {
    assert.equal(
      selectPreviousPublishedRelease([
        { isDraft: false, tagName: 'v-undated' },
        { createdAt: '2026-05-07T10:00:00Z', isDraft: false, tagName: 'v2026-05-07' }
      ]),
      'v2026-05-07'
    )
  })

  it('returns null when only drafts exist', () => {
    assert.equal(
      selectPreviousPublishedRelease([
        { createdAt: '2026-05-09T10:00:00Z', isDraft: true, tagName: 'vnext' }
      ]),
      null
    )
  })
})

describe('signing gate', () => {
  it('builds the keytool listing args', () => {
    assert.deepEqual(buildKeytoolListArgs({ configPath: '/tmp/pkcs11.cfg' }), [
      '-list',
      '-keystore',
      'NONE',
      '-storetype',
      'PKCS11',
      '-providerClass',
      'sun.security.pkcs11.SunPKCS11',
      '-providerArg',
      '/tmp/pkcs11.cfg'
    ])
    assert.throws(() => buildKeytoolListArgs({}), /configPath is required/)
  })

  it('is ready when keytool lists the alias', () => {
    assert.deepEqual(
      decideSigningSession({
        alias: 'Certum',
        status: 0,
        stdout: 'Keystore type: PKCS11\nAlias name: CERTUM code signing\n'
      }),
      { ready: true, reason: 'signing key Certum is available' }
    )
  })

  it('is not ready when keytool succeeds without the alias', () => {
    assert.deepEqual(
      decideSigningSession({
        alias: 'Certum',
        status: 0,
        stdout: 'Your keystore contains 0 entries'
      }),
      { ready: false, reason: 'SimplySign keystore listed no alias Certum' }
    )
  })

  it('recognizes an inactive SimplySign session from either stream', () => {
    assert.deepEqual(
      decideSigningSession({
        alias: 'Certum',
        status: 1,
        stderr: 'java.security.ProviderException: CKR_USER_NOT_LOGGED_IN'
      }),
      { ready: false, reason: 'SimplySign Desktop has no active session' }
    )
    assert.deepEqual(
      decideSigningSession({ alias: 'Certum', status: 1, stdout: 'no token present' }),
      { ready: false, reason: 'SimplySign Desktop has no active session' }
    )
  })

  it('surfaces the first useful keytool error line', () => {
    assert.deepEqual(
      decideSigningSession({
        alias: 'Certum',
        status: 1,
        stderr: '\n\nkeytool error: java.io.IOException: bad config\n  at sun.security'
      }),
      { ready: false, reason: 'keytool failed: keytool error: java.io.IOException: bad config' }
    )
  })

  it('falls back to stdout, then to a placeholder, when stderr is empty', () => {
    assert.deepEqual(
      decideSigningSession({ alias: 'Certum', status: 1, stdout: 'something went wrong' }),
      { ready: false, reason: 'keytool failed: something went wrong' }
    )
    assert.deepEqual(decideSigningSession({ alias: 'Certum', status: 2 }), {
      ready: false,
      reason: 'keytool failed: unknown error'
    })
  })

  it('requires an alias', () => {
    assert.throws(() => decideSigningSession({ status: 0, stdout: '' }), /alias is required/)
  })
})

describe('signature verification', () => {
  it('builds the osslsigncode verify args', () => {
    assert.deepEqual(
      buildOsslsigncodeVerifyArgs({ caFile: '/tmp/ca.pem', filePath: 'dist/Setup.exe' }),
      ['verify', '-CAfile', '/tmp/ca.pem', '-TSA-CAfile', '/tmp/ca.pem', 'dist/Setup.exe']
    )
    assert.throws(
      () => buildOsslsigncodeVerifyArgs({ filePath: 'dist/Setup.exe' }),
      /caFile is required/
    )
    assert.throws(
      () => buildOsslsigncodeVerifyArgs({ caFile: '/tmp/ca.pem' }),
      /filePath is required/
    )
  })

  it('accepts the verification line on its own line', () => {
    assert.equal(
      isSignatureVerified('Number of verified signatures: 1\nSignature verification: ok\n'),
      true
    )
    assert.equal(isSignatureVerified('  Signature verification: ok  \r'), true)
  })

  it('rejects a failed or absent verification', () => {
    assert.equal(isSignatureVerified('Signature verification: failed'), false)
    assert.equal(isSignatureVerified(''), false)
    assert.equal(isSignatureVerified(undefined), false)
  })

  it('rejects the phrase embedded in a longer line', () => {
    assert.equal(isSignatureVerified('we wanted Signature verification: ok but got nothing'), false)
    assert.equal(isSignatureVerified('Signature verification: ok (untrusted chain)'), false)
  })
})

describe('smoke dispatch', () => {
  it('builds the smoke workflow dispatch args', () => {
    assert.deepEqual(
      buildSmokeDispatchArgs({
        fromVersion: '2026.507.1',
        tag: 'v2026-05-08',
        toVersion: '2026.508.1'
      }),
      [
        'workflow',
        'run',
        'velopack-smoke.yml',
        '--ref',
        'main',
        '-f',
        'release_tag=v2026-05-08',
        '-f',
        'from_version=2026.507.1',
        '-f',
        'to_version=2026.508.1'
      ]
    )
  })

  it('adds update_tag when the nupkg lives on another release', () => {
    assert.deepEqual(
      buildSmokeDispatchArgs({
        fromVersion: '2026.507.1',
        tag: 'v2026-05-07',
        toVersion: '2026.508.1',
        updateTag: 'v2026-05-08'
      }).slice(-6),
      [
        '-f',
        'from_version=2026.507.1',
        '-f',
        'to_version=2026.508.1',
        '-f',
        'update_tag=v2026-05-08'
      ]
    )
  })

  it('honours a non-default ref', () => {
    const args = buildSmokeDispatchArgs({
      fromVersion: '2026.507.1',
      ref: 'release/windows',
      tag: 'v2026-05-08',
      toVersion: '2026.508.1'
    })

    assert.equal(args[args.indexOf('--ref') + 1], 'release/windows')
  })

  it('names the missing required field', () => {
    assert.throws(
      () => buildSmokeDispatchArgs({ fromVersion: '1', toVersion: '2' }),
      /tag is required/
    )
    assert.throws(
      () => buildSmokeDispatchArgs({ tag: 'v2026-05-08', toVersion: '2' }),
      /fromVersion is required/
    )
    assert.throws(
      () => buildSmokeDispatchArgs({ fromVersion: '1', tag: 'v2026-05-08' }),
      /toVersion is required/
    )
  })
})

describe('run artifacts', () => {
  it('derives the app version and the asset artifact from the metadata artifact', () => {
    assert.deepEqual(
      selectRunArtifacts([
        'memry-release-windows-2026.911.1',
        'memry-release-2026.911.1',
        'release-metadata-2026.911.1'
      ]),
      {
        appVersion: '2026.911.1',
        assetsArtifact: 'memry-release-2026.911.1',
        metadataArtifact: 'release-metadata-2026.911.1'
      }
    )
  })

  it('rejects a run with no metadata artifact', () => {
    assert.throws(
      () => selectRunArtifacts(['memry-release-2026.911.1']),
      /uploaded no release-metadata-\* artifact/
    )
  })

  it('rejects a run whose staged asset artifact is missing', () => {
    assert.throws(
      () => selectRunArtifacts(['release-metadata-2026.911.1']),
      /uploaded no memry-release-2026\.911\.1 artifact/
    )
  })
})
