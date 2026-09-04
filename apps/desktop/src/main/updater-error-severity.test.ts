import { beforeEach, describe, expect, it } from 'vitest'

import type { UpdaterErrorPhase } from './updater'
import {
  classifyUpdaterError,
  isExpiredSignedAssetError,
  isReadOnlyVolumeError,
  isUpdaterCheckPhase,
  recordUpdaterCheckFailure,
  recordUpdaterCheckSuccess,
  resetUpdaterCheckHealth,
  type UpdaterErrorSeverity
} from './updater-error-severity'

// Every message below is the verbatim production shape from issue #1587's
// PostHog window (2026-08-09 → 2026-08-19), not an invented sample.
const netError = (code: string): Error => new Error(code)

const invalidReleaseFeed = (cause: string): Error =>
  Object.assign(
    new Error(
      `Cannot parse releases feed: Error: Unable to find latest version on GitHub ` +
        `(https://github.com/memrynote/memry/releases/latest), please ensure a production ` +
        `release exists: Error: ${cause}`
    ),
    { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }
  )

interface Case {
  name: string
  error: unknown
  expected: UpdaterErrorSeverity
}

const CHECK_PHASE: UpdaterErrorPhase = 'check'

describe('classifyUpdaterError', () => {
  // 917 of the 1,043 noisy production events were a bare code from this list.
  const transient: Case[] = [
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_TIMED_OUT',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_REFUSED',
    // Issue #1994, measured on builds that already carry the #1587 allowlist
    // (2026.822.1+) — older builds reported everything as an error, so they
    // cannot evidence a gap in this set.
    'net::ERR_CONNECTION_ABORTED',
    'net::ERR_ADDRESS_UNREACHABLE',
    'net::ERR_ADDRESS_INVALID',
    'net::ERR_NETWORK_ACCESS_DENIED',
    'net::ERR_NETWORK_IO_SUSPENDED',
    'net::ERR_HTTP2_PROTOCOL_ERROR',
    'net::ERR_HTTP2_SERVER_REFUSED_STREAM'
  ].map((code) => ({ name: code, error: netError(code), expected: 'warn' as const }))

  const wrapped: Case[] = [
    {
      // 30 of 30 ERR_UPDATER_INVALID_RELEASE_FEED events carried a network cause:
      // GitHubProvider wraps a transport failure in a parse-shaped message.
      name: 'ERR_UPDATER_INVALID_RELEASE_FEED wrapping net::ERR_NETWORK_CHANGED',
      error: invalidReleaseFeed('net::ERR_NETWORK_CHANGED'),
      expected: 'warn'
    },
    {
      name: 'ERR_UPDATER_INVALID_RELEASE_FEED wrapping net::ERR_TIMED_OUT',
      error: invalidReleaseFeed('net::ERR_TIMED_OUT'),
      expected: 'warn'
    },
    {
      name: 'transport failure carried on the cause chain instead of the message',
      error: Object.assign(new Error('Cannot parse releases feed'), {
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
        cause: new Error('net::ERR_INTERNET_DISCONNECTED')
      }),
      expected: 'warn'
    },
    {
      // The load-bearing negative: a feed that is genuinely malformed has no
      // network cause anywhere in the chain and must stay an exception.
      name: 'ERR_UPDATER_INVALID_RELEASE_FEED with a parse-only cause',
      error: Object.assign(new Error('Cannot parse releases feed'), {
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
        cause: new SyntaxError('end of the stream or a document separator is expected')
      }),
      expected: 'error'
    }
  ]

  const stillErrors: Case[] = [
    {
      // 27 of 27 were `jwt:expired` on GitHub's pre-signed asset URLs. Delivery
      // side, not the user's link — it must stay visible in Error Tracking.
      name: 'HTTP_ERROR_618 jwt:expired on a signed release-asset URL',
      error: Object.assign(
        new Error(
          'Cannot download "https://release-assets.githubusercontent.com/github-production-release-asset/x", status 618: jwt:expired'
        ),
        { name: 'HttpError', code: 'HTTP_ERROR_618', statusCode: 618 }
      ),
      expected: 'error'
    },
    {
      name: 'a 404 release feed',
      error: Object.assign(new Error('Cannot download "https://x.test/latest.yml", status 404'), {
        name: 'HttpError',
        code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
        statusCode: 404
      }),
      expected: 'error'
    },
    {
      // A server that answered is never "the user is offline", even when a
      // retry wrapper stitched a transport code into the same message.
      name: 'a 5xx that also mentions a transient transport code',
      error: Object.assign(new Error('status 503, retry after net::ERR_CONNECTION_RESET'), {
        name: 'HttpError',
        statusCode: 503
      }),
      expected: 'error'
    },
    {
      // Issue #1994 proposed demoting an upstream 5xx during a check. Kept loud
      // deliberately. A 504 on the releases feed is GitHub's edge failing for
      // everyone at once, so it is the one check-phase shape that means the whole
      // fleet has stopped receiving updates — the opposite of the per-device
      // transport codes above, which scale with the number of flaky networks.
      // Losing it from Error Tracking would hide a delivery outage.
      name: 'a 504 on the releases feed during a check',
      error: Object.assign(
        new Error(
          '504 \n"method: GET url: https://github.com/memrynote/memry/releases.atom\n\nData:\n<html><body>'
        ),
        { name: 'HttpError', code: 'HTTP_ERROR_504', statusCode: 504 }
      ),
      expected: 'error'
    },
    {
      // A certificate failure is a security signal, never noise — the reason the
      // transient set is an allowlist and not a `net::ERR_` prefix test.
      name: 'net::ERR_CERT_AUTHORITY_INVALID',
      error: netError('net::ERR_CERT_AUTHORITY_INVALID'),
      expected: 'error'
    },
    {
      name: 'net::ERR_SSL_PROTOCOL_ERROR',
      error: netError('net::ERR_SSL_PROTOCOL_ERROR'),
      expected: 'error'
    },
    {
      // Fail closed: a code we have never reasoned about is not "normal".
      name: 'an unrecognised net::ERR_SOMETHING_NEW',
      error: netError('net::ERR_SOMETHING_NEW'),
      expected: 'error'
    },
    {
      name: 'a transient code accompanied by a certificate failure in the chain',
      error: Object.assign(new Error('net::ERR_TIMED_OUT'), {
        cause: new Error('net::ERR_CERT_DATE_INVALID')
      }),
      expected: 'error'
    },
    {
      name: 'signature verification failure',
      error: new Error('New version is not signed by the application owner'),
      expected: 'error'
    },
    {
      name: 'ENOENT app-update.yml (a repackaged build with no update config)',
      error: Object.assign(
        new Error("ENOENT: no such file or directory, open '/Applications/X.app/app-update.yml'"),
        { code: 'ENOENT' }
      ),
      expected: 'error'
    },
    {
      name: 'a failed install copy',
      error: new Error('ditto: Could not lstat /Library/Caches/memry.ShipIt/update.HcExUK'),
      expected: 'error'
    },
    { name: 'a non-Error rejection value', error: 'boom', expected: 'error' },
    { name: 'null', error: null, expected: 'error' }
  ]

  it.each([...transient, ...wrapped, ...stillErrors])(
    'reports $name as $expected in the check phase',
    ({ error, expected }) => {
      expect(classifyUpdaterError(error, CHECK_PHASE)).toBe(expected)
    }
  )

  const checkPhases: UpdaterErrorPhase[] = [
    'check',
    'startup-check',
    'scheduled-check',
    'auto-check-enable'
  ]
  const otherPhases: UpdaterErrorPhase[] = [
    'download',
    'downloaded',
    'install',
    'auto-download-enable',
    'idle'
  ]

  it.each(checkPhases)('demotes a transient failure in the %s phase', (phase) => {
    expect(isUpdaterCheckPhase(phase)).toBe(true)
    expect(classifyUpdaterError(netError('net::ERR_INTERNET_DISCONNECTED'), phase)).toBe('warn')
  })

  // Deliberate narrowing: a network drop mid-download or mid-install can leave a
  // half-applied update, so it keeps error severity even for a transient code.
  it.each(otherPhases)('keeps the same failure at error in the %s phase', (phase) => {
    expect(isUpdaterCheckPhase(phase)).toBe(false)
    expect(classifyUpdaterError(netError('net::ERR_INTERNET_DISCONNECTED'), phase)).toBe('error')
  })

  // The codes added by #1994 inherit that narrowing rather than widening it.
  it.each(otherPhases)('keeps a newly demoted code at error in the %s phase', (phase) => {
    expect(classifyUpdaterError(netError('net::ERR_ADDRESS_UNREACHABLE'), phase)).toBe('error')
  })
})

describe('stuck-updater escalation', () => {
  const start = Date.UTC(2026, 7, 19, 9, 0, 0)
  const DAY = 24 * 60 * 60 * 1000

  beforeEach(() => {
    resetUpdaterCheckHealth(start)
  })

  it('stays quiet for one laptop that is offline for an afternoon', () => {
    // #given six failed checks an hour apart — the 10-minute poll while awake
    for (let index = 1; index <= 5; index += 1) {
      expect(recordUpdaterCheckFailure(start + index * 60 * 60 * 1000).stuck).toBe(false)
    }
    expect(recordUpdaterCheckFailure(start + 6 * 60 * 60 * 1000)).toEqual({
      consecutiveFailures: 6,
      stuck: false
    })
  })

  it('escalates once when an install has not completed a check in a day', () => {
    for (let index = 1; index <= 5; index += 1) {
      expect(recordUpdaterCheckFailure(start + DAY + index).stuck).toBe(false)
    }
    // #then the sixth failure past the 24h window is the one exception raised…
    expect(recordUpdaterCheckFailure(start + DAY + 6)).toEqual({
      consecutiveFailures: 6,
      stuck: true
    })
    // #and the streak never floods Error Tracking again
    expect(recordUpdaterCheckFailure(start + DAY + 7).stuck).toBe(false)
    expect(recordUpdaterCheckFailure(start + 2 * DAY).stuck).toBe(false)
  })

  it('does not escalate on the first failed check after a long sleep', () => {
    // #given a laptop closed for a week, whose first wake-up check fails
    expect(recordUpdaterCheckFailure(start + 7 * DAY)).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
  })

  it('a successful check clears the streak and re-arms the escalation', () => {
    for (let index = 1; index <= 6; index += 1) {
      recordUpdaterCheckFailure(start + DAY + index)
    }
    recordUpdaterCheckSuccess(start + DAY + 10)

    expect(recordUpdaterCheckFailure(start + DAY + 11)).toEqual({
      consecutiveFailures: 1,
      stuck: false
    })
    for (let index = 2; index <= 5; index += 1) {
      expect(recordUpdaterCheckFailure(start + 2 * DAY + index).stuck).toBe(false)
    }
    expect(recordUpdaterCheckFailure(start + 2 * DAY + 20).stuck).toBe(true)
  })
})

// The verbatim production shape: builder-util-runtime's createHttpError() builds
// `<status> <statusMessage>` plus the request line and GitHub's HTML body.
const signedAssetError = (statusCode: number, host: string, body: string): Error =>
  Object.assign(
    new Error(
      `${statusCode} \n"method: GET url: https://${host}/1132/releases/assets/x?sha256=y&jwt=z\n\n` +
        `          Data:\n          \n<html><head><title>${body}</title></head></html>`
    ),
    { name: 'HttpError', code: `HTTP_ERROR_${statusCode}`, statusCode }
  )

describe('isExpiredSignedAssetError', () => {
  it('recognises the 618 jwt:expired that loses an update check', () => {
    expect(
      isExpiredSignedAssetError(
        signedAssetError(618, 'release-assets.githubusercontent.com', '618 jwt:expired')
      )
    ).toBe(true)
  })

  it('recognises an expired signature reported as 403 on the signed-asset host', () => {
    expect(
      isExpiredSignedAssetError(
        signedAssetError(403, 'release-assets.githubusercontent.com', '403 Forbidden')
      )
    ).toBe(true)
  })

  it('leaves a 403 from anywhere else alone, so a real refusal is not retried', () => {
    expect(
      isExpiredSignedAssetError(signedAssetError(403, 'api.github.com', '403 Forbidden'))
    ).toBe(false)
  })

  it('leaves every other updater failure alone', () => {
    expect(isExpiredSignedAssetError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false)
    expect(isExpiredSignedAssetError(signedAssetError(404, 'github.com', '404 Not Found'))).toBe(
      false
    )
    expect(
      isExpiredSignedAssetError(
        signedAssetError(500, 'release-assets.githubusercontent.com', '500')
      )
    ).toBe(false)
    expect(isExpiredSignedAssetError(undefined)).toBe(false)
    expect(isExpiredSignedAssetError('618')).toBe(false)
  })

  // #1595 classified a 618 as a defect worth an exception. That is still true of
  // the failure that survives the retry — only the recovered attempts are quiet.
  it('does not change how a surviving 618 is classified', () => {
    const expired = signedAssetError(618, 'release-assets.githubusercontent.com', '618 jwt:expired')
    expect(classifyUpdaterError(expired, 'check')).toBe('error')
    expect(classifyUpdaterError(new Error('net::ERR_TIMED_OUT'), 'check')).toBe('warn')
  })
})

describe('isReadOnlyVolumeError', () => {
  // Verbatim Squirrel.Mac copy from the 2026-09-04 PostHog window (issue #1995).
  const squirrelReadOnlyVolume =
    'Cannot update while running on a read-only volume. The application is on a ' +
    "read-only volume. Please move the application and try again. If you're on " +
    "macOS Sierra or later, you'll need to move the application out of the " +
    'Downloads directory. See https://github.com/Squirrel/Squirrel.Mac/issues/182 ' +
    'for more information.'

  it('recognises the Squirrel.Mac read-only volume failure', () => {
    expect(isReadOnlyVolumeError(new Error(squirrelReadOnlyVolume))).toBe(true)
  })

  it('reads through a cause chain, the way electron-updater wraps failures', () => {
    const wrapped = new Error('Cannot install update')
    ;(wrapped as { cause?: unknown }).cause = new Error(squirrelReadOnlyVolume)
    expect(isReadOnlyVolumeError(wrapped)).toBe(true)
  })

  it('leaves every other updater failure alone', () => {
    expect(isReadOnlyVolumeError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false)
    expect(isReadOnlyVolumeError(new Error('ENOSPC: no space left on device'))).toBe(false)
    // "read-only" without the volume is a file-permission problem, not this one.
    expect(isReadOnlyVolumeError(new Error('EROFS: read-only file system'))).toBe(false)
    expect(isReadOnlyVolumeError(undefined)).toBe(false)
    expect(isReadOnlyVolumeError(squirrelReadOnlyVolume)).toBe(true)
  })

  it('demotes the failure below error severity in the install phase', () => {
    expect(classifyUpdaterError(new Error(squirrelReadOnlyVolume), 'downloaded')).toBe('warn')
    expect(classifyUpdaterError(new Error('ENOSPC: no space left'), 'downloaded')).toBe('error')
  })
})
