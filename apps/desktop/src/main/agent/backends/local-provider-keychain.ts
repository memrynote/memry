import { deleteSecret, getSecret, setSecret } from '../../secrets/secret-storage'

const SERVICE = 'memry.agent.local-provider'
const ACCOUNT_BASE = 'api-key'

function account(): string {
  const device = process.env.MEMRY_DEVICE?.trim()
  return device ? `${ACCOUNT_BASE}:${device}` : ACCOUNT_BASE
}

export async function getLocalProviderApiKey(): Promise<string | null> {
  return getSecret(SERVICE, account())
}

export async function hasLocalProviderApiKey(): Promise<boolean> {
  return (await getLocalProviderApiKey()) !== null
}

export async function setLocalProviderApiKey(value: string | null): Promise<void> {
  if (!value) {
    await deleteSecret(SERVICE, account())
    return
  }
  await setSecret(SERVICE, account(), value)
}
