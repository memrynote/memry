import keytar from 'keytar'

const SERVICE = 'com.memry.calendar.google'
const ACCESS_TOKEN_ACCOUNT = 'access-token'
const REFRESH_TOKEN_ACCOUNT = 'refresh-token'

function resolveAccount(account: string): string {
  const deviceSuffix = process.env.MEMRY_DEVICE
  return deviceSuffix ? `${account}-${deviceSuffix}` : account
}

async function setPassword(account: string, value: string | null): Promise<void> {
  const resolvedAccount = resolveAccount(account)

  try {
    if (!value || value.trim().length === 0) {
      await keytar.deletePassword(SERVICE, resolvedAccount)
      return
    }

    await keytar.setPassword(SERVICE, resolvedAccount, value.trim())
  } catch (error) {
    throw new Error(
      `Failed to store Google Calendar credential (${resolvedAccount}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

async function getPassword(account: string): Promise<string | null> {
  const resolvedAccount = resolveAccount(account)

  try {
    return await keytar.getPassword(SERVICE, resolvedAccount)
  } catch (error) {
    throw new Error(
      `Failed to read Google Calendar credential (${resolvedAccount}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

async function deletePassword(account: string): Promise<void> {
  const resolvedAccount = resolveAccount(account)

  try {
    await keytar.deletePassword(SERVICE, resolvedAccount)
  } catch (error) {
    throw new Error(
      `Failed to delete Google Calendar credential (${resolvedAccount}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

export async function storeGoogleCalendarTokens(input: {
  accessToken: string
  refreshToken: string
}): Promise<void> {
  await setPassword(ACCESS_TOKEN_ACCOUNT, input.accessToken)
  await setPassword(REFRESH_TOKEN_ACCOUNT, input.refreshToken)
}

export async function getGoogleCalendarTokens(): Promise<{
  accessToken: string | null
  refreshToken: string | null
}> {
  const [accessToken, refreshToken] = await Promise.all([
    getPassword(ACCESS_TOKEN_ACCOUNT),
    getPassword(REFRESH_TOKEN_ACCOUNT)
  ])

  return { accessToken, refreshToken }
}

export async function hasGoogleCalendarTokens(): Promise<boolean> {
  const { refreshToken } = await getGoogleCalendarTokens()
  return typeof refreshToken === 'string' && refreshToken.trim().length > 0
}

export async function clearGoogleCalendarTokens(): Promise<void> {
  await Promise.all([deletePassword(ACCESS_TOKEN_ACCOUNT), deletePassword(REFRESH_TOKEN_ACCOUNT)])
}
