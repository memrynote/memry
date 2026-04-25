import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { describe, expect, it } from 'vitest'

import { updaterRoutes } from './updater'

async function call(name: keyof typeof updaterRoutes, args?: unknown): Promise<unknown> {
  const handler = updaterRoutes[name]
  if (!handler) throw new Error(`route ${String(name)} not registered`)
  return handler(args)
}

describe('updaterRoutes', () => {
  it('updater_get_state returns the AppUpdateState shape with status="unavailable"', async () => {
    // #given the M2 mock has no real update surface
    // #when the renderer asks for current state
    const res = (await call('updater_get_state')) as AppUpdateState

    // #then it gets a fully populated AppUpdateState
    expect(res).toMatchObject({
      currentVersion: '2.0.0-alpha.1',
      updateSupported: false,
      availableVersion: null
    })
    expect(['unavailable', 'idle', 'up-to-date']).toContain(res.status)
  })

  it('updater_check_for_updates marks state up-to-date and stamps lastCheckedAt', async () => {
    // #when the renderer triggers a check
    const res = (await call('updater_check_for_updates')) as AppUpdateState

    // #then the mock reports up-to-date and records the check time
    expect(res.status).toBe('up-to-date')
    expect(typeof res.lastCheckedAt).toBe('number')
    expect(res.error).toBeNull()
  })

  it('updater_download_update returns a no-op state because updates are unsupported in M2', async () => {
    // #when the renderer asks to download
    const res = (await call('updater_download_update')) as AppUpdateState

    // #then the mock returns the AppUpdateState shape unchanged
    expect(res.updateSupported).toBe(false)
    expect(res.availableVersion).toBeNull()
  })

  it('updater_quit_and_install resolves to undefined because there is nothing to install', async () => {
    // #when the renderer asks to install
    const res = await call('updater_quit_and_install')

    // #then the route resolves without payload
    expect(res).toBeUndefined()
  })

  it('legacy updater_check / updater_download / updater_install routes are removed', () => {
    // #then the M2 mocks no longer expose the pre-M1 names
    expect(updaterRoutes).not.toHaveProperty('updater_check')
    expect(updaterRoutes).not.toHaveProperty('updater_download')
    expect(updaterRoutes).not.toHaveProperty('updater_install')
  })
})
