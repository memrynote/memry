import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import type { DataDb } from '../../src/main/database/types'

/** Registers this install as the current sync device, so a claim by another id is "elsewhere". */
export function insertThisDevice(db: DataDb, id = 'this-device'): void {
  db.insert(syncDevices)
    .values({
      id,
      name: 'This Mac',
      platform: 'macos',
      appVersion: '1.0.0',
      linkedAt: new Date(),
      isCurrentDevice: true,
      signingPublicKey: 'key'
    })
    .run()
}
