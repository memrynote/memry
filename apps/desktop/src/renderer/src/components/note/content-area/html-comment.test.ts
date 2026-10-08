import { describe, expect, it } from 'vitest'
import { encodeHtmlCommentToken } from '@memry/shared/html-comments'
import { renderHtmlComment } from './html-comment'

const nodeView = { renderType: 'nodeView' }

describe('htmlComment node view', () => {
  it('shows an HTML comment as an empty HTML comment marker', () => {
    const { dom } = renderHtmlComment.call(nodeView, { props: { source: '<!-- [[A]] -->' } })
    expect(dom.textContent).toBe('<!---->')
    expect(dom.getAttribute('aria-label')).toBe('Hidden HTML comment')
  })

  it('shows a %% comment as an empty %% marker, never its text', () => {
    const { dom } = renderHtmlComment.call(nodeView, {
      props: { source: '%%\nblock [[Other]] secret\n%%' }
    })
    expect(dom.textContent).toBe('%%%%')
    expect(dom.getAttribute('aria-label')).toBe('Hidden comment')
    expect(dom.getAttribute('contenteditable')).toBe('false')
  })

  it('writes the token outside the node view', () => {
    const source = '%% [[Topic]] %%'
    expect(
      renderHtmlComment.call({ renderType: 'dom' }, { props: { source } }).dom.textContent
    ).toBe(encodeHtmlCommentToken(source))
  })
})
