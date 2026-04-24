import { describe, it, expect, vi } from 'vitest'
import { runCheckBindings } from './check-bindings'

describe('runCheckBindings', () => {
  it('runs bindings:generate then git diff --exit-code on bindings.ts', () => {
    // #given
    const execFn = vi.fn()
    const appRoot = '/path/to/desktop-tauri'

    // #when
    runCheckBindings(execFn, appRoot)

    // #then
    expect(execFn).toHaveBeenCalledTimes(2)
    expect(execFn.mock.calls[0][0]).toBe('pnpm bindings:generate')
    expect(execFn.mock.calls[0][1]).toMatchObject({ cwd: appRoot })
    expect(execFn.mock.calls[1][0]).toBe('git diff --exit-code -- src/generated/bindings.ts')
    expect(execFn.mock.calls[1][1]).toMatchObject({ cwd: appRoot })
  })

  it('returns exitCode 0 when no drift', () => {
    // #given
    const execFn = vi.fn().mockReturnValue(undefined)
    const appRoot = '/path/to/desktop-tauri'

    // #when
    const result = runCheckBindings(execFn, appRoot)

    // #then
    expect(result.exitCode).toBe(0)
    expect(result.drift).toBe(false)
  })

  it('returns exitCode 1 when git diff throws (drift detected)', () => {
    // #given
    const execFn = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error('git diff non-zero exit')
      })
    const appRoot = '/path/to/desktop-tauri'

    // #when
    const result = runCheckBindings(execFn, appRoot)

    // #then
    expect(result.exitCode).toBe(1)
    expect(result.drift).toBe(true)
  })

  it('propagates bindings:generate failure without swallowing', () => {
    // #given
    const execFn = vi.fn().mockImplementationOnce(() => {
      throw new Error('cargo compile error')
    })
    const appRoot = '/path/to/desktop-tauri'

    // #when / #then
    expect(() => runCheckBindings(execFn, appRoot)).toThrow('cargo compile error')
    expect(execFn).toHaveBeenCalledTimes(1)
  })
})
