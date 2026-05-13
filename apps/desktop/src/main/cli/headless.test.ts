import { describe, expect, it, vi } from 'vitest'
import { getHeadlessCliArgs, runHeadlessCli } from './headless'

describe('headless CLI mode', () => {
  it('extracts the arguments after --cli', () => {
    expect(
      getHeadlessCliArgs([
        '/Applications/Memry.app/Contents/MacOS/Memry',
        '--cli',
        '--vault',
        '/Users/test/MemryVault',
        'notes',
        'list'
      ])
    ).toEqual(['--vault', '/Users/test/MemryVault', 'notes', 'list'])
  })

  it('returns null when the app was launched normally', () => {
    expect(getHeadlessCliArgs(['/Applications/Memry.app/Contents/MacOS/Memry'])).toBeNull()
  })

  it('runs the CLI and exits with its status code', async () => {
    const runCli = vi.fn(async () => 2)
    const exit = vi.fn()

    await runHeadlessCli(['--vault', '/Users/test/MemryVault', 'vault', 'status'], {
      runCli,
      exit
    })

    expect(runCli).toHaveBeenCalledWith(['--vault', '/Users/test/MemryVault', 'vault', 'status'])
    expect(exit).toHaveBeenCalledWith(2)
  })
})
