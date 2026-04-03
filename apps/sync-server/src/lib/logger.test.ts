import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createLogger } from './logger'

describe('createLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns object with info, warn, error, debug methods', () => {
    const logger = createLogger('Auth')

    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.debug).toBe('function')
  })

  it('error calls console.error with JSON containing level, scope, message, and context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('Auth')

    logger.error('token expired', { userId: '123' })

    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toEqual({
      level: 'error',
      scope: 'Auth',
      message: 'token expired',
      userId: '123'
    })
  })

  it('warn calls console.warn with JSON containing level, scope, message', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logger = createLogger('Config')

    logger.warn('missing binding')

    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toEqual({
      level: 'warn',
      scope: 'Config',
      message: 'missing binding'
    })
  })

  it('info calls console.info with JSON string', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const logger = createLogger('Sync')

    logger.info('pull complete')

    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toEqual({
      level: 'info',
      scope: 'Sync',
      message: 'pull complete'
    })
  })

  it('debug calls console.debug with JSON string', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const logger = createLogger('Debug')

    logger.debug('trace data')

    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toEqual({
      level: 'debug',
      scope: 'Debug',
      message: 'trace data'
    })
  })

  it('spreads context object into JSON output', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger('Email')

    logger.error('send failed', { status: 500, body: 'server error' })

    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.status).toBe(500)
    expect(parsed.body).toBe('server error')
    expect(parsed.level).toBe('error')
    expect(parsed.scope).toBe('Email')
    expect(parsed.message).toBe('send failed')
  })

  it('includes scope in all log entries', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    const logger = createLogger('MyScope')

    logger.info('a')
    logger.warn('b')
    logger.error('c')
    logger.debug('d')

    for (const spy of [infoSpy, warnSpy, errorSpy, debugSpy]) {
      const parsed = JSON.parse(spy.mock.calls[0][0] as string)
      expect(parsed.scope).toBe('MyScope')
    }
  })
})
