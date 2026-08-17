/**
 * CanvasEditor persistence-safety tests.
 *
 * jsdom cannot host the real Excalidraw (no layout, no canvas), so the
 * component is stubbed with a controllable imperative API. The subject here is
 * the serialize/flush safety net around it:
 *
 * 1. The init-window wipe (regression): Excalidraw applies initialData
 *    asynchronously, so right after mount getSceneElements() is [] while
 *    appState.isLoading is true. StrictMode's simulated remount runs the
 *    persistence effect's cleanup flush inside that window with the wrapper
 *    still connected — without the isLoading serialize guard that flush
 *    persisted an EMPTY scene over the stored drawing.
 * 2. Cmd/Ctrl+S must flush to the vault and never reach Excalidraw's
 *    save-to-disk file dialog.
 */

import { act, fireEvent, render } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasEditor } from './canvas-editor'

interface FakeApi {
  getSceneElements: () => unknown[]
  getAppState: () => { isLoading: boolean }
  getFiles: () => Record<string, unknown>
}

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  toastSuccess: vi.fn(),
  // Mutable fake-Excalidraw state each test drives to simulate init phases.
  api: {
    elements: [] as unknown[],
    isLoading: true,
    selectedElementIds: {} as Record<string, boolean>,
    showHyperlinkPopup: false as false | 'info' | 'editor'
  },
  linkDialogProps: {} as Record<string, unknown>,
  onChange: null as (() => void) | null,
  excalidrawProps: {} as Record<string, unknown>,
  liveOpened: vi.fn(),
  liveClosed: vi.fn(),
  serializeAsJSON: vi.fn((elements: unknown[]) => JSON.stringify({ elements })),
  openTab: vi.fn(),
  toastError: vi.fn(),
  scrollToContent: vi.fn(),
  updateScene: vi.fn(),
  noteGet: vi.fn(),
  fileGet: vi.fn(),
  windowOpen: vi.fn()
}))

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: {
    excalidrawAPI: (api: FakeApi) => void
    onChange: () => void
    [key: string]: unknown
  }) => {
    mocks.excalidrawProps = props
    // The real Excalidraw passes (elements, appState, files); the editor reads
    // appState from it, so the fake has to hand one over too.
    mocks.onChange = () =>
      (props.onChange as unknown as (e: unknown[], a: unknown, f: unknown) => void)(
        mocks.api.elements,
        { showHyperlinkPopup: mocks.api.showHyperlinkPopup },
        {}
      )
    // The real Excalidraw hands out its imperative API on mount — long before
    // initialData is applied. A child effect still runs before the parent's
    // persistence effect, so the ordering under test is preserved (calling it
    // during render would be a cross-component setState → render loop).
    React.useEffect(() => {
      props.excalidrawAPI({
        getSceneElements: () => mocks.api.elements,
        getAppState: () => ({
          isLoading: mocks.api.isLoading,
          selectedElementIds: mocks.api.selectedElementIds
        }),
        getFiles: () => ({}),
        scrollToContent: (...args: unknown[]) => mocks.scrollToContent(...args),
        updateScene: (...args: unknown[]) => mocks.updateScene(...args)
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, like the real API handoff
    }, [])
    return <div data-testid="excalidraw" />
  },
  serializeAsJSON: (elements: unknown[], ...rest: unknown[]) =>
    mocks.serializeAsJSON(elements, ...rest),
  // The editor installs the vault-backed shape library on mount; this suite is
  // about scene persistence, so the hook is a no-op here.
  useHandleLibrary: () => undefined,
  languages: [],
  defaultLang: { code: 'en' },
  // Library persistence is covered by the adapter's own tests; here it only
  // needs to exist so the hook call does not blow up the component.
  useHandleLibrary: () => {},
  CaptureUpdateAction: { EVENTUALLY: 'eventually', IMMEDIATELY: 'immediately', NEVER: 'never' }
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))
vi.mock('react-i18next', () => ({ getI18n: () => ({ language: 'en' }) }))
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args)
  }
}))
vi.mock('@/services/canvas-service', () => ({
  canvasService: {
    update: (...args: unknown[]) => mocks.update(...args),
    uploadAsset: vi.fn()
  },
  onCanvasTooLarge: () => () => {}
}))
vi.mock('./canvas-card-overlay', () => ({ CanvasCardLayer: () => null }))
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: mocks.openTab }) }))
// The link picker is mounted (closed) alongside Excalidraw, so its data
// sources have to exist even for the suites that never open it.
// The picker's own rows are covered by canvas-link-candidates.test.ts; here the
// subject is the wiring, so the dialog is a prop recorder.
vi.mock('./canvas-link-dialog', () => ({
  CanvasLinkDialog: (props: Record<string, unknown>) => {
    mocks.linkDialogProps = props
    return null
  }
}))
vi.mock('@/hooks/use-projects-list', () => ({
  useProjectsList: () => ({ projects: [], isLoading: false })
}))
vi.mock('@/services/search-service', () => ({
  searchService: { quick: () => Promise.resolve({ results: [], queryTimeMs: 0 }) }
}))
vi.mock('@/services/calendar-service', () => ({
  calendarService: { searchEvents: () => Promise.resolve({ events: [] }) }
}))
vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: (...args: unknown[]) => mocks.noteGet(...args),
    getFile: (...args: unknown[]) => mocks.fileGet(...args)
  }
}))
vi.mock('@/lib/save-registry', () => ({
  registerPendingSave: vi.fn(),
  unregisterPendingSave: vi.fn()
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('./canvas-externalize', () => ({
  externalizeSceneAssets: (scene: string) => Promise.resolve(scene)
}))

const STORED_SCENE = JSON.stringify({ elements: [{ id: 'stroke-1', type: 'freedraw' }] })

/** Drives the fake Excalidraw through "initialData has been applied". */
function finishInit(): void {
  mocks.api.elements = [{ id: 'stroke-1', type: 'freedraw' }]
  mocks.api.isLoading = false
}

describe('CanvasEditor persistence safety', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.update.mockReset().mockResolvedValue({ id: 'c1' })
    mocks.toastSuccess.mockReset()
    mocks.serializeAsJSON.mockClear()
    mocks.api.elements = []
    mocks.api.isLoading = true
    mocks.api.selectedElementIds = {}
    mocks.api.showHyperlinkPopup = false
    mocks.onChange = null
    // The editor reports live-canvas ownership to main so agent writes can be
    // routed to this instance (#916); this suite only needs the calls to land.
    mocks.liveOpened.mockReset().mockResolvedValue({ ok: true })
    mocks.liveClosed.mockReset().mockResolvedValue({ ok: true })
    ;(window as Window & { api: unknown }).api = {
      canvas: { liveOpened: mocks.liveOpened, liveClosed: mocks.liveClosed },
      notes: { getFolders: () => Promise.resolve([]) }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never persists the empty init-window scene on a StrictMode remount (wipe regression)', async () => {
    // StrictMode mounts, runs effects, then simulates a remount: cleanup (which
    // flushes the persister) runs while the wrapper is still connected and the
    // fake scene is still in its pre-init state ([] + isLoading).
    render(
      <React.StrictMode>
        <CanvasEditor canvasId="c1" initialScene={STORED_SCENE} />
      </React.StrictMode>
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('persists a changed scene after init completes', async () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)
    finishInit()
    act(() => {
      mocks.onChange?.()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', scene: JSON.stringify({ elements: mocks.api.elements }) })
    )
  })

  it('Cmd+S flushes to the vault and never reaches Excalidraw', async () => {
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)
    finishInit()
    act(() => {
      mocks.onChange?.()
    })

    const documentKeydown = vi.fn()
    document.addEventListener('keydown', documentKeydown)
    try {
      const wrapper = container.querySelector('[data-canvas-editor="c1"]')!
      const prevented = !fireEvent.keyDown(wrapper.querySelector('[data-testid="excalidraw"]')!, {
        key: 's',
        metaKey: true
      })
      // Flushed immediately — no 800ms debounce wait.
      await act(async () => {
        await Promise.resolve()
      })
      expect(prevented).toBe(true)
      expect(documentKeydown).not.toHaveBeenCalled()
      expect(mocks.update).toHaveBeenCalledTimes(1)
      expect(mocks.toastSuccess).toHaveBeenCalledWith('canvas.savedToVault')
    } finally {
      document.removeEventListener('keydown', documentKeydown)
    }
  })

  it('does not re-serialize the scene when only the viewport moved (pan/zoom)', async () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)
    finishInit()

    // A real edit: serialized once and written.
    act(() => {
      mocks.onChange?.()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(mocks.update).toHaveBeenCalledTimes(1)

    // Full-scene serializes only — the appState fingerprint probe passes [].
    const sceneSerializes = (): number =>
      mocks.serializeAsJSON.mock.calls.filter((call) => (call[0] as unknown[]).length > 0).length
    const before = sceneSerializes()
    expect(before).toBeGreaterThan(0)

    // Pan/zoom fires onChange but leaves every element untouched. Before the
    // signature gate each of these paid a full serializeAsJSON (multi-MB with
    // inline images) purely to discover the string was identical.
    act(() => {
      mocks.onChange?.()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    act(() => {
      mocks.onChange?.()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(sceneSerializes()).toBe(before)
    expect(mocks.update).toHaveBeenCalledTimes(1)
  })

  it('persists an edit made right after the previous save (flush is never gated)', async () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)
    finishInit()
    act(() => {
      mocks.onChange?.()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(mocks.update).toHaveBeenCalledTimes(1)

    // New stroke, then an immediate flush (Cmd+S / tab close / quit) inside the
    // debounce window: the fingerprint moved, so it must reach the vault.
    mocks.api.elements = [...mocks.api.elements, { id: 'stroke-2', type: 'freedraw' }]
    act(() => {
      mocks.onChange?.()
    })
    const wrapper = document.querySelector('[data-canvas-editor="c1"]')!
    fireEvent.keyDown(wrapper.querySelector('[data-testid="excalidraw"]')!, {
      key: 's',
      metaKey: true
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.update).toHaveBeenCalledTimes(2)
    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ scene: JSON.stringify({ elements: mocks.api.elements }) })
    )
  })

  it('parses the stored scene lazily and keeps no copy of it', () => {
    render(<CanvasEditor canvasId="c1" initialScene={STORED_SCENE} />)

    // initialData is a function so the parsed scene lives only for the length
    // of Excalidraw's componentDidMount, instead of being retained for the
    // tab's lifetime alongside the raw string and the persister baseline.
    const initialData = mocks.excalidrawProps.initialData as () => unknown
    expect(typeof initialData).toBe('function')
    expect(initialData()).toEqual({
      elements: [{ id: 'stroke-1', type: 'freedraw' }],
      appState: {},
      files: undefined,
      scrollToContent: true
    })
  })

  it('refuses to mount the editor on an unparseable stored scene', () => {
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="{not json" />)

    expect(container.querySelector('[data-canvas-editor="c1"]')).toBeNull()
    expect(container.textContent).toContain('canvas.corruptScene')
  })

  it('disables Excalidraw file actions (open / save to disk) via UIOptions', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)
    expect(mocks.excalidrawProps.UIOptions).toEqual({
      canvasActions: { export: false, loadScene: false, saveToActiveFile: false }
    })
  })
})

/**
 * Link clicks (#Aurelie): Excalidraw's own handler ends in
 * `window.open(undefined, target)` + `newWindow.location = url`, which under
 * Electron either silently no-ops (the real URL never reaches the main-process
 * allowlist) or reloads the whole SPA document. The editor takes the click over
 * via `onLinkOpen` and must always prevent that fallback.
 */
describe('CanvasEditor link opening', () => {
  const PROD_DOC = 'file:///Applications/Memry.app/Contents/renderer/index.html'

  function clickLink(link: string): { defaultPrevented: boolean } {
    const onLinkOpen = mocks.excalidrawProps.onLinkOpen as (
      element: { id: string; link: string },
      event: { preventDefault: () => void; defaultPrevented: boolean }
    ) => void
    const event = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true
      }
    }
    onLinkOpen({ id: 'shape-1', link }, event)
    return event
  }

  beforeEach(() => {
    mocks.openTab.mockReset()
    mocks.toastError.mockReset()
    mocks.scrollToContent.mockReset()
    mocks.updateScene.mockReset()
    mocks.noteGet.mockReset().mockResolvedValue({ id: 'n1', title: 'Roadmap' })
    mocks.fileGet.mockReset().mockResolvedValue(null)
    mocks.windowOpen.mockReset()
    mocks.api.elements = [{ id: 'shape-1', type: 'rectangle' }]
    mocks.api.isLoading = false
    window.open = mocks.windowOpen as unknown as typeof window.open
    ;(window as Window & { api: unknown }).api = {
      canvas: { liveOpened: mocks.liveOpened, liveClosed: mocks.liveClosed },
      notes: { getFolders: () => Promise.resolve([]) }
    }
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: PROD_DOC }
    })
  })

  it('opens a linked note in a tab instead of letting Excalidraw navigate', async () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    const event = clickLink('memry://note/n1')
    await act(async () => {})

    expect(event.defaultPrevented).toBe(true)
    expect(mocks.noteGet).toHaveBeenCalledWith('n1')
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', path: '/note/n1', title: 'Roadmap' })
    )
    expect(mocks.windowOpen).not.toHaveBeenCalled()
  })

  it('reports a deleted target rather than opening a blank tab', async () => {
    mocks.noteGet.mockResolvedValue(null)
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    clickLink('memry://note/gone')
    await act(async () => {})

    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('canvas.link.itemMissing')
  })

  it('moves the viewport to an element link instead of reloading the app', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    const event = clickLink(`${PROD_DOC}?element=shape-1`)

    expect(event.defaultPrevented).toBe(true)
    expect(mocks.scrollToContent).toHaveBeenCalledWith(
      { id: 'shape-1', type: 'rectangle' },
      expect.objectContaining({ fitToContent: true })
    )
    expect(mocks.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({ appState: { selectedElementIds: { 'shape-1': true } } })
    )
    expect(mocks.windowOpen).not.toHaveBeenCalled()
  })

  it('reports an element link whose target has since been deleted', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    clickLink(`${PROD_DOC}?element=deleted-shape`)

    expect(mocks.scrollToContent).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('canvas.link.elementMissing')
  })

  it('hands a web link to the OS browser through the allowlisted _blank path', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    const event = clickLink('https://example.com/docs')

    expect(event.defaultPrevented).toBe(true)
    expect(mocks.windowOpen).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('still blocks Excalidraw entirely when there is nothing to act on', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    const event = clickLink('   ')

    expect(event.defaultPrevented).toBe(true)
    expect(mocks.windowOpen).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

/**
 * The "Link to item" picker's wiring. What the picker itself lists is covered
 * by canvas-link-candidates.test.ts; here the subject is which selection may
 * open it and what selecting a row writes onto the scene.
 */
describe('CanvasEditor link picker', () => {
  function pressShortcut(container: HTMLElement): void {
    fireEvent.keyDown(container.querySelector('[data-canvas-editor]') as Element, {
      key: 'K',
      metaKey: true,
      shiftKey: true
    })
  }

  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.updateScene.mockReset()
    mocks.linkDialogProps = {}
    mocks.api.isLoading = false
    mocks.api.showHyperlinkPopup = false
    ;(window as Window & { api: unknown }).api = {
      canvas: { liveOpened: mocks.liveOpened, liveClosed: mocks.liveClosed },
      notes: { getFolders: () => Promise.resolve([]) }
    }
  })

  it('opens the picker for a single selected shape', () => {
    mocks.api.elements = [{ id: 'shape-1', type: 'rectangle' }]
    mocks.api.selectedElementIds = { 'shape-1': true }
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)

    pressShortcut(container)

    expect(mocks.linkDialogProps.open).toBe(true)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('refuses to guess which of several selected shapes to link', () => {
    mocks.api.elements = [
      { id: 'shape-1', type: 'rectangle' },
      { id: 'shape-2', type: 'ellipse' }
    ]
    mocks.api.selectedElementIds = { 'shape-1': true, 'shape-2': true }
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)

    pressShortcut(container)

    expect(mocks.linkDialogProps.open).toBe(false)
    expect(mocks.toastError).toHaveBeenCalledWith('canvas.link.selectOneShape')
  })

  it('says so when nothing is selected', () => {
    mocks.api.elements = [{ id: 'shape-1', type: 'rectangle' }]
    mocks.api.selectedElementIds = {}
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)

    pressShortcut(container)

    expect(mocks.toastError).toHaveBeenCalledWith('canvas.link.selectOneShape')
  })

  it('will not put a second link on a card, which already opens its own item', () => {
    mocks.api.elements = [
      { id: 'card-1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } }
    ]
    mocks.api.selectedElementIds = { 'card-1': true }
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)

    pressShortcut(container)

    expect(mocks.linkDialogProps.open).toBe(false)
    expect(mocks.toastError).toHaveBeenCalledWith('canvas.link.cardsCannotLink')
  })

  it('writes the chosen href onto the shape and marks the scene dirty', () => {
    mocks.api.elements = [
      { id: 'shape-1', type: 'rectangle' },
      { id: 'shape-2', type: 'ellipse' }
    ]
    mocks.api.selectedElementIds = { 'shape-1': true }
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)
    pressShortcut(container)

    act(() => {
      ;(mocks.linkDialogProps.onPick as (href: string) => void)('memry://note/n1')
    })

    const [call] = mocks.updateScene.mock.calls as [{ elements: { id: string; link?: string }[] }][]
    expect(call[0].elements).toEqual([
      { id: 'shape-1', type: 'rectangle', link: 'memry://note/n1' },
      { id: 'shape-2', type: 'ellipse' }
    ])
    expect(mocks.toastSuccess).toHaveBeenCalledWith('canvas.link.linked')
  })

  it('reports a shape deleted while the picker was open instead of writing nowhere', () => {
    mocks.api.elements = [{ id: 'shape-1', type: 'rectangle' }]
    mocks.api.selectedElementIds = { 'shape-1': true }
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)
    pressShortcut(container)

    mocks.api.elements = []
    act(() => {
      ;(mocks.linkDialogProps.onPick as (href: string) => void)('memry://note/n1')
    })

    expect(mocks.updateScene).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('canvas.link.elementMissing')
  })
})

/**
 * Excalidraw's own "Create link" action — the chain button under Actions and
 * Cmd/Ctrl+K — opens a box that only takes a typed address. It works by setting
 * appState.showHyperlinkPopup to "editor", which reaches the editor through
 * onChange, so the button is answered with our item picker instead.
 */
describe('CanvasEditor native link action', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.updateScene.mockReset()
    mocks.linkDialogProps = {}
    mocks.api.isLoading = false
    mocks.api.showHyperlinkPopup = false
    mocks.api.elements = [{ id: 'shape-1', type: 'rectangle' }]
    mocks.api.selectedElementIds = { 'shape-1': true }
    ;(window as Window & { api: unknown }).api = {
      canvas: { liveOpened: mocks.liveOpened, liveClosed: mocks.liveClosed },
      notes: { getFolders: () => Promise.resolve([]) }
    }
  })

  it('answers the built-in link button with the item picker, and closes its URL box', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    mocks.api.showHyperlinkPopup = 'editor'
    act(() => mocks.onChange?.())

    expect(mocks.linkDialogProps.open).toBe(true)
    expect(mocks.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({ appState: { showHyperlinkPopup: false } })
    )
  })

  it('acts once per opening, not on every change while the popup is up', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    mocks.api.showHyperlinkPopup = 'editor'
    act(() => mocks.onChange?.())
    act(() => mocks.onChange?.())
    act(() => mocks.onChange?.())

    expect(mocks.updateScene).toHaveBeenCalledTimes(1)
  })

  it('re-arms after the popup closes, so the next click opens the picker again', () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    mocks.api.showHyperlinkPopup = 'editor'
    act(() => mocks.onChange?.())
    mocks.api.showHyperlinkPopup = false
    act(() => mocks.onChange?.())
    mocks.api.showHyperlinkPopup = 'editor'
    act(() => mocks.onChange?.())

    expect(mocks.updateScene).toHaveBeenCalledTimes(2)
  })

  it("leaves the 'info' popup alone, where the remove-link button lives", () => {
    render(<CanvasEditor canvasId="c1" initialScene="" />)

    mocks.api.showHyperlinkPopup = 'info'
    act(() => mocks.onChange?.())

    expect(mocks.linkDialogProps.open).toBe(false)
    expect(mocks.updateScene).not.toHaveBeenCalled()
  })
})

/**
 * Excalidraw's link bubble prints `element.link` verbatim, so a link to a note
 * read as `memry://note/s5b2qadr6tg4`. There is no prop to change what it
 * renders, so the editor swaps the text in place once the bubble appears.
 */
describe('CanvasEditor link bubble label', () => {
  async function mountAnchor(container: HTMLElement, href: string): Promise<HTMLAnchorElement> {
    const wrapper = container.querySelector('[data-canvas-editor]') as HTMLElement
    const anchor = document.createElement('a')
    anchor.className = 'excalidraw-hyperlinkContainer-link'
    anchor.setAttribute('href', href)
    anchor.textContent = href
    await act(async () => {
      wrapper.appendChild(anchor)
      await Promise.resolve()
    })
    return anchor
  }

  beforeEach(() => {
    mocks.api.isLoading = false
    mocks.api.elements = []
    ;(window as Window & { api: unknown }).api = {
      canvas: { liveOpened: mocks.liveOpened, liveClosed: mocks.liveClosed },
      notes: { getFolders: () => Promise.resolve([]) }
    }
  })

  it("shows the linked item's name instead of its id", async () => {
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)

    const anchor = await mountAnchor(
      container,
      'memry://note/s5b2qadr6tg4?label=memrynote%20Launch'
    )

    expect(anchor.textContent).toBe('memrynote Launch')
  })

  it('leaves a web address as written, where the URL is the honest label', async () => {
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)

    const anchor = await mountAnchor(container, 'https://example.com/docs')

    expect(anchor.textContent).toBe('https://example.com/docs')
  })

  it('leaves a link written before labels existed as written', async () => {
    const { container } = render(<CanvasEditor canvasId="c1" initialScene="" />)

    const anchor = await mountAnchor(container, 'memry://note/n1')

    expect(anchor.textContent).toBe('memry://note/n1')
  })
})
