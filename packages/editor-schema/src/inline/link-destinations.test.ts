import { describe, expect, it } from 'vitest'

import { linkDestination, withLinkDestination } from './link-destinations'

describe('withLinkDestination', () => {
  it.each([
    ['https://e.com/x "T"', 'https://e.com/y', 'https://e.com/y "T"'],
    ["<https://e.com/a b> 'T'", 'https://e.com/c', "<https://e.com/c> 'T'"],
    ['https://e.com/x (T)', 'https://e.com/c d', '<https://e.com/c d> (T)'],
    ['<https://e.com/a b>', 'https://e.com/c', 'https://e.com/c'],
    ['<https://e.com/a b>', 'https://e.com/c d', '<https://e.com/c d>'],
    ['https://e.com/x', 'https://e.com/y', 'https://e.com/y'],
    ['https://e.com/x', 'https://e.com/c d', '<https://e.com/c d>']
  ])('replaces the address of %s with %s and keeps the title', (href, address, next) => {
    expect(withLinkDestination(href, address)).toBe(next)
    expect(linkDestination(next)).toBe(address)
  })
})
