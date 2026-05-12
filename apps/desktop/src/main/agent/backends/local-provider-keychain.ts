import keytar from 'keytar'

const SERVICE = 'memry.agent.local-provider'
const ACCOUNT_BASE = 'api-key'

function account(): string {
  const device = process.env.MEMRY_DEVICE?.trim()
  return device ? `${ACCOUNT_BASE}:${device}` : ACCOUNT_BASE
}

export async function getLocalProviderApiKey(): Promise<string | null> {
  return keytar.getPassword(SERVICE, account())
}

export async function hasLocalProviderApiKey(): Promise<boolean> {
  return (await getLocalProviderApiKey()) !== null
}

export async function setLocalProviderApiKey(value: string | null): Promise<void> {
  if (!value) {
    await keytar.deletePassword(SERVICE, account())
    return
  }
  await keytar.setPassword(SERVICE, account(), value)
}
