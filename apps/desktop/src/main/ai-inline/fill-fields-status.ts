import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import type { FieldFillStatus } from '@memry/contracts/tag-fill-api'

/** Kept apart from fill-fields.ts so asking for the status never loads `ai`. */
export function fieldFillStatus(
  settings: AIInlineSettings,
  disclosureAccepted: boolean
): FieldFillStatus {
  const local = settings.provider === 'ollama'
  const credentialed =
    settings.provider === 'custom'
      ? settings.baseUrl.length > 0
      : local || settings.apiKey.length > 0
  const configured = settings.model.trim().length > 0 && credentialed
  return {
    available: settings.enabled && configured,
    model: settings.model,
    local,
    disclosureAccepted
  }
}
