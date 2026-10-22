import { describe, expect, it } from 'vitest'
import { parsePortalDefinition } from '@memry/shared/portal-block'
import {
  blockDefinition,
  findPortalCycle,
  noteDefinition,
  portalFenceMarkdown
} from './portal-insert'

describe('findPortalCycle', () => {
  it('refuses the host itself and any portal ancestor, allows the rest', () => {
    expect(findPortalCycle('host', [], 'host')).toBe('self')
    expect(findPortalCycle('host', ['outer', 'mid'], 'mid')).toBe('ancestor')
    expect(findPortalCycle('host', ['outer'], 'other')).toBeNull()
  })

  it('has no host to loop into while the note is unsaved', () => {
    expect(findPortalCycle(undefined, [], 'any')).toBeNull()
  })
})

describe('portalFenceMarkdown', () => {
  it('writes a fence a reader parses back to the same definition', () => {
    const definition = blockDefinition('n1', 'chl-7f2a', ['kid1'])
    const markdown = portalFenceMarkdown(definition)
    expect(markdown.startsWith('```memry-portal\n')).toBe(true)
    expect(markdown.endsWith('\n```')).toBe(true)
    const body = markdown.split('\n').slice(1, -1).join('\n')
    const parsed = parsePortalDefinition(body)
    expect(parsed.ok && parsed.definition).toEqual(definition)
  })

  it('stores a whole note by id alone', () => {
    expect(portalFenceMarkdown(noteDefinition('n1'))).toBe(
      '```memry-portal\n{\n  "note": "n1"\n}\n```'
    )
  })
})
