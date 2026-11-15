import { authService, envelope } from './auth-service'
import { commands } from '../../../generated/bindings'

/** The account's devices, in Electron's shapes (`ipc/auth-device-handlers.ts:515-641`). */
export const deviceService = {
  getDevices: async () => {
    const list = await commands.syncGetDevices()
    return {
      devices: list.devices.map((device) => ({
        ...device,
        lastSyncAt: device.lastSyncAt ?? undefined
      })),
      email: list.email ?? undefined,
      needsRecoveryConfirmation: list.needsRecoveryConfirmation
    }
  },

  removeDevice: (input: { deviceId: string }) =>
    envelope(async () => {
      await commands.syncRemoveDevice(input.deviceId)
      return {}
    }),

  renameDevice: (input: { deviceId: string; newName: string }) =>
    envelope(async () => {
      await commands.syncRenameDevice(input.deviceId, input.newName)
      return {}
    })
}

export const setupService = {
  setupNewAccount: authService.setupNewAccount,

  confirmRecoveryPhrase: authService.confirmRecoveryPhrase
}
