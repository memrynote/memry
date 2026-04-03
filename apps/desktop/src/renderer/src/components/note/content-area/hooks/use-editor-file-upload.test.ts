import { describe, it, expect } from 'vitest'

const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml'
]

function isImageFile(file: File): boolean {
  return IMAGE_TYPES.includes(file.type.toLowerCase())
}

describe('isImageFile', () => {
  it('should return true for PNG files', () => {
    expect(isImageFile(new File([], 'test.png', { type: 'image/png' }))).toBe(true)
  })

  it('should return true for JPEG files', () => {
    expect(isImageFile(new File([], 'test.jpg', { type: 'image/jpeg' }))).toBe(true)
  })

  it('should return true for GIF files', () => {
    expect(isImageFile(new File([], 'test.gif', { type: 'image/gif' }))).toBe(true)
  })

  it('should return true for WebP files', () => {
    expect(isImageFile(new File([], 'test.webp', { type: 'image/webp' }))).toBe(true)
  })

  it('should return true for SVG files', () => {
    expect(isImageFile(new File([], 'test.svg', { type: 'image/svg+xml' }))).toBe(true)
  })

  it('should return false for PDF files', () => {
    expect(isImageFile(new File([], 'doc.pdf', { type: 'application/pdf' }))).toBe(false)
  })

  it('should return false for text files', () => {
    expect(isImageFile(new File([], 'readme.txt', { type: 'text/plain' }))).toBe(false)
  })

  it('should return false for Word documents', () => {
    expect(
      isImageFile(
        new File([], 'doc.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        })
      )
    ).toBe(false)
  })

  it('should handle case-insensitive MIME types', () => {
    expect(isImageFile(new File([], 'test.PNG', { type: 'IMAGE/PNG' }))).toBe(true)
  })
})
