import { describe, it, expect } from 'vitest'
import { preparePageHtml } from './prepare-page-html.ts'
import { extractDataImages, extensionForMime } from './extract-images.ts'
import { parseOneNoteImportOptions } from './types.ts'

// 1x1 transparent PNG, base64.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('preparePageHtml', () => {
  it('pairs self-closing object and iframe tags', () => {
    const { html } = preparePageHtml('<p>hi<object data="x"/></p><iframe src="y"/>')
    expect(html).toContain('<object data="x"></object>')
    expect(html).toContain('<iframe src="y"></iframe>')
  })

  it('drops empty paragraphs and blank-line filler', () => {
    const { html } = preparePageHtml('<p>a</p><p>&nbsp;</p><p> <br/> </p>\n  \n<p>b</p>')
    expect(html).toBe('<p>a</p>\n<p>b</p>')
  })
})

describe('extractDataImages', () => {
  it('lifts data-URI images and leaves placeholders', () => {
    const { images, html } = extractDataImages(
      `<img alt="pic" src="data:image/png;base64,${PNG_BASE64}">`
    )
    expect(images).toEqual([
      { placeholder: 'onenote-img-0', base64: PNG_BASE64, mime: 'image/png' }
    ])
    expect(html).toContain('src="onenote-img-0"')
  })

  it('leaves regular image sources alone', () => {
    const input = '<img src="https://example.com/a.png">'
    expect(extractDataImages(input)).toEqual({ html: input, images: [] })
  })
})

describe('extensionForMime', () => {
  it('maps mime subtypes to file extensions', () => {
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/svg+xml')).toBe('svg')
  })
})

describe('option parsing + tag preservation', () => {
  it('keeps an empty checklist paragraph so it can import as a task', () => {
    const { html } = preparePageHtml('<p data-tag="to-do"></p><p></p>')
    expect(html).toBe('<p data-tag="to-do"></p>')
  })

  it('treats an explicitly empty section list as "nothing selected"', () => {
    expect(parseOneNoteImportOptions({ sectionIds: [] }).sectionIds).toEqual([])
    expect(parseOneNoteImportOptions({}).sectionIds).toBeNull()
    expect(parseOneNoteImportOptions(undefined).sectionIds).toBeNull()
  })

  it('defaults to skipping previously imported pages and blocking extra types', () => {
    const options = parseOneNoteImportOptions({})
    expect(options.skipPreviouslyImported).toBe(true)
    expect(options.includeIncompatibleAttachments).toBe(false)
  })

  it('maps vendor-prefixed image mime types to real extensions', () => {
    expect(extensionForMime('image/x-emf')).toBe('emf')
    expect(extensionForMime('image/TIFF')).toBe('tiff')
  })
})
