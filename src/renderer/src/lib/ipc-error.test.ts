import { describe, expect, it } from 'vitest'

import { extractErrorMessage } from './ipc-error'

describe('extractErrorMessage', () => {
  it('strips ipcMain handler prefixes from Error objects', () => {
    const error = new Error(
      "Error occurred in handler for 'sync:link-via-recovery': Error: Incorrect recovery phrase"
    )

    expect(extractErrorMessage(error, 'Recovery failed')).toBe('Incorrect recovery phrase')
  })

  it('strips invoke prefixes from string errors', () => {
    const error = "Error invoking remote method 'sync:auth-verify-otp': Error: Invalid OTP code"

    expect(extractErrorMessage(error, 'Verification failed')).toBe('Invalid OTP code')
  })

  it('strips nested Error prefixes repeatedly', () => {
    const error =
      "Error: Error occurred in handler for 'sync:link-via-recovery': Error: Incorrect recovery phrase"

    expect(extractErrorMessage(error, 'Recovery failed')).toBe('Incorrect recovery phrase')
  })

  it('falls back when message is empty', () => {
    expect(extractErrorMessage('', 'Custom fallback')).toBe('Custom fallback')
    expect(extractErrorMessage({ message: 'not-an-error' }, 'Custom fallback')).toBe(
      'Custom fallback'
    )
  })
})
