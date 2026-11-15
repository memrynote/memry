import { authService } from './auth-service'

export const deviceService = {
  getDevices: () => {
    return window.api.syncDevices.getDevices()
  },

  removeDevice: (input: { deviceId: string }) => {
    return window.api.syncDevices.removeDevice(input)
  },

  renameDevice: (input: { deviceId: string; newName: string }) => {
    return window.api.syncDevices.renameDevice(input)
  }
}

export const setupService = {
  setupNewAccount: authService.setupNewAccount,

  confirmRecoveryPhrase: authService.confirmRecoveryPhrase
}
