import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import type { DataDb } from '../../database'
import { isMemryUserSignedIn } from '../../auth-state'
import { getFromServer } from '../../sync/http-client'
import { getValidAccessToken } from '../../sync/token-manager'
import type { RemoteDeviceForCompat, WriterCompatDeps } from './writer-compat'

function parseDevices(raw: unknown): RemoteDeviceForCompat[] | null {
  if (!raw || typeof raw !== 'object') return null
  const list = (raw as { devices?: unknown }).devices
  if (!Array.isArray(list)) return null
  const devices: RemoteDeviceForCompat[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') return null
    const row = entry as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.name !== 'string') return null
    devices.push({
      id: row.id,
      name: row.name,
      platform: typeof row.platform === 'string' ? row.platform : 'unknown',
      // A server that predates `appVersion` omits it: unknown, not current.
      appVersion: typeof row.appVersion === 'string' ? row.appVersion : null
    })
  }
  return devices
}

/** The live dependencies: the Memry session, `GET /devices`, and this device's id. */
export function createWriterCompatDeps(db: DataDb): WriterCompatDeps {
  return {
    isSignedIn: () => isMemryUserSignedIn(),
    async listDevices() {
      const token = await getValidAccessToken()
      if (!token) return null
      return parseDevices(await getFromServer<unknown>('/devices', token))
    },
    currentDeviceId: () => getCurrentDeviceId(db)
  }
}
