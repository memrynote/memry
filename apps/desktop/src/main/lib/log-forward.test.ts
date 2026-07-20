import { afterEach, describe, expect, it, vi } from 'vitest'
import log from 'electron-log'

import { installWorkerLogForwarding } from './log-forward'

type ParentPortStub = { postMessage: ReturnType<typeof vi.fn> }

const setParentPort = (port: ParentPortStub | undefined): void => {
  ;(process as unknown as { parentPort?: ParentPortStub }).parentPort = port
}

const clearTransport = (): void => {
  ;(log.transports as unknown as Record<string, unknown>).forwardToMain = undefined
}

describe('installWorkerLogForwarding', () => {
  afterEach(() => {
    setParentPort(undefined)
    clearTransport()
  })

  it('forwards a warn record to the parent over process.parentPort', () => {
    const port: ParentPortStub = { postMessage: vi.fn() }
    setParentPort(port)

    installWorkerLogForwarding('Embeddings')
    log.warn('m', { a: 1 })

    expect(port.postMessage).toHaveBeenCalledTimes(1)
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'log',
      record: { level: 'warn', scope: 'Embeddings', data: ['m', { a: 1 }] }
    })
  })

  it('forwards an error record', () => {
    const port: ParentPortStub = { postMessage: vi.fn() }
    setParentPort(port)

    installWorkerLogForwarding('Embeddings')
    log.error('boom')

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'log',
      record: { level: 'error', scope: 'Embeddings', data: ['boom'] }
    })
  })

  it('uses the call-site scope over the worker name when present', () => {
    const port: ParentPortStub = { postMessage: vi.fn() }
    setParentPort(port)

    installWorkerLogForwarding('Embeddings')
    log.scope('Embeddings:Worker').warn('scoped')

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'log',
      record: { level: 'warn', scope: 'Embeddings:Worker', data: ['scoped'] }
    })
  })

  it('does not forward info or debug records', () => {
    const port: ParentPortStub = { postMessage: vi.fn() }
    setParentPort(port)

    installWorkerLogForwarding('Embeddings')
    log.info('hi')
    log.debug('hi')

    expect(port.postMessage).not.toHaveBeenCalled()
  })

  it('no-ops and never installs a transport when process.parentPort is undefined', () => {
    setParentPort(undefined)

    expect(() => installWorkerLogForwarding('Embeddings')).not.toThrow()
    expect((log.transports as unknown as Record<string, unknown>).forwardToMain).toBeUndefined()
  })

  it('sanitizes an Error arg and drops a function arg without throwing', () => {
    const port: ParentPortStub = { postMessage: vi.fn() }
    setParentPort(port)

    installWorkerLogForwarding('Embeddings')

    expect(() => log.error('boom', new Error('inner'), () => {})).not.toThrow()

    expect(port.postMessage).toHaveBeenCalledTimes(1)
    const [[posted]] = port.postMessage.mock.calls as [
      [{ type: string; record: { data: unknown[] } }]
    ]
    expect(posted.type).toBe('log')
    expect(posted.record.data).toEqual(['boom', { name: 'Error', message: 'inner' }])
  })
})
