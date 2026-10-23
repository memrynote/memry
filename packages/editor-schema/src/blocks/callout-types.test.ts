import { afterEach, describe, expect, it } from 'vitest'
import {
  CALLOUT_TYPE_VALUES,
  sanitizeCalloutTypeDefinitions,
  setCalloutTypeDefinitions
} from './callout-types'
import { readCalloutRun } from './markdown'

const mytype = { name: 'mytype', label: 'My type', color: '#ff8800', icon: 'star' }

afterEach(() => setCalloutTypeDefinitions([]))

describe('custom callout types (#3207)', () => {
  it('leaves a type without a definition unclaimed, so it stays a quote', () => {
    expect(readCalloutRun(['> [!mytype]', '> body'], 0, true)).toBeNull()
  })

  it('claims a defined type, with and without a fold marker', () => {
    setCalloutTypeDefinitions([mytype])

    expect(readCalloutRun(['> [!mytype]', '> body'], 0, true)).toMatchObject({
      type: 'mytype',
      fold: 'none',
      contentLines: ['body']
    })
    expect(readCalloutRun(['> [!mytype]-', '> body'], 0, true)).toMatchObject({ fold: 'closed' })
  })

  it('stops claiming a type once its definition is removed', () => {
    setCalloutTypeDefinitions([mytype])
    setCalloutTypeDefinitions([])

    expect(readCalloutRun(['> [!mytype]', '> body'], 0, true)).toBeNull()
  })

  it('keeps built-in types claimed without any definition', () => {
    expect(readCalloutRun(['> [!tip]+', '> body'], 0, true)).toMatchObject({ type: 'tip' })
  })

  it('does not claim an uppercase or titled marker of a defined type', () => {
    setCalloutTypeDefinitions([mytype])

    expect(readCalloutRun(['> [!MYTYPE]', '> body'], 0, true)).toBeNull()
    expect(readCalloutRun(['> [!mytype] A title', '> body'], 0, true)).toBeNull()
  })

  describe('sanitizeCalloutTypeDefinitions', () => {
    it('keeps valid entries sorted by name and drops tombstones and junk', () => {
      const result = sanitizeCalloutTypeDefinitions({
        zeta: { label: 'Zeta', color: '#00ff00', icon: 'bolt' },
        mytype: { label: 'My type', color: '#FF8800', icon: 'star' },
        gone: null,
        broken: 'nope',
        'Bad Name': { label: 'x', color: '#000000', icon: 'star' },
        badcolor: { label: 'x', color: 'red', icon: 'star' }
      })

      expect(result.map((d) => d.name)).toEqual(['mytype', 'zeta'])
      expect(result[0]).toEqual({
        name: 'mytype',
        label: 'My type',
        color: '#ff8800',
        icon: 'star'
      })
    })

    it.each(CALLOUT_TYPE_VALUES)('drops a definition that shadows the built-in %s', (name) => {
      expect(
        sanitizeCalloutTypeDefinitions({ [name]: { label: 'x', color: '#000000', icon: 'star' } })
      ).toEqual([])
    })

    it('reads anything that is not a map as no definitions', () => {
      expect(sanitizeCalloutTypeDefinitions(undefined)).toEqual([])
      expect(sanitizeCalloutTypeDefinitions([mytype])).toEqual([])
    })
  })
})
