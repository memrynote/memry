import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContentMetadata, ContentSection, ContentSkeleton, TypeIcon } from './content-section'
import type { InboxItemType } from '@/types'

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '12h' } })
}))

vi.mock('./tweet-card', () => ({
  TweetCard: ({ item }: { item: { title: string } }) => <div>tweet {item.title}</div>
}))

vi.mock('./inbox-content-editor', () => ({
  InboxContentEditor: ({
    initialContent,
    onContentChange
  }: {
    initialContent: string | null
    onContentChange?: (content: string) => void
  }) => (
    <textarea
      aria-label="inbox content editor"
      defaultValue={initialContent ?? ''}
      onChange={(event) => onContentChange?.(event.target.value)}
    />
  )
}))

vi.mock('./link-preview', () => ({
  LinkPreview: ({ item }: { item: { title: string } }) => <div>link preview {item.title}</div>
}))

vi.mock('./reminder-detail', () => ({
  ReminderDetail: ({ item }: { item: { title: string } }) => <div>reminder {item.title}</div>
}))

const baseItem = (type: InboxItemType, overrides: Record<string, unknown> = {}) =>
  ({
    id: `${type}-1`,
    type,
    title: `${type} item`,
    content: 'plain content',
    rawContent: 'plain content',
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    status: 'pending',
    viewedAt: undefined,
    snoozedUntil: null,
    archivedAt: null,
    sourceUrl: null,
    metadata: null,
    thumbnailUrl: null,
    transcription: null,
    transcriptionStatus: null,
    duration: null,
    attachments: [],
    ...overrides
  }) as any

describe('ContentSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders the loading skeleton and relative capture metadata dates', () => {
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'))

    const { container, rerender } = render(<ContentSkeleton />)
    expect(container.querySelectorAll('[data-slot="skeleton"]')).not.toHaveLength(0)

    rerender(<ContentMetadata item={baseItem('note', { createdAt: '2026-01-15T09:30:00.000Z' })} />)
    expect(screen.getByText(/today/i)).toBeInTheDocument()

    rerender(<ContentMetadata item={baseItem('note', { createdAt: '2026-01-14T09:30:00.000Z' })} />)
    expect(screen.getByText(/yesterday/i)).toBeInTheDocument()

    rerender(<ContentMetadata item={baseItem('note', { createdAt: '2026-01-01T09:30:00.000Z' })} />)
    expect(screen.getByText(/Jan 1, 2026/i)).toBeInTheDocument()
  })

  it('renders type icons and metadata for links, notes, and voice captures', () => {
    const { rerender } = render(<TypeIcon type="link" />)
    expect(document.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument()

    for (const type of ['note', 'image', 'voice', 'pdf', 'video', 'reminder', 'clip'] as const) {
      rerender(<TypeIcon type={type} />)
      expect(document.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument()
    }

    rerender(
      <ContentMetadata
        item={baseItem('link', {
          sourceUrl: 'https://example.com/story',
          metadata: { author: 'Ada' }
        })}
      />
    )
    expect(screen.getByRole('link', { name: 'example.com' })).toBeInTheDocument()
    expect(screen.getByText('Ada')).toBeInTheDocument()

    rerender(<ContentMetadata item={baseItem('note', { content: 'one two three' })} />)
    expect(screen.getByText(/3/)).toBeInTheDocument()

    rerender(<ContentMetadata item={baseItem('voice', { duration: 65 })} />)
    expect(screen.getByText(/1:05/)).toBeInTheDocument()
  })

  it('routes content types to their detail previews', () => {
    const { rerender } = render(
      <ContentSection
        item={baseItem('link', {
          title: 'Article',
          sourceUrl: 'https://example.com/story',
          content: '<p>Body</p>'
        })}
      />
    )
    expect(screen.getByLabelText('inbox content editor')).toHaveValue('<p>Body</p>')
    expect(screen.getByRole('link', { name: 'example.com' })).toBeInTheDocument()

    rerender(
      <ContentSection
        item={baseItem('image', {
          title: 'Screenshot',
          attachmentUrl: 'memry-file://image.png',
          metadata: {
            originalFilename: 'image.png',
            width: 1200,
            height: 800,
            format: 'png',
            fileSize: 2048
          }
        })}
      />
    )
    expect(screen.getByRole('img', { name: 'Screenshot' })).toHaveAttribute(
      'src',
      'memry-file://image.png'
    )
    expect(screen.getByText('image.png')).toBeInTheDocument()
    expect(screen.getByText('png')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()

    rerender(
      <ContentSection
        item={baseItem('pdf', {
          title: 'Spec',
          metadata: { originalFilename: 'spec.pdf', pageCount: 12, fileSize: 2_097_152 }
        })}
      />
    )
    expect(screen.getByText('spec.pdf')).toBeInTheDocument()
    expect(screen.getByText(/2.0 MB/)).toBeInTheDocument()

    rerender(
      <ContentSection
        item={baseItem('video', {
          title: 'Demo',
          attachmentUrl: 'memry-file://demo.mp4',
          metadata: { originalFilename: 'demo.mp4', fileSize: 4096 }
        })}
      />
    )
    expect(document.querySelector('video')).toHaveAttribute('src', 'memry-file://demo.mp4')
    expect(screen.getByText('demo.mp4')).toBeInTheDocument()

    rerender(<ContentSection item={baseItem('social', { title: 'Thread' })} />)
    expect(screen.getByText('tweet Thread')).toBeInTheDocument()

    rerender(<ContentSection item={baseItem('reminder', { title: 'Follow up' })} />)
    expect(screen.getByText('reminder Follow up')).toBeInTheDocument()
  })

  it('keeps youtube and screenshot links as previews but makes plain articles editable', async () => {
    const user = userEvent.setup()
    const onContentChange = vi.fn()

    const { rerender } = render(
      <ContentSection
        item={baseItem('link', {
          title: 'Video',
          sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
        })}
      />
    )
    expect(screen.getByText('link preview Video')).toBeInTheDocument()

    rerender(
      <ContentSection
        item={baseItem('link', {
          title: 'Shot',
          content: '![screenshot](attachments/inbox/x/screenshot.png)'
        })}
      />
    )
    expect(screen.getByText('link preview Shot')).toBeInTheDocument()

    rerender(
      <ContentSection
        item={baseItem('link', {
          title: 'Doc',
          sourceUrl: 'https://example.com/a',
          content: '<p>Hello</p>'
        })}
        onContentChange={onContentChange}
      />
    )
    const editor = screen.getByLabelText('inbox content editor')
    expect(editor).toHaveValue('<p>Hello</p>')
    await user.clear(editor)
    await user.type(editor, 'Edited')
    expect(onContentChange).toHaveBeenLastCalledWith('Edited')
  })

  it('renders fallback image and video previews without attachments', () => {
    const { container, rerender } = render(
      <ContentSection
        item={baseItem('image', {
          title: 'Image without file',
          thumbnailUrl: null,
          attachmentUrl: null,
          metadata: null
        })}
      />
    )
    expect(container.querySelector('img')).not.toBeInTheDocument()

    rerender(
      <ContentSection
        item={baseItem('video', {
          title: 'Video without file',
          attachmentUrl: null,
          metadata: {
            originalFilename: 'demo.mov',
            fileSize: 1024
          }
        })}
      />
    )
    expect(container.querySelector('video')).not.toBeInTheDocument()
    expect(screen.getByText('demo.mov')).toBeInTheDocument()
    expect(screen.getByText('1.0 KB')).toBeInTheDocument()
  })

  it('drives voice audio playback, waveform seeking, transcription copy, and error states', async () => {
    const user = userEvent.setup()
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const writeText = vi.fn().mockResolvedValue(undefined)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
      }))
    )
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext(this: any) {
        this.decodeAudioData = vi.fn(async () => ({
          getChannelData: vi.fn(() =>
            Float32Array.from({ length: 120 }, (_, index) => (index % 2 === 0 ? 0.25 : -0.25))
          )
        }))
        this.close = vi.fn()
      })
    )

    const { container } = render(
      <ContentSection
        item={baseItem('voice', {
          title: 'Voice memo',
          attachmentUrl: 'memry-file://voice.wav',
          duration: 120,
          transcription: 'Transcript text',
          transcriptionStatus: 'completed',
          metadata: {
            duration: 120,
            format: 'wav',
            sampleRate: 16000,
            fileSize: 2048
          }
        })}
      />
    )

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('memry-file://voice.wav'))

    const audio = container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
    Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 10 })
    fireEvent.loadedMetadata(audio)
    fireEvent.timeUpdate(audio)

    await user.click(screen.getByRole('button', { name: /play/i }))
    expect(play).toHaveBeenCalledTimes(1)

    fireEvent.play(audio)
    await user.click(screen.getByRole('button', { name: /pause/i }))
    expect(pause).toHaveBeenCalledTimes(1)

    const slider = screen.getByRole('slider')
    slider.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 100,
        top: 0,
        bottom: 10,
        right: 100,
        height: 10
      }) as DOMRect
    fireEvent.click(slider, { clientX: 50 })
    expect(audio.currentTime).toBe(60)

    await user.click(screen.getByLabelText(/copy/i))
    expect(writeText).toHaveBeenCalledWith('Transcript text')
    expect(screen.getByText('WAV · 16kHz · 2.0 KB')).toBeInTheDocument()

    Object.defineProperty(audio, 'error', {
      configurable: true,
      value: { code: 4, message: 'cannot decode' }
    })
    fireEvent.error(audio)
    expect(screen.getByText('cannot decode')).toBeInTheDocument()
  })

  it('closes the waveform AudioContext when the decode fails, and only once', async () => {
    const close = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
      }))
    )
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext(this: any) {
        this.decodeAudioData = vi.fn(async () => {
          throw new Error('unsupported audio file')
        })
        this.close = close
      })
    )

    const { unmount } = render(
      <ContentSection
        item={baseItem('voice', {
          title: 'Corrupt memo',
          attachmentUrl: 'memry-file://corrupt.wav',
          duration: 12,
          metadata: { duration: 12, format: 'wav' }
        })}
      />
    )

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))

    unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the waveform AudioContext when the item unmounts mid-decode', async () => {
    const close = vi.fn()
    const audioContextCtor = vi.fn(function AudioContext(this: any) {
      this.decodeAudioData = vi.fn(() => new Promise(() => {}))
      this.close = close
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
      }))
    )
    vi.stubGlobal('AudioContext', audioContextCtor)

    const { unmount } = render(
      <ContentSection
        item={baseItem('voice', {
          title: 'Slow memo',
          attachmentUrl: 'memry-file://slow.wav',
          duration: 12,
          metadata: { duration: 12, format: 'wav' }
        })}
      />
    )

    await waitFor(() => expect(audioContextCtor).toHaveBeenCalledTimes(1))

    unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('renders voice transcription pending, processing, empty, and failed retrying states', () => {
    const { rerender } = render(
      <ContentSection item={baseItem('voice', { transcriptionStatus: 'processing' })} />
    )
    expect(screen.getByText(/transcribing/i)).toBeInTheDocument()

    rerender(<ContentSection item={baseItem('voice', { transcriptionStatus: 'pending' })} />)
    expect(screen.getByText(/awaiting/i)).toBeInTheDocument()

    rerender(<ContentSection item={baseItem('voice', { transcriptionStatus: null })} />)
    expect(screen.getByText(/no transcription/i)).toBeInTheDocument()

    rerender(
      <ContentSection
        item={baseItem('voice', { transcriptionStatus: 'failed' })}
        onRetryTranscription={vi.fn()}
        isRetrying={true}
      />
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeDisabled()
  })

  it('supports voice retry and text editing callbacks', async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    const onContentChange = vi.fn()

    const { rerender } = render(
      <ContentSection
        item={baseItem('voice', {
          title: 'Voice memo',
          duration: 95,
          transcriptionStatus: 'failed'
        })}
        onRetryTranscription={retry}
      />
    )
    expect(screen.getByText(/1:35/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(retry).toHaveBeenCalledTimes(1)

    rerender(
      <ContentSection
        item={baseItem('clip', { content: 'Original clip' })}
        onContentChange={onContentChange}
      />
    )
    await user.clear(screen.getByLabelText('inbox content editor'))
    await user.type(screen.getByLabelText('inbox content editor'), 'Updated clip')
    expect(onContentChange).toHaveBeenLastCalledWith('Updated clip')
  })
})
