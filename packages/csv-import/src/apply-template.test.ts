import { describe, it, expect } from 'vitest'
import { applyTemplate } from './apply-template.ts'

describe('applyTemplate', () => {
  it('replaces known placeholders', () => {
    const result = applyTemplate('Hello {{Name}}, tagged: {{Tags}}', {
      Name: 'Alice',
      Tags: 'work'
    })
    expect(result).toBe('Hello Alice, tagged: work')
  })

  it('leaves unknown placeholders as-is', () => {
    const result = applyTemplate('{{Unknown}} here', { Name: 'Alice' })
    expect(result).toBe('{{Unknown}} here')
  })

  it('replaces placeholder with empty string when value is empty', () => {
    const result = applyTemplate('Tag: {{Tags}}', { Tags: '' })
    expect(result).toBe('Tag: ')
  })

  it('handles placeholder with surrounding whitespace in key', () => {
    const result = applyTemplate('{{ Name }}', { Name: 'Bob' })
    expect(result).toBe('Bob')
  })

  it('handles no placeholders', () => {
    const result = applyTemplate('No placeholders here', { Name: 'Alice' })
    expect(result).toBe('No placeholders here')
  })

  it('handles multiple occurrences of same placeholder', () => {
    const result = applyTemplate('{{X}} and {{X}}', { X: 'yes' })
    expect(result).toBe('yes and yes')
  })
})
