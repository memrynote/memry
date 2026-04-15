import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

const handleMock = vi.fn()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args)
  }
}))

import { registerCommand } from './register-command'

describe('registerCommand', () => {
  beforeEach(() => {
    handleMock.mockReset()
  })

  it('registers a single ipcMain.handle with the given channel', () => {
    // #given
    const schema = z.object({ id: z.string() })
    const command = vi.fn(async () => ({ success: true as const }))

    // #when
    registerCommand('test:channel', schema, command)

    // #then
    expect(handleMock).toHaveBeenCalledTimes(1)
    expect(handleMock.mock.calls[0][0]).toBe('test:channel')
  })

  it('validates input and forwards validated data to command', async () => {
    // #given
    const schema = z.object({ id: z.string().min(1) })
    const command = vi.fn(async (input: { id: string }) => ({
      success: true as const,
      id: input.id
    }))
    registerCommand('test:validate', schema, command)
    const registeredHandler = handleMock.mock.calls[0][1] as (
      event: unknown,
      raw: unknown
    ) => Promise<unknown>

    // #when
    const result = await registeredHandler({}, { id: 'abc' })

    // #then
    expect(command).toHaveBeenCalledWith({ id: 'abc' })
    expect(result).toEqual({ success: true, id: 'abc' })
  })

  it('throws on invalid input (schema parse failure)', async () => {
    // #given
    const schema = z.object({ id: z.string().min(1) })
    const command = vi.fn()
    registerCommand('test:invalid', schema, command)
    const registeredHandler = handleMock.mock.calls[0][1] as (
      event: unknown,
      raw: unknown
    ) => Promise<unknown>

    // #when / #then
    await expect(registeredHandler({}, { id: '' })).rejects.toThrow(/Validation failed/)
    expect(command).not.toHaveBeenCalled()
  })

  it('catches thrown errors and returns success:false envelope', async () => {
    // #given
    const schema = z.object({ id: z.string() })
    const command = vi.fn(async () => {
      throw new Error('boom')
    })
    registerCommand('test:error', schema, command, 'Failed to do the thing')
    const registeredHandler = handleMock.mock.calls[0][1] as (
      event: unknown,
      raw: unknown
    ) => Promise<unknown>

    // #when
    const result = await registeredHandler({}, { id: 'x' })

    // #then
    expect(result).toEqual({ success: false, error: 'boom' })
  })

  it('falls back to provided fallback message when error has no message', async () => {
    // #given
    const schema = z.object({ id: z.string() })
    const command = vi.fn(async () => {
      throw 'raw string not error'
    })
    registerCommand('test:fallback', schema, command, 'Failed fallback')
    const registeredHandler = handleMock.mock.calls[0][1] as (
      event: unknown,
      raw: unknown
    ) => Promise<unknown>

    // #when
    const result = await registeredHandler({}, { id: 'x' })

    // #then
    expect(result).toEqual({ success: false, error: 'Failed fallback' })
  })
})
