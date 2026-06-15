import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { convertHtmlToMarkdown } from './convert-to-md'
import { NotionResolverInfo } from './resolver'

const ID_T = 'cccccccccccccccccccccccccccccccc'

function docOf(html: string): Document {
  return new JSDOM(html).window.document
}

describe('convertHtmlToMarkdown', () => {
  it('converts a to-do list (input style) to markdown checkboxes', () => {
    const doc = docOf(
      `<body><ul><li class="to-do"><input type="checkbox" checked>done</li>` +
        `<li class="to-do"><input type="checkbox">todo</li></ul></body>`
    )
    const { body } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(body).toContain('- [x] done')
    expect(body).toContain('- [ ] todo')
  })

  it('converts a to-do list (notion checkbox div) to markdown checkboxes', () => {
    const doc = docOf(
      `<body><ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> shipped</li></ul></body>`
    )
    const { body } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(body).toContain('- [x] shipped')
  })

  it('rewrites an internal page link to a wikilink', () => {
    const info = new NotionResolverInfo()
    info.idsToFileInfo[ID_T] = {
      path: `Target ${ID_T}.html`,
      parentIds: [],
      title: 'Target',
      ctime: null,
      mtime: null
    }
    const doc = docOf(`<body><p><a href="Target%20${ID_T}.html">Target</a></p></body>`)
    const { body } = convertHtmlToMarkdown(info, doc, 'src.html')
    expect(body).toContain('[[Target]]')
  })

  it('keeps an external link as a markdown link', () => {
    const doc = docOf(`<body><p><a href="https://memry.app">Memry</a></p></body>`)
    const { body } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(body).toContain('[Memry](https://memry.app)')
  })

  it('renders headings, emphasis and code fences', () => {
    const doc = docOf(
      `<div class="page-body"><h2>Title</h2><p>a <strong>bold</strong> and <em>italic</em></p>` +
        `<pre class="code"><code>const x = 1</code></pre></div>`
    )
    const { body } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(body).toContain('## Title')
    expect(body).toContain('**bold**')
    expect(body).toContain('*italic*')
    expect(body).toContain('```')
    expect(body).toContain('const x = 1')
  })

  it('extracts a multi_select Tags property as tags', () => {
    const doc = docOf(
      `<body><table class="properties"><tbody>` +
        `<tr class="property-row"><th>Tags</th>` +
        `<td class="multi_select"><span>work</span><span>home</span></td></tr>` +
        `</tbody></table></body>`
    )
    const { tags } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(tags).toEqual(['work', 'home'])
  })

  it('extracts a non-tag property into frontmatter properties', () => {
    const doc = docOf(
      `<body><table class="properties"><tbody>` +
        `<tr class="property-row property-row-select"><th>Status</th>` +
        `<td class="cell-select"><span class="selected-value">Active</span></td></tr>` +
        `</tbody></table></body>`
    )
    const { properties } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(properties.Status).toBe('Active')
  })

  it('does not treat created/last_edited rows as properties', () => {
    const doc = docOf(
      `<body><table class="properties"><tbody>` +
        `<tr class="property-row property-row-created_time"><th>Created</th><td><time>@January 1, 2024 10:00 AM</time></td></tr>` +
        `</tbody></table></body>`
    )
    const { properties } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(Object.keys(properties)).toHaveLength(0)
  })

  it('embeds a known image attachment and reports it as an asset', () => {
    const info = new NotionResolverInfo()
    info.pathsToAttachmentInfo['Page abc/cat.png'] = {
      path: 'Page abc/cat.png',
      parentIds: [],
      nameWithExtension: 'cat.png',
      targetParentFolder: ''
    }
    const doc = docOf(
      `<div class="page-body"><figure><img src="Page%20abc/cat.png"/></figure></div>`
    )
    const { body, assets } = convertHtmlToMarkdown(info, doc, 'p.html')
    expect(body).toContain('![](Page abc/cat.png)')
    expect(assets).toContain('Page abc/cat.png')
  })
})
