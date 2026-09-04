import { describe, expect, it } from 'vitest'

import {
  isConnectionRefusedError,
  isExpectedConditionError,
  isWatchEnvironmentError,
  markExpectedCondition
} from './expected-conditions'

describe('markExpectedCondition', () => {
  it('marks an error without changing its identity or message', () => {
    // #given an error the UI still has to show the user
    const error = new Error('Ollama is not running')

    // #when marking it as an expected condition
    const marked = markExpectedCondition(error)

    // #then the same error comes back, untouched apart from the marker
    expect(marked).toBe(error)
    expect(marked.message).toBe('Ollama is not running')
    expect(isExpectedConditionError(error)).toBe(true)
  })

  it('leaves the marker off the JSON shape (non-enumerable)', () => {
    const error = markExpectedCondition(new Error('boom'))
    expect(Object.keys(error)).toEqual([])
    expect(JSON.stringify({ ...error })).toBe('{}')
  })

  it('tolerates non-object reasons', () => {
    expect(markExpectedCondition('boom')).toBe('boom')
    expect(isExpectedConditionError('boom')).toBe(false)
  })
})

describe('isExpectedConditionError', () => {
  it('is false for an ordinary unmarked error', () => {
    expect(isExpectedConditionError(new Error('real fault'))).toBe(false)
  })

  it('is false for null/undefined', () => {
    expect(isExpectedConditionError(null)).toBe(false)
    expect(isExpectedConditionError(undefined)).toBe(false)
  })
})

describe('isConnectionRefusedError', () => {
  it('detects the undici fetch shape: TypeError with ECONNREFUSED on cause', () => {
    // #given Ollama is simply not running — nothing listening on the port
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
        syscall: 'connect'
      })
    })

    expect(isConnectionRefusedError(error)).toBe(true)
  })

  it('detects ECONNREFUSED inside an AggregateError cause (dual-stack localhost)', () => {
    // #given localhost resolves to both ::1 and 127.0.0.1 and both refuse
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new AggregateError([], 'all attempts failed'), {
        code: 'ECONNREFUSED',
        errors: [
          Object.assign(new Error('connect ECONNREFUSED ::1:11434'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
            code: 'ECONNREFUSED'
          })
        ]
      })
    })

    expect(isConnectionRefusedError(error)).toBe(true)
  })

  it('detects a bare ECONNREFUSED system error', () => {
    expect(isConnectionRefusedError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      true
    )
  })

  it('does NOT swallow other failures — a misconfigured Ollama still reports', () => {
    // #given failures that are real faults, not "the app is not running"
    const httpError = new Error('Ollama responded 500')
    const dnsError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND nope.local'), { code: 'ENOTFOUND' })
    })
    const resetError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    })
    const parseError = new SyntaxError('Unexpected token < in JSON')

    // #then none of them count as "not running"
    expect(isConnectionRefusedError(httpError)).toBe(false)
    expect(isConnectionRefusedError(dnsError)).toBe(false)
    expect(isConnectionRefusedError(resetError)).toBe(false)
    expect(isConnectionRefusedError(parseError)).toBe(false)
    expect(isConnectionRefusedError(null)).toBe(false)
    expect(isConnectionRefusedError('ECONNREFUSED')).toBe(false)
  })

  it('terminates on a self-referencing cause chain', () => {
    // #given a cyclic cause chain
    const error: { cause?: unknown } = {}
    error.cause = error

    // #then the walk is depth-bounded rather than hanging
    expect(isConnectionRefusedError(error)).toBe(false)
  })
})

describe('isWatchEnvironmentError', () => {
  const watchError = (code: string): Error =>
    Object.assign(new Error(`${code}: operation not permitted, watch`), { code })

  it('accepts the per-file conditions another process imposes on a watch', () => {
    // #given a vault file held by antivirus, a cloud-sync client, or deleted mid-scan
    // #then the watcher is still running and there is nothing to report
    expect(isWatchEnvironmentError(watchError('EPERM'))).toBe(true)
    expect(isWatchEnvironmentError(watchError('EACCES'))).toBe(true)
    expect(isWatchEnvironmentError(watchError('EBUSY'))).toBe(true)
    expect(isWatchEnvironmentError(watchError('ENOENT'))).toBe(true)
  })

  it('still reports a watcher that has actually stopped seeing changes', () => {
    // #given the watch descriptor limit is exhausted, so changes are being missed
    // #then this is a real defect and must not be suppressed
    expect(isWatchEnvironmentError(watchError('EMFILE'))).toBe(false)
    expect(isWatchEnvironmentError(watchError('ENOSPC'))).toBe(false)
  })

  it('does not match on message text or a missing code', () => {
    // #given an error that only looks like one
    expect(isWatchEnvironmentError(new Error('EPERM: operation not permitted, watch'))).toBe(false)
    expect(isWatchEnvironmentError('EPERM')).toBe(false)
    expect(isWatchEnvironmentError(null)).toBe(false)
  })
})
