import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ trackMainLog: vi.fn() }))

vi.mock('../../../telemetry/diagnostics', () => ({ trackMainLog: mocks.trackMainLog }))

import {
  PATH_MARKER,
  type RunShellProbe,
  applyLoginShellPath,
  mergePaths,
  parseShellPath,
  readLoginShellPath
} from '../login-shell-path'

const probeOk =
  (path: string): RunShellProbe =>
  async () =>
    `${PATH_MARKER}${path}\n`

const probeThrows =
  (error: unknown): RunShellProbe =>
  async () => {
    throw error
  }

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const freshModule = async (): Promise<typeof import('../login-shell-path')> => {
  vi.resetModules()
  return import('../login-shell-path')
}

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
  beforeEach(() => {
    mocks.trackMainLog.mockClear()
  })

  it('returns the login-shell PATH on a successful probe', async () => {
    await expect(readLoginShellPath(probeOk('/opt/homebrew/bin:/usr/bin'))).resolves.toBe(
      '/opt/homebrew/bin:/usr/bin'
    )
  })

  it('invokes an interactive login shell', async () => {
    const run = vi.fn(probeOk('/usr/bin'))
    await readLoginShellPath(run)
    expect(run.mock.calls[0][1][0]).toBe('-ilc')
  })

  it('reports a non-zero exit as its status', async () => {
    const error = Object.assign(new Error('boom'), { code: 1 })
    await expect(readLoginShellPath(probeThrows(error))).resolves.toBeNull()
    expect(mocks.trackMainLog).toHaveBeenCalledWith(
      'warn',
      expect.objectContaining({ action: 'login_shell_path_probe_failed', errorCode: 'status_1' })
    )
  })

  it('reports a shell that never started as a spawn error', async () => {
    const error = Object.assign(new Error('nope'), { code: 'ENOENT' })
    await expect(readLoginShellPath(probeThrows(error))).resolves.toBeNull()
    expect(mocks.trackMainLog).toHaveBeenCalledWith(
      'warn',
      expect.objectContaining({ action: 'login_shell_path_probe_failed', errorCode: 'spawn_error' })
    )
  })

  it('reports stdout without the marker', async () => {
    const run: RunShellProbe = async () => 'rc banner only\n'
    await expect(readLoginShellPath(run)).resolves.toBeNull()
    expect(mocks.trackMainLog).toHaveBeenCalledWith(
      'warn',
      expect.objectContaining({ errorCode: 'marker_missing' })
    )
  })
})

describe('applyLoginShellPath', () => {
  it('augments env.PATH when packaged on a non-Windows platform', async () => {
    const env = { PATH: '/usr/bin:/bin' }
    const applied = await applyLoginShellPath({
      packaged: true,
      platform: 'darwin',
      env,
      resolve: async () => '/opt/homebrew/bin:/usr/bin'
    })
    expect(applied).toBe(true)
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('is a no-op when the app is not packaged (terminal already has full PATH)', async () => {
    const env = { PATH: '/usr/bin:/bin' }
    const resolve = vi.fn(async () => '/opt/homebrew/bin')
    const applied = await applyLoginShellPath({
      packaged: false,
      platform: 'darwin',
      env,
      resolve
    })
    expect(applied).toBe(false)
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('is a no-op on Windows (GUI apps inherit the system PATH)', async () => {
    const env = { PATH: 'C:\\Windows' }
    const applied = await applyLoginShellPath({
      packaged: true,
      platform: 'win32',
      env,
      resolve: async () => 'C:\\tools'
    })
    expect(applied).toBe(false)
    expect(env.PATH).toBe('C:\\Windows')
  })

  it('is a no-op when the login-shell PATH cannot be resolved', async () => {
    const env = { PATH: '/usr/bin:/bin' }
    const applied = await applyLoginShellPath({
      packaged: true,
      platform: 'darwin',
      env,
      resolve: async () => null
    })
    expect(applied).toBe(false)
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})

describe('startLoginShellPathAugmentation', () => {
  it('runs one probe however many callers start it', async () => {
    const module = await freshModule()
    const env = { PATH: '/usr/bin' }
    const resolve = vi.fn(async () => '/opt/homebrew/bin')
    const options = { packaged: true, platform: 'darwin' as const, env, resolve }

    const first = module.startLoginShellPathAugmentation(options)
    const second = module.startLoginShellPathAugmentation(options)

    expect(second).toBe(first)
    await expect(first).resolves.toBe(true)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('holds whenLoginShellPathApplied open until the probe settles', async () => {
    const module = await freshModule()
    const env = { PATH: '/usr/bin' }
    let release: (path: string) => void = () => {}

    module.startLoginShellPathAugmentation({
      packaged: true,
      platform: 'darwin',
      env,
      resolve: () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    })

    let settled = false
    const waiter = module.whenLoginShellPathApplied().then(() => {
      settled = true
    })

    await flush()
    expect(settled).toBe(false)
    expect(env.PATH).toBe('/usr/bin')

    release('/opt/homebrew/bin')
    await waiter
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('survives a probe that rejects outright', async () => {
    const module = await freshModule()
    const applied = module.startLoginShellPathAugmentation({
      packaged: true,
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      resolve: async () => {
        throw new Error('shell exploded')
      }
    })
    await expect(applied).resolves.toBe(false)
    await expect(module.whenLoginShellPathApplied()).resolves.toBeUndefined()
  })

  it('resolves whenLoginShellPathApplied when no augmentation was started', async () => {
    const module = await freshModule()
    await expect(module.whenLoginShellPathApplied()).resolves.toBeUndefined()
  })
})
