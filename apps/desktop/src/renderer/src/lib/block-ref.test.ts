import { describe, expect, it } from 'vitest'
import { findBlockRefBlockId } from './block-ref'

function page(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

const block = (id: string, inner: string): string =>
  `<div class="bn-block" data-id="${id}">${inner}</div>`

describe('findBlockRefBlockId', () => {
  it('finds the block of the Nth portal fence, in document order', () => {
    const root = page(
      block('a', '<p>intro</p>') +
        block('p1', '<div data-memry-portal=""></div>') +
        block('b', '<p>between</p>') +
        block('p2', '<div data-memry-portal=""></div>')
    )
    expect(findBlockRefBlockId(root, { kind: 'portal', ordinal: 0 })).toBe('p1')
    expect(findBlockRefBlockId(root, { kind: 'portal', ordinal: 1 })).toBe('p2')
    expect(findBlockRefBlockId(root, { kind: 'portal', ordinal: 2 })).toBeNull()
  })

  it('does not count portals drawn inside a portal window, which belong to other notes', () => {
    const root = page(
      block(
        'p1',
        '<div data-memry-portal=""><div class="portal-window">' +
          block('inner', '<div data-memry-portal=""></div>') +
          '</div></div>'
      ) + block('p2', '<div data-memry-portal=""></div>')
    )
    expect(findBlockRefBlockId(root, { kind: 'portal', ordinal: 1 })).toBe('p2')
  })

  it('finds a wiki link or a markdown link by the anchor its target ends in', () => {
    const root = page(
      block('x', '<p><span data-wiki-link="" data-target="Other#^abcd"></span></p>') +
        block('w', '<p><span data-wiki-link="" data-target="Lecture 1#^dna1"></span></p>') +
        block('m', '<p><a href="memry://note/n1?label=x#%5Edna2">t</a></p>')
    )
    expect(findBlockRefBlockId(root, { kind: 'link', anchor: 'dna1' })).toBe('w')
    expect(findBlockRefBlockId(root, { kind: 'link', anchor: 'dna2' })).toBe('m')
    expect(findBlockRefBlockId(root, { kind: 'link', anchor: 'nope' })).toBeNull()
  })

  it('ignores a link inside a portal window', () => {
    const root = page(
      block(
        'p1',
        '<div class="portal-window"><span data-wiki-link="" data-target="L#^dna1"></span></div>'
      )
    )
    expect(findBlockRefBlockId(root, { kind: 'link', anchor: 'dna1' })).toBeNull()
  })
})
