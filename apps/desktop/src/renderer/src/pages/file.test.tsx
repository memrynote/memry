import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { FilePage } from './file'

const mocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  openExternal: vi.fn(),
  revealInFinder: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getFile: mocks.getFile
  }
}))

vi.mock('@/components/tasks/projects/item-project-chips', () => ({
  ItemProjectChips: ({ itemType, itemId }: { itemType: string; itemId: string }) => (
    <div data-testid="chips" data-item-type={itemType} data-item-id={itemId} />
  )
}))

vi.mock('@/components/tasks/projects/add-file-to-project-dialog', () => ({
  AddFileToProjectDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-file-dialog" /> : null
}))

vi.mock('@/components/viewers', () => ({
  PdfViewer: ({ src }: { src: string }) => <div data-testid="pdf-viewer">{src}</div>,
  ImageViewer: ({ src, alt }: { src: string; alt: string }) => (
    <div data-testid="image-viewer">
      {src}
      {alt}
    </div>
  ),
  AudioPlayer: ({
    src,
    fileName,
    transcription
  }: {
    src: string
    fileName: string
    transcription?: string | null
  }) => (
    <div data-testid="audio-player">
      {src}
      {fileName}
      {transcription}
    </div>
  ),
  VideoPlayer: ({ src }: { src: string }) => <div data-testid="video-player">{src}</div>
}))

const baseFile = {
  id: 'file-1',
  path: 'notes/file.pdf',
  absolutePath: '/vault/notes/file.pdf',
  title: 'File title',
  fileType: 'pdf',
  mimeType: 'application/pdf',
  fileSize: 2048,
  created: new Date('2026-05-10T09:00:00.000Z'),
  modified: new Date('2026-05-10T09:00:00.000Z')
}

describe('FilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window.api.notes, {
      openExternal: mocks.openExternal,
      revealInFinder: mocks.revealInFinder
    })
    mocks.getFile.mockResolvedValue(baseFile)
  })

  it('renders the empty state when no file is selected', () => {
    renderWithProviders(<FilePage />)

    expect(screen.getByText('phaseF.pagesFile.noFileSelected')).toBeInTheDocument()
    expect(
      screen.getByText('phaseF.pagesFile.selectAFileFromTheSidebarToViewIt')
    ).toBeInTheDocument()
    expect(mocks.getFile).not.toHaveBeenCalled()
  })

  it('loads metadata, renders file info, and opens or reveals the file', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FilePage fileId="file-1" />)

    expect(await screen.findByText('File title')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-viewer')).toHaveTextContent(
      'memry-file://local/vault/notes/file.pdf'
    )

    await user.click(screen.getByTitle('phaseF.pagesFile.openInDefaultApp'))
    expect(mocks.openExternal).toHaveBeenCalledWith('file-1')

    await user.click(screen.getByTitle('phaseF.pagesFile.revealInFinder'))
    expect(mocks.revealInFinder).toHaveBeenCalledWith('file-1')
  })

  it('routes supported file types to their viewers and shows unsupported files', async () => {
    mocks.getFile.mockImplementation(async (id: string) => ({
      ...baseFile,
      id,
      fileType: id,
      absolutePath: `/vault/${id}`,
      title: `${id} file`,
      fileSize: null
    }))

    const pdf = renderWithProviders(<FilePage fileId="pdf" />)
    expect(await screen.findByTestId('pdf-viewer')).toHaveTextContent(
      'memry-file://local/vault/pdf'
    )
    pdf.unmount()

    const image = renderWithProviders(<FilePage fileId="image" />)
    expect(await screen.findByTestId('image-viewer')).toHaveTextContent('image file')
    image.unmount()

    const audio = renderWithProviders(<FilePage fileId="audio" />)
    expect(await screen.findByTestId('audio-player')).toHaveTextContent('audio file')
    audio.unmount()

    const video = renderWithProviders(<FilePage fileId="video" />)
    expect(await screen.findByTestId('video-player')).toHaveTextContent(
      'memry-file://local/vault/video'
    )
    video.unmount()

    renderWithProviders(<FilePage fileId="zip" />)
    expect(await screen.findByText('phaseF.pagesFile.unsupportedFileType')).toBeInTheDocument()
    expect(screen.getByText('Unknown size')).toBeInTheDocument()
  })

  it('passes filed voice transcripts to the audio viewer', async () => {
    mocks.getFile.mockResolvedValue({
      ...baseFile,
      id: 'voice-file-1',
      fileType: 'audio',
      absolutePath: '/vault/notes/standup.webm',
      title: 'standup',
      transcription: 'We covered launch risks and pricing.',
      transcriptionStatus: 'complete'
    })

    renderWithProviders(<FilePage fileId="voice-file-1" />)

    expect(await screen.findByTestId('audio-player')).toHaveTextContent(
      'We covered launch risks and pricing.'
    )
  })

  it('shows retryable error and not-found states', async () => {
    const user = userEvent.setup()
    mocks.getFile.mockRejectedValueOnce(new Error('disk offline')).mockResolvedValueOnce(baseFile)
    renderWithProviders(<FilePage fileId="file-1" />)

    expect(await screen.findByText('disk offline')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'phaseF.pagesFile.tryAgain' }))
    await waitFor(() => expect(mocks.getFile).toHaveBeenCalledTimes(2))

    mocks.getFile.mockResolvedValueOnce(null)
    renderWithProviders(<FilePage fileId="missing" />)
    expect(
      await screen.findByText('File not found. It may have been deleted or moved.')
    ).toBeInTheDocument()
  })

  it('renders file project chips with itemType file', async () => {
    renderWithProviders(<FilePage fileId="file-1" />)

    const chips = await screen.findByTestId('chips')
    expect(chips).toHaveAttribute('data-item-type', 'file')
    expect(chips).toHaveAttribute('data-item-id', 'file-1')
  })

  it('opens the add-to-project dialog from the info-bar button', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FilePage fileId="file-1" />)

    expect(await screen.findByText('File title')).toBeInTheDocument()
    await user.click(screen.getByTitle('addToProject.menuLabel'))

    expect(screen.getByTestId('add-file-dialog')).toBeInTheDocument()
  })
})
