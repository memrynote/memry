import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'

import { classifyWritingAssistFailure } from './writing-assist'

function apiCallError(statusCode?: number): APICallError {
  return new APICallError({
    message: statusCode ? 'Request failed' : 'Cannot connect to API: ',
    url: 'http://localhost:11434/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === undefined
  })
}

function retried(lastError: unknown): RetryError {
  return new RetryError({
    message: 'Failed after 3 attempts. Last error: Cannot connect to API: ',
    reason: 'maxRetriesExceeded',
    errors: [lastError]
  })
}

describe('classifyWritingAssistFailure', () => {
  it('reports an unreachable provider after the SDK gives up retrying', () => {
    expect(classifyWritingAssistFailure(retried(apiCallError()))).toBe('unreachable')
  })

  it('reports a rejected API key', () => {
    expect(classifyWritingAssistFailure(apiCallError(401))).toBe('unauthorized')
  })

  it('leaves other failures to their own message', () => {
    expect(classifyWritingAssistFailure(apiCallError(500))).toBe('other')
    expect(classifyWritingAssistFailure(new Error('boom'))).toBe('other')
  })
})
