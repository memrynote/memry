import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CriticMarkupCommentAttachmentRef, CriticMarkupMark } from '@memry/shared'
import { CommentAttachments, classifyCommentAttachment } from './comment-attachments'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))

// The real viewers pull in react-pdf / canvas machinery; this component's job is
// only to route the right attachment to the right viewer, so stub them. The PDF
// viewer is lazy-loaded in the component, so its stub resolves asynchronously.
vi.mock('@/components/viewers/image-viewer', () => ({
  ImageViewer: ({ src }: { src: string }) => <div data-testid="image-viewer" data-src={src} />
}))
vi.mock('@/components/viewers/pdf-viewer', () => ({
  PdfViewer: ({ src }: { src: string }) => <div data-testid="pdf-viewer" data-src={src} />
}))

function att(
  overrides: Partial<CriticMarkupCommentAttachmentRef> & { name: string }
): CriticMarkupCommentAttachmentRef {
  const path = overrides.path ?? `memry-file://local/vault/attachments/n1/${overrides.name}`
  return { id: overrides.id ?? path, name: overrides.name, path, ...overrides }
}

function markWith(attachments: CriticMarkupCommentAttachmentRef[]): CriticMarkupMark {
  return {
    id: 'm1',
    kind: 'comment',
    visibleText: '',
    start: 0,
    end: 0,
    attachments
  }
}

describe('classifyCommentAttachment', () => {
  it('trusts an explicit image type over the extension', () => {
    expect(classifyCommentAttachment(att({ name: 'blob.bin', type: 'image' }))).toBe('image')
  })

  it('classifies images by mimeType', () => {
    expect(classifyCommentAttachment(att({ name: 'blob', mimeType: 'image/png' }))).toBe('image')
  })

  it('falls back to the filename extension when mimeType and type are missing', () => {
    expect(classifyCommentAttachment(att({ name: 'holiday.JPEG' }))).toBe('image')
    expect(classifyCommentAttachment(att({ name: 'diagram.svg' }))).toBe('image')
  })

  it('classifies pdf by mimeType and by extension', () => {
    expect(classifyCommentAttachment(att({ name: 'blob', mimeType: 'application/pdf' }))).toBe(
      'pdf'
    )
    expect(classifyCommentAttachment(att({ name: 'report.PDF' }))).toBe('pdf')
  })

  it('classifies everything else as a plain file', () => {
    expect(classifyCommentAttachment(att({ name: 'notes.docx' }))).toBe('file')
    expect(classifyCommentAttachment(att({ name: 'README' }))).toBe('file')
  })
})

describe('CommentAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when there are no attachments', () => {
    const { container } = render(<CommentAttachments mark={markWith([])} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an image attachment as an <img> thumbnail — never a navigable anchor', () => {
    const path = 'memry-file://local/vault/attachments/n1/pic.png'
    const { container } = render(
      <CommentAttachments mark={markWith([att({ name: 'pic.png', path })])} />
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(path)
    // The trap this fixes was a bare <a href="memry-file://…">; there must be none.
    expect(container.querySelector('a')).toBeNull()
  })

  it('renders pdf and other files as buttons, never navigable memry-file anchors', () => {
    const { container } = render(
      <CommentAttachments
        mark={markWith([att({ name: 'report.pdf' }), att({ name: 'notes.docx' })])}
      />
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(2)
  })

  it('opens the in-app ImageViewer with the attachment path when an image is clicked', () => {
    const path = 'memry-file://local/vault/attachments/n1/pic.png'
    render(<CommentAttachments mark={markWith([att({ name: 'pic.png', path })])} />)
    expect(screen.queryByTestId('image-viewer')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('image-viewer').getAttribute('data-src')).toBe(path)
  })

  it('opens the in-app PdfViewer when a pdf is clicked (not a black frame / external app)', async () => {
    const path = 'memry-file://local/vault/attachments/n1/report.pdf'
    render(<CommentAttachments mark={markWith([att({ name: 'report.pdf', path })])} />)
    fireEvent.click(screen.getByRole('button'))
    // PdfViewer is lazy-loaded, so it resolves asynchronously.
    const viewer = await screen.findByTestId('pdf-viewer')
    expect(viewer.getAttribute('data-src')).toBe(path)
  })

  it('hands a non-viewable file to the OS via window.open — no in-app viewer, no trap', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const path = 'memry-file://local/vault/attachments/n1/notes.docx'
    render(<CommentAttachments mark={markWith([att({ name: 'notes.docx', path })])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(openSpy).toHaveBeenCalledWith(path, '_blank', 'noopener,noreferrer')
    expect(screen.queryByTestId('image-viewer')).toBeNull()
    expect(screen.queryByTestId('pdf-viewer')).toBeNull()
  })
})
