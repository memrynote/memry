import { describe, expect, it } from 'vitest'
import { substituteTemplatePlaceholders } from './template-placeholders'

describe('substituteTemplatePlaceholders', () => {
  it('substitutes every occurrence of the title placeholder', () => {
    const content = '# {{title}}\n\nNotes for {{title}} ({{title}})'

    expect(substituteTemplatePlaceholders(content, 'Weekly review')).toBe(
      '# Weekly review\n\nNotes for Weekly review (Weekly review)'
    )
  })

  it('returns content without the placeholder unchanged', () => {
    const content = '# Meeting\n\n- [ ] agenda\n'

    expect(substituteTemplatePlaceholders(content, 'Weekly review')).toBe(content)
  })

  it('replaces the placeholder with an empty string for an empty title', () => {
    expect(substituteTemplatePlaceholders('# {{title}}\n\nbody', '')).toBe('# \n\nbody')
  })
})
