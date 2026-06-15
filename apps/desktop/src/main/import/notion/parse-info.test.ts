import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { parsePageInfo } from './parse-info'

function pageHtml(id: string, title: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
  <body><div id="${id}" class="page">
    <table><tbody>
      <tr class="property-row property-row-created_time"><td><time>@January 1, 2024 10:00 AM</time></td></tr>
      <tr class="property-row property-row-last_edited_time"><td><time>@January 2, 2024 11:00 AM</time></td></tr>
    </tbody></table>
  </div></body></html>`
}

describe('parsePageInfo', () => {
  it('extracts id, title, ctime, mtime', () => {
    const id = '0123456789abcdef0123456789abcdef'
    const dom = new JSDOM(pageHtml(id, 'My Page'))
    const info = parsePageInfo(dom.window.document, `My Page ${id}.html`)
    expect(info.id).toBe(id)
    expect(info.title).toBe('My Page')
    expect(info.ctime?.getFullYear()).toBe(2024)
    expect(info.mtime?.getMonth()).toBe(0) // January
  })

  it('records parent ids from the filepath', () => {
    const id = '0123456789abcdef0123456789abcdef'
    const parent = 'fedcba9876543210fedcba9876543210'
    const dom = new JSDOM(pageHtml(id, 'Child'))
    const info = parsePageInfo(dom.window.document, `Parent ${parent}/Child ${id}.html`)
    expect(info.parentIds).toContain(parent)
  })

  it('falls back to Untitled and null times when absent', () => {
    const id = '0123456789abcdef0123456789abcdef'
    const dom = new JSDOM(`<html><head></head><body><div id="${id}"></div></body></html>`)
    const info = parsePageInfo(dom.window.document, `x ${id}.html`)
    expect(info.title).toBe('Untitled')
    expect(info.ctime).toBeNull()
    expect(info.mtime).toBeNull()
  })

  it('throws when no notion id is present', () => {
    const dom = new JSDOM('<html><head><title>x</title></head><body><div>no id</div></body></html>')
    expect(() => parsePageInfo(dom.window.document, 'index.html')).toThrow(/no notion id/i)
  })
})
