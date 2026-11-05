import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createRendererI18n } from '@memry/i18n/renderer'

const commands = vi.hoisted(() => ({
  propertiesRename: vi.fn(),
  propertiesMerge: vi.fn(),
  propertiesResolveRefs: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))

import { propertiesService } from './properties-service'

const refused = (code: string) => ({ kind: 'invalid', code, message: 'rust text' })

describe('propertiesService', () => {
  beforeAll(async () => {
    await createRendererI18n({ locale: 'en' })
  })

  it('names the taken new name or the missing old one when a rename is refused', async () => {
    commands.propertiesRename.mockRejectedValueOnce(refused('property_exists'))
    await expect(propertiesService.rename('n1', 'due', 'deadline')).resolves.toEqual({
      success: false,
      error: 'Property "deadline" already exists'
    })
    commands.propertiesRename.mockRejectedValueOnce(refused('property_not_found'))
    await expect(propertiesService.rename('n1', 'due', 'deadline')).resolves.toEqual({
      success: false,
      error: 'Property "due" not found'
    })
  })

  it('answers a refused edit with the text the user acts on', async () => {
    commands.propertiesMerge.mockRejectedValueOnce(refused('note_edit_kept'))
    await expect(propertiesService.merge('n1', { stage: 'Done' })).resolves.toEqual({
      success: false,
      error: 'This note changed while its properties were being saved. Try again.'
    })
  })

  it('resolves relation refs through its command', async () => {
    const chip = {
      uri: 'memry://task/t1',
      targetType: 'task' as const,
      targetId: 't1',
      title: 'Call the bank',
      exists: true
    }
    commands.propertiesResolveRefs.mockResolvedValueOnce([chip])
    await expect(propertiesService.resolveRefs(['memry://task/t1'])).resolves.toEqual([chip])
    expect(commands.propertiesResolveRefs).toHaveBeenCalledWith(['memry://task/t1'])
  })
})
