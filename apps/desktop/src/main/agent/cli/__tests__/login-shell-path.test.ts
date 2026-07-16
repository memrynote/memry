import { describe, expect, it, vi } from 'vitest'

import {
  PATH_MARKER,
  applyLoginShellPath,
  mergePaths,
  parseShellPath,
  readLoginShellPath
} from '../login-shell-path'

describe('parseShellPath', () => {
  it('extracts PATH from the marker line', () => {
    const stdout = `${PATH_MARKER}/opt/homebrew/bin:/usr/bin:/bin\n`
    expect(parseShellPath(stdout)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('ignores rc noise printed before the marker', () => {
    const stdout = [
      'nvm: loaded',
      'some rc banner',
      `${PATH_MARKER}/Users/me/.local/bin:/usr/bin`
    ].join('\n')
    expect(parseShellPath(stdout)).toBe('/Users/me/.local/bin:/usr/bin')
  })

  it('trims trailing CR/whitespace', () => {
    expect(parseShellPath(`${PATH_MARKER}/usr/bin:/bin  \r\n`)).toBe('/usr/bin:/bin')
  })

  it('returns null when the marker is absent', () => {
    expect(parseShellPath('/usr/bin:/bin\n')).toBeNull()
  })

  it('returns null when nothing usable follows the marker', () => {
    expect(parseShellPath(`${PATH_MARKER}\n`)).toBeNull()
  })
})

describe('mergePaths', () => {
  it('puts resolved dirs first, then current-only dirs, deduped', () => {
    const merged = mergePaths('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', ':')
    expect(merged).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('drops exact duplicate entries', () => {
    expect(mergePaths('/usr/bin:/usr/bin', '/usr/bin', ':')).toBe('/usr/bin')
  })

  it('returns resolved when current is empty', () => {
    expect(mergePaths('', '/opt/homebrew/bin', ':')).toBe('/opt/homebrew/bin')
  })

  it('returns current when resolved is empty', () => {
    expect(mergePaths('/usr/bin', '', ':')).toBe('/usr/bin')
  })
})

describe('readLoginShellPath', () => {
  const spawnOk = (path: string) =>
    vi.fn().mockReturnValue({ status: 0, stdout: `${PATH_MARKER}${path}\n`, stderr: '' })

  it('returns the login-shell PATH on a successful probe', () => {
    const spawn = spawnOk('/opt/homebrew/bin:/usr/bin')
    expect(readLoginShellPath(spawn as never)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('invokes an interactive login shell', () => {
    const spawn = spawnOk('/usr/bin')
    readLoginShellPath(spawn as never)
    const args = spawn.mock.calls[0][1] as string[]
    expect(args[0]).toBe('-ilc')
  })

  it('returns null when the probe exits non-zero', () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'boom' })
    expect(readLoginShellPath(spawn as never)).toBeNull()
  })

  it('returns null when the probe throws', () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error('spawn failed')
    })
    expect(readLoginShellPath(spawn as never)).toBeNull()
  })
})

describe('applyLoginShellPath', () => {
  it('augments env.PATH when packaged on a non-Windows platform', () => {
    const env = { PATH: '/usr/bin:/bin' }
    const applied = applyLoginShellPath({
      packaged: true,
      platform: 'darwin',
      env,
      resolve: () => '/opt/homebrew/bin:/usr/bin'
    })
    expect(applied).toBe(true)
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('is a no-op when the app is not packaged (terminal already has full PATH)', () => {
    const env = { PATH: '/usr/bin:/bin' }
    const applied = applyLoginShellPath({
      packaged: false,
      platform: 'darwin',
      env,
      resolve: () => '/opt/homebrew/bin'
    })
    expect(applied).toBe(false)
    expect(env.PATH).toBe('/usr/bin:/bin')
  })

  it('is a no-op on Windows (GUI apps inherit the system PATH)', () => {
    const env = { PATH: 'C:\\Windows' }
    const applied = applyLoginShellPath({
      packaged: true,
      platform: 'win32',
      env,
      resolve: () => 'C:\\tools'
    })
    expect(applied).toBe(false)
    expect(env.PATH).toBe('C:\\Windows')
  })

  it('is a no-op when the login-shell PATH cannot be resolved', () => {
    const env = { PATH: '/usr/bin:/bin' }
    const applied = applyLoginShellPath({
      packaged: true,
      platform: 'darwin',
      env,
      resolve: () => null
    })
    expect(applied).toBe(false)
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})
