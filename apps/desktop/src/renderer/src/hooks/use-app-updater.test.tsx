import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key,
    t: (key: string) => key
  })
}))

type Hooks = typeof import('./use-app-updater')

const baseState: AppUpdateState = {
  currentVersion: '1.0.0',
  status: 'idle',
  updateSupported: true,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  releaseNotesHtml: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null,
  autoCheckEnabled: true
}

const makeState = (patch: Partial<AppUpdateState> = {}): AppUpdateState => ({
  ...baseState,
  ...patch
})

let hooks: Hooks
let listeners: Array<(next: AppUpdateState) => void>
let onUpdaterStateChanged: ReturnType<typeof vi.fn>
let updaterApi: {
  getState: ReturnType<typeof vi.fn>
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
  setAutoCheck: ReturnType<typeof vi.fn>
}

/** Push a main-process broadcast through every registered renderer listener. */
async function broadcast(next: AppUpdateState): Promise<void> {
  await act(async () => {
    for (const listener of [...listeners]) listener(next)
  })
}

interface FullSample {
  status: AppUpdateState['status']
  percent: number | null
  version: string | null
  isLoading: boolean
  error: string | null
}

/** Records every render and the exact updater values that render observed. */
function FullConsumer({ log }: { log: FullSample[] }): null {
  const { state, isLoading, error } = hooks.useAppUpdater()
  log.push({
    status: state.status,
    percent: state.downloadProgressPercent,
    version: state.availableVersion,
    isLoading,
    error
  })
  return null
}

interface InstallSample {
  isInstalling: boolean
  version: string | null
}

/** Mirrors what App.tsx needs: the installing flag and the version, nothing else. */
function InstallConsumer({ log }: { log: InstallSample[] }): null {
  const isInstalling = hooks.useAppUpdaterSelector((state) => state.status === 'installing')
  const version = hooks.useAppUpdaterSelector((state) => state.availableVersion)
  log.push({ isInstalling, version })
  return null
}

beforeEach(async () => {
  vi.resetModules()
  listeners = []
  onUpdaterStateChanged = vi.fn((callback: (next: AppUpdateState) => void) => {
    listeners.push(callback)
    return () => {
      listeners = listeners.filter((entry) => entry !== callback)
    }
  })
  updaterApi = {
    getState: vi.fn().mockResolvedValue(makeState()),
    checkForUpdates: vi.fn().mockResolvedValue(makeState({ status: 'up-to-date' })),
    downloadUpdate: vi.fn().mockResolvedValue(makeState({ status: 'downloading' })),
    quitAndInstall: vi.fn().mockResolvedValue(undefined),
    setAutoCheck: vi.fn().mockResolvedValue(makeState({ autoCheckEnabled: false }))
  }
  ;(window as unknown as { api: unknown }).api = { updater: updaterApi, onUpdaterStateChanged }
  hooks = await import('./use-app-updater')
})

describe('useAppUpdater shared store', () => {
  it('opens one main-process subscription and one getState() round-trip for all consumers', async () => {
    const logs: FullSample[][] = [[], [], [], [], []]

    await act(async () => {
      render(
        <>
          <FullConsumer log={logs[0]} />
          <FullConsumer log={logs[1]} />
          <FullConsumer log={logs[2]} />
          <FullConsumer log={logs[3]} />
          <FullConsumer log={logs[4]} />
        </>
      )
    })

    expect(onUpdaterStateChanged).toHaveBeenCalledTimes(1)
    expect(updaterApi.getState).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(1)
  })

  it('does not re-render selector consumers when only the download percent changes', async () => {
    const fullLog: FullSample[] = []
    const installLog: InstallSample[] = []

    await act(async () => {
      render(
        <>
          <FullConsumer log={fullLog} />
          <InstallConsumer log={installLog} />
        </>
      )
    })

    const fullAtMount = fullLog.length
    const installAtMount = installLog.length

    await broadcast(makeState({ status: 'downloading', downloadProgressPercent: 10 }))
    await broadcast(makeState({ status: 'downloading', downloadProgressPercent: 55 }))
    await broadcast(makeState({ status: 'downloading', downloadProgressPercent: 100 }))

    // The full-state consumer (sidebar progress bar) must see every tick verbatim.
    expect(fullLog.length - fullAtMount).toBe(3)
    expect(fullLog.slice(fullAtMount).map((sample) => sample.percent)).toEqual([10, 55, 100])
    expect(fullLog.slice(fullAtMount).map((sample) => sample.status)).toEqual([
      'downloading',
      'downloading',
      'downloading'
    ])

    // App.tsx's slice is unchanged by progress, so the app tree must not re-render.
    expect(installLog.length - installAtMount).toBe(0)
    expect(installLog.at(-1)).toEqual({ isInstalling: false, version: null })
  })

  it('re-renders selector consumers when their own slice changes', async () => {
    const installLog: InstallSample[] = []

    await act(async () => {
      render(<InstallConsumer log={installLog} />)
    })

    const atMount = installLog.length

    await broadcast(makeState({ status: 'available', availableVersion: '2.0.0' }))
    await broadcast(
      makeState({ status: 'downloading', availableVersion: '2.0.0', downloadProgressPercent: 40 })
    )
    await broadcast(makeState({ status: 'installing', availableVersion: '2.0.0' }))

    expect(installLog.slice(atMount)).toEqual([
      { isInstalling: false, version: '2.0.0' },
      { isInstalling: true, version: '2.0.0' }
    ])
  })

  it('delivers every updater phase to every consumer', async () => {
    const a: FullSample[] = []
    const b: FullSample[] = []

    await act(async () => {
      render(
        <>
          <FullConsumer log={a} />
          <FullConsumer log={b} />
        </>
      )
    })

    const startA = a.length
    const startB = b.length

    await broadcast(makeState({ status: 'available', availableVersion: '2.0.0' }))
    await broadcast(
      makeState({ status: 'downloading', availableVersion: '2.0.0', downloadProgressPercent: 0 })
    )
    await broadcast(
      makeState({ status: 'downloading', availableVersion: '2.0.0', downloadProgressPercent: 100 })
    )
    await broadcast(
      makeState({ status: 'downloaded', availableVersion: '2.0.0', downloadProgressPercent: 100 })
    )
    await broadcast(
      makeState({ status: 'error', availableVersion: '2.0.0', error: 'install failed' })
    )
    await broadcast(makeState({ status: 'up-to-date' }))

    const expected = [
      { status: 'available', percent: null, version: '2.0.0' },
      { status: 'downloading', percent: 0, version: '2.0.0' },
      { status: 'downloading', percent: 100, version: '2.0.0' },
      { status: 'downloaded', percent: 100, version: '2.0.0' },
      { status: 'error', percent: null, version: '2.0.0' },
      { status: 'up-to-date', percent: null, version: null }
    ]

    for (const log of [a.slice(startA), b.slice(startB)]) {
      expect(
        log.map((sample) => ({
          status: sample.status,
          percent: sample.percent,
          version: sample.version
        }))
      ).toEqual(expected)
    }
    // The install failure the user must see is carried on the state, not swallowed.
    expect(a.at(-2)?.status).toBe('error')
  })

  it('never caches a stale result: a later broadcast overrides "no update available"', async () => {
    const log: FullSample[] = []

    await act(async () => {
      render(<FullConsumer log={log} />)
    })

    await broadcast(makeState({ status: 'up-to-date' }))
    expect(log.at(-1)?.status).toBe('up-to-date')

    await broadcast(makeState({ status: 'available', availableVersion: '3.0.0' }))
    expect(log.at(-1)).toMatchObject({ status: 'available', version: '3.0.0' })
  })

  it('re-reads state from main when the last consumer unmounts and a new one mounts', async () => {
    const first: FullSample[] = []

    const view = await act(async () => render(<FullConsumer log={first} />))

    expect(updaterApi.getState).toHaveBeenCalledTimes(1)
    await broadcast(makeState({ status: 'downloading', downloadProgressPercent: 33 }))

    await act(async () => {
      view.unmount()
    })
    expect(listeners).toHaveLength(0)

    let resolveState: (state: AppUpdateState) => void = () => {}
    updaterApi.getState.mockReturnValue(
      new Promise<AppUpdateState>((resolve) => {
        resolveState = resolve
      })
    )

    const second: FullSample[] = []
    await act(async () => {
      render(<FullConsumer log={second} />)
    })

    expect(updaterApi.getState).toHaveBeenCalledTimes(2)
    expect(onUpdaterStateChanged).toHaveBeenCalledTimes(2)
    // The dropped snapshot must not resurface: no stale 'downloading 33%'.
    expect(second[0]).toEqual({
      status: 'unavailable',
      percent: null,
      version: null,
      isLoading: true,
      error: null
    })

    await act(async () => {
      resolveState(makeState({ status: 'available', availableVersion: '4.0.0' }))
    })
    expect(second.at(-1)).toMatchObject({ status: 'available', version: '4.0.0', isLoading: false })
  })

  it('shares one snapshot with a consumer that mounts after the first load', async () => {
    const first: FullSample[] = []
    await act(async () => {
      render(<FullConsumer log={first} />)
    })
    await broadcast(makeState({ status: 'downloading', downloadProgressPercent: 33 }))

    const late: FullSample[] = []
    await act(async () => {
      render(<FullConsumer log={late} />)
    })

    expect(updaterApi.getState).toHaveBeenCalledTimes(1)
    expect(late[0]).toEqual({
      status: 'downloading',
      percent: 33,
      version: null,
      isLoading: false,
      error: null
    })
  })

  it('surfaces a failed initial load as an error on every consumer', async () => {
    updaterApi.getState.mockRejectedValue(new Error('getState exploded'))
    const log: FullSample[] = []

    await act(async () => {
      render(<FullConsumer log={log} />)
    })

    expect(log.at(-1)).toMatchObject({ error: 'getState exploded', isLoading: false })
  })

  it('publishes action results to every consumer and clears the previous error', async () => {
    const log: FullSample[] = []
    let api: ReturnType<Hooks['useAppUpdater']> | null = null

    function ActionHost(): null {
      api = hooks.useAppUpdater()
      return null
    }

    await act(async () => {
      render(
        <>
          <FullConsumer log={log} />
          <ActionHost />
        </>
      )
    })

    await act(async () => {
      await api!.checkForUpdates()
    })
    expect(log.at(-1)).toMatchObject({ status: 'up-to-date', error: null })

    await act(async () => {
      await api!.downloadUpdate()
    })
    expect(log.at(-1)).toMatchObject({ status: 'downloading' })

    await act(async () => {
      await api!.setAutoCheck(false)
    })
    expect(updaterApi.setAutoCheck).toHaveBeenCalledWith(false)

    // Put a real error on the store first, so the clear is observable.
    updaterApi.setAutoCheck.mockRejectedValueOnce(new Error('auto-check failed'))
    await act(async () => {
      await expect(api!.setAutoCheck(true)).rejects.toThrow('auto-check failed')
    })
    expect(log.at(-1)?.error).toBe('auto-check failed')

    await act(async () => {
      await api!.quitAndInstall()
    })
    expect(updaterApi.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(log.at(-1)?.error).toBeNull()
  })

  it('surfaces action failures as errors on every consumer', async () => {
    const log: FullSample[] = []
    let api: ReturnType<Hooks['useAppUpdater']> | null = null

    function ActionHost(): null {
      api = hooks.useAppUpdater()
      return null
    }

    await act(async () => {
      render(
        <>
          <FullConsumer log={log} />
          <ActionHost />
        </>
      )
    })

    updaterApi.checkForUpdates.mockRejectedValue(new Error('check failed'))
    await act(async () => {
      await expect(api!.checkForUpdates()).rejects.toThrow('check failed')
    })
    expect(log.at(-1)?.error).toBe('check failed')

    updaterApi.downloadUpdate.mockRejectedValue(new Error('download failed'))
    await act(async () => {
      await expect(api!.downloadUpdate()).rejects.toThrow('download failed')
    })
    expect(log.at(-1)?.error).toBe('download failed')

    updaterApi.quitAndInstall.mockRejectedValue(new Error('install failed'))
    await act(async () => {
      await expect(api!.quitAndInstall()).rejects.toThrow('install failed')
    })
    expect(log.at(-1)?.error).toBe('install failed')

    updaterApi.setAutoCheck.mockRejectedValue(new Error('auto-check failed'))
    await act(async () => {
      await expect(api!.setAutoCheck(false)).rejects.toThrow('auto-check failed')
    })
    expect(log.at(-1)?.error).toBe('auto-check failed')
  })
})
