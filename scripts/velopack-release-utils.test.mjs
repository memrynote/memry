import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildKeytoolListArgs,
  buildOsslsigncodeVerifyArgs,
  buildSmokeDispatchArgs,
  clearStepsFrom,
  createReleaseState,
  decideSigningSession,
  decideWorkflowAction,
  isSignatureVerified,
  isStepDone,
  markStepDone,
  parseReleaseMetadata,
  parseReleaseState,
  payloadZipName,
  planFinishSteps,
  releaseStepOrder,
  selectRunArtifacts,
  selectPreviousFullNupkgAsset,
  selectPreviousPublishedRelease,
  windowsTargets
} from './velopack-release-utils.mjs'
import { assetNames, RETIRED_SETUP_NAME } from './release/vpk-args.mjs'
import { VELOPACK_SETUP_ASSET_NAME } from '../apps/desktop/src/main/installer-handoff-script.ts'

describe('release state', () => {
  it('lists the pipeline steps in execution order', () => {
    assert.deepEqual(releaseStepOrder, [
      'dispatch',
      'build',
      'download',
      'pack-windows',
      'bridge',
      'verify',
      'upload',
      'publish'
    ])
  })

  it('creates an empty state for a draft tag', () => {
    assert.deepEqual(createReleaseState({ draftTag: 'vnext' }), {
      appVersion: null,
      completed: [],
      draftCreatedAt: null,
      draftTag: 'vnext',
      pipeline: 'tauri',
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
        pipeline: 'tauri',
        runId: 25571212462,
        tag: null
      },
      { draftTag: 'vnext' }
    )

    assert.deepEqual(state, {
      appVersion: '2026.508.1',
      completed: ['dispatch', 'build'],
      draftCreatedAt: null,
      draftTag: 'vnext',
      pipeline: 'tauri',
      runId: '25571212462',
      tag: null
    })
  })

  it('keeps a state whose draft creation time matches the live draft', () => {
    const state = parseReleaseState(
      {
        appVersion: '2026.912.1',
        completed: ['dispatch'],
        draftCreatedAt: '2026-09-12T10:07:38Z',
        draftTag: 'vnext',
        pipeline: 'tauri',
        runId: '1',
        tag: null
      },
      { draftCreatedAt: '2026-09-12T10:07:38Z', draftTag: 'vnext' }
    )

    assert.deepEqual(state.completed, ['dispatch'])
    assert.equal(state.draftCreatedAt, '2026-09-12T10:07:38Z')
  })

  it('starts over when the reused draft tag belongs to a new release cycle', () => {
    const published = {
      appVersion: '2026.912.1',
      completed: ['dispatch', 'build', 'download', 'pack', 'verify', 'upload', 'publish'],
      draftCreatedAt: '2026-09-11T23:13:30Z',
      draftTag: 'vnext',
      runId: '1',
      tag: 'v2026-09-12'
    }

    assert.deepEqual(
      parseReleaseState(published, { draftCreatedAt: '2026-09-12T10:07:38Z', draftTag: 'vnext' }),
      createReleaseState({ draftCreatedAt: '2026-09-12T10:07:38Z', draftTag: 'vnext' })
    )

    const legacyWithoutCreatedAt = { ...published }
    delete legacyWithoutCreatedAt.draftCreatedAt

    assert.deepEqual(
      parseReleaseState(legacyWithoutCreatedAt, {
        draftCreatedAt: '2026-09-12T10:07:38Z',
        draftTag: 'vnext'
      }),
      createReleaseState({ draftCreatedAt: '2026-09-12T10:07:38Z', draftTag: 'vnext' })
    )
  })

  it('keeps a state when no live draft exists (resume after tag rename)', () => {
    const state = parseReleaseState(
      {
        appVersion: '2026.912.1',
        completed: ['dispatch'],
        draftCreatedAt: '2026-09-11T23:13:30Z',
        draftTag: 'vnext',
        pipeline: 'tauri',
        runId: '1',
        tag: null
      },
      { draftCreatedAt: null, draftTag: 'vnext' }
    )

    assert.deepEqual(state.completed, ['dispatch'])
    assert.equal(state.draftCreatedAt, '2026-09-11T23:13:30Z')
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
    assert.deepEqual(parseReleaseState({ draftTag: 'vnext' }, { draftTag: 'vnext' }), fresh)
    assert.deepEqual(parseReleaseState(null, { draftTag: 'vnext' }), fresh)
    assert.deepEqual(parseReleaseState(['dispatch'], { draftTag: 'vnext' }), fresh)
    assert.deepEqual(parseReleaseState('vnext', { draftTag: 'vnext' }), fresh)
  })

  // An Electron release left this state: its steps and artifacts (NSIS, -win.zip) do not exist in
  // the Tauri pipeline, so resuming it would pack nothing or upload the wrong set.
  it('rejects a state written by the Electron pnpm release, naming the directory to remove', () => {
    const electron = {
      appVersion: '2026.1015.1',
      completed: ['dispatch', 'build', 'download', 'sign-nsis'],
      draftTag: 'v/next',
      runId: '1',
      tag: null
    }
    const message =
      /\.release-state\/v-next\/state\.json was written by an older pnpm release \(steps: dispatch, build, download, sign-nsis\)\. Remove \.release-state\/v-next and rerun pnpm release\./

    assert.throws(() => parseReleaseState(electron, { draftTag: 'v/next' }), message)
    // Steps the Tauri order also has do not make an Electron state resumable.
    assert.throws(
      () => parseReleaseState({ ...electron, completed: ['dispatch'] }, { draftTag: 'v/next' }),
      /written by an older pnpm release/
    )
    assert.throws(
      () =>
        parseReleaseState(
          { ...electron, completed: ['dispatch', 'teleport'], pipeline: 'tauri' },
          { draftTag: 'v/next' }
        ),
      /written by an older pnpm release/
    )
  })

  it('reports completed steps', () => {
    const state = { ...createReleaseState({ draftTag: 'vnext' }), completed: ['dispatch'] }

    assert.equal(isStepDone(state, 'dispatch'), true)
    assert.equal(isStepDone(state, 'pack-windows'), false)
    assert.throws(() => isStepDone(state, 'teleport'), /Unknown release step: teleport/)
  })

  it('marks a step done without mutating the input state', () => {
    const state = { ...createReleaseState({ draftTag: 'vnext' }), completed: ['build'] }
    const next = markStepDone(state, 'dispatch', { runId: '25571212462' })

    assert.deepEqual(next, {
      appVersion: null,
      completed: ['dispatch', 'build'],
      draftCreatedAt: null,
      draftTag: 'vnext',
      pipeline: 'tauri',
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
      completed: ['dispatch', 'build', 'download', 'pack-windows', 'bridge', 'upload']
    }
    const next = clearStepsFrom(state, 'download')

    assert.deepEqual(next.completed, ['dispatch', 'build'])
    assert.deepEqual(state.completed, [
      'dispatch',
      'build',
      'download',
      'pack-windows',
      'bridge',
      'upload'
    ])
    assert.deepEqual(clearStepsFrom(state, 'dispatch').completed, [])
  })
})

describe('finish steps', () => {
  const stateWith = (completed) => ({ ...createReleaseState({ draftTag: 'vnext' }), completed })

  it('redoes the packs and the bridge after a fresh download, then verify, upload, publish', () => {
    const plan = planFinishSteps(
      stateWith(['dispatch', 'build', 'download', 'pack-windows', 'bridge', 'verify']),
      { downloaded: true, published: false }
    )

    assert.deepEqual(plan.steps, ['pack-windows', 'bridge', 'verify', 'upload', 'publish'])
    assert.deepEqual(plan.state.completed, ['dispatch', 'build', 'download'])
  })

  it('resumes after the last finished pack step and always reruns verify, upload, publish', () => {
    for (const [completed, steps] of [
      [
        ['dispatch', 'build', 'download'],
        ['pack-windows', 'bridge', 'verify', 'upload', 'publish']
      ],
      [
        ['dispatch', 'build', 'download', 'pack-windows'],
        ['bridge', 'verify', 'upload', 'publish']
      ],
      [
        ['dispatch', 'build', 'download', 'pack-windows', 'bridge', 'verify', 'upload'],
        ['verify', 'upload', 'publish']
      ]
    ]) {
      const plan = planFinishSteps(stateWith(completed), { downloaded: false, published: false })

      assert.deepEqual(plan.steps, steps)
      assert.deepEqual(plan.state.completed, completed)
    }
  })

  // A crash after the publish call and before the state write: rerunning upload would clobber the
  // live release and publish would turn it back into a draft.
  it('only marks publish done when the release is already published', () => {
    const plan = planFinishSteps(
      stateWith(['dispatch', 'build', 'download', 'pack-windows', 'bridge', 'verify', 'upload']),
      { downloaded: false, published: true }
    )

    assert.deepEqual(plan.steps, [])
    assert.deepEqual(plan.state.completed, releaseStepOrder)
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
  const x64Sha = 'a'.repeat(64)
  const armSha = 'b'.repeat(64)
  const windowsPayloads = [
    { name: 'MemryNote-2026.508.1-win-x64-payload.zip', sha256: x64Sha },
    { name: 'MemryNote-2026.508.1-win-arm64-payload.zip', sha256: armSha }
  ]

  it('parses CI release metadata and normalizes the release id', () => {
    assert.deepEqual(
      parseReleaseMetadata({
        appVersion: '2026.508.1',
        commitSha: '61103d9739b1c0a3f1b4b2e7f0c9a1d2e3f4a5b6',
        draftTag: 'vnext',
        releaseId: 233871199,
        releaseName: 'Memry v2026-05-08',
        tag: 'v2026-05-08',
        windowsPayloads
      }),
      {
        appVersion: '2026.508.1',
        commitSha: '61103d9739b1c0a3f1b4b2e7f0c9a1d2e3f4a5b6',
        draftTag: 'vnext',
        releaseId: '233871199',
        releaseName: 'Memry v2026-05-08',
        tag: 'v2026-05-08',
        windowsPayloads: { 'win-arm64': armSha, 'win-x64': x64Sha }
      }
    )
  })

  it('names the payload zip build-windows uploads', () => {
    assert.equal(
      payloadZipName('win-arm64', '2026.508.1'),
      'MemryNote-2026.508.1-win-arm64-payload.zip'
    )
  })

  // The Mac packs and signs whatever zip it downloaded; without the digest the build checked it
  // could sign bytes no CI check ever saw.
  it('requires the sha256 of every Windows payload zip', () => {
    const metadata = {
      appVersion: '2026.508.1',
      commitSha: 'abc1234',
      draftTag: 'vnext',
      releaseId: 1,
      releaseName: 'Memry v2026-05-08',
      tag: 'v2026-05-08'
    }

    assert.throws(() => parseReleaseMetadata(metadata), /invalid: missing windowsPayloads$/)
    assert.throws(
      () => parseReleaseMetadata({ ...metadata, windowsPayloads: {} }),
      /invalid: invalid windowsPayloads$/
    )
    assert.throws(
      () =>
        parseReleaseMetadata({
          ...metadata,
          windowsPayloads: [windowsPayloads[0], { ...windowsPayloads[1], sha256: 'B'.repeat(64) }]
        }),
      /invalid: no sha256 for MemryNote-2026\.508\.1-win-arm64-payload\.zip in windowsPayloads$/
    )
    assert.throws(
      () => parseReleaseMetadata({ ...metadata, windowsPayloads: [windowsPayloads[1]] }),
      /invalid: no sha256 for MemryNote-2026\.508\.1-win-x64-payload\.zip in windowsPayloads$/
    )
  })

  it('accepts a numeric string release id', () => {
    const metadata = parseReleaseMetadata({
      appVersion: '2026.508.1',
      commitSha: 'abc1234',
      draftTag: 'vnext',
      releaseId: '233871199',
      releaseName: 'Memry v2026-05-08',
      tag: 'v2026-05-08',
      windowsPayloads
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
          tag: 'v2026-05-08',
          windowsPayloads
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
          tag: 'v2026-05-08',
          windowsPayloads: []
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

describe('Windows Setup name', () => {
  // Shipped Electron builds up to v2026-10-25 HEAD vpk's Setup name and, on a 200, arm a hand-off
  // that hangs. The published name must differ from it and be the one the desktop app reads.
  it("publishes the x64 Setup under the name the app hands off to, never vpk's", () => {
    const { setup } = assetNames('win-x64', '2026.508.1')

    assert.notEqual(setup, RETIRED_SETUP_NAME)
    assert.equal(setup, VELOPACK_SETUP_ASSET_NAME)
  })
})

describe('previous release lookup', () => {
  const tauriRelease = [
    'RELEASES',
    'MemryNote-2026.1120.1-win-arm64-full.nupkg',
    'MemryNote-2026.1120.1-osx-arm64-full.nupkg',
    'MemryNote-2026.1120.1-linux-full.nupkg',
    'MemryNote-2026.1120.1-full.nupkg',
    'MemryNote-2026.1120.1-delta.nupkg'
  ]

  it("finds each Windows channel's own full nupkg and its version", () => {
    assert.deepEqual(selectPreviousFullNupkgAsset(tauriRelease, 'win-x64'), {
      name: 'MemryNote-2026.1120.1-full.nupkg',
      version: '2026.1120.1'
    })
    assert.deepEqual(selectPreviousFullNupkgAsset(tauriRelease, 'win-arm64'), {
      name: 'MemryNote-2026.1120.1-win-arm64-full.nupkg',
      version: '2026.1120.1'
    })
    assert.deepEqual(selectPreviousFullNupkgAsset(tauriRelease, 'linux-x64'), {
      name: 'MemryNote-2026.1120.1-linux-full.nupkg',
      version: '2026.1120.1'
    })
  })

  // A foreign full in vpk's output dir is listed in this channel's feed.
  it("never takes another channel's full nupkg", () => {
    const armOnly = ['MemryNote-2026.1120.1-win-arm64-full.nupkg']

    assert.equal(selectPreviousFullNupkgAsset(armOnly, 'win-x64'), null)
    assert.equal(
      selectPreviousFullNupkgAsset(['MemryNote-2026.1015.1-full.nupkg'], 'win-arm64'),
      null
    )
  })

  it('returns null when no full nupkg is present', () => {
    assert.equal(
      selectPreviousFullNupkgAsset(['RELEASES', 'MemryNote-2026.507.1-delta.nupkg'], 'win-x64'),
      null
    )
  })

  it('rejects an unknown pack target', () => {
    assert.throws(
      () => selectPreviousFullNupkgAsset([], 'win-x86'),
      /Unknown pack target "win-x86"/
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

  it('skips prereleases such as the ort-pod CI build-input release', () => {
    const releases = [
      {
        createdAt: '2026-11-23T13:34:03Z',
        isDraft: false,
        isPrerelease: false,
        tagName: 'v2026-11-23'
      },
      { createdAt: '2026-11-23T15:09:40Z', isDraft: true, isPrerelease: false, tagName: 'vnext' },
      {
        createdAt: '2026-11-23T16:05:56Z',
        isDraft: false,
        isPrerelease: true,
        tagName: 'ort-pod-1.30.0'
      }
    ]

    assert.equal(selectPreviousPublishedRelease(releases, { excludeTag: 'vnext' }), 'v2026-11-23')
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
  const runArtifacts = [
    'memry-release-macos-arm64-2026.1120.1',
    'memry-release-2026.1120.1',
    'release-metadata-2026.1120.1',
    'release-inputs-2026.1120.1',
    'memry-windows-payload-win-x64-2026.1120.1',
    'memry-windows-payload-win-arm64-2026.1120.1'
  ]

  it('derives every artifact pnpm release downloads from the metadata artifact', () => {
    assert.deepEqual(selectRunArtifacts(runArtifacts), {
      appVersion: '2026.1120.1',
      assetsArtifact: 'memry-release-2026.1120.1',
      inputsArtifact: 'release-inputs-2026.1120.1',
      metadataArtifact: 'release-metadata-2026.1120.1',
      payloadArtifacts: {
        'win-arm64': 'memry-windows-payload-win-arm64-2026.1120.1',
        'win-x64': 'memry-windows-payload-win-x64-2026.1120.1'
      }
    })
  })

  it('packs both Windows targets', () => {
    assert.deepEqual(windowsTargets(), ['win-x64', 'win-arm64'])
  })

  it('rejects a run with no metadata artifact', () => {
    assert.throws(
      () => selectRunArtifacts(['memry-release-2026.1120.1']),
      /uploaded no release-metadata-\* artifact/
    )
  })

  for (const artifact of runArtifacts.slice(1)) {
    if (artifact.startsWith('release-metadata-')) continue

    it(`rejects a run without ${artifact}`, () => {
      assert.throws(
        () => selectRunArtifacts(runArtifacts.filter((name) => name !== artifact)),
        new RegExp(`uploaded no ${artifact.replaceAll('.', '\\.')} artifact`)
      )
    })
  }
})
