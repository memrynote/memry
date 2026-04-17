import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { retrieveToken } from './token-manager'

export async function isMemryUserSignedIn(): Promise<boolean> {
  const refresh = await retrieveToken(KEYCHAIN_ENTRIES.REFRESH_TOKEN)
  return typeof refresh === 'string' && refresh.trim().length > 0
}
