import { describe, it, expect, vi } from 'vitest'
import { runGenerateBindings } from './generate-bindings'

describe('runGenerateBindings', () => {
  it('invokes cargo with correct command and cwd in src-tauri', () => {
    // #given
    const execFn = vi.fn()
    const appRoot = '/path/to/desktop-tauri'

    // #when
    runGenerateBindings(execFn, appRoot)

    // #then
    expect(execFn).toHaveBeenCalledTimes(1)
    const [cmd, opts] = execFn.mock.calls[0]
    expect(cmd).toBe('cargo run --bin generate_bindings --quiet')
    expect(opts).toMatchObject({
      cwd: '/path/to/desktop-tauri/src-tauri',
      stdio: 'inherit'
    })
  })

  it('returns exitCode 0 on success', () => {
    // #given
    const execFn = vi.fn().mockReturnValue(undefined)
    const appRoot = '/path/to/desktop-tauri'

    // #when
    const result = runGenerateBindings(execFn, appRoot)

    // #then
    expect(result.exitCode).toBe(0)
  })

  it('propagates cargo failure as thrown error', () => {
    // #given
    const execFn = vi.fn(() => {
      throw new Error('cargo exited with code 101')
    })
    const appRoot = '/path/to/desktop-tauri'

    // #when / #then
    expect(() => runGenerateBindings(execFn, appRoot)).toThrow('cargo exited with code 101')
  })
})
