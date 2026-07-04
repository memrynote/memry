import { describe, it, expect, vi } from 'vitest'
import {
  createHashTagInlinePlugin,
  matchHashTagImmediate,
  matchTrailingTagChars,
  isTagChar,
  extendTagName,
  shrinkTagName
} from './hash-tag-inline-plugin'

describe('hash-tag-inline-plugin', () => {
  describe('matchHashTagImmediate', () => {
    it('matches # followed by a single letter at end of text', () => {
      expect(matchHashTagImmediate('#a')).toBe('a')
    })

    it('matches at start of text', () => {
      expect(matchHashTagImmediate('#z')).toBe('z')
    })

    it('matches after whitespace', () => {
      expect(matchHashTagImmediate('hello #b')).toBe('b')
    })

    it('matches after object replacement char (inline node before #)', () => {
      expect(matchHashTagImmediate('\ufffc #c')).toBe('c')
    })

    it('returns null when no hash', () => {
      expect(matchHashTagImmediate('abc')).toBeNull()
    })

    it('returns null for hash only (no letter)', () => {
      expect(matchHashTagImmediate('#')).toBeNull()
    })

    it('matches hash with digit', () => {
      expect(matchHashTagImmediate('#1')).toBe('1')
      expect(matchHashTagImmediate('#9')).toBe('9')
    })

    it('matches hash with digit after whitespace', () => {
      expect(matchHashTagImmediate('hello #5')).toBe('5')
    })

    it('returns null when hash not preceded by whitespace or start', () => {
      expect(matchHashTagImmediate('word#a')).toBeNull()
    })

    it('returns null for multi-char tag (already a word)', () => {
      expect(matchHashTagImmediate('#abc')).toBeNull()
    })

    it('preserves case', () => {
      expect(matchHashTagImmediate('#A')).toBe('A')
    })
  })

  describe('isTagChar', () => {
    it('accepts lowercase letters', () => {
      expect(isTagChar('a')).toBe(true)
      expect(isTagChar('z')).toBe(true)
    })

    it('accepts uppercase letters', () => {
      expect(isTagChar('A')).toBe(true)
      expect(isTagChar('Z')).toBe(true)
    })

    it('accepts digits', () => {
      expect(isTagChar('0')).toBe(true)
      expect(isTagChar('9')).toBe(true)
    })

    it('accepts hyphen and underscore', () => {
      expect(isTagChar('-')).toBe(true)
      expect(isTagChar('_')).toBe(true)
    })

    it('rejects space', () => {
      expect(isTagChar(' ')).toBe(false)
    })

    it('rejects special characters', () => {
      expect(isTagChar('@')).toBe(false)
      expect(isTagChar('!')).toBe(false)
      expect(isTagChar('#')).toBe(false)
    })

    it('rejects empty string', () => {
      expect(isTagChar('')).toBe(false)
    })
  })

  describe('extendTagName', () => {
    it('appends character to tag name', () => {
      expect(extendTagName('a', 'b')).toBe('ab')
    })

    it('preserves case', () => {
      expect(extendTagName('hello', 'W')).toBe('helloW')
    })

    it('appends digits', () => {
      expect(extendTagName('v', '2')).toBe('v2')
    })

    it('appends hyphen', () => {
      expect(extendTagName('my', '-')).toBe('my-')
    })

    it('appends underscore', () => {
      expect(extendTagName('my', '_')).toBe('my_')
    })
  })

  describe('shrinkTagName', () => {
    it('removes last character', () => {
      expect(shrinkTagName('abc')).toBe('ab')
    })

    it('returns single char from two-char tag', () => {
      expect(shrinkTagName('ab')).toBe('a')
    })

    it('returns null for single-char tag (tag should be deleted)', () => {
      expect(shrinkTagName('a')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(shrinkTagName('')).toBeNull()
    })
  })

  describe('matchTrailingTagChars', () => {
    it('matches tag chars after object replacement char', () => {
      expect(matchTrailingTagChars('\ufffcabc')).toEqual({ chars: 'abc', offset: 0 })
    })

    it('matches after text + object replacement char', () => {
      expect(matchTrailingTagChars('hello \ufffccar')).toEqual({ chars: 'car', offset: 6 })
    })

    it('returns null when no object replacement char', () => {
      expect(matchTrailingTagChars('abc')).toBeNull()
    })

    it('returns null for lone object replacement char (no trailing chars)', () => {
      expect(matchTrailingTagChars('\ufffc')).toBeNull()
    })

    it('returns null when space follows object replacement char', () => {
      expect(matchTrailingTagChars('\ufffc test')).toBeNull()
    })

    it('matches digits in trailing chars', () => {
      expect(matchTrailingTagChars('\ufffcv2')).toEqual({ chars: 'v2', offset: 0 })
    })

    it('matches hyphens and underscores', () => {
      expect(matchTrailingTagChars('\ufffcmy-tag_v2')).toEqual({ chars: 'my-tag_v2', offset: 0 })
    })

    it('only matches the last object replacement char', () => {
      expect(matchTrailingTagChars('\ufffc first \ufffcsecond')).toEqual({
        chars: 'second',
        offset: 8
      })
    })

    it('returns null if chars end with space', () => {
      expect(matchTrailingTagChars('\ufffcabc ')).toBeNull()
    })
  })

  describe('createHashTagInlinePlugin', () => {
    function createTransaction() {
      return {
        delete: vi.fn().mockReturnThis(),
        replaceWith: vi.fn().mockReturnThis(),
        setMeta: vi.fn().mockReturnThis()
      }
    }

    function createHashTagNode(tag: string, nodeSize = 1) {
      return {
        type: { name: 'hashTag' },
        attrs: { tag },
        nodeSize
      }
    }

    it('shrinks and deletes hashTag nodes on Backspace before the cursor', () => {
      const plugin = createHashTagInlinePlugin((tag) => `color-${tag}`)
      const hashTagNodeType = { create: vi.fn((attrs) => ({ type: 'hashTag', attrs })) }
      const dispatch = vi.fn()
      const tr = createTransaction()
      const state = {
        selection: {
          $from: {
            parentOffset: 1,
            nodeBefore: createHashTagNode('abc', 3),
            pos: 8
          }
        },
        schema: {
          nodes: {
            hashTag: hashTagNodeType
          }
        },
        tr
      }
      const view = { state, dispatch }

      expect(
        plugin.props.handleKeyDown?.(
          view as never,
          new KeyboardEvent('keydown', {
            key: 'Enter'
          })
        )
      ).toBe(false)
      expect(
        plugin.props.handleKeyDown?.(
          view as never,
          new KeyboardEvent('keydown', {
            key: 'Backspace'
          })
        )
      ).toBe(true)

      expect(hashTagNodeType.create).toHaveBeenCalledWith({ tag: 'ab', color: 'color-ab' })
      expect(tr.replaceWith).toHaveBeenCalledWith(5, 8, {
        type: 'hashTag',
        attrs: { tag: 'ab', color: 'color-ab' }
      })
      expect(dispatch).toHaveBeenCalledWith(tr)

      const deleteTr = createTransaction()
      state.tr = deleteTr
      state.selection.$from.nodeBefore = createHashTagNode('a', 2)
      state.selection.$from.pos = 12

      expect(
        plugin.props.handleKeyDown?.(
          view as never,
          new KeyboardEvent('keydown', {
            key: 'Backspace'
          })
        )
      ).toBe(true)
      expect(deleteTr.delete).toHaveBeenCalledWith(10, 12)
    })

    it('creates a hashTag node from #x typed in normal text', () => {
      const plugin = createHashTagInlinePlugin((tag) => `color-${tag}`)
      const tr = createTransaction()
      const hashTagNode = { type: 'hashTag', attrs: { tag: 'a', color: 'color-a' } }
      const newState = {
        selection: {
          $from: {
            parentOffset: 2,
            start: () => 10,
            parent: {
              type: { spec: { code: false } },
              textBetween: () => '#A'
            }
          }
        },
        schema: {
          nodes: {
            hashTag: { create: vi.fn(() => hashTagNode) }
          }
        },
        tr
      }

      const result = plugin.spec.appendTransaction?.(
        [{ docChanged: true, getMeta: () => false }] as never,
        {} as never,
        newState as never
      )

      expect(result).toBe(tr)
      expect(tr.replaceWith).toHaveBeenCalledWith(10, 12, expect.anything())
      expect(tr.setMeta).toHaveBeenCalled()
    })

    it('extends a hashTag node with trailing tag characters', () => {
      const plugin = createHashTagInlinePlugin((tag) => `color-${tag}`)
      const tr = createTransaction()
      const currentNode = createHashTagNode('alpha')
      const newNode = { type: 'hashTag', attrs: { tag: 'alphabeta', color: 'color-alphabeta' } }
      const newState = {
        selection: {
          $from: {
            parentOffset: 5,
            start: () => 20,
            parent: {
              type: { spec: { code: false } },
              textBetween: () => '\ufffcbeta'
            }
          }
        },
        doc: {
          nodeAt: vi.fn(() => currentNode)
        },
        schema: {
          nodes: {
            hashTag: { create: vi.fn(() => newNode) }
          }
        },
        tr
      }

      const result = plugin.spec.appendTransaction?.(
        [{ docChanged: true, getMeta: () => false }] as never,
        {} as never,
        newState as never
      )

      expect(result).toBe(tr)
      expect(newState.doc.nodeAt).toHaveBeenCalledWith(20)
      expect(tr.replaceWith).toHaveBeenCalledWith(20, 25, expect.anything())
    })

    it('ignores non-document transactions, code blocks, missing node types, and non-tag trailing nodes', () => {
      const plugin = createHashTagInlinePlugin(() => 'color')
      const baseState = {
        selection: {
          $from: {
            parentOffset: 2,
            start: () => 1,
            parent: {
              type: { spec: { code: false } },
              textBetween: () => '#a'
            }
          }
        },
        schema: { nodes: {} },
        tr: createTransaction()
      }

      expect(
        plugin.spec.appendTransaction?.(
          [{ docChanged: false, getMeta: () => false }] as never,
          {} as never,
          baseState as never
        )
      ).toBeNull()

      expect(
        plugin.spec.appendTransaction?.(
          [{ docChanged: true, getMeta: () => false }] as never,
          {} as never,
          {
            ...baseState,
            selection: {
              $from: {
                ...baseState.selection.$from,
                parent: { type: { spec: { code: true } }, textBetween: () => '#a' }
              }
            },
            schema: { nodes: { hashTag: { create: vi.fn() } } }
          } as never
        )
      ).toBeNull()

      expect(
        plugin.spec.appendTransaction?.(
          [{ docChanged: true, getMeta: () => false }] as never,
          {} as never,
          baseState as never
        )
      ).toBeNull()

      expect(
        plugin.spec.appendTransaction?.(
          [{ docChanged: true, getMeta: () => false }] as never,
          {} as never,
          {
            ...baseState,
            selection: {
              $from: {
                ...baseState.selection.$from,
                parentOffset: 5,
                parent: { type: { spec: { code: false } }, textBetween: () => '\ufffcbeta' }
              }
            },
            schema: { nodes: { hashTag: { create: vi.fn() } } },
            doc: { nodeAt: vi.fn(() => ({ type: { name: 'paragraph' } })) }
          } as never
        )
      ).toBeNull()
    })
  })
})
