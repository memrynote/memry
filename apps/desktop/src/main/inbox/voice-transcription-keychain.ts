import keytar from 'keytar'

const SERVICE = 'memry.voice-transcription'
const OPENAI_ACCOUNT = 'openai'

function resolveAccount(account: string): string {
  const deviceSuffix = process.env.MEMRY_DEVICE
  return deviceSuffix ? `${account}-${deviceSuffix}` : account
}

export async function getVoiceTranscriptionOpenAIApiKey(): Promise<string | null> {
  try {
    return await keytar.getPassword(SERVICE, resolveAccount(OPENAI_ACCOUNT))
  } catch (error) {
    throw new Error(
      `Failed to read voice transcription API key: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}

export async function hasVoiceTranscriptionOpenAIApiKey(): Promise<boolean> {
  const apiKey = await getVoiceTranscriptionOpenAIApiKey()
  return typeof apiKey === 'string' && apiKey.trim().length > 0
}

export async function setVoiceTranscriptionOpenAIApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()

  try {
    const account = resolveAccount(OPENAI_ACCOUNT)
    if (trimmed.length === 0) {
      await keytar.deletePassword(SERVICE, account)
      return
    }

    await keytar.setPassword(SERVICE, account, trimmed)
  } catch (error) {
    throw new Error(
      `Failed to store voice transcription API key: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}
