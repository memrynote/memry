import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { retrieveKey } from './crypto'

export async function isMemryUserSignedIn(): Promise<boolean> {
  const refresh = await retrieveKey(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
  if (!refresh) return false
  return new TextDecoder().decode(refresh).trim().length > 0
}
