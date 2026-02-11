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
  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) => {
    return window.api.syncSetup.setupFirstDevice(input)
  },

  setupNewAccount: () => {
    return window.api.syncSetup.setupNewAccount()
  },

  confirmRecoveryPhrase: (input: { confirmed: boolean }) => {
    return window.api.syncSetup.confirmRecoveryPhrase(input)
  }
}
