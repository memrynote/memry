import { describe, it, expect } from 'vitest'
import { loadResources } from './load-resources'

describe('loadResources', () => {
  it('returns all namespaces for English', () => {
    const result = loadResources('en')
    expect(result.common).toBeDefined()
    expect(result.settings).toBeDefined()
    expect(result.menu).toBeDefined()
  })

  it('returns the actual translated strings', () => {
    const result = loadResources('tr')
    expect(result.menu.file.label).toBe('Dosya')
  })
})
