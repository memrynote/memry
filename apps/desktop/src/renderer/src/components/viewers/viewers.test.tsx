import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Profiler } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioPlayer } from './audio-player'
import { ImageViewer } from './image-viewer'
import { PdfViewer } from './pdf-viewer'
import { VideoPlayer } from './video-player'

const mocks = vi.hoisted(() => {
  const customPlayers: unknown[] = []
  return {
    customPlayers,
    addCustomPlayer: vi.fn((player: unknown) => customPlayers.push(player)),
    videoError: undefined as undefined | (() => void),
    logError: vi.fn(),
    clipboardWrite: vi.fn(),
    // Render probes. `useT` runs once per component render *pass*, so it catches a render
    // React throws away and redoes. `sliderRender` runs once per Slider render; `max === 1`
    // is the volume slider, which the AudioPlayer shell owns.
    useT: vi.fn(() => ({ t: (key: string) => key })),
    sliderRender: vi.fn()
  }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: mocks.useT
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError })
}))

vi.mock('@/components/ui/slider', () => ({
  Slider: ({
    value,
    max = 100,
    onValueChange
  }: {
    value: number[]
    max?: number
    onValueChange?: (value: number[]) => void
  }) => {
    mocks.sliderRender({ max, value: value[0] })
    return (
      <button
        type="button"
        aria-label={`slider-${value[0]}`}
        onClick={() => onValueChange?.([max])}
      >
        slider {value[0]}
      </button>
    )
  }
}))

vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({
    children,
    onLoadSuccess,
    onLoadError,
    loading,
    file
  }: {
    children: React.ReactNode
    onLoadSuccess?: (result: { numPages: number }) => void
    onLoadError?: (error: Error) => void
    loading?: React.ReactNode
    file: string
  }) => (
    <section data-testid="pdf-document" data-file={file}>
      {loading}
      <button type="button" onClick={() => onLoadSuccess?.({ numPages: 3 })}>
        load pdf
      </button>
      <button type="button" onClick={() => onLoadError?.(new Error('pdf failed'))}>
        fail pdf
      </button>
      {children}
    </section>
  ),
  Page: ({
    pageNumber,
    scale,
    rotate,
    width
  }: {
    pageNumber: number
    scale?: number
    rotate?: number
    width?: number
  }) => (
    <div data-testid="pdf-page">
      page {pageNumber} scale {scale ?? 'thumb'} rotate {rotate ?? 0} width {width ?? 'full'}
    </div>
  )
}))

vi.mock('react-player', () => {
  const Player = ({ src, onError }: { src: string; onError?: () => void }) => {
    mocks.videoError = onError
    return <div data-testid="react-player">video {src}</div>
  }
  Player.addCustomPlayer = mocks.addCustomPlayer
  return { default: Player }
})

describe('viewer components', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.videoError = undefined
    mocks.clipboardWrite.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.clipboardWrite }
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      value: vi.fn(),
      configurable: true
    })
  })

  it('plays audio, updates metadata, seeks, changes volume, skips, and handles errors', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(
      <AudioPlayer src="memry-file://voice.mp3" fileName="Voice" />
    )
    const audio = container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { value: 125, configurable: true })
    Object.defineProperty(audio, 'currentTime', { value: 15, writable: true, configurable: true })

    fireEvent.loadedMetadata(audio)
    fireEvent.timeUpdate(audio)
    expect(screen.getByText('Voice')).toBeInTheDocument()
    expect(screen.getByText('0:15')).toBeInTheDocument()
    expect(screen.getByText('2:05')).toBeInTheDocument()

    const buttons = container.querySelectorAll('button')
    await user.click(buttons[2])
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    await user.click(buttons[1])
    expect(audio.currentTime).toBe(5)
    await user.click(buttons[3])
    expect(audio.currentTime).toBe(15)

    await user.click(screen.getByLabelText('slider-15'))
    expect(audio.currentTime).toBe(125)
    await user.click(screen.getByLabelText('slider-1'))
    expect(audio.volume).toBe(1)
    await user.click(buttons[4])
    expect(audio.volume).toBe(0)

    fireEvent.ended(audio)
    fireEvent.error(audio)
    rerender(<AudioPlayer src="memry-file://voice.mp3" fileName="Voice" />)
    expect(
      screen.getByText('phaseF.componentsViewersAudioPlayer.failedToLoadAudio')
    ).toBeInTheDocument()
  })

  it('tracks playback in the scrubber without re-rendering the rest of the player', async () => {
    const user = userEvent.setup()
    const { container } = render(<AudioPlayer src="memry-file://voice.mp3" fileName="Voice" />)
    const audio = container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true })
    let elapsed = 0
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => elapsed,
      set: (next: number) => {
        elapsed = next
      }
    })

    fireEvent.loadedMetadata(audio)
    const shellRenders = (): number =>
      mocks.sliderRender.mock.calls.filter(([props]) => props.max === 1).length

    mocks.sliderRender.mockClear()

    // A ~4 Hz timeupdate stream, the way a playing track delivers it.
    for (let tick = 1; tick <= 10; tick += 1) {
      elapsed = tick * 1.5
      fireEvent.timeUpdate(audio)
    }

    // The scrubber still follows playback at full timeupdate resolution...
    expect(screen.getByLabelText('slider-15')).toBeInTheDocument()
    expect(screen.getByText('0:15')).toBeInTheDocument()
    // ...but the surrounding player (volume slider, controls, transcript) never re-rendered.
    expect(shellRenders()).toBe(0)

    // Seeking still moves the element and the display together.
    await user.click(screen.getByLabelText('slider-15'))
    expect(audio.currentTime).toBe(100)
    expect(screen.getByLabelText('slider-100')).toBeInTheDocument()
    // Elapsed and total both read 1:40 once the scrubber is dragged to the end.
    expect(screen.getAllByText('1:40')).toHaveLength(2)

    // Play, then `ended`, must still leave the button back in its "play" state.
    const playButton = container.querySelectorAll('button')[2]
    await user.click(playButton)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
    fireEvent.ended(audio)
    await user.click(playButton)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()

    // ...and pausing still pauses.
    await user.click(playButton)
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
  })

  // `useTrackedTimeout` (#1266) owns the cancellation; this asserts the player is actually
  // wired to it, which the hook's own unit test cannot see.
  it('cancels the copy-confirmation timer when the player unmounts', async () => {
    vi.useFakeTimers()
    try {
      const { unmount } = render(
        <AudioPlayer src="memry-file://voice.mp3" fileName="Voice" transcription="Launch risks." />
      )

      fireEvent.click(screen.getByRole('button', { name: 'content.copyTranscription' }))
      await act(async () => {})
      expect(mocks.clipboardWrite).toHaveBeenCalledWith('Launch risks.')
      expect(vi.getTimerCount()).toBe(1)

      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows an available audio transcription and copies it', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.clipboardWrite }
    })

    render(
      <AudioPlayer
        src="memry-file://voice.mp3"
        fileName="Voice"
        transcription="We covered launch risks and pricing."
      />
    )

    expect(screen.getByText('content.transcription')).toBeInTheDocument()
    expect(screen.getByText('We covered launch risks and pricing.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'content.copyTranscription' }))
    expect(mocks.clipboardWrite).toHaveBeenCalledWith('We covered launch risks and pricing.')
  })

  it('zooms, rotates, pans, fits, and errors image previews', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(
      <ImageViewer src="memry-file://image.png" alt="Sketch" />
    )
    const image = screen.getByRole('img', { name: 'Sketch' })
    const imageContainer = image.parentElement as HTMLDivElement
    Object.defineProperty(image, 'naturalWidth', { value: 400, configurable: true })
    Object.defineProperty(image, 'naturalHeight', { value: 200, configurable: true })
    Object.defineProperty(imageContainer, 'clientWidth', { value: 500, configurable: true })
    Object.defineProperty(imageContainer, 'clientHeight', { value: 300, configurable: true })

    fireEvent.load(image)
    expect(screen.getByText('100%')).toBeInTheDocument()

    const buttons = container.querySelectorAll('button')
    await user.click(buttons[1])
    expect(screen.getByText('125%')).toBeInTheDocument()
    fireEvent.mouseDown(imageContainer, { clientX: 20, clientY: 20 })
    fireEvent.mouseMove(imageContainer, { clientX: 35, clientY: 40 })
    fireEvent.mouseUp(imageContainer)
    await user.click(screen.getByTitle('phaseF.componentsViewersImageViewer.rotate'))
    expect(image).toHaveStyle('transform: translate(15px, 20px) scale(1.25) rotate(90deg)')

    fireEvent.wheel(imageContainer, { deltaY: 1 })
    await user.click(screen.getByTitle('phaseF.componentsViewersImageViewer.resetZoom'))
    expect(screen.getByText('100%')).toBeInTheDocument()

    fireEvent.error(image)
    rerender(<ImageViewer src="memry-file://image.png" alt="Sketch" />)
    expect(
      screen.getByText('phaseF.componentsViewersImageViewer.failedToLoadImage')
    ).toBeInTheDocument()
  })

  it('pans an image without re-rendering per mousemove and commits the final offset', async () => {
    const user = userEvent.setup()
    const onRender = vi.fn()
    const { container } = render(
      <Profiler id="image-viewer" onRender={onRender}>
        <ImageViewer src="memry-file://pan.png" alt="Pan" />
      </Profiler>
    )
    const image = screen.getByRole('img', { name: 'Pan' })
    const imageContainer = image.parentElement as HTMLDivElement

    // Pan only engages above 100%.
    await user.click(container.querySelectorAll('button')[1])
    expect(screen.getByText('125%')).toBeInTheDocument()

    fireEvent.mouseDown(imageContainer, { clientX: 100, clientY: 100 })
    onRender.mockClear()

    const steps = 12
    for (let step = 1; step <= steps; step += 1) {
      fireEvent.mouseMove(imageContainer, { clientX: 100 + step * 3, clientY: 100 + step * 5 })
    }

    // The gesture drives the transform imperatively: pixel-accurate, zero React commits.
    expect(onRender).not.toHaveBeenCalled()
    expect(image).toHaveStyle('transform: translate(36px, 60px) scale(1.25) rotate(0deg)')

    // The pointer leaving the container must not abort or freeze the pan.
    fireEvent.mouseMove(window, { clientX: 140, clientY: 170 })
    expect(onRender).not.toHaveBeenCalled()
    expect(image).toHaveStyle('transform: translate(40px, 70px) scale(1.25) rotate(0deg)')

    // Mouseup outside the container still ends the drag and commits state once.
    fireEvent.mouseUp(window)
    expect(onRender).toHaveBeenCalledTimes(1)

    // A later re-render must not snap back to the pointer-down offset.
    await user.click(screen.getByTitle('phaseF.componentsViewersImageViewer.rotate'))
    expect(image).toHaveStyle('transform: translate(40px, 70px) scale(1.25) rotate(90deg)')

    // Dropping back to 100% still recenters.
    await user.click(screen.getByTitle('phaseF.componentsViewersImageViewer.resetZoom'))
    expect(image).toHaveStyle('transform: translate(0px, 0px) scale(1) rotate(90deg)')
  })

  it('recenters on zoom-out to 100% without a throwaway render pass', async () => {
    const user = userEvent.setup()
    const { container } = render(<ImageViewer src="memry-file://zoom.png" alt="Zoom" />)
    const image = screen.getByRole('img', { name: 'Zoom' })
    const imageContainer = image.parentElement as HTMLDivElement

    // Zoom past 100% and pan, so there is an offset left to clear.
    await user.click(container.querySelectorAll('button')[1])
    expect(screen.getByText('125%')).toBeInTheDocument()
    fireEvent.mouseDown(imageContainer, { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 30, clientY: 40 })
    fireEvent.mouseUp(window)
    expect(image).toHaveStyle('transform: translate(30px, 40px) scale(1.25) rotate(0deg)')

    mocks.useT.mockClear()
    await user.click(container.querySelectorAll('button')[0])

    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(image).toHaveStyle('transform: translate(0px, 0px) scale(1) rotate(0deg)')
    // Scale and the recenter land in the same batch: one render pass, not two.
    expect(mocks.useT).toHaveBeenCalledTimes(1)
  })

  // Zoom mixes 0.1 wheel steps with 0.25 button steps and those do not round-trip in binary
  // floating point. Nothing below sets a scale directly: each test drives real events, so the
  // values under test are whatever the component actually accumulates.
  it('recenters when a wheel step lands back on a displayed 100%', async () => {
    const user = userEvent.setup()
    const { container } = render(<ImageViewer src="memry-file://drift-down.png" alt="DriftDown" />)
    const image = screen.getByRole('img', { name: 'DriftDown' })
    const imageContainer = image.parentElement as HTMLDivElement
    const [zoomOutButton, zoomInButton] = container.querySelectorAll('button')

    // wheel-down, zoom-in, zoom-out, wheel-up leaves 0.9999999999999999, shown as "100%".
    fireEvent.wheel(imageContainer, { deltaY: 1 })
    await user.click(zoomInButton)
    expect(screen.getByText('115%')).toBeInTheDocument()

    fireEvent.mouseDown(imageContainer, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 170 })
    fireEvent.mouseUp(window)
    expect(image.style.transform).toBe('translate(40px, 70px) scale(1.15) rotate(0deg)')

    await user.click(zoomOutButton)
    fireEvent.wheel(imageContainer, { deltaY: -1 })

    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1) rotate(0deg)')
  })

  it('does not leave drag-to-pan armed at a displayed 100%', async () => {
    const user = userEvent.setup()
    const { container } = render(<ImageViewer src="memry-file://drift-up.png" alt="DriftUp" />)
    const image = screen.getByRole('img', { name: 'DriftUp' })
    const imageContainer = image.parentElement as HTMLDivElement
    const [zoomOutButton, zoomInButton] = container.querySelectorAll('button')

    // The mirror sequence lands on 1.0000000000000002 — also "100%", but above 1, so the
    // pan affordances stayed switched on at what the toolbar called natural size.
    fireEvent.wheel(imageContainer, { deltaY: -1 })
    fireEvent.wheel(imageContainer, { deltaY: -1 })
    expect(screen.getByText('120%')).toBeInTheDocument()

    fireEvent.mouseDown(imageContainer, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 170 })
    fireEvent.mouseUp(window)

    await user.click(zoomOutButton)
    fireEvent.wheel(imageContainer, { deltaY: 1 })
    fireEvent.wheel(imageContainer, { deltaY: 1 })
    await user.click(zoomInButton)

    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1) rotate(0deg)')
    expect(screen.queryByText('phaseF.componentsViewersImageViewer.dragToPan')).toBeNull()
    expect(imageContainer.className).toContain('cursor-default')
  })

  it('still recenters on a toolbar-only round trip to 100%', async () => {
    const user = userEvent.setup()
    const { container } = render(<ImageViewer src="memry-file://toolbar.png" alt="Toolbar" />)
    const image = screen.getByRole('img', { name: 'Toolbar' })
    const imageContainer = image.parentElement as HTMLDivElement
    const [zoomOutButton, zoomInButton] = container.querySelectorAll('button')

    await user.click(zoomInButton)
    expect(screen.getByText('125%')).toBeInTheDocument()

    fireEvent.mouseDown(imageContainer, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 170 })
    fireEvent.mouseUp(window)
    expect(image.style.transform).toBe('translate(40px, 70px) scale(1.25) rotate(0deg)')

    await user.click(zoomOutButton)
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1) rotate(0deg)')
  })

  it('leaves a genuine 105% zoom alone instead of snapping it to 100%', async () => {
    const user = userEvent.setup()
    const { container } = render(<ImageViewer src="memry-file://real-zoom.png" alt="RealZoom" />)
    const image = screen.getByRole('img', { name: 'RealZoom' })
    const imageContainer = image.parentElement as HTMLDivElement
    const zoomInButton = container.querySelectorAll('button')[1]

    await user.click(zoomInButton)
    fireEvent.mouseDown(imageContainer, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 170 })
    fireEvent.mouseUp(window)

    // 1.25 -> 1.15 -> 1.0499999999999998: a zoom level the user picked, 0.05 away from 1 and
    // so nowhere near the snap tolerance. It must keep its offset and its pan affordances.
    fireEvent.wheel(imageContainer, { deltaY: 1 })
    fireEvent.wheel(imageContainer, { deltaY: 1 })

    expect(screen.getByText('105%')).toBeInTheDocument()
    expect(image.style.transform).toBe(
      'translate(40px, 70px) scale(1.0499999999999998) rotate(0deg)'
    )
    expect(screen.getByText('phaseF.componentsViewersImageViewer.dragToPan')).toBeInTheDocument()
  })

  it('loads PDFs, navigates pages, changes zoom/sidebar/rotation, and reports load errors', async () => {
    const user = userEvent.setup()
    const { container } = render(<PdfViewer src="memry-file://spec.pdf" />)
    Object.defineProperty(container.firstElementChild, 'clientWidth', {
      value: 1156,
      configurable: true
    })

    await user.click(screen.getAllByRole('button', { name: 'load pdf' })[0])
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByText(/page 1 scale 1 rotate 0/)).toBeInTheDocument()

    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.nextPage'))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.previousPage'))
    expect(screen.getByText('1 / 3')).toBeInTheDocument()

    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.zoomIn'))
    expect(screen.getByText('125%')).toBeInTheDocument()
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.zoomOut'))
    expect(screen.getByText('100%')).toBeInTheDocument()
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.rotate'))
    expect(screen.getByText(/rotate 90/)).toBeInTheDocument()

    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.fitToWidth'))
    expect(screen.getAllByText((_, node) => node?.textContent === '155%').length).toBeGreaterThan(0)
    await user.click(screen.getByTitle('Hide thumbnails'))
    expect(screen.getByTitle('Show thumbnails')).toBeInTheDocument()

    await user.click(
      within(screen.getByTestId('pdf-document')).getByRole('button', { name: 'fail pdf' })
    )
    expect(
      screen.getByText('phaseF.componentsViewersPdfViewer.failedToLoadPdf')
    ).toBeInTheDocument()
    expect(screen.getByText('pdf failed')).toBeInTheDocument()
  })

  it('registers the memry video player, drives native playback events, and renders video error state', () => {
    const callbacks = {
      onReady: vi.fn(),
      onStart: vi.fn(),
      onPlay: vi.fn(),
      onPause: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
      onProgress: vi.fn(),
      onDuration: vi.fn()
    }

    render(<VideoPlayer src="memry-file://clip.mp4" />)
    expect(screen.getByTestId('react-player')).toHaveTextContent('memry-file://clip.mp4')
    expect(mocks.customPlayers.length).toBeGreaterThan(0)

    const MemryFilePlayer = mocks.customPlayers[0] as React.ComponentType<{
      src: string
      playing?: boolean
      controls?: boolean
      loop?: boolean
      muted?: boolean
      volume?: number
      playbackRate?: number
      onReady?: () => void
      onStart?: () => void
      onPlay?: () => void
      onPause?: () => void
      onEnded?: () => void
      onError?: () => void
      onProgress?: (state: {
        played: number
        playedSeconds: number
        loaded: number
        loadedSeconds: number
      }) => void
      onDuration?: (duration: number) => void
    }>
    expect((MemryFilePlayer as any).canPlay('memry-file://clip.mp4')).toBe(true)
    expect((MemryFilePlayer as any).canPlay('https://example.test/clip.mp4')).toBe(false)

    const { container, rerender } = render(
      <MemryFilePlayer
        src="memry-file://clip.mp4"
        playing
        controls
        loop
        muted
        volume={0.4}
        playbackRate={1.25}
        {...callbacks}
      />
    )
    const video = container.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { value: 100, configurable: true })
    Object.defineProperty(video, 'currentTime', { value: 25, configurable: true })
    Object.defineProperty(video, 'buffered', {
      value: {
        length: 1,
        end: () => 50
      },
      configurable: true
    })

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    expect(video.volume).toBe(0.4)
    expect(video.playbackRate).toBe(1.25)

    fireEvent.loadedMetadata(video)
    expect(callbacks.onDuration).toHaveBeenCalledWith(100)
    expect(callbacks.onReady).toHaveBeenCalledOnce()

    fireEvent.play(video)
    expect(callbacks.onStart).toHaveBeenCalledOnce()
    expect(callbacks.onPlay).toHaveBeenCalledOnce()

    fireEvent.timeUpdate(video)
    expect(callbacks.onProgress).toHaveBeenCalledWith({
      played: 0.25,
      playedSeconds: 25,
      loaded: 0.5,
      loadedSeconds: 50
    })

    fireEvent.pause(video)
    fireEvent.ended(video)
    fireEvent.error(video)
    expect(callbacks.onPause).toHaveBeenCalledOnce()
    expect(callbacks.onEnded).toHaveBeenCalledOnce()
    expect(callbacks.onError).toHaveBeenCalledOnce()

    rerender(<MemryFilePlayer src="memry-file://clip.mp4" playing={false} />)
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()

    act(() => mocks.videoError?.())
    expect(
      screen.getByText('phaseF.componentsViewersVideoPlayer.failedToLoadVideo')
    ).toBeInTheDocument()
    expect(mocks.logError).toHaveBeenCalledWith('Error loading video', 'memry-file://clip.mp4')
  })
})
