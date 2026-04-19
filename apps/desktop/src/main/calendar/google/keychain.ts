import keytar from 'keytar'

const SERVICE = 'com.memry.calendar.google'

export const LEGACY_DEFAULT_ACCOUNT_ID = '__memry_default__'

export type GoogleTokenKind = 'access-token' | 'refresh-token'

export function getAccountKey(accountId: string, kind: GoogleTokenKind): string {
  if (!accountId || !accountId.trim()) {
    throw new Error('getAccountKey requires a non-empty accountId')
  }
  const deviceSuffix = process.env.MEMRY_DEVICE
  const base = `${kind}-${accountId}`
  return deviceSuffix ? `${base}-${deviceSuffix}` : base
}

async function setPassword(
  accountId: string,
  kind: GoogleTokenKind,
  value: string | null
): Promise<void> {
  const account = getAccountKey(accountId, kind)

  try {
    if (!value || value.trim().length === 0) {
      await keytar.deletePassword(SERVICE, account)
      return
    }

    await keytar.setPassword(SERVICE, account, value.trim())
  } catch (error) {
    throw new Error(
      `Failed to store Google Calendar credential (${account}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

async function getPassword(accountId: string, kind: GoogleTokenKind): Promise<string | null> {
  const account = getAccountKey(accountId, kind)

  try {
    return await keytar.getPassword(SERVICE, account)
  } catch (error) {
    throw new Error(
      `Failed to read Google Calendar credential (${account}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

async function deletePassword(accountId: string, kind: GoogleTokenKind): Promise<void> {
  const account = getAccountKey(accountId, kind)

  try {
    await keytar.deletePassword(SERVICE, account)
  } catch (error) {
    throw new Error(
      `Failed to delete Google Calendar credential (${account}): ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

export async function storeGoogleCalendarTokens(input: {
  accountId: string
  accessToken: string
  refreshToken: string
}): Promise<void> {
  await setPassword(input.accountId, 'access-token', input.accessToken)
  await setPassword(input.accountId, 'refresh-token', input.refreshToken)
}

export async function getGoogleCalendarTokens(accountId: string): Promise<{
  accessToken: string | null
  refreshToken: string | null
}> {
  const [accessToken, refreshToken] = await Promise.all([
    getPassword(accountId, 'access-token'),
    getPassword(accountId, 'refresh-token')
  ])

  return { accessToken, refreshToken }
}

export async function hasGoogleCalendarTokens(accountId: string): Promise<boolean> {
  const { refreshToken } = await getGoogleCalendarTokens(accountId)
  return typeof refreshToken === 'string' && refreshToken.trim().length > 0
}

export async function clearGoogleCalendarTokens(accountId: string): Promise<void> {
  await Promise.all([
    deletePassword(accountId, 'access-token'),
    deletePassword(accountId, 'refresh-token')
  ])
}
