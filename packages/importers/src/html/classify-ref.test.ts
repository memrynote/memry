import { describe, it, expect } from 'vitest'
import { classifyRef } from './classify-ref.ts'

describe('classifyRef', () => {
  it('classifies data URIs as data', () => {
    expect(classifyRef('data:image/png;base64,abc==')).toBe('data')
    expect(classifyRef('data:text/html,<h1>hi</h1>')).toBe('data')
  })

  it('classifies http URLs as http', () => {
    expect(classifyRef('http://example.com/img.png')).toBe('http')
    expect(classifyRef('HTTP://example.com/img.png')).toBe('http')
  })

  it('classifies https URLs as http', () => {
    expect(classifyRef('https://cdn.example.com/remote.png')).toBe('http')
    expect(classifyRef('HTTPS://example.com/img.png')).toBe('http')
  })

  it('classifies file:// URLs as file', () => {
    expect(classifyRef('file:///Users/me/docs/image.png')).toBe('file')
    expect(classifyRef('FILE:///path/to/img.png')).toBe('file')
  })

  it('classifies relative paths as local', () => {
    expect(classifyRef('images/photo.jpg')).toBe('local')
    expect(classifyRef('./assets/icon.svg')).toBe('local')
    expect(classifyRef('../sibling/img.png')).toBe('local')
    expect(classifyRef('image.png')).toBe('local')
  })
})
